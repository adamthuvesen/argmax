//! Walks every provider transcript on disk and folds the billed calls into
//! the hourly ledger (`persistence::usage_scan`). A sweep is incremental: an
//! unchanged file is skipped on its size and mtime, a grown file is read from
//! the byte the last sweep stopped at, and only a rewritten or unknown file is
//! parsed in full. See `docs/usage.md`.

use std::{
    collections::HashMap,
    fs,
    io::{Read, Seek, SeekFrom},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::{SystemTime, UNIX_EPOCH},
};

use rusqlite::Connection;
use sha2::{Digest, Sha256};

use crate::error::{ArgmaxError, ArgmaxResult};
use crate::ipc::validation::ProviderId;
use crate::persistence::{
    time::now_iso,
    usage_scan::{self, HourlyBucketDelta, ScanFileRecord},
    Database,
};
use crate::providers::pricing::normalize_model_id;
use crate::usage::records::{TranscriptContext, UsageRecord, UsageRecordTokens};
use crate::usage::{claude, codex, grok, opencode};
use crate::util::sync::LockOrRecover;

/// Bump when a parser's output for the same bytes changes; the next sweep
/// empties the ledger and reads everything again.
pub const PARSER_VERSION: &str = "2";
/// How far back the ledger reaches. The widest window is 30 days; the rest is
/// headroom for a longer window later without a rescan.
pub const RETENTION_DAYS: i64 = 90;
/// A file's mtime lags the calls inside it by at most a session, so the walk
/// cutoff sits this much before the ledger cutoff.
const MTIME_SLACK_MS: i64 = 36 * 60 * 60 * 1000;
/// A file this old is finished: its last line counts even without a newline.
const SETTLED_AFTER_MS: i64 = 5 * 60 * 1000;
/// Bytes before the cursor whose digest tells an append from a rewrite.
const GUARD_BYTES: u64 = 64;
/// OpenCode rows are re-read this far back on every sweep, because a message
/// row is inserted first and its tokens filled in when the step completes.
const OPENCODE_REREAD_MS: i64 = 24 * 60 * 60 * 1000;

const META_OPENCODE_SCANNED_AT_MS: &str = "opencode_scanned_at_ms";

#[derive(Debug, Clone, Default, PartialEq)]
pub struct ScanProgress {
    pub scanning: bool,
    pub files_total: i64,
    pub files_done: i64,
    /// RFC 3339 UTC of the last sweep that ran to the end.
    pub last_completed_at: Option<String>,
}

pub struct UsageScanner {
    database: Arc<Database>,
    home: PathBuf,
    sweep_lock: Mutex<()>,
    progress: Mutex<ScanProgress>,
}

/// How `walk` classifies a file: which provider it belongs to and, for Claude
/// subagent transcripts, the parent session id.
type Classify<'a> = &'a mut dyn FnMut(&Path, usize) -> Option<(ProviderId, Option<String>)>;

#[derive(Debug, Clone)]
struct SourceFile {
    path: PathBuf,
    provider: ProviderId,
    /// Claude subagent transcripts belong to the session directory above them.
    session_id_hint: Option<String>,
    size: i64,
    mtime_ms: i64,
}

impl UsageScanner {
    pub fn new(database: Arc<Database>, home: PathBuf) -> Self {
        let last_completed_at = {
            let connection = database.connection();
            usage_scan::get_meta(&connection, usage_scan::META_LAST_COMPLETED_AT)
                .ok()
                .flatten()
        };
        Self {
            database,
            home,
            sweep_lock: Mutex::new(()),
            progress: Mutex::new(ScanProgress {
                last_completed_at,
                ..ScanProgress::default()
            }),
        }
    }

    pub fn progress(&self) -> ScanProgress {
        self.progress.lock_or_recover("usage scan progress").clone()
    }

    /// Whether a sweep has ever run to the end on this ledger.
    pub fn has_completed_once(&self) -> bool {
        self.progress().last_completed_at.is_some()
    }

