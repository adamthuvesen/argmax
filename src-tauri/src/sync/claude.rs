//! Reads Claude Code's own transcript store: `~/.claude/projects/<slug>/<sessionId>.jsonl`,
//! one JSONL line per timeline entry.
//!
//! The directory slug is a lossy encoding of the cwd (`/`, `.`, and spaces
//! all become `-`), so it is never decoded back into a path. Discovery stats
//! every transcript, keeps the ones modified inside the sync window, and
//! reads the real `cwd` out of the file's own lines.
//!
//! The line shapes (`{"type":"user","message":{…}}`, `{"type":"assistant",…}`)
//! are the same ones the CLI writes to stdout under
//! `--output-format stream-json`, so the existing Claude normalizer turns
//! them into timeline events unchanged. This module decides which lines the
//! sweep offers it — what a line then means is the normalizer's call, in
//! transcript-replay mode.

use std::path::{Path, PathBuf};

use serde_json::Value;

use super::DiscoveredSession;
use crate::providers::normalizer::claude::{transcript_user_row, TranscriptUserRow};

/// Cheap prefix read for metadata: enough lines to find `cwd` and the first
/// prompt without parsing a 12MB transcript.
const METADATA_LINE_BUDGET: usize = 200;
/// Transcript lines are one JSON object each; anything larger than this is
/// not a line Argmax can use and is skipped rather than buffered.
const MAX_LINE_BYTES: usize = 4 * 1024 * 1024;

pub fn transcript_root(home: &Path) -> PathBuf {
    home.join(".claude").join("projects")
}

/// Every transcript modified at or after `cutoff_ms`, paired with the
/// metadata needed to decide whether to import it.
pub fn discover(home: &Path, cutoff_ms: i64) -> Vec<DiscoveredSession> {
    let root = transcript_root(home);
    let Ok(entries) = std::fs::read_dir(&root) else {
        return Vec::new();
    };
    let mut discovered = Vec::new();
    for project_dir in entries.flatten() {
        if !project_dir.file_type().is_ok_and(|kind| kind.is_dir()) {
            continue;
        }
        let Ok(files) = std::fs::read_dir(project_dir.path()) else {
            continue;
        };
        for file in files.flatten() {
            let path = file.path();
            if path.extension().and_then(|ext| ext.to_str()) != Some("jsonl") {
                continue;
            }
            let Ok(metadata) = file.metadata() else {
                continue;
            };
            let mtime_ms = modified_ms(&metadata);
            if mtime_ms < cutoff_ms {
                continue;
            }
            if let Some(session) = read_metadata(&path, mtime_ms) {
                discovered.push(session);
            }
        }
    }
    discovered
}

fn modified_ms(metadata: &std::fs::Metadata) -> i64 {
    metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|since| since.as_millis() as i64)
        .unwrap_or(0)
}

/// Pull session metadata from the head of a transcript. Returns None when the
/// file carries no usable session (no cwd, no timestamps, or unreadable).
fn read_metadata(path: &Path, mtime_ms: i64) -> Option<DiscoveredSession> {
    let external_id = path.file_stem()?.to_str()?.to_string();
    if external_id.is_empty() {
        return None;
    }
    let body = read_head(path, METADATA_LINE_BUDGET)?;

    let mut cwd: Option<String> = None;
    let mut started_at: Option<String> = None;
    let mut last_activity_at: Option<String> = None;
    let mut custom_title: Option<String> = None;
    let mut first_prompt: Option<String> = None;
    let mut model_id: Option<String> = None;

    for line in body.lines() {
        let Ok(value) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        if cwd.is_none() {
            cwd = value.get("cwd").and_then(Value::as_str).map(str::to_string);
        }
        if let Some(timestamp) = value.get("timestamp").and_then(Value::as_str) {
            if started_at.is_none() {
                started_at = Some(timestamp.to_string());
            }
            last_activity_at = Some(timestamp.to_string());
        }
        match value.get("type").and_then(Value::as_str) {
            Some("custom-title") => {
                custom_title = value
                    .get("customTitle")
                    .and_then(Value::as_str)
                    .filter(|title| !title.trim().is_empty())
                    .map(str::to_string);
            }
            // The title comes from the first thing a human typed, read with
            // the same predicate the replay uses, so a skill body or one of
            // the CLI's own notes never titles a session.
            Some("user") if first_prompt.is_none() && !is_sidechain(&value) => {
                if let Some(TranscriptUserRow::Prompt(text)) =
                    value.as_object().map(transcript_user_row)
                {
                    first_prompt = Some(text);
                }
            }
            Some("assistant") if model_id.is_none() => {
                model_id = value
                    .get("message")
                    .and_then(|message| message.get("model"))
                    .and_then(Value::as_str)
                    .map(str::to_string);
            }
            _ => {}
        }
    }

    let cwd = cwd?;
    let started_at = started_at?;
    // The head budget may stop short of the real last line; the file's mtime
    // is the better "when did this session last do something" signal.
    let last_activity_at = iso_from_ms(mtime_ms).or(last_activity_at)?;
    let prompt = custom_title
        .or_else(|| first_prompt.as_deref().and_then(title_from_prompt))
        .unwrap_or_else(|| "Imported session".to_string());

    Some(DiscoveredSession {
        external_id,
        cwd: PathBuf::from(cwd),
        source_path: path.to_path_buf(),
        source_mtime_ms: mtime_ms,
        started_at,
        last_activity_at,
        prompt: truncate_prompt(&prompt),
        model_id,
    })
}