    /// Run one sweep unless another is in flight. Returns whether it ran.
    /// Per-file failures are logged and skipped; only a database failure
    /// aborts the sweep.
    pub fn sweep(&self) -> ArgmaxResult<bool> {
        let Ok(_guard) = self.sweep_lock.try_lock() else {
            return Ok(false);
        };
        let result = self.sweep_locked();
        let mut progress = self.progress.lock_or_recover("usage scan progress");
        progress.scanning = false;
        if result.is_ok() {
            progress.last_completed_at = Some(now_iso());
        }
        result.map(|()| true)
    }

    fn sweep_locked(&self) -> ArgmaxResult<()> {
        self.ensure_parser_version()?;
        let now_ms = now_ms();
        let ledger_cutoff_ms = now_ms - RETENTION_DAYS * 24 * 60 * 60 * 1000;
        let walk_cutoff_ms = ledger_cutoff_ms - MTIME_SLACK_MS;

        let files = self.discover(walk_cutoff_ms);
        {
            let mut progress = self.progress.lock_or_recover("usage scan progress");
            progress.scanning = true;
            progress.files_total = files.len() as i64 + 1;
            progress.files_done = 0;
        }

        for file in &files {
            if let Err(error) = self.scan_file(file, now_ms) {
                tracing::warn!(
                    target: "usage",
                    path = %file.path.display(),
                    error = %error,
                    "usage scan skipped a transcript"
                );
            }
            self.progress
                .lock_or_recover("usage scan progress")
                .files_done += 1;
        }

        if let Err(error) = self.scan_opencode(now_ms, ledger_cutoff_ms) {
            tracing::warn!(target: "usage", error = %error, "usage scan skipped OpenCode");
        }
        self.progress
            .lock_or_recover("usage scan progress")
            .files_done += 1;

        let connection = self.database.connection();
        for provider in [ProviderId::Claude, ProviderId::Codex, ProviderId::Grok] {
            for path in usage_scan::list_scan_file_paths(&connection, provider_key(provider))? {
                if !Path::new(&path).exists() {
                    usage_scan::forget_file(&connection, &path)?;
                }
            }
        }
        usage_scan::prune_before(&connection, hour_start_secs(ledger_cutoff_ms))?;
        usage_scan::set_meta(&connection, usage_scan::META_LAST_COMPLETED_AT, &now_iso())?;
        Ok(())
    }

    fn ensure_parser_version(&self) -> ArgmaxResult<()> {
        let connection = self.database.connection();
        let stored = usage_scan::get_meta(&connection, usage_scan::META_PARSER_VERSION)?;
        if stored.as_deref() == Some(PARSER_VERSION) {
            return Ok(());
        }
        if stored.is_some() {
            tracing::info!(target: "usage", "parser version changed; rebuilding the usage ledger");
        }
        usage_scan::clear_all(&connection)?;
        usage_scan::set_meta(&connection, usage_scan::META_PARSER_VERSION, PARSER_VERSION)?;
        Ok(())
    }

    fn discover(&self, cutoff_ms: i64) -> Vec<SourceFile> {
        let mut files = Vec::new();
        // Claude: <projects>/<slug>/<session>.jsonl and
        // <projects>/<slug>/<session>/subagents/<agent>.jsonl.
        walk(
            &self.home.join(".claude").join("projects"),
            4,
            &mut |path, depth| {
                if path.extension().and_then(|ext| ext.to_str()) != Some("jsonl") {
                    return None;
                }
                match depth {
                    2 => Some((ProviderId::Claude, None)),
                    4 if path.parent().and_then(Path::file_name) == Some("subagents".as_ref()) => {
                        let session = path
                            .parent()
                            .and_then(Path::parent)
                            .and_then(Path::file_name)
                            .and_then(|name| name.to_str())
                            .map(str::to_owned);
                        Some((ProviderId::Claude, session))
                    }
                    _ => None,
                }
            },
            cutoff_ms,
            &mut files,
        );
        // Codex: <sessions>/<year>/<month>/<day>/rollout-*.jsonl, and the
        // flat <archived_sessions>/rollout-*.jsonl a user moves finished
        // threads into. Both are billed calls.
        for root in [
            self.home.join(".codex").join("sessions"),
            self.home.join(".codex").join("archived_sessions"),
        ] {
            walk(
                &root,
                4,
                &mut |path, _| {
                    (path.extension().and_then(|ext| ext.to_str()) == Some("jsonl"))
                        .then_some((ProviderId::Codex, None))
                },
                cutoff_ms,
                &mut files,
            );
        }
        // Grok Build: <sessions>/<encoded cwd>/<session>/updates.jsonl. The
        // sibling logs are large and carry no usage.
        walk(
            &self.home.join(".grok").join("sessions"),
            3,
            &mut |path, depth| {
                (depth == 3 && path.file_name() == Some("updates.jsonl".as_ref()))
                    .then_some((ProviderId::Grok, None))
            },
            cutoff_ms,
            &mut files,
        );
        files.sort_by_key(|file| file.mtime_ms);
        files
    }

    fn scan_file(&self, file: &SourceFile, now_ms: i64) -> ArgmaxResult<()> {
        let path_key = file.path.to_string_lossy().into_owned();
        let known = {
            let connection = self.database.connection();
            usage_scan::find_scan_file(&connection, &path_key)?
        };
        let (start_offset, full_reparse) = match &known {
            None => (0, false),
            Some(record) if record.size == file.size && record.mtime_ms == file.mtime_ms => {
                return Ok(());
            }
            Some(record)
                if file.size >= record.cursor_offset
                    && guard_matches(
                        &file.path,
                        record.cursor_offset,
                        record.guard_hash.as_deref(),
                    )? =>
            {
                (record.cursor_offset, false)
            }
            Some(_) => (0, true),
        };

        let settled = now_ms - file.mtime_ms > SETTLED_AFTER_MS;
        let (text, consumed) = read_complete_lines(&file.path, start_offset as u64, settled)?;
        let context = TranscriptContext {
            source_path: &file.path,
            session_id_hint: file.session_id_hint.as_deref(),
        };
        let records = match file.provider {
            ProviderId::Claude => claude::parse_claude_transcript(&text, &context),
            ProviderId::Codex => codex::parse_codex_rollout(&text, &context),
            ProviderId::Grok => grok::parse_grok_updates(&text, &context),
            ProviderId::Cursor | ProviderId::Opencode => Vec::new(),
        };
        let new_cursor = start_offset + consumed as i64;
        let session_id = records
            .first()
            .map(|record| record.session_id.clone())
            .or_else(|| known.as_ref().and_then(|record| record.session_id.clone()));
        let guard_hash = guard_hash_at(&file.path, new_cursor as u64)?;

        let connection = self.database.connection();
        let transaction = connection.unchecked_transaction().map_err(sqlite_error)?;
        if full_reparse {
            usage_scan::forget_file(&transaction, &path_key)?;
        }
        fold_records(&transaction, &path_key, records)?;
        usage_scan::upsert_scan_file(
            &transaction,
            &ScanFileRecord {
                path: path_key,
                provider: provider_key(file.provider).to_owned(),
                session_id,
                size: file.size,
                mtime_ms: file.mtime_ms,
                cursor_offset: new_cursor,
                guard_hash,
            },
        )?;
        transaction.commit().map_err(sqlite_error)
    }

    fn scan_opencode(&self, now_ms: i64, ledger_cutoff_ms: i64) -> ArgmaxResult<()> {
        let db_path = self
            .home
            .join(".local")
            .join("share")
            .join("opencode")
            .join("opencode.db");
        if !db_path.exists() {
            return Ok(());
        }
        let since_ms = {
            let connection = self.database.connection();
            usage_scan::get_meta(&connection, META_OPENCODE_SCANNED_AT_MS)?
                .and_then(|value| value.parse::<i64>().ok())
                .map(|scanned| (scanned - OPENCODE_REREAD_MS).max(ledger_cutoff_ms))
                .unwrap_or(ledger_cutoff_ms)
        };
        let records = opencode::read_opencode_messages(&db_path, since_ms)?;
        let path_key = db_path.to_string_lossy().into_owned();
        let connection = self.database.connection();
        let transaction = connection.unchecked_transaction().map_err(sqlite_error)?;
        fold_records(&transaction, &path_key, records)?;
        usage_scan::set_meta(
            &transaction,
            META_OPENCODE_SCANNED_AT_MS,
            &now_ms.to_string(),
        )?;
        transaction.commit().map_err(sqlite_error)
    }
}