/// One transcript row for the normalizer: the line index it came from (the
/// sweep's cursor), its raw JSON, and the row's own timestamp.
#[derive(Debug, Clone, PartialEq)]
pub struct TimelineLine {
    pub index: usize,
    pub raw: String,
    pub timestamp: Option<String>,
}

/// Transcript lines the normalizer should read, in order, starting at
/// `from_line`. Only lines this reader cannot hand over are dropped: what is
/// not a JSON object, what is too large to parse, and sidechain (subagent)
/// chatter, which belongs to a child agent rather than this conversation.
/// Whether a line means anything on the timeline is the normalizer's call.
///
/// Read line by line rather than whole: a long-running session's transcript
/// runs to tens of megabytes and every sweep re-reads it from `from_line`.
pub fn timeline_lines(path: &Path, from_line: usize) -> Vec<TimelineLine> {
    use std::io::{BufRead, BufReader};
    let Ok(file) = std::fs::File::open(path) else {
        return Vec::new();
    };
    let mut lines = Vec::new();
    for (index, line) in BufReader::new(file)
        .lines()
        .map_while(Result::ok)
        .enumerate()
    {
        if index < from_line || line.is_empty() || line.len() > MAX_LINE_BYTES {
            continue;
        }
        let Ok(value) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        if !value.is_object() || is_sidechain(&value) {
            continue;
        }
        lines.push(TimelineLine {
            index,
            raw: line,
            timestamp: value
                .get("timestamp")
                .and_then(Value::as_str)
                .map(str::to_string),
        });
    }
    lines
}

fn is_sidechain(value: &Value) -> bool {
    value
        .get("isSidechain")
        .and_then(Value::as_bool)
        .unwrap_or(false)
}

/// A session's title from its first user message. The raw text is often not
/// the thing the human typed: a slash-command launch records an XML wrapper,
/// and Argmax prepends its own launch instruction to the prompt it sends.
/// Both are exactly identifiable, so strip them instead of titling a session
/// with protocol scaffolding. Anything else is left alone — a long first
/// prompt is indistinguishable from a preamble, and guessing would be worse.
fn title_from_prompt(raw: &str) -> Option<String> {
    let text = raw.trim();

    // `<command-message>foo</command-message>\n<command-name>/foo</command-name>`
    // (plus an optional `<command-args>`) is what a `/slash` launch writes.
    if let Some(name) = tag_text(text, "command-name") {
        let args = tag_text(text, "command-args").unwrap_or_default();
        let title = if args.is_empty() {
            name
        } else {
            format!("{name} {args}")
        };
        return non_empty(&title);
    }

    non_empty(crate::providers::mcp_injection::strip_instruction(text))
}

/// Contents of the first `<tag>…</tag>` pair, trimmed. Not a parser: these are
/// fixed single-line markers the CLI writes, never nested or attributed.
fn tag_text(text: &str, tag: &str) -> Option<String> {
    let open = format!("<{tag}>");
    let close = format!("</{tag}>");
    let start = text.find(&open)? + open.len();
    let end = text[start..].find(&close)? + start;
    Some(text[start..end].trim().to_string())
}