/// Run a sweep on the blocking pool and log its failure. Used for the cold
/// first sweep and the boot refresh; the page's own requests run warm sweeps
/// inline.
pub fn spawn_sweep(scanner: &Arc<UsageScanner>) {
    let scanner = Arc::clone(scanner);
    tauri::async_runtime::spawn_blocking(move || match scanner.sweep() {
        Ok(_) => {}
        Err(error) => tracing::warn!(target: "usage", error = %error, "usage sweep failed"),
    });
}

/// Fold parsed records into hour buckets, claiming each billed call's key
/// first so a repeat in another file counts once. Records without a key are
/// counted as they come.
fn fold_records(
    connection: &Connection,
    source_path: &str,
    records: Vec<UsageRecord>,
) -> ArgmaxResult<()> {
    let mut deltas: HashMap<(ProviderId, String, String, i64), HourlyBucketDelta> = HashMap::new();
    for record in records {
        if record.tokens.is_empty() {
            continue;
        }
        let hour_utc = hour_start_secs(record.at_ms);
        if let Some(key) = record.dedupe_key.as_deref() {
            if !usage_scan::claim_dedupe_key(connection, key, source_path, hour_utc)? {
                continue;
            }
        }
        let model_id = normalize_model_id(&record.model_id);
        let delta = deltas
            .entry((
                record.provider,
                model_id.clone(),
                record.session_id.clone(),
                hour_utc,
            ))
            .or_insert_with(|| HourlyBucketDelta {
                provider: provider_key(record.provider).to_owned(),
                model_id,
                session_id: record.session_id.clone(),
                source_path: source_path.to_owned(),
                hour_utc,
                tokens: UsageRecordTokens::default(),
                reported_cost_usd: None,
                reported_records: 0,
                records: 0,
            });
        delta.tokens.input_uncached += record.tokens.input_uncached;
        delta.tokens.cache_read += record.tokens.cache_read;
        delta.tokens.cache_write_5m += record.tokens.cache_write_5m;
        delta.tokens.cache_write_1h += record.tokens.cache_write_1h;
        delta.tokens.output += record.tokens.output;
        delta.tokens.reasoning += record.tokens.reasoning;
        delta.records += 1;
        if let Some(cost) = record.reported_cost_usd {
            delta.reported_cost_usd = Some(delta.reported_cost_usd.unwrap_or(0.0) + cost);
            delta.reported_records += 1;
        }
    }
    let mut ordered: Vec<HourlyBucketDelta> = deltas.into_values().collect();
    ordered.sort_by(|a, b| {
        (a.hour_utc, &a.provider, &a.model_id, &a.session_id).cmp(&(
            b.hour_utc,
            &b.provider,
            &b.model_id,
            &b.session_id,
        ))
    });
    for delta in &ordered {
        usage_scan::add_hourly_bucket(connection, delta)?;
    }
    Ok(())
}

/// Depth-limited walk under `root`. `accept` sees each regular file and its
/// depth (1 = directly under `root`) and answers with the provider and an
/// optional session hint. Files older than `cutoff_ms` are left out.
fn walk(
    root: &Path,
    max_depth: usize,
    accept: Classify<'_>,
    cutoff_ms: i64,
    out: &mut Vec<SourceFile>,
) {
    fn visit(
        dir: &Path,
        depth: usize,
        max_depth: usize,
        accept: Classify<'_>,
        cutoff_ms: i64,
        out: &mut Vec<SourceFile>,
    ) {
        let Ok(entries) = fs::read_dir(dir) else {
            return;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let Ok(file_type) = entry.file_type() else {
                continue;
            };
            if file_type.is_dir() {
                if depth < max_depth {
                    visit(&path, depth + 1, max_depth, accept, cutoff_ms, out);
                }
                continue;
            }
            if !file_type.is_file() {
                continue;
            }
            let Some((provider, session_id_hint)) = accept(&path, depth) else {
                continue;
            };
            let Ok(metadata) = entry.metadata() else {
                continue;
            };
            let mtime_ms = modified_ms(&metadata);
            if mtime_ms < cutoff_ms {
                continue;
            }
            out.push(SourceFile {
                path,
                provider,
                session_id_hint,
                size: metadata.len() as i64,
                mtime_ms,
            });
        }
    }
    visit(root, 1, max_depth, accept, cutoff_ms, out);
}

/// Read from `offset` to the end. Unless the file has settled, the trailing
/// bytes after the last newline are left for the next sweep, since the
/// writer may still be mid-line. Returns the text and the bytes consumed.
fn read_complete_lines(path: &Path, offset: u64, settled: bool) -> ArgmaxResult<(String, usize)> {
    let mut file = fs::File::open(path).map_err(|error| io_error(path, error))?;
    file.seek(SeekFrom::Start(offset))
        .map_err(|error| io_error(path, error))?;
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes)
        .map_err(|error| io_error(path, error))?;
    let consumed = if settled {
        bytes.len()
    } else {
        bytes
            .iter()
            .rposition(|byte| *byte == b'\n')
            .map(|index| index + 1)
            .unwrap_or(0)
    };
    let text = String::from_utf8_lossy(&bytes[..consumed]).into_owned();
    Ok((text, consumed))
}

/// Digest of the bytes just before `offset`, `None` at the start of a file.
fn guard_hash_at(path: &Path, offset: u64) -> ArgmaxResult<Option<String>> {
    if offset == 0 {
        return Ok(None);
    }
    let span = offset.min(GUARD_BYTES);
    let mut file = fs::File::open(path).map_err(|error| io_error(path, error))?;
    file.seek(SeekFrom::Start(offset - span))
        .map_err(|error| io_error(path, error))?;
    let mut bytes = vec![0u8; span as usize];
    file.read_exact(&mut bytes)
        .map_err(|error| io_error(path, error))?;
    let digest = Sha256::digest(&bytes);
    Ok(Some(
        digest.iter().map(|byte| format!("{byte:02x}")).collect(),
    ))
}

fn guard_matches(path: &Path, cursor_offset: i64, expected: Option<&str>) -> ArgmaxResult<bool> {
    if cursor_offset <= 0 {
        return Ok(true);
    }
    let Some(expected) = expected else {
        return Ok(false);
    };
    Ok(guard_hash_at(path, cursor_offset as u64)?.as_deref() == Some(expected))
}

pub fn provider_key(provider: ProviderId) -> &'static str {
    match provider {
        ProviderId::Claude => "claude",
        ProviderId::Codex => "codex",
        ProviderId::Cursor => "cursor",
        ProviderId::Opencode => "opencode",
        ProviderId::Grok => "grok",
    }
}

pub fn provider_from_key(key: &str) -> Option<ProviderId> {
    match key {
        "claude" => Some(ProviderId::Claude),
        "codex" => Some(ProviderId::Codex),
        "cursor" => Some(ProviderId::Cursor),
        "opencode" => Some(ProviderId::Opencode),
        "grok" => Some(ProviderId::Grok),
        _ => None,
    }
}

/// Unix seconds at the start of the UTC hour containing `at_ms`.
pub fn hour_start_secs(at_ms: i64) -> i64 {
    at_ms.div_euclid(3_600_000) * 3600
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|since| since.as_millis() as i64)
        .unwrap_or(0)
}

fn modified_ms(metadata: &fs::Metadata) -> i64 {
    metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|since| since.as_millis() as i64)
        .unwrap_or(0)
}

fn io_error(path: &Path, error: std::io::Error) -> ArgmaxError {
    ArgmaxError::service("USAGE_SCAN_IO", format!("{}: {error}", path.display()))
}