fn non_empty(text: &str) -> Option<String> {
    let trimmed = text.trim();
    (!trimmed.is_empty()).then(|| trimmed.to_string())
}

fn truncate_prompt(prompt: &str) -> String {
    const MAX_CHARS: usize = 200;
    let collapsed = prompt.split_whitespace().collect::<Vec<_>>().join(" ");
    if collapsed.chars().count() <= MAX_CHARS {
        return collapsed;
    }
    collapsed.chars().take(MAX_CHARS).collect::<String>() + "…"
}

/// Read at most `max_lines` lines without pulling a multi-megabyte transcript
/// into memory.
fn read_head(path: &Path, max_lines: usize) -> Option<String> {
    use std::io::{BufRead, BufReader};
    let file = std::fs::File::open(path).ok()?;
    let mut reader = BufReader::new(file);
    let mut head = String::new();
    let mut line = String::new();
    for _ in 0..max_lines {
        line.clear();
        match reader.read_line(&mut line) {
            Ok(0) => break,
            Ok(_) => {
                if line.len() <= MAX_LINE_BYTES {
                    head.push_str(&line);
                }
            }
            Err(_) => break,
        }
    }
    Some(head)
}

fn iso_from_ms(ms: i64) -> Option<String> {
    chrono::DateTime::from_timestamp_millis(ms)
        .map(|time| time.to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_slash_command_launch_is_titled_with_the_command() {
        let raw = "<command-message>brain-sync</command-message>\n\
                   <command-name>/brain-sync</command-name>";

        assert_eq!(title_from_prompt(raw).as_deref(), Some("/brain-sync"));
    }

    #[test]
    fn a_slash_command_keeps_its_arguments() {
        let raw = "<command-message>review</command-message>\n\
                   <command-name>/review</command-name>\n\
                   <command-args>the auth module</command-args>";

        assert_eq!(
            title_from_prompt(raw).as_deref(),
            Some("/review the auth module")
        );
    }

    #[test]
    fn argmax_own_launch_preamble_does_not_become_the_title() {
        let raw = format!(
            "{}\n\nGood morning! Status check.",
            crate::providers::mcp_injection::LEGACY_SHELL_COMMAND_INSTRUCTION
        );

        assert_eq!(
            title_from_prompt(&raw).as_deref(),
            Some("Good morning! Status check.")
        );
    }

    #[test]
    fn an_ordinary_prompt_is_left_alone() {
        let raw = "fix the failing test in <auth>, it broke after the rename";

        assert_eq!(title_from_prompt(raw).as_deref(), Some(raw));
    }

    fn write_transcript(home: &Path, slug: &str, id: &str, lines: &[&str]) -> PathBuf {
        let dir = transcript_root(home).join(slug);
        std::fs::create_dir_all(&dir).expect("create transcript dir");
        let path = dir.join(format!("{id}.jsonl"));
        std::fs::write(&path, lines.join("\n")).expect("write transcript");
        path
    }

    const USER_LINE: &str = r#"{"type":"user","isSidechain":false,"cwd":"/repo/app","timestamp":"2026-08-30T10:00:00.000Z","sessionId":"sess-1","message":{"role":"user","content":"Fix the flaky test"}}"#;
    const ASSISTANT_LINE: &str = r#"{"type":"assistant","isSidechain":false,"cwd":"/repo/app","timestamp":"2026-08-30T10:00:05.000Z","sessionId":"sess-1","message":{"role":"assistant","model":"claude-opus-5","content":[{"type":"text","text":"On it."}]}}"#;
    const SIDECHAIN_LINE: &str = r#"{"type":"assistant","isSidechain":true,"cwd":"/repo/app","timestamp":"2026-08-30T10:00:06.000Z","sessionId":"sess-1","message":{"role":"assistant","model":"claude-opus-5","content":[{"type":"text","text":"subagent chatter"}]}}"#;

    #[test]
    fn discovers_transcripts_inside_the_window_with_their_real_cwd() {
        let home = tempfile::tempdir().expect("tempdir");
        write_transcript(
            home.path(),
            "-repo-app",
            "sess-1",
            &[
                r#"{"type":"bridge-session","sessionId":"sess-1"}"#,
                USER_LINE,
                ASSISTANT_LINE,
            ],
        );

        let found = discover(home.path(), 0);
        assert_eq!(found.len(), 1);
        let session = &found[0];
        assert_eq!(session.external_id, "sess-1");
        // The cwd comes from the file, never from the lossy directory slug.
        assert_eq!(session.cwd, PathBuf::from("/repo/app"));
        assert_eq!(session.started_at, "2026-08-30T10:00:00.000Z");
        assert_eq!(session.prompt, "Fix the flaky test");
        assert_eq!(session.model_id.as_deref(), Some("claude-opus-5"));
    }

    #[test]
    fn a_custom_title_wins_over_the_opening_prompt() {
        let home = tempfile::tempdir().expect("tempdir");
        write_transcript(
            home.path(),
            "-repo-app",
            "sess-1",
            &[
                USER_LINE,
                r#"{"type":"custom-title","customTitle":"Flaky test hunt","sessionId":"sess-1"}"#,
            ],
        );
        assert_eq!(discover(home.path(), 0)[0].prompt, "Flaky test hunt");
    }

    #[test]
    fn transcripts_older_than_the_cutoff_are_skipped() {
        let home = tempfile::tempdir().expect("tempdir");
        write_transcript(home.path(), "-repo-app", "sess-1", &[USER_LINE]);
        // A cutoff far in the future excludes everything on disk.
        let future_ms = i64::MAX / 2;
        assert!(discover(home.path(), future_ms).is_empty());
    }

    #[test]
    fn files_without_a_cwd_are_not_sessions() {
        let home = tempfile::tempdir().expect("tempdir");
        write_transcript(
            home.path(),
            "-repo-app",
            "sess-1",
            &[r#"{"type":"bridge-session","sessionId":"sess-1"}"#],
        );
        assert!(discover(home.path(), 0).is_empty());
    }

    #[test]
    fn timeline_lines_hand_over_every_row_but_sidechains() {
        let home = tempfile::tempdir().expect("tempdir");
        let path = write_transcript(
            home.path(),
            "-repo-app",
            "sess-1",
            &[
                r#"{"type":"bridge-session","sessionId":"sess-1"}"#,
                USER_LINE,
                SIDECHAIN_LINE,
                ASSISTANT_LINE,
            ],
        );

        // What a row means is the normalizer's call, so the reader keeps the
        // CLI's own bookkeeping rows too — only the subagent's is dropped.
        let lines = timeline_lines(&path, 0);
        assert_eq!(lines.len(), 3);
        // Line indexes are absolute, so a resumed read picks up where it left off.
        assert_eq!(
            lines.iter().map(|line| line.index).collect::<Vec<_>>(),
            vec![0, 1, 3]
        );
        assert!(lines
            .iter()
            .all(|line| !line.raw.contains("subagent chatter")));
        // The row's own timestamp rides along; the file mtime is one instant
        // for the whole batch.
        assert_eq!(
            lines[1].timestamp.as_deref(),
            Some("2026-08-30T10:00:00.000Z")
        );

        // Resuming past the first rows yields only the later one.
        let resumed = timeline_lines(&path, 2);
        assert_eq!(resumed.len(), 1);
        assert_eq!(resumed[0].index, 3);
    }

    #[test]
    fn the_title_skips_the_clis_own_notes_for_the_first_typed_prompt() {
        let home = tempfile::tempdir().expect("tempdir");
        let meta = r#"{"type":"user","isSidechain":false,"isMeta":true,"cwd":"/repo/app","timestamp":"2026-08-30T09:59:00.000Z","message":{"role":"user","content":"Caveat: the messages below were generated while running local commands."}}"#;
        write_transcript(home.path(), "-repo-app", "sess-1", &[meta, USER_LINE]);

        assert_eq!(discover(home.path(), 0)[0].prompt, "Fix the flaky test");
    }

    #[test]
    fn malformed_lines_do_not_sink_the_file() {
        let home = tempfile::tempdir().expect("tempdir");
        let path = write_transcript(
            home.path(),
            "-repo-app",
            "sess-1",
            &["{ not json at all", USER_LINE, "", ASSISTANT_LINE],
        );
        assert_eq!(timeline_lines(&path, 0).len(), 2);
        assert_eq!(discover(home.path(), 0).len(), 1);
    }
}