fn sqlite_error(error: rusqlite::Error) -> ArgmaxError {
    ArgmaxError::service("SQLITE", error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::{Duration, SecondsFormat, Utc};
    use std::io::Write;

    fn claude_line(message_id: &str, at: chrono::DateTime<Utc>, input: i64) -> String {
        format!(
            concat!(
                r#"{{"type":"assistant","uuid":"u-{id}","requestId":"req-{id}","sessionId":"sess1","#,
                r#""timestamp":"{ts}","cwd":"/tmp/proj","message":{{"id":"{id}","model":"claude-opus-5","#,
                r#""role":"assistant","content":[{{"type":"text","text":"hi"}}],"usage":{{"input_tokens":{input},"#,
                r#""cache_creation_input_tokens":0,"cache_read_input_tokens":0,"output_tokens":10}}}}}}"#,
                "\n"
            ),
            id = message_id,
            ts = at.to_rfc3339_opts(SecondsFormat::Millis, true),
            input = input,
        )
    }

    fn scanner_in(home: &Path) -> UsageScanner {
        let database = Arc::new(Database::open_in_memory().expect("db"));
        UsageScanner::new(database, home.to_path_buf())
    }

    fn ledger(scanner: &UsageScanner) -> Vec<usage_scan::HourlyBucket> {
        let connection = scanner.database.connection();
        usage_scan::list_hourly_between(&connection, 0, i64::MAX).unwrap()
    }

    fn set_mtime(path: &Path, at: SystemTime) {
        fs::File::options()
            .write(true)
            .open(path)
            .unwrap()
            .set_modified(at)
            .unwrap();
    }

    #[test]
    fn sweep_folds_a_transcript_then_reads_only_what_grew() {
        let home = tempfile::tempdir().unwrap();
        let project = home.path().join(".claude").join("projects").join("proj");
        fs::create_dir_all(&project).unwrap();
        let transcript = project.join("sess1.jsonl");
        let now = Utc::now();
        let mut file = fs::File::create(&transcript).unwrap();
        file.write_all(claude_line("m1", now - Duration::minutes(30), 100).as_bytes())
            .unwrap();
        file.write_all(claude_line("m2", now - Duration::minutes(20), 100).as_bytes())
            .unwrap();
        drop(file);
        let settled = SystemTime::now() - std::time::Duration::from_secs(600);
        set_mtime(&transcript, settled);

        let scanner = scanner_in(home.path());
        assert!(!scanner.has_completed_once());
        assert!(scanner.sweep().unwrap());
        assert!(scanner.has_completed_once());
        let rows = ledger(&scanner);
        assert_eq!(rows.iter().map(|row| row.records).sum::<i64>(), 2);
        assert_eq!(
            rows.iter()
                .map(|row| row.tokens.input_uncached)
                .sum::<i64>(),
            200
        );
        assert_eq!(rows[0].provider, "claude");
        assert_eq!(rows[0].session_id, "sess1");

        // Unchanged: nothing re-read, cursor stays at the end.
        let path_key = transcript.to_string_lossy().into_owned();
        let cursor_before = {
            let connection = scanner.database.connection();
            usage_scan::find_scan_file(&connection, &path_key)
                .unwrap()
                .unwrap()
        };
        assert_eq!(
            cursor_before.cursor_offset as u64,
            fs::metadata(&transcript).unwrap().len()
        );
        assert!(scanner.sweep().unwrap());
        assert_eq!(
            ledger(&scanner).iter().map(|row| row.records).sum::<i64>(),
            2
        );

        // Grown: only the tail is parsed, and the cursor moves to the new end.
        let mut file = fs::File::options().append(true).open(&transcript).unwrap();
        file.write_all(claude_line("m3", now - Duration::minutes(10), 100).as_bytes())
            .unwrap();
        drop(file);
        set_mtime(&transcript, settled + std::time::Duration::from_secs(1));
        assert!(scanner.sweep().unwrap());
        assert_eq!(
            ledger(&scanner).iter().map(|row| row.records).sum::<i64>(),
            3
        );
        let cursor_after = {
            let connection = scanner.database.connection();
            usage_scan::find_scan_file(&connection, &path_key)
                .unwrap()
                .unwrap()
        };
        assert!(cursor_after.cursor_offset > cursor_before.cursor_offset);
        assert_eq!(
            cursor_after.cursor_offset as u64,
            fs::metadata(&transcript).unwrap().len()
        );

        // Rewritten with one line: the old rows go, the file is parsed again.
        fs::write(
            &transcript,
            claude_line("m1", now - Duration::minutes(30), 100),
        )
        .unwrap();
        set_mtime(&transcript, settled + std::time::Duration::from_secs(2));
        assert!(scanner.sweep().unwrap());
        assert_eq!(
            ledger(&scanner).iter().map(|row| row.records).sum::<i64>(),
            1
        );

        // Deleted: forgotten.
        fs::remove_file(&transcript).unwrap();
        assert!(scanner.sweep().unwrap());
        assert!(ledger(&scanner).is_empty());
    }

    #[test]
    fn a_live_file_keeps_its_partial_last_line_for_the_next_sweep() {
        let home = tempfile::tempdir().unwrap();
        let project = home.path().join(".claude").join("projects").join("proj");
        fs::create_dir_all(&project).unwrap();
        let transcript = project.join("sess1.jsonl");
        let now = Utc::now();
        let complete = claude_line("m1", now - Duration::minutes(5), 100);
        let mut partial = claude_line("m2", now - Duration::minutes(4), 100);
        partial.pop();
        fs::write(&transcript, format!("{complete}{partial}")).unwrap();

        let scanner = scanner_in(home.path());
        assert!(scanner.sweep().unwrap());
        assert_eq!(
            ledger(&scanner).iter().map(|row| row.records).sum::<i64>(),
            1
        );

        // Once the file settles the trailing line counts.
        set_mtime(
            &transcript,
            SystemTime::now() - std::time::Duration::from_secs(600),
        );
        assert!(scanner.sweep().unwrap());
        assert_eq!(
            ledger(&scanner).iter().map(|row| row.records).sum::<i64>(),
            2
        );
    }

    #[test]
    fn the_same_billed_call_in_two_files_counts_once() {
        let home = tempfile::tempdir().unwrap();
        let project = home.path().join(".claude").join("projects").join("proj");
        fs::create_dir_all(&project).unwrap();
        let now = Utc::now();
        let line = claude_line("m1", now - Duration::minutes(30), 100);
        fs::write(project.join("sess1.jsonl"), &line).unwrap();
        fs::write(project.join("sess1-resumed.jsonl"), &line).unwrap();
        let settled = SystemTime::now() - std::time::Duration::from_secs(600);
        set_mtime(&project.join("sess1.jsonl"), settled);
        set_mtime(&project.join("sess1-resumed.jsonl"), settled);

        let scanner = scanner_in(home.path());
        assert!(scanner.sweep().unwrap());
        assert_eq!(
            ledger(&scanner).iter().map(|row| row.records).sum::<i64>(),
            1
        );
    }

    #[test]
    fn a_parser_version_change_rebuilds_the_ledger() {
        let home = tempfile::tempdir().unwrap();
        let scanner = scanner_in(home.path());
        {
            let connection = scanner.database.connection();
            usage_scan::set_meta(&connection, usage_scan::META_PARSER_VERSION, "0").unwrap();
            usage_scan::add_hourly_bucket(
                &connection,
                &HourlyBucketDelta {
                    provider: "claude".into(),
                    model_id: "claude-opus-5".into(),
                    session_id: "stale".into(),
                    source_path: "gone".into(),
                    hour_utc: hour_start_secs(Utc::now().timestamp_millis()),
                    tokens: UsageRecordTokens {
                        input_uncached: 1,
                        ..Default::default()
                    },
                    reported_cost_usd: None,
                    reported_records: 0,
                    records: 1,
                },
            )
            .unwrap();
        }
        assert!(scanner.sweep().unwrap());
        assert!(ledger(&scanner).is_empty());
        let connection = scanner.database.connection();
        assert_eq!(
            usage_scan::get_meta(&connection, usage_scan::META_PARSER_VERSION)
                .unwrap()
                .as_deref(),
            Some(PARSER_VERSION)
        );
    }
}
