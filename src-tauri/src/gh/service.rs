// GhService shells out to `gh pr view`
// against a session's workspace and persists the result so the renderer can
// render PR status without re-running `gh` on every read.

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, LazyLock, Mutex};

use rusqlite::OptionalExtension;
use serde_json::Value;

use crate::error::{ArgmaxError, ArgmaxResult};
use crate::git::ops::{extract_github_remote_from_url, extract_pr_number, extract_pr_url};
use crate::persistence::database::Database;
use crate::persistence::gh::{
    list_gh_pr_for_session, list_refreshable_pr_numbers_for_session, pr_branch_for_session,
    record_gh_pr_observation, record_pr_refresh_error, record_session_pr_evidence,
    store_gh_pr_observation, store_pr_metadata, GhPrRecord, PrAttribution,
    SESSION_PR_EVIDENCE_PARSER_VERSION,
};
use crate::persistence::projects::{get_project_remote, ProjectRemote};
use crate::persistence::sessions::find_session_by_id;
use crate::persistence::time::now_iso;
use crate::persistence::workspaces::find_workspace_by_id;
use crate::util::gh_runner::{default_gh_runner, GhRunner};

const PR_VIEW_JSON_FIELDS: &str =
    "number,title,headRefOid,headRefName,state,statusCheckRollup,createdAt,mergedAt,url";
/// Bound on extra `gh pr view <number>` calls per refresh, after the branch
/// view. A session that accumulated many OPEN rows still finishes a tick.
const MAX_OPEN_PR_NUMBER_VIEWS: usize = 8;
/// PR URLs sit at the end of `gh pr create` stdout. Scanning a huge tool
/// payload for one would be wasted work.
const COMMAND_EVENT_SCAN_TAIL: usize = 8 * 1024;

static PROJECT_REFRESH_LOCKS: LazyLock<Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

fn refresh_lock(key: String) -> Arc<tokio::sync::Mutex<()>> {
    let mut locks = PROJECT_REFRESH_LOCKS
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    Arc::clone(
        locks
            .entry(key)
            .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(()))),
    )
}

/// `GhService` keeps the renderer's PR rows fresh. Cheap reads (`list_for_session`)
/// hit SQLite; `refresh` calls out to `gh` and upserts.
pub struct GhService {
    database: Arc<Database>,
    runner: GhRunner,
}

impl GhService {
    pub fn new(database: Arc<Database>) -> Arc<Self> {
        Arc::new(Self {
            database,
            runner: default_gh_runner(),
        })
    }

    pub fn with_runner(database: Arc<Database>, runner: GhRunner) -> Arc<Self> {
        Arc::new(Self { database, runner })
    }

    /// Returns the cached `gh_pr` rows for a session. Cheap — single
    /// read-only DB hit.
    pub fn list_for_session(&self, session_id: &str) -> ArgmaxResult<Vec<GhPrRecord>> {
        let conn = self.database.read_connection();
        list_gh_pr_for_session(&conn, session_id)
    }

    /// Runs `gh pr view --json …` against the session's workspace and upserts
    /// the result. On `gh` failure (no PR / auth / transport) returns the
    /// existing cached rows — historical rows are never deleted because the
    /// timeline still wants to render them.
    ///
    /// After the branch view, re-views this session's already-cached OPEN rows
    /// by number. `gh pr view <branch>` cannot see a PR whose head the
    /// checkout has left, so without the number pass those rows stay OPEN
    /// forever and a PR the agent opened on another branch is never refreshed.
    pub async fn refresh(&self, session_id: &str) -> ArgmaxResult<Vec<GhPrRecord>> {
        let (workspace_project_id, workspace_path, branch, cached_numbers) = {
            let conn = self.database.connection();
            let session = find_session_by_id(&conn, session_id)?;
            let workspace = find_workspace_by_id(&conn, &session.workspace_id)?;
            // CLOSED is refreshable because GitHub permits reopening it.
            // Ordering by the last attempt keeps this bounded pass fair even
            // when a session has accumulated more associations than one tick
            // can view.
            let cached_numbers = list_refreshable_pr_numbers_for_session(&conn, session_id)?;
            let branch = pr_branch_for_session(&conn, session_id)?;
            (workspace.project_id, workspace.path, branch, cached_numbers)
        };
        if workspace_path.is_empty() {
            // A persisted workspace always has a path; an empty one signals
            // data corruption. Surface it rather than silently no-op'ing.
            tracing::warn!(%session_id, "gh.refresh: workspace path is empty; returning cached PR rows");
            return self.list_for_session(session_id);
        }

        let mut mentioned_numbers = {
            let conn = self.database.connection();
            scan_session_pr_evidence(&conn, session_id, &workspace_project_id)?
        };

        let mut viewed = HashSet::new();
        // A shared checkout's live branch can change after the session ends.
        // Persistence only returns a branch captured while it was trustworthy
        // for this session.
        if let Some(branch) = branch {
            let lock = refresh_lock(format!("{workspace_project_id}:branch:{branch}"));
            let _guard = lock.lock().await;
            let request_started_at = now_iso();
            if let Ok(Some(parsed)) = self
                .view_pr(&workspace_path, Some(branch.as_str()), session_id)
                .await
            {
                if let Some(pr_number) = parsed.number {
                    viewed.insert(pr_number);
                    let pr_lock = refresh_lock(format!("{workspace_project_id}:pr:{pr_number}"));
                    let _pr_guard = pr_lock.lock().await;
                    let stale = {
                        let conn = self.database.read_connection();
                        canonical_successfully_refreshed_after(
                            &conn,
                            &workspace_project_id,
                            pr_number,
                            &request_started_at,
                        )?
                    };
                    if !stale {
                        self.record_view(session_id, &workspace_project_id, parsed, true)?;
                    }
                } else {
                    self.record_view(session_id, &workspace_project_id, parsed, true)?;
                }
            }
        }

        // The first successful view may have supplied a project remote. Scan
        // again before number refreshes so a first-ever PR URL is not skipped.
        {
            let conn = self.database.connection();
            for number in scan_session_pr_evidence(&conn, session_id, &workspace_project_id)? {
                if !mentioned_numbers.contains(&number) {
                    mentioned_numbers.push(number);
                }
            }
        }

        // Fresh evidence gets one immediate chance. The canonical attempt
        // timestamp then moves it into the same oldest-first rotation as all
        // cached associations. Deduplicate before applying the per-tick cap so
        // the branch view or repeated evidence cannot consume a slot.
        let mut scheduled = viewed.clone();
        let mut refresh_numbers = Vec::new();
        for pr_number in mentioned_numbers.into_iter().chain(cached_numbers) {
            if scheduled.insert(pr_number) {
                refresh_numbers.push(pr_number);
            }
        }

        for pr_number in refresh_numbers.into_iter().take(MAX_OPEN_PR_NUMBER_VIEWS) {
            let request_started_at = now_iso();
            let lock = refresh_lock(format!("{workspace_project_id}:pr:{pr_number}"));
            let _guard = lock.lock().await;
            let already_refreshed = {
                let conn = self.database.read_connection();
                canonical_successfully_refreshed_after(
                    &conn,
                    &workspace_project_id,
                    pr_number,
                    &request_started_at,
                )?
            };
            if already_refreshed {
                continue;
            }
            match self
                .view_pr(&workspace_path, Some(&pr_number.to_string()), session_id)
                .await
            {
                Ok(Some(parsed)) => {
                    self.record_view(session_id, &workspace_project_id, parsed, false)?;
                }
                Ok(None) => {
                    let conn = self.database.connection();
                    record_pr_refresh_error(
                        &conn,
                        session_id,
                        pr_number,
                        "pull request is unavailable",
                    )?;
                }
                Err(error) => {
                    let conn = self.database.connection();
                    record_pr_refresh_error(&conn, session_id, pr_number, &error)?;
                }
            }
        }

        self.list_for_session(session_id)
    }

    /// `gh pr view <number>` against the session's workspace. The number is
    /// enough — `gh` talks to the GitHub remote, so this finds a PR opened
    /// from another worktree of the same repo.
    pub async fn refresh_pr_number(
        &self,
        session_id: &str,
        pr_number: i64,
    ) -> ArgmaxResult<Vec<GhPrRecord>> {
        let (workspace_project_id, workspace_path) = {
            let conn = self.database.connection();
            let session = find_session_by_id(&conn, session_id)?;
            let workspace = find_workspace_by_id(&conn, &session.workspace_id)?;
            (workspace.project_id, workspace.path)
        };
        if workspace_path.is_empty() {
            tracing::warn!(%session_id, "gh.refresh_pr_number: workspace path is empty; returning cached PR rows");
            return self.list_for_session(session_id);
        }
        let request_started_at = now_iso();
        let refresh_lock = refresh_lock(format!("{workspace_project_id}:pr:{pr_number}"));
        let _refresh_guard = refresh_lock.lock().await;
        let already_refreshed = {
            let conn = self.database.read_connection();
            canonical_successfully_refreshed_after(
                &conn,
                &workspace_project_id,
                pr_number,
                &request_started_at,
            )?
        };
        if already_refreshed {
            return self.list_for_session(session_id);
        }
        match self
            .view_pr(&workspace_path, Some(&pr_number.to_string()), session_id)
            .await
        {
            Ok(Some(parsed)) => {
                self.record_view(session_id, &workspace_project_id, parsed, false)?;
            }
            Ok(None) => {
                let conn = self.database.connection();
                record_pr_refresh_error(
                    &conn,
                    session_id,
                    pr_number,
                    "pull request is unavailable",
                )?;
            }
            Err(error) => {
                let conn = self.database.connection();
                record_pr_refresh_error(&conn, session_id, pr_number, &error)?;
            }
        }
        self.list_for_session(session_id)
    }

    async fn view_pr(
        &self,
        workspace_path: &str,
        reference: Option<&str>,
        session_id: &str,
    ) -> Result<Option<PrViewResponse>, String> {
        let mut args = vec!["pr".into(), "view".into()];
        if let Some(reference) = reference.filter(|name| !name.is_empty()) {
            args.push(reference.to_string());
        }
        args.extend(["--json".into(), PR_VIEW_JSON_FIELDS.into()]);

        let stdout = match (self.runner)(workspace_path.to_string(), args).await {
            Ok(text) => text,
            Err(error) => {
                let category = gh_error_category(&error);
                if category == GhErrorCategory::Unknown {
                    tracing::info!(
                        session_id = %session_id,
                        error = %error,
                        "gh.refresh: gh failed with unknown error"
                    );
                } else if category != GhErrorCategory::NoPr {
                    tracing::warn!(
                        session_id = %session_id,
                        error = %error,
                        category = ?category,
                        "gh.refresh: gh failed"
                    );
                }
                if category == GhErrorCategory::NoPr {
                    return Ok(None);
                }
                return Err(error.to_string());
            }
        };
        serde_json::from_str(stdout.trim())
            .map(Some)
            .map_err(|error| format!("invalid gh pr view response: {error}"))
    }

    fn record_view(
        &self,
        session_id: &str,
        workspace_project_id: &str,
        parsed: PrViewResponse,
        associate_branch: bool,
    ) -> ArgmaxResult<()> {
        let Some(pr_number) = parsed.number else {
            return Ok(());
        };
        let Some(head_sha) = parsed.head_ref_oid.filter(|sha| !sha.is_empty()) else {
            return Ok(());
        };

        let record = GhPrRecord {
            session_id: session_id.to_string(),
            pr_number,
            head_sha,
            last_seen_check_state: collapse_rollup(parsed.status_check_rollup.as_deref()).into(),
            updated_at: now_iso(),
            pr_state: normalize_pr_state(parsed.state.as_deref()),
            notified_at: None,
            pr_created_at: parsed.created_at.filter(|timestamp| !timestamp.is_empty()),
            pr_merged_at: parsed.merged_at.filter(|timestamp| !timestamp.is_empty()),
            head_ref_name: parsed.head_ref_name.filter(|name| !name.is_empty()),
        };
        let conn = self.database.connection();
        if associate_branch {
            record_gh_pr_observation(&conn, &record, PrAttribution::Inferred)?;
        } else {
            store_gh_pr_observation(&conn, &record)?;
        }
        store_pr_metadata(
            &conn,
            session_id,
            pr_number,
            parsed.url.as_deref(),
            parsed.title.as_deref(),
        )?;
        if let Some(url) = parsed.url.as_deref() {
            if let Some(remote) = crate::git::ops::extract_github_remote_from_url(url) {
                let _ = crate::persistence::projects::update_project_remote(
                    &conn,
                    workspace_project_id,
                    Some(&remote),
                );
            }
        }
        Ok(())
    }
}

fn canonical_successfully_refreshed_after(
    connection: &rusqlite::Connection,
    project_id: &str,
    pr_number: i64,
    started_at: &str,
) -> ArgmaxResult<bool> {
    connection
        .prepare_cached(
            r#"
            SELECT EXISTS (
              SELECT 1 FROM gh_pull_requests
              WHERE project_id = ?1 AND pr_number = ?2 AND refreshed_at >= ?3
                AND refresh_error IS NULL
            )
            "#,
        )
        .map_err(crate::persistence::sqlite_error)?
        .query_row((project_id, pr_number, started_at), |row| row.get(0))
        .map_err(crate::persistence::sqlite_error)
}

/// GitHub PR numbers mentioned in a completed tool event's stdout. Used to
/// notice `gh pr create` (and similar) without waiting for the poller, which
/// only views `workspace.branch`.
pub fn pr_numbers_from_command_event(event_type: &str, message: &str, payload: &Value) -> Vec<i64> {
    let mut numbers = Vec::new();
    for url in pr_urls_from_command_event(event_type, message, payload) {
        if let Some(number) = extract_pr_number(&url) {
            if !numbers.contains(&number) {
                numbers.push(number);
            }
        }
    }
    numbers
}

fn pr_urls_from_command_event(event_type: &str, message: &str, payload: &Value) -> Vec<String> {
    if event_type != "command.completed" {
        return Vec::new();
    }
    let mut text = String::new();
    push_scan_text(&mut text, message);
    if let Some(content) = payload.get("content").and_then(Value::as_str) {
        push_scan_text(&mut text, content);
    }
    if let Some(output) = payload.get("aggregated_output").and_then(Value::as_str) {
        push_scan_text(&mut text, output);
    }
    if let Some(result) = payload.get("result") {
        push_result_text(&mut text, result);
    }
    let scan = tail_str(&text, COMMAND_EVENT_SCAN_TAIL);
    let mut urls = Vec::new();
    let mut rest = scan;
    while let Some(url) = extract_pr_url(rest) {
        if !urls.contains(&url) {
            urls.push(url.clone());
        }
        let Some(next) = rest.find(&url).map(|at| at + url.len()) else {
            break;
        };
        rest = &rest[next..];
    }
    urls
}

fn push_result_text(into: &mut String, result: &Value) {
    match result {
        Value::String(text) => push_scan_text(into, text),
        Value::Array(values) => {
            for value in values {
                push_result_text(into, value);
            }
        }
        Value::Object(fields) => {
            for value in fields.values() {
                push_result_text(into, value);
            }
        }
        Value::Null | Value::Bool(_) | Value::Number(_) => {}
    }
}

fn push_scan_text(into: &mut String, chunk: &str) {
    if chunk.is_empty() {
        return;
    }
    if !into.is_empty() {
        into.push('\n');
    }
    into.push_str(chunk);
}

pub fn repair_session_pr_evidence(
    connection: &rusqlite::Connection,
    session_id: &str,
) -> ArgmaxResult<Vec<i64>> {
    let project_id = connection
        .prepare_cached(
            r#"
            SELECT workspaces.project_id
            FROM sessions
            JOIN workspaces ON workspaces.id = sessions.workspace_id
            WHERE sessions.id = ?1
            "#,
        )
        .map_err(crate::persistence::sqlite_error)?
        .query_row([session_id], |row| row.get::<_, String>(0))
        .map_err(crate::persistence::sqlite_error)?;
    scan_session_pr_evidence(connection, session_id, &project_id)
}

fn scan_session_pr_evidence(
    connection: &rusqlite::Connection,
    session_id: &str,
    project_id: &str,
) -> ArgmaxResult<Vec<i64>> {
    let project_remote = get_project_remote(connection, project_id)?;
    let Some(project_remote) = project_remote else {
        // A successful `gh pr view` will populate the remote, then refresh
        // calls this scanner again before advancing the cursor.
        return Ok(Vec::new());
    };

    let progress = connection
        .prepare_cached(
            r#"
            SELECT last_event_rowid, last_change_sequence, parser_version
            FROM session_pr_evidence_scans
            WHERE session_id = ?1
            "#,
        )
        .map_err(crate::persistence::sqlite_error)?
        .query_row([session_id], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, i64>(2)?,
            ))
        })
        .optional()
        .map_err(crate::persistence::sqlite_error)?;
    let (latest_event_rowid, latest_change_sequence, pruned_change_sequence) = connection
        .prepare_cached(
            r#"
            SELECT
              COALESCE((SELECT MAX(rowid) FROM events WHERE session_id = ?1), 0),
              COALESCE((SELECT MAX(sequence) FROM session_changes WHERE session_id = ?1), 0),
              COALESCE((SELECT pruned_through FROM session_change_watermarks WHERE session_id = ?1), 0)
            "#,
        )
        .map_err(crate::persistence::sqlite_error)?
        .query_row([session_id], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, i64>(2)?,
            ))
        })
        .map_err(crate::persistence::sqlite_error)?;
    let (last_event_rowid, last_change_sequence, parser_version) = progress.unwrap_or((0, 0, 0));
    let change_history_was_pruned =
        last_change_sequence > 0 && last_change_sequence < pruned_change_sequence;
    let parser_changed = parser_version < SESSION_PR_EVIDENCE_PARSER_VERSION;

    // A completion can arrive before its command.started peer during provider
    // sync. If that older completion was previously unverified, replay URL
    // candidates once when the late start mutation supplies its command.
    let has_late_started_change = if parser_changed || change_history_was_pruned {
        false
    } else {
        connection
            .prepare_cached(
                r#"
                SELECT EXISTS (
                  SELECT 1
                  FROM session_changes changes
                  JOIN events started
                    ON started.session_id = changes.session_id
                   AND started.id = changes.entity_id
                  JOIN events completed
                    ON completed.session_id = started.session_id
                   AND completed.type = 'command.completed'
                   AND completed.rowid <= ?3
                   AND (
                     json_extract(completed.payload_json, '$.tool_use_id') =
                       COALESCE(
                         json_extract(started.payload_json, '$.id'),
                         json_extract(started.payload_json, '$.call_id'),
                         json_extract(started.payload_json, '$.callId')
                       )
                     OR json_extract(completed.payload_json, '$.call_id') =
                       COALESCE(
                         json_extract(started.payload_json, '$.id'),
                         json_extract(started.payload_json, '$.call_id'),
                         json_extract(started.payload_json, '$.callId')
                       )
                     OR json_extract(completed.payload_json, '$.callId') =
                       COALESCE(
                         json_extract(started.payload_json, '$.id'),
                         json_extract(started.payload_json, '$.call_id'),
                         json_extract(started.payload_json, '$.callId')
                       )
                     OR json_extract(completed.payload_json, '$.id') =
                       COALESCE(
                         json_extract(started.payload_json, '$.id'),
                         json_extract(started.payload_json, '$.call_id'),
                         json_extract(started.payload_json, '$.callId')
                       )
                   )
                   AND (
                     COALESCE(
                       json_extract(completed.payload_json, '$.provider_invocation_id'),
                       json_extract(completed.payload_json, '$.providerInvocationId')
                     ) IS NULL
                     OR COALESCE(
                       json_extract(completed.payload_json, '$.provider_invocation_id'),
                       json_extract(completed.payload_json, '$.providerInvocationId')
                     ) = COALESCE(
                       json_extract(started.payload_json, '$.provider_invocation_id'),
                       json_extract(started.payload_json, '$.providerInvocationId')
                     )
                   )
                  WHERE changes.session_id = ?1
                    AND changes.sequence > ?2
                    AND changes.sequence <= ?4
                    AND changes.entity_kind = 'event'
                    AND changes.operation = 'upsert'
                    AND started.type = 'command.started'
                    AND (
                      started.payload_json LIKE '%gh pr%'
                      OR started.payload_json LIKE '%git push%'
                    )
                )
                "#,
            )
            .map_err(crate::persistence::sqlite_error)?
            .query_row(
                (
                    session_id,
                    last_change_sequence,
                    last_event_rowid,
                    latest_change_sequence,
                ),
                |row| row.get::<_, bool>(0),
            )
            .map_err(crate::persistence::sqlite_error)?
    };
    let full_scan = progress.is_none()
        || parser_changed
        || change_history_was_pruned
        || has_late_started_change;
    if !full_scan
        && latest_event_rowid <= last_event_rowid
        && latest_change_sequence <= last_change_sequence
    {
        return Ok(Vec::new());
    }

    let mut statement = connection
        .prepare_cached(
            r#"
            SELECT events.rowid, events.id, events.message, events.payload_json, events.created_at
            FROM events
            WHERE events.session_id = ?1
              AND events.type = 'command.completed'
              AND events.rowid <= ?5
              AND (
                ?2
                OR events.rowid > ?3
                OR EXISTS (
                  SELECT 1
                  FROM session_changes changes
                  WHERE changes.session_id = ?1
                    AND changes.sequence > ?4
                    AND changes.sequence <= ?6
                    AND changes.entity_kind = 'event'
                    AND changes.entity_id = events.id
                    AND changes.operation = 'upsert'
                )
              )
            ORDER BY events.rowid ASC
            "#,
        )
        .map_err(crate::persistence::sqlite_error)?;
    let mut rows = statement
        .query((
            session_id,
            full_scan,
            last_event_rowid,
            last_change_sequence,
            latest_event_rowid,
            latest_change_sequence,
        ))
        .map_err(crate::persistence::sqlite_error)?;
    let mut events = Vec::new();
    while let Some(row) = rows.next().map_err(crate::persistence::sqlite_error)? {
        events.push((
            row.get::<_, String>(1)
                .map_err(crate::persistence::sqlite_error)?,
            row.get::<_, String>(2)
                .map_err(crate::persistence::sqlite_error)?,
            row.get::<_, String>(3)
                .map_err(crate::persistence::sqlite_error)?,
            row.get::<_, String>(4)
                .map_err(crate::persistence::sqlite_error)?,
        ));
    }
    drop(rows);
    drop(statement);

    let mut numbers = Vec::new();
    for (event_id, message, payload_json, occurred_at) in events {
        let payload: Value = serde_json::from_str(&payload_json).unwrap_or(Value::Null);
        if !command_completed_successfully(&payload) {
            continue;
        }
        let command = command_from_payload(&payload).or_else(|| {
            correlated_command_from_started_event(connection, session_id, &payload)
                .ok()
                .flatten()
        });
        let urls = pr_urls_from_command_event("command.completed", &message, &payload)
            .into_iter()
            .filter(|url| url_matches_project_remote(url, Some(&project_remote)))
            .collect::<Vec<_>>();
        for url in &urls {
            if let Some(number) = extract_pr_number(url) {
                let relationship = classify_pr_relationship(
                    command.as_deref(),
                    number,
                    urls.len(),
                    &project_remote,
                );
                store_pr_metadata(connection, session_id, number, Some(url), None)?;
                if evidence_needs_update(connection, session_id, number, &event_id, relationship)? {
                    record_session_pr_evidence(
                        connection,
                        session_id,
                        number,
                        relationship,
                        &event_id,
                        &occurred_at,
                    )?;
                    if !numbers.contains(&number) {
                        numbers.push(number);
                    }
                }
            }
        }
        if urls.is_empty() {
            if let Some(command) = command.as_deref() {
                for (number, relationship) in explicit_pr_targets(command, &project_remote) {
                    if evidence_needs_update(
                        connection,
                        session_id,
                        number,
                        &event_id,
                        relationship,
                    )? {
                        record_session_pr_evidence(
                            connection,
                            session_id,
                            number,
                            relationship,
                            &event_id,
                            &occurred_at,
                        )?;
                        if !numbers.contains(&number) {
                            numbers.push(number);
                        }
                    }
                }
            }
        }
    }

    connection
        .prepare_cached(
            r#"
            INSERT INTO session_pr_evidence_scans (
              session_id, last_event_rowid, last_change_sequence,
              parser_version, scanned_at
            ) VALUES (?1, ?2, ?3, ?4, ?5)
            ON CONFLICT(session_id) DO UPDATE SET
              last_event_rowid = MAX(last_event_rowid, excluded.last_event_rowid),
              last_change_sequence = MAX(last_change_sequence, excluded.last_change_sequence),
              parser_version = excluded.parser_version,
              scanned_at = excluded.scanned_at
            "#,
        )
        .map_err(crate::persistence::sqlite_error)?
        .execute((
            session_id,
            latest_event_rowid,
            latest_change_sequence.max(pruned_change_sequence),
            SESSION_PR_EVIDENCE_PARSER_VERSION,
            now_iso(),
        ))
        .map_err(crate::persistence::sqlite_error)?;
    Ok(numbers)
}

fn evidence_needs_update(
    connection: &rusqlite::Connection,
    session_id: &str,
    pr_number: i64,
    source_id: &str,
    relationship: &str,
) -> ArgmaxResult<bool> {
    let existing = connection
        .prepare_cached(
            r#"
            SELECT relationship FROM session_pr_evidence
            WHERE session_id = ?1 AND pr_number = ?2 AND source_id = ?3
            "#,
        )
        .map_err(crate::persistence::sqlite_error)?
        .query_row((session_id, pr_number, source_id), |row| {
            row.get::<_, String>(0)
        })
        .optional()
        .map_err(crate::persistence::sqlite_error)?;
    Ok(existing.is_none_or(|existing| {
        relationship_strength(relationship) > relationship_strength(&existing)
    }))
}

fn relationship_strength(relationship: &str) -> u8 {
    match relationship {
        "worked" => 2,
        "referenced" => 1,
        _ => 0,
    }
}

fn command_completed_successfully(payload: &Value) -> bool {
    if payload.get("is_error").and_then(Value::as_bool) == Some(true)
        || payload.get("isError").and_then(Value::as_bool) == Some(true)
        || payload.get("success").and_then(Value::as_bool) == Some(false)
        || payload.get("error").is_some_and(|value| !value.is_null())
    {
        return false;
    }
    for pointer in [
        "/exit_code",
        "/exitCode",
        "/metadata/exit_code",
        "/metadata/exitCode",
    ] {
        if payload
            .pointer(pointer)
            .and_then(Value::as_i64)
            .is_some_and(|code| code != 0)
        {
            return false;
        }
    }
    !payload
        .get("status")
        .and_then(Value::as_str)
        .is_some_and(|status| {
            matches!(
                status.to_ascii_lowercase().as_str(),
                "failed" | "error" | "cancelled"
            )
        })
}

fn command_from_payload(payload: &Value) -> Option<String> {
    for pointer in [
        "/command",
        "/cmd",
        "/input/command",
        "/input/cmd",
        "/params/command",
        "/tool_call/shell/args/command",
    ] {
        let Some(value) = payload.pointer(pointer) else {
            continue;
        };
        if let Some(command) = value.as_str().filter(|command| !command.is_empty()) {
            return Some(command.to_owned());
        }
        if let Some(parts) = value.as_array() {
            let command = parts
                .iter()
                .filter_map(Value::as_str)
                .collect::<Vec<_>>()
                .join(" ");
            if !command.is_empty() {
                return Some(command);
            }
        }
    }
    None
}

fn correlated_command_from_started_event(
    connection: &rusqlite::Connection,
    session_id: &str,
    completed_payload: &Value,
) -> ArgmaxResult<Option<String>> {
    let correlation_id = ["tool_use_id", "call_id", "callId", "id"]
        .into_iter()
        .find_map(|key| completed_payload.get(key).and_then(Value::as_str));
    let Some(correlation_id) = correlation_id else {
        return Ok(None);
    };
    let provider_invocation_id = ["provider_invocation_id", "providerInvocationId"]
        .into_iter()
        .find_map(|key| completed_payload.get(key).and_then(Value::as_str));
    let mut statement = connection
        .prepare_cached(
            r#"
            SELECT payload_json
            FROM events
            WHERE session_id = ?1 AND type = 'command.started'
              AND (
                json_extract(payload_json, '$.id') = ?2
                OR json_extract(payload_json, '$.call_id') = ?2
                OR json_extract(payload_json, '$.callId') = ?2
              )
              AND (
                ?3 IS NULL
                OR json_extract(payload_json, '$.provider_invocation_id') = ?3
                OR json_extract(payload_json, '$.providerInvocationId') = ?3
              )
            ORDER BY rowid DESC
            LIMIT 1
            "#,
        )
        .map_err(crate::persistence::sqlite_error)?;
    let payload_json = statement
        .query_row(
            (session_id, correlation_id, provider_invocation_id),
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(crate::persistence::sqlite_error)?;
    Ok(payload_json
        .and_then(|json| serde_json::from_str::<Value>(&json).ok())
        .and_then(|payload| command_from_payload(&payload)))
}

fn classify_pr_relationship(
    command: Option<&str>,
    pr_number: i64,
    matching_url_count: usize,
    project_remote: &ProjectRemote,
) -> &'static str {
    let Some(command) = command else {
        return "unverified";
    };
    let changed_directory = command_changes_directory(command);
    for segment in executable_shell_segments(command) {
        let tokens = shell_tokens(segment);
        let Some(start) = tokens
            .windows(2)
            .position(|pair| pair == ["gh", "pr"] || pair == ["git", "push"])
        else {
            continue;
        };
        if !is_shell_command_prefix(&tokens[..start]) {
            continue;
        }
        if tokens.get(start..start + 2) == Some(&["git", "push"]) && matching_url_count == 1 {
            return "worked";
        }
        if tokens.get(start..start + 2) != Some(&["gh", "pr"]) {
            continue;
        }
        if !gh_segment_matches_project(
            &tokens,
            start,
            project_remote,
            !changed_directory || matching_url_count > 0,
        ) {
            continue;
        }
        let verb = tokens.get(start + 2).copied().unwrap_or_default();
        let target = (verb != "create")
            .then(|| explicit_pr_number(&tokens, start))
            .flatten();
        let targets_this_pr =
            target == Some(pr_number) || (target.is_none() && matching_url_count == 1);
        if targets_this_pr
            && matches!(
                verb,
                "create" | "edit" | "merge" | "close" | "reopen" | "ready"
            )
        {
            return "worked";
        }
        if targets_this_pr && matches!(verb, "view" | "checks" | "status" | "review") {
            return "referenced";
        }
    }
    "unverified"
}

fn explicit_pr_targets(command: &str, project_remote: &ProjectRemote) -> Vec<(i64, &'static str)> {
    let mut targets = Vec::new();
    let changed_directory = command_changes_directory(command);
    for segment in executable_shell_segments(command) {
        let tokens = shell_tokens(segment);
        let Some(start) = tokens.windows(2).position(|pair| pair == ["gh", "pr"]) else {
            continue;
        };
        if !is_shell_command_prefix(&tokens[..start])
            || !gh_segment_matches_project(&tokens, start, project_remote, !changed_directory)
        {
            continue;
        }
        let verb = tokens.get(start + 2).copied().unwrap_or_default();
        if verb == "create" {
            continue;
        }
        let Some(pr_number) = explicit_pr_number(&tokens, start) else {
            continue;
        };
        let relationship = if matches!(
            verb,
            "create" | "edit" | "merge" | "close" | "reopen" | "ready"
        ) {
            "worked"
        } else if matches!(verb, "view" | "checks" | "status" | "review") {
            "referenced"
        } else {
            continue;
        };
        if let Some(existing) = targets
            .iter_mut()
            .find(|(existing_number, _)| *existing_number == pr_number)
        {
            if relationship_strength(relationship) > relationship_strength(existing.1) {
                existing.1 = relationship;
            }
        } else {
            targets.push((pr_number, relationship));
        }
    }
    targets
}

fn shell_tokens(segment: &str) -> Vec<&str> {
    segment
        .split_whitespace()
        .map(|token| {
            token.trim_matches(|character| matches!(character, '\'' | '"' | '(' | ')' | '{' | '}'))
        })
        .collect()
}

fn gh_segment_matches_project(
    tokens: &[&str],
    gh_start: usize,
    project_remote: &ProjectRemote,
    allow_unscoped: bool,
) -> bool {
    let mut repository = None;
    let mut index = gh_start + 3;
    while let Some(token) = tokens.get(index).copied() {
        if matches!(token, "-R" | "--repo") {
            repository = tokens.get(index + 1).copied();
            break;
        }
        if let Some(value) = token.strip_prefix("--repo=") {
            repository = Some(value);
            break;
        }
        index += 1;
    }
    if repository.is_none() {
        repository = tokens[..gh_start]
            .iter()
            .find_map(|token| token.strip_prefix("GH_REPO="));
    }
    let Some(repository) = repository else {
        return allow_unscoped;
    };
    let Some((owner, name)) = repository.trim_end_matches(".git").split_once('/') else {
        return false;
    };
    owner.eq_ignore_ascii_case(&project_remote.owner)
        && name.eq_ignore_ascii_case(&project_remote.name)
}

fn explicit_pr_number(tokens: &[&str], gh_start: usize) -> Option<i64> {
    let mut index = gh_start + 3;
    while let Some(token) = tokens.get(index).copied() {
        if matches!(token, "|" | ">" | ">>") {
            return None;
        }
        if matches!(token, "-R" | "--repo") {
            index += 2;
            continue;
        }
        if token.starts_with("--repo=") || token.starts_with("-R") && token.len() > 2 {
            index += 1;
            continue;
        }
        if matches!(
            token,
            "--web"
                | "--squash"
                | "--merge"
                | "--rebase"
                | "--auto"
                | "--disable-auto"
                | "--delete-branch"
                | "--admin"
                | "--watch"
        ) {
            index += 1;
            continue;
        }
        // Once another option appears, its shell-quoted value may contain a
        // number (`--title "Fix #123"`). Without a full shell parser there is
        // no safe positional target after that boundary.
        if token.starts_with('-') {
            return None;
        }
        return token
            .trim_start_matches('#')
            .parse::<i64>()
            .ok()
            .filter(|number| *number > 0);
    }
    None
}

fn command_changes_directory(command: &str) -> bool {
    executable_shell_segments(command).iter().any(|segment| {
        let tokens = shell_tokens(segment);
        tokens.first().is_some_and(|token| *token == "cd")
    })
}

/// Split a shell script into executable command fragments while excluding
/// heredoc bodies. PR descriptions often contain command examples and URLs,
/// and treating those prose lines as executed work creates false ownership.
fn executable_shell_segments(command: &str) -> Vec<&str> {
    let mut segments = Vec::new();
    let mut heredoc_delimiter = None::<String>;
    for line in command.lines() {
        let trimmed = line.trim();
        if let Some(delimiter) = heredoc_delimiter.as_deref() {
            if trimmed == delimiter {
                heredoc_delimiter = None;
            }
            continue;
        }

        for segment in shell_control_segments(line) {
            segments.push(segment);
            segments.extend(shell_command_substitutions(segment));
        }
        heredoc_delimiter = shell_heredoc_delimiter(line);
    }
    segments
}

fn shell_control_segments(line: &str) -> Vec<&str> {
    let bytes = line.as_bytes();
    let mut segments = Vec::new();
    let mut start = 0;
    let mut index = 0;
    let mut quote = None;
    let mut paren_depth = 0_u32;
    while index < bytes.len() {
        let character = bytes[index] as char;
        if character == '\\' && quote != Some('\'') {
            index = (index + 2).min(bytes.len());
            continue;
        }
        if let Some(active_quote) = quote {
            if character == active_quote {
                quote = None;
            }
            index += 1;
            continue;
        }
        if matches!(character, '\'' | '"') {
            quote = Some(character);
            index += 1;
            continue;
        }
        if character == '(' {
            paren_depth += 1;
            index += 1;
            continue;
        }
        if character == ')' && paren_depth > 0 {
            paren_depth -= 1;
            index += 1;
            continue;
        }
        let control_width = if paren_depth == 0 && character == ';' {
            1
        } else if paren_depth == 0
            && index + 1 < bytes.len()
            && matches!(&bytes[index..index + 2], b"&&" | b"||")
        {
            2
        } else {
            0
        };
        if control_width > 0 {
            let segment = line[start..index].trim();
            if !segment.is_empty() {
                segments.push(segment);
            }
            index += control_width;
            start = index;
            continue;
        }
        index += 1;
    }
    let segment = line[start..].trim();
    if !segment.is_empty() {
        segments.push(segment);
    }
    segments
}

fn shell_command_substitutions(segment: &str) -> Vec<&str> {
    let bytes = segment.as_bytes();
    let mut substitutions = Vec::new();
    let mut search_from = 0;
    let mut outer_quote = None;
    while search_from + 1 < bytes.len() {
        let character = bytes[search_from] as char;
        if character == '\\' && outer_quote != Some('\'') {
            search_from = (search_from + 2).min(bytes.len());
            continue;
        }
        if let Some(active_quote) = outer_quote {
            if character == active_quote {
                outer_quote = None;
            }
            if active_quote == '\'' || character != '$' || bytes[search_from + 1] != b'(' {
                search_from += 1;
                continue;
            }
        } else if matches!(character, '\'' | '"') {
            outer_quote = Some(character);
            search_from += 1;
            continue;
        } else if character != '$' || bytes[search_from + 1] != b'(' {
            search_from += 1;
            continue;
        }

        let content_start = search_from + 2;
        let mut index = content_start;
        let mut depth = 1_u32;
        let mut quote = None;
        while index < bytes.len() {
            let character = bytes[index] as char;
            if character == '\\' {
                index = (index + 2).min(bytes.len());
                continue;
            }
            if let Some(active_quote) = quote {
                if character == active_quote {
                    quote = None;
                }
                index += 1;
                continue;
            }
            if matches!(character, '\'' | '"') {
                quote = Some(character);
                index += 1;
                continue;
            }
            if character == '(' {
                depth += 1;
            } else if character == ')' {
                depth -= 1;
                if depth == 0 {
                    let substitution = segment[content_start..index].trim();
                    if !substitution.is_empty() {
                        substitutions.push(substitution);
                    }
                    search_from = index + 1;
                    break;
                }
            }
            index += 1;
        }
        if depth != 0 {
            break;
        }
    }
    substitutions
}

fn shell_heredoc_delimiter(line: &str) -> Option<String> {
    let marker = line.find("<<")?;
    let mut rest = line[marker + 2..].trim_start();
    if let Some(without_tabs_flag) = rest.strip_prefix('-') {
        rest = without_tabs_flag.trim_start();
    }
    let (quote, rest) = match rest.as_bytes().first().copied() {
        Some(b'\'') => (Some('\''), &rest[1..]),
        Some(b'"') => (Some('"'), &rest[1..]),
        _ => (None, rest),
    };
    let end = rest
        .char_indices()
        .find(|(_, character)| match quote {
            Some(quote) => *character == quote,
            None => character.is_whitespace() || matches!(*character, ';' | '&' | '|' | ')' | '('),
        })
        .map(|(index, _)| index)
        .unwrap_or(rest.len());
    let delimiter = &rest[..end];
    (!delimiter.is_empty()).then(|| delimiter.to_owned())
}

fn is_shell_command_prefix(prefix: &[&str]) -> bool {
    let mut index = 0;
    while prefix
        .get(index)
        .is_some_and(|token| matches!(*token, "env" | "sudo" | "command") || token.contains('='))
    {
        index += 1;
    }
    let remaining = &prefix[index..];
    remaining.is_empty()
        || matches!(
            remaining,
            [
                "sh" | "bash" | "zsh" | "/bin/sh" | "/bin/bash" | "/bin/zsh",
                "-c" | "-lc"
            ]
        )
}

fn url_matches_project_remote(url: &str, expected: Option<&ProjectRemote>) -> bool {
    let Some(expected) = expected else {
        return false;
    };
    extract_github_remote_from_url(url).is_some_and(|actual| {
        actual.owner.eq_ignore_ascii_case(&expected.owner)
            && actual.name.eq_ignore_ascii_case(&expected.name)
    })
}

fn tail_str(text: &str, max_bytes: usize) -> &str {
    if text.len() <= max_bytes {
        return text;
    }
    let start = text.len() - max_bytes;
    match text.get(start..) {
        Some(tail) => tail,
        None => {
            let start = text
                .char_indices()
                .rev()
                .find(|(idx, _)| *idx <= start)
                .map(|(idx, _)| idx)
                .unwrap_or(0);
            &text[start..]
        }
    }
}

// The subset of `gh` JSON output that Argmax reads.

#[derive(Debug, serde::Deserialize)]
struct PrViewResponse {
    #[serde(default)]
    number: Option<i64>,
    #[serde(default)]
    url: Option<String>,
    #[serde(default)]
    title: Option<String>,
    #[serde(default, rename = "headRefOid")]
    head_ref_oid: Option<String>,
    #[serde(default, rename = "headRefName")]
    head_ref_name: Option<String>,
    #[serde(default)]
    state: Option<String>,
    #[serde(default, rename = "createdAt")]
    created_at: Option<String>,
    #[serde(default, rename = "mergedAt")]
    merged_at: Option<String>,
    #[serde(default, rename = "statusCheckRollup")]
    status_check_rollup: Option<Vec<RollupEntry>>,
}

#[derive(Debug, serde::Deserialize)]
struct RollupEntry {
    #[serde(default)]
    state: Option<String>,
    #[serde(default)]
    status: Option<String>,
    #[serde(default)]
    conclusion: Option<String>,
}

// Error categorization distinguishes "no PR" from "transport broke" so the log
// surface doesn't bury real failures under PR-less branches.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum GhErrorCategory {
    Transient,
    Auth,
    RateLimit,
    NoPr,
    Unknown,
}

fn gh_error_category(error: &ArgmaxError) -> GhErrorCategory {
    let text = error.to_string().to_lowercase();
    if text.contains("no pull requests")
        || text.contains("not a git repository")
        || text.contains("no commits between")
    {
        return GhErrorCategory::NoPr;
    }
    if text.contains("authentication")
        || text.contains("unauthorized")
        || text.contains("not authenticated")
        || text.contains("token")
    {
        return GhErrorCategory::Auth;
    }
    if text.contains("rate limit") || text.contains("api rate") {
        return GhErrorCategory::RateLimit;
    }
    if text.contains("timeout") || text.contains("etimedout") || text.contains("network") {
        return GhErrorCategory::Transient;
    }
    GhErrorCategory::Unknown
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum GhCheckState {
    Unknown,
    Pending,
    Success,
    Failure,
    Cancelled,
    Skipped,
}

impl From<GhCheckState> for String {
    fn from(value: GhCheckState) -> Self {
        match value {
            GhCheckState::Unknown => "unknown",
            GhCheckState::Pending => "pending",
            GhCheckState::Success => "success",
            GhCheckState::Failure => "failure",
            GhCheckState::Cancelled => "cancelled",
            GhCheckState::Skipped => "skipped",
        }
        .to_string()
    }
}

fn collapse_rollup(rollup: Option<&[RollupEntry]>) -> GhCheckState {
    let Some(entries) = rollup else {
        return GhCheckState::Unknown;
    };
    if entries.is_empty() {
        return GhCheckState::Unknown;
    }
    let mut has_pending = false;
    for entry in entries {
        let state = entry_state(entry);
        match state.as_str() {
            "failure" | "failed" | "timed_out" | "action_required" => return GhCheckState::Failure,
            "cancelled" | "cancel" => return GhCheckState::Cancelled,
            "pending" | "in_progress" | "queued" | "waiting" => has_pending = true,
            _ => {}
        }
    }
    if has_pending {
        return GhCheckState::Pending;
    }
    let all_skipped = entries.iter().all(|entry| {
        let state = entry_state(entry);
        state == "skipped" || state == "neutral"
    });
    if all_skipped {
        GhCheckState::Skipped
    } else {
        GhCheckState::Success
    }
}

fn entry_state(entry: &RollupEntry) -> String {
    entry
        .conclusion
        .clone()
        .or_else(|| entry.state.clone())
        .or_else(|| entry.status.clone())
        .unwrap_or_default()
        .to_lowercase()
}

fn normalize_pr_state(raw: Option<&str>) -> Option<String> {
    let raw = raw?;
    let upper = raw.to_uppercase();
    matches!(upper.as_str(), "OPEN" | "CLOSED" | "MERGED").then_some(upper)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::persistence::events::{persist_timeline_event, PersistTimelineEventInput};
    use crate::persistence::projects::{persist_project, PersistProjectInput, ProjectSettings};
    use crate::persistence::sessions::{persist_session, PersistSessionInput};
    use crate::persistence::workspaces::{persist_workspace, PersistWorkspaceInput};
    use crate::sessions::state::SessionState;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Mutex;
    use tempfile::TempDir;

    struct StubRunner {
        responses: Mutex<Vec<ArgmaxResult<String>>>,
        calls: AtomicUsize,
        last_args: Mutex<Vec<String>>,
    }

    impl StubRunner {
        fn new(responses: Vec<ArgmaxResult<String>>) -> Arc<Self> {
            Arc::new(Self {
                responses: Mutex::new(responses),
                calls: AtomicUsize::new(0),
                last_args: Mutex::new(Vec::new()),
            })
        }

        fn runner(self: Arc<Self>) -> GhRunner {
            Arc::new(move |_cwd, args| {
                let next = {
                    let mut responses = self.responses.lock().expect("stub responses poisoned");
                    *self.last_args.lock().expect("stub args poisoned") = args;
                    self.calls.fetch_add(1, Ordering::SeqCst);
                    if responses.is_empty() {
                        None
                    } else {
                        Some(responses.remove(0))
                    }
                };
                Box::pin(async move {
                    next.unwrap_or_else(|| {
                        Err(ArgmaxError::service(
                            "GH_TEST_EXHAUSTED",
                            "stub runner ran out of responses",
                        ))
                    })
                })
            })
        }

        fn call_count(&self) -> usize {
            self.calls.load(Ordering::SeqCst)
        }

        fn last_args(&self) -> Vec<String> {
            self.last_args.lock().expect("stub args poisoned").clone()
        }
    }

    fn fixture(database: &Arc<Database>, repo_path: &str) -> (String, String) {
        let conn = database.connection();
        persist_project(
            &conn,
            &PersistProjectInput {
                id: "p1".to_string(),
                name: "fixture".to_string(),
                repo_path: repo_path.to_string(),
                default_branch: Some("main".to_string()),
                current_branch: "main".to_string(),
                settings: ProjectSettings {
                    archive_on_merge: false,
                    worktree_location: format!("{repo_path}/.worktrees"),
                    setup_command: String::new(),
                    check_commands: Vec::new(),
                },
            },
        )
        .expect("project");
        persist_workspace(
            &conn,
            &PersistWorkspaceInput {
                id: "w1".to_string(),
                project_id: "p1".to_string(),
                task_label: "gh-test".to_string(),
                branch: "feature/x".to_string(),
                base_ref: "main".to_string(),
                path: repo_path.to_string(),
                state: "running".to_string(),
                shared_workspace: false,
                kind: "git".to_string(),
                dirty: false,
                changed_files: 0,
            },
        )
        .expect("workspace");
        persist_session(
            &conn,
            &PersistSessionInput {
                id: "s1".to_string(),
                workspace_id: "w1".to_string(),
                provider: "claude".to_string(),
                model_label: "Haiku 4.5".to_string(),
                model_id: "claude-haiku-4.5".to_string(),
                reasoning_effort: None,
                permission_mode: Some("auto-approve".to_string()),
                agent_mode: Some("auto".to_string()),
                prompt: "test".to_string(),
                state: SessionState::Running,
            },
        )
        .expect("session");
        ("s1".to_string(), "w1".to_string())
    }

    fn open_db() -> (TempDir, Arc<Database>) {
        let dir = TempDir::new().unwrap();
        let database = Arc::new(Database::open(dir.path().join("argmax.sqlite")).unwrap());
        (dir, database)
    }

    fn success_payload(pr_number: i64, head_sha: &str, rollup_state: &str) -> String {
        format!(
            r#"{{
                "number": {pr_number},
                "headRefOid": "{head_sha}",
                "headRefName": "feature/x",
                "state": "MERGED",
                "createdAt": "2026-05-24T10:00:00Z",
                "mergedAt": "2026-05-24T11:00:00Z",
                "statusCheckRollup": [{{"conclusion": "{rollup_state}"}}]
            }}"#
        )
    }

    #[tokio::test]
    async fn list_for_session_roundtrip() {
        let (_dir, database) = open_db();
        let (session_id, _) = fixture(&database, "/tmp/argmax-gh-list");
        // Pre-seed an existing row so list_for_session has something to read.
        {
            let conn = database.connection();
            record_gh_pr_observation(
                &conn,
                &GhPrRecord {
                    session_id: session_id.clone(),
                    pr_number: 42,
                    head_sha: "deadbeef".to_string(),
                    last_seen_check_state: "success".to_string(),
                    updated_at: now_iso(),
                    pr_state: Some("OPEN".to_string()),
                    notified_at: None,
                    pr_created_at: None,
                    pr_merged_at: None,
                    head_ref_name: None,
                },
                PrAttribution::Explicit,
            )
            .expect("seed gh_pr");
        }
        let stub = StubRunner::new(Vec::new());
        let service = GhService::with_runner(Arc::clone(&database), Arc::clone(&stub).runner());
        let rows = service.list_for_session(&session_id).expect("list");
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].pr_number, 42);
        assert_eq!(rows[0].last_seen_check_state, "success");
        // Read-only — runner must not have been invoked.
        assert_eq!(stub.call_count(), 0);
    }

    #[tokio::test]
    async fn refresh_upserts_pr_row_from_gh_stdout() {
        let (_dir, database) = open_db();
        let (session_id, _) = fixture(&database, "/tmp/argmax-gh-refresh");
        let stub = StubRunner::new(vec![Ok(success_payload(7, "feedface", "success"))]);
        let service = GhService::with_runner(Arc::clone(&database), Arc::clone(&stub).runner());

        let rows = service.refresh(&session_id).await.expect("refresh");
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].pr_number, 7);
        assert_eq!(rows[0].head_sha, "feedface");
        assert_eq!(rows[0].last_seen_check_state, "success");
        assert_eq!(rows[0].pr_state.as_deref(), Some("MERGED"));
        assert_eq!(rows[0].head_ref_name.as_deref(), Some("feature/x"));
        assert_eq!(
            rows[0].pr_created_at.as_deref(),
            Some("2026-05-24T10:00:00Z")
        );
        assert_eq!(
            rows[0].pr_merged_at.as_deref(),
            Some("2026-05-24T11:00:00Z")
        );
        assert_eq!(stub.call_count(), 1);
        assert_eq!(
            stub.last_args(),
            vec![
                "pr",
                "view",
                "feature/x",
                "--json",
                "number,title,headRefOid,headRefName,state,statusCheckRollup,createdAt,mergedAt,url",
            ]
        );

        // Subsequent gh call returns a failure rollup for a new head — same
        // pr_number, but state moves.
        let stub2 = StubRunner::new(vec![Ok(success_payload(7, "cafef00d", "failure"))]);
        let service2 = GhService::with_runner(Arc::clone(&database), Arc::clone(&stub2).runner());
        let rows = service2.refresh(&session_id).await.expect("refresh2");
        assert_eq!(rows.len(), 1, "still one row — upsert keyed on pr_number");
        assert_eq!(rows[0].head_sha, "cafef00d");
        assert_eq!(rows[0].last_seen_check_state, "failure");
    }

    #[tokio::test]
    async fn refresh_populates_project_remote_from_url() {
        let (_dir, database) = open_db();
        let (session_id, _) = fixture(&database, "/tmp/argmax-gh-remote");
        let payload = r#"{
            "number": 15,
            "headRefOid": "abcd1234",
            "headRefName": "feature/x",
            "state": "OPEN",
            "createdAt": "2026-05-24T10:00:00Z",
            "url": "https://github.com/my-org/my-repo/pull/15"
        }"#;
        let stub = StubRunner::new(vec![Ok(payload.to_string())]);
        let service = GhService::with_runner(Arc::clone(&database), Arc::clone(&stub).runner());
        let rows = service.refresh(&session_id).await.expect("refresh");
        assert_eq!(rows.len(), 1);
        let conn = database.connection();
        let remote = crate::persistence::projects::get_project_remote(&conn, "p1").unwrap();
        assert_eq!(
            remote,
            Some(crate::persistence::projects::ProjectRemote {
                owner: "my-org".to_string(),
                name: "my-repo".to_string(),
            })
        );
    }

    #[tokio::test]
    async fn refresh_returns_cached_rows_when_gh_fails() {
        let (_dir, database) = open_db();
        let (session_id, _) = fixture(&database, "/tmp/argmax-gh-fail");
        // Seed an existing row so we can distinguish "kept the cache" from
        // "nuked the cache".
        {
            let conn = database.connection();
            record_gh_pr_observation(
                &conn,
                &GhPrRecord {
                    session_id: session_id.clone(),
                    pr_number: 99,
                    head_sha: "abc123".to_string(),
                    last_seen_check_state: "pending".to_string(),
                    updated_at: now_iso(),
                    pr_state: Some("OPEN".to_string()),
                    notified_at: None,
                    pr_created_at: None,
                    pr_merged_at: None,
                    head_ref_name: None,
                },
                PrAttribution::Explicit,
            )
            .expect("seed gh_pr");
        }

        let stub = StubRunner::new(vec![Err(ArgmaxError::service(
            "GH_NON_ZERO_EXIT",
            "no pull requests found for branch feature/x",
        ))]);
        let service = GhService::with_runner(Arc::clone(&database), Arc::clone(&stub).runner());

        let rows = service.refresh(&session_id).await.expect("returns cache");
        assert_eq!(rows.len(), 1, "row preserved on gh failure");
        assert_eq!(rows[0].pr_number, 99);
        assert_eq!(rows[0].last_seen_check_state, "pending");
        // Branch view failed, then the cached OPEN row is retried by number.
        assert_eq!(stub.call_count(), 2);
    }

    #[tokio::test]
    async fn refresh_updates_cached_open_pr_by_number_when_branch_has_none() {
        let (_dir, database) = open_db();
        let (session_id, _) = fixture(&database, "/tmp/argmax-gh-number");
        {
            let conn = database.connection();
            record_gh_pr_observation(
                &conn,
                &GhPrRecord {
                    session_id: session_id.clone(),
                    pr_number: 568,
                    head_sha: "oldsha".to_string(),
                    last_seen_check_state: "pending".to_string(),
                    updated_at: now_iso(),
                    pr_state: Some("OPEN".to_string()),
                    notified_at: None,
                    pr_created_at: None,
                    pr_merged_at: None,
                    head_ref_name: Some("fix/other-worktree".to_string()),
                },
                PrAttribution::Explicit,
            )
            .expect("seed gh_pr");
        }

        let stub = StubRunner::new(vec![
            Err(ArgmaxError::service(
                "GH_NON_ZERO_EXIT",
                "no pull requests found for branch feature/x",
            )),
            Ok(r#"{
                "number": 568,
                "headRefOid": "newsha",
                "headRefName": "fix/other-worktree",
                "state": "MERGED",
                "mergedAt": "2026-09-07T04:00:00Z",
                "statusCheckRollup": [{"conclusion": "success"}]
            }"#
            .to_string()),
        ]);
        let service = GhService::with_runner(Arc::clone(&database), Arc::clone(&stub).runner());
        let rows = service.refresh(&session_id).await.expect("refresh");
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].pr_number, 568);
        assert_eq!(rows[0].head_sha, "newsha");
        assert_eq!(rows[0].pr_state.as_deref(), Some("MERGED"));
        assert_eq!(stub.call_count(), 2);
        assert_eq!(
            stub.last_args(),
            vec![
                "pr",
                "view",
                "568",
                "--json",
                "number,title,headRefOid,headRefName,state,statusCheckRollup,createdAt,mergedAt,url",
            ]
        );
    }

    #[tokio::test]
    async fn bounded_refresh_rotates_through_more_than_eight_associations() {
        let (_dir, database) = open_db();
        let (session_id, _) = fixture(&database, "/tmp/argmax-gh-fair-refresh");
        {
            let conn = database.connection();
            conn.execute(
                "UPDATE workspaces SET shared_workspace = 1 WHERE id = 'w1'",
                [],
            )
            .expect("mark shared");
            conn.execute(
                "UPDATE sessions SET state = 'complete', completed_at = '2026-01-01T00:01:00Z', pr_branch_at_start = NULL, pr_branch_last_active = NULL WHERE id = 's1'",
                [],
            )
            .expect("remove branch discovery");
            for pr_number in 1..=10 {
                record_session_pr_evidence(
                    &conn,
                    &session_id,
                    pr_number,
                    "worked",
                    &format!("seed:{pr_number}"),
                    "2026-01-01T00:00:00Z",
                )
                .expect("seed association");
                conn.execute(
                    r#"
                    UPDATE gh_pull_requests
                    SET refreshed_at = ?2,
                        pr_state = CASE WHEN pr_number = 10 THEN 'CLOSED' ELSE 'OPEN' END
                    WHERE project_id = 'p1' AND pr_number = ?1
                    "#,
                    (pr_number, format!("2026-01-01T00:00:{pr_number:02}Z")),
                )
                .expect("age refresh attempt");
            }
        }

        let viewed_numbers = Arc::new(Mutex::new(Vec::new()));
        let runner: GhRunner = {
            let viewed_numbers = Arc::clone(&viewed_numbers);
            Arc::new(move |_cwd, args| {
                let pr_number = args[2].parse::<i64>().expect("numeric PR reference");
                viewed_numbers
                    .lock()
                    .expect("viewed numbers poisoned")
                    .push(pr_number);
                Box::pin(async move {
                    Ok(format!(
                        r#"{{
                            "number": {pr_number},
                            "headRefOid": "head-{pr_number}",
                            "headRefName": "feature/{pr_number}",
                            "state": "OPEN",
                            "statusCheckRollup": [{{"conclusion": "success"}}]
                        }}"#
                    ))
                })
            })
        };
        let service = GhService::with_runner(Arc::clone(&database), runner);

        service.refresh(&session_id).await.expect("first refresh");
        service.refresh(&session_id).await.expect("second refresh");

        let viewed = viewed_numbers.lock().expect("viewed numbers poisoned");
        assert!(
            (1..=10).all(|number| viewed.contains(&number)),
            "oldest-first rotation must eventually reach every association: {viewed:?}"
        );
        let conn = database.connection();
        let reopened: String = conn
            .query_row(
                "SELECT pr_state FROM gh_pull_requests WHERE project_id = 'p1' AND pr_number = 10",
                [],
                |row| row.get(0),
            )
            .expect("reopened PR state");
        assert_eq!(reopened, "OPEN");
    }

    #[tokio::test]
    async fn refresh_updates_known_shared_pr_after_checkout_branch_changes() {
        let (_dir, database) = open_db();
        let (session_id, _) = fixture(&database, "/tmp/argmax-gh-shared-known");
        {
            let conn = database.connection();
            conn.execute(
                "UPDATE workspaces SET shared_workspace = 1 WHERE id = 'w1'",
                [],
            )
            .expect("mark workspace shared");
            conn.execute(
                "UPDATE sessions SET pr_branch_at_start = 'feature/x', pr_branch_last_active = 'feature/x' WHERE id = 's1'",
                [],
            )
            .expect("capture session branch");
            record_gh_pr_observation(
                &conn,
                &GhPrRecord {
                    session_id: session_id.clone(),
                    pr_number: 568,
                    head_sha: "oldsha".to_string(),
                    last_seen_check_state: "pending".to_string(),
                    updated_at: now_iso(),
                    pr_state: Some("OPEN".to_string()),
                    notified_at: None,
                    pr_created_at: Some("2026-05-24T08:00:00Z".to_string()),
                    pr_merged_at: None,
                    head_ref_name: Some("feature/x".to_string()),
                },
                PrAttribution::Inferred,
            )
            .expect("seed inferred PR");
            conn.execute(
                "UPDATE sessions SET state = 'complete', completed_at = '2026-05-24T09:00:00Z' WHERE id = 's1'",
                [],
            )
            .expect("complete session");
            conn.execute(
                "UPDATE workspaces SET branch = 'unrelated/later' WHERE id = 'w1'",
                [],
            )
            .expect("move shared checkout");
        }

        let stub = StubRunner::new(vec![
            Err(ArgmaxError::service(
                "GH_NON_ZERO_EXIT",
                "no pull requests found for branch feature/x",
            )),
            Ok(r#"{
                "number": 568,
                "headRefOid": "newsha",
                "headRefName": "feature/x",
                "state": "MERGED",
                "mergedAt": "2026-05-24T10:00:00Z",
                "statusCheckRollup": [{"conclusion": "success"}]
            }"#
            .to_string()),
        ]);
        let service = GhService::with_runner(Arc::clone(&database), Arc::clone(&stub).runner());

        let rows = service.refresh(&session_id).await.expect("refresh");
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].head_sha, "newsha");
        assert_eq!(rows[0].pr_state.as_deref(), Some("MERGED"));
        assert_eq!(stub.call_count(), 2);
        assert_eq!(stub.last_args()[2], "568");
    }

    #[tokio::test]
    async fn completed_shared_session_does_not_view_an_unknown_later_branch() {
        let (_dir, database) = open_db();
        let (session_id, _) = fixture(&database, "/tmp/argmax-gh-shared-later");
        {
            let conn = database.connection();
            conn.execute(
                "UPDATE workspaces SET shared_workspace = 1, branch = 'later/pr-branch' WHERE id = 'w1'",
                [],
            )
            .expect("move shared checkout");
            conn.execute(
                "UPDATE sessions SET state = 'complete', completed_at = '2026-05-24T09:00:00Z', pr_branch_at_start = NULL, pr_branch_last_active = NULL WHERE id = 's1'",
                [],
            )
            .expect("complete session without branch evidence");
        }
        let stub = StubRunner::new(vec![Ok(success_payload(184, "later", "success"))]);
        let service = GhService::with_runner(Arc::clone(&database), Arc::clone(&stub).runner());

        let rows = service.refresh(&session_id).await.expect("refresh");
        assert!(rows.is_empty());
        assert_eq!(stub.call_count(), 0);
    }

    #[tokio::test]
    async fn refresh_pr_number_views_that_pr_in_the_workspace() {
        let (_dir, database) = open_db();
        let (session_id, _) = fixture(&database, "/tmp/argmax-gh-by-number");
        let stub = StubRunner::new(vec![Ok(r#"{
            "number": 566,
            "headRefOid": "abc123",
            "headRefName": "refactor/drop-profound",
            "state": "OPEN",
            "createdAt": "2026-09-07T03:14:11Z",
            "statusCheckRollup": [{"conclusion": "pending"}]
        }"#
        .to_string())]);
        let service = GhService::with_runner(Arc::clone(&database), Arc::clone(&stub).runner());
        let rows = service
            .refresh_pr_number(&session_id, 566)
            .await
            .expect("refresh number");
        assert!(rows.is_empty(), "number refresh is metadata-only");
        let conn = database.connection();
        let cached: (String, String) = conn
            .query_row(
                "SELECT head_ref_name, pr_state FROM gh_pull_requests WHERE project_id = 'p1' AND pr_number = 566",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(
            cached,
            ("refactor/drop-profound".to_owned(), "OPEN".to_owned())
        );
        assert_eq!(
            stub.last_args(),
            vec![
                "pr",
                "view",
                "566",
                "--json",
                "number,title,headRefOid,headRefName,state,statusCheckRollup,createdAt,mergedAt,url",
            ]
        );
    }

    #[tokio::test]
    async fn refresh_discovers_pr_url_from_recent_command_output() {
        let (_dir, database) = open_db();
        let (session_id, _) = fixture(&database, "/tmp/argmax-gh-from-command");
        {
            let conn = database.connection();
            crate::persistence::projects::update_project_remote(
                &conn,
                "p1",
                Some(&ProjectRemote {
                    owner: "mentimeter".to_string(),
                    name: "revops-backoffice".to_string(),
                }),
            )
            .expect("project remote");
            conn.execute(
                "UPDATE workspaces SET shared_workspace = 1, branch = 'later/branch' WHERE id = 'w1'",
                [],
            )
            .expect("mark workspace shared");
            conn.execute(
                "UPDATE sessions SET state = 'complete', completed_at = '2026-05-24T09:00:00Z', pr_branch_at_start = NULL, pr_branch_last_active = NULL WHERE id = 's1'",
                [],
            )
            .expect("complete session without branch evidence");
            persist_timeline_event(
                &conn,
                &PersistTimelineEventInput {
                    id: "e-create".to_string(),
                    session_id: session_id.clone(),
                    r#type: "command.completed".to_string(),
                    message: "tool_result".to_string(),
                    payload: serde_json::json!({
                        "content": "https://github.com/mentimeter/revops-backoffice/pull/568"
                    }),
                    created_at: None,
                },
            )
            .expect("command event");
        }
        let stub = StubRunner::new(vec![Ok(r#"{
                "number": 568,
                "headRefOid": "head568",
                "headRefName": "fix/ai-discoverability-headline-metric",
                "state": "OPEN",
                "statusCheckRollup": [{"conclusion": "pending"}]
            }"#
        .to_string())]);
        let service = GhService::with_runner(Arc::clone(&database), Arc::clone(&stub).runner());
        let rows = service.refresh(&session_id).await.expect("refresh");
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].pr_number, 568);
        assert_eq!(
            rows[0].head_ref_name.as_deref(),
            Some("fix/ai-discoverability-headline-metric")
        );
        assert_eq!(rows[0].pr_state.as_deref(), Some("OPEN"));
        assert_eq!(stub.call_count(), 1);
    }

    #[tokio::test]
    async fn refresh_ignores_command_pr_url_for_another_project() {
        let (_dir, database) = open_db();
        let (session_id, _) = fixture(&database, "/tmp/argmax-gh-foreign-command");
        {
            let conn = database.connection();
            crate::persistence::projects::update_project_remote(
                &conn,
                "p1",
                Some(&ProjectRemote {
                    owner: "menti".to_string(),
                    name: "argmax".to_string(),
                }),
            )
            .expect("project remote");
            conn.execute(
                "UPDATE workspaces SET shared_workspace = 1 WHERE id = 'w1'",
                [],
            )
            .expect("mark workspace shared");
            conn.execute(
                "UPDATE sessions SET state = 'complete', completed_at = '2026-05-24T09:00:00Z', pr_branch_at_start = NULL, pr_branch_last_active = NULL WHERE id = 's1'",
                [],
            )
            .expect("complete session without branch evidence");
            persist_timeline_event(
                &conn,
                &PersistTimelineEventInput {
                    id: "e-foreign".to_string(),
                    session_id: session_id.clone(),
                    r#type: "command.completed".to_string(),
                    message: "tool_result".to_string(),
                    payload: serde_json::json!({
                        "content": "https://github.com/other/repository/pull/184"
                    }),
                    created_at: None,
                },
            )
            .expect("command event");
        }
        let stub = StubRunner::new(Vec::new());
        let service = GhService::with_runner(Arc::clone(&database), Arc::clone(&stub).runner());

        let rows = service.refresh(&session_id).await.expect("refresh");
        assert!(rows.is_empty());
        assert_eq!(stub.call_count(), 0);
    }

    #[test]
    fn unknown_project_remote_rejects_command_pr_url() {
        assert!(!url_matches_project_remote(
            "https://github.com/other/repository/pull/184",
            None,
        ));
    }

    #[test]
    fn pr_numbers_from_command_event_reads_create_stdout() {
        let payload = serde_json::json!({
            "content": "https://github.com/mentimeter/revops-backoffice/pull/568",
            "name": "Bash",
        });
        assert_eq!(
            pr_numbers_from_command_event("command.completed", "tool_result", &payload),
            vec![568]
        );
        assert!(pr_numbers_from_command_event("command.started", "Bash", &payload).is_empty());
        assert!(pr_numbers_from_command_event(
            "command.completed",
            "tool_result",
            &serde_json::json!({"content": "no pr here"})
        )
        .is_empty());
        assert_eq!(
            pr_numbers_from_command_event(
                "command.completed",
                "Bash",
                &serde_json::json!({
                    "result": "https://github.com/mentimeter/revops-backoffice/pull/569"
                })
            ),
            vec![569],
            "OpenCode stores string output in top-level result"
        );
        assert_eq!(
            pr_numbers_from_command_event(
                "command.completed",
                "Shell",
                &serde_json::json!({
                    "result": {"content": [{"text": "https://github.com/mentimeter/revops-backoffice/pull/570"}]}
                })
            ),
            vec![570],
            "Cursor ACP may store structured output in top-level result"
        );
    }

    #[test]
    fn classifies_pr_commands_after_heredocs_and_shell_wrappers() {
        let remote = ProjectRemote {
            owner: "mentimeter".to_owned(),
            name: "revops".to_owned(),
        };
        let create_after_body = r#"cat > /tmp/pr-body.md <<'EOF'
The PR body mentions `gh pr view 99` and https://github.com/mentimeter/argmax/pull/99.
EOF
gh pr create --base main --head feature/x --body-file /tmp/pr-body.md 2>&1 | tail -5"#;
        assert_eq!(
            executable_shell_segments(create_after_body),
            vec![
                "cat > /tmp/pr-body.md <<'EOF'",
                "gh pr create --base main --head feature/x --body-file /tmp/pr-body.md 2>&1 | tail -5"
            ]
        );
        assert_eq!(
            classify_pr_relationship(Some(create_after_body), 42, 1, &remote),
            "worked"
        );

        let wrapped_edit = r#"/bin/zsh -lc "cat > /tmp/pr-body.md <<'EOF'
Body text containing `git push` is not executable.
EOF
gh pr edit 48 --repo mentimeter/revops --body-file /tmp/pr-body.md
gh pr view 48 --repo mentimeter/revops --json url'""#;
        assert_eq!(
            classify_pr_relationship(Some(wrapped_edit), 48, 2, &remote),
            "worked"
        );
        assert_eq!(
            classify_pr_relationship(Some(wrapped_edit), 49, 2, &remote),
            "unverified",
            "an unrelated URL in command output must not inherit the edit target"
        );

        let prose_only = r#"cat <<'EOF'
Run git push and gh pr create when this draft is ready.
EOF
printf 'saved\n'"#;
        assert_eq!(
            classify_pr_relationship(Some(prose_only), 50, 1, &remote),
            "unverified"
        );

        let other_repo = "gh pr edit 48 --repo other/revops --body-file /tmp/pr-body.md";
        assert_eq!(
            classify_pr_relationship(Some(other_repo), 48, 1, &remote),
            "unverified"
        );

        let create_with_issue_title = "gh pr create --title \"Fix #123\" --fill";
        assert!(explicit_pr_targets(create_with_issue_title, &remote).is_empty());
        assert_eq!(
            classify_pr_relationship(Some(create_with_issue_title), 762, 1, &remote),
            "worked"
        );
        assert!(explicit_pr_targets("gh pr edit --title \"Fix #123\" 762", &remote).is_empty());
        assert_eq!(
            explicit_pr_targets("gh pr edit 762 --title \"Fix #123\"", &remote),
            vec![(762, "worked")]
        );
        assert_eq!(
            explicit_pr_targets("gh pr merge --squash 762", &remote),
            vec![(762, "worked")]
        );
        assert_eq!(
            explicit_pr_targets("gh pr view --web 762", &remote),
            vec![(762, "referenced")]
        );

        let substitution = "PR_URL=$(gh pr create --fill); echo \"$PR_URL\"";
        assert_eq!(
            classify_pr_relationship(Some(substitution), 763, 1, &remote),
            "worked"
        );
        assert!(explicit_pr_targets("echo '$(gh pr edit 123)'", &remote).is_empty());
        assert!(
            explicit_pr_targets("printf 'safe; gh pr edit 124 && git push'", &remote).is_empty()
        );

        let changed_repo = "cd ../other-repo && gh pr edit 48 --body-file /tmp/body";
        assert!(explicit_pr_targets(changed_repo, &remote).is_empty());
        assert_eq!(
            classify_pr_relationship(Some(changed_repo), 48, 1, &remote),
            "worked",
            "an exact-project result URL may restore scope after cd"
        );
        let env_scoped = "GH_REPO=other/revops gh pr edit 48";
        assert!(explicit_pr_targets(env_scoped, &remote).is_empty());
        assert_eq!(
            classify_pr_relationship(Some(env_scoped), 48, 1, &remote),
            "unverified"
        );
    }

    #[test]
    fn evidence_repair_records_successful_work_once_and_suppresses_failure() {
        let (_dir, database) = open_db();
        let (session_id, _) = fixture(&database, "/tmp/argmax-gh-evidence-repair");
        let conn = database.connection();
        crate::persistence::projects::update_project_remote(
            &conn,
            "p1",
            Some(&ProjectRemote {
                owner: "mentimeter".to_owned(),
                name: "argmax".to_owned(),
            }),
        )
        .unwrap();
        persist_timeline_event(
            &conn,
            &PersistTimelineEventInput {
                id: "push-success".to_owned(),
                session_id: session_id.clone(),
                r#type: "command.completed".to_owned(),
                message: "tool_result".to_owned(),
                payload: serde_json::json!({
                    "input": {"command": "git push -u origin feature/x"},
                    "content": "https://github.com/mentimeter/argmax/pull/42",
                    "exit_code": 0
                }),
                created_at: Some("2026-05-24T10:00:00Z".to_owned()),
            },
        )
        .unwrap();
        persist_timeline_event(
            &conn,
            &PersistTimelineEventInput {
                id: "push-failed".to_owned(),
                session_id: session_id.clone(),
                r#type: "command.completed".to_owned(),
                message: "tool_result".to_owned(),
                payload: serde_json::json!({
                    "input": {"command": "git push"},
                    "content": "https://github.com/mentimeter/argmax/pull/43",
                    "exit_code": 1
                }),
                created_at: Some("2026-05-24T10:01:00Z".to_owned()),
            },
        )
        .unwrap();

        assert_eq!(
            repair_session_pr_evidence(&conn, &session_id).unwrap(),
            vec![42]
        );
        assert!(repair_session_pr_evidence(&conn, &session_id)
            .unwrap()
            .is_empty());
        let prs = crate::persistence::gh::list_session_prs(&conn, &session_id).unwrap();
        assert_eq!(prs.len(), 1);
        assert_eq!(prs[0].relationship, "worked");
        let evidence_count: i64 = conn
            .query_row("SELECT COUNT(*) FROM session_pr_evidence", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(evidence_count, 1);
    }

    #[test]
    fn evidence_repair_reads_provider_results_without_treating_title_numbers_as_prs() {
        let (_dir, database) = open_db();
        let (session_id, _) = fixture(&database, "/tmp/argmax-gh-provider-results");
        let conn = database.connection();
        crate::persistence::projects::update_project_remote(
            &conn,
            "p1",
            Some(&ProjectRemote {
                owner: "mentimeter".to_owned(),
                name: "argmax".to_owned(),
            }),
        )
        .unwrap();
        persist_timeline_event(
            &conn,
            &PersistTimelineEventInput {
                id: "opencode-create".to_owned(),
                session_id: session_id.clone(),
                r#type: "command.completed".to_owned(),
                message: "Bash".to_owned(),
                payload: serde_json::json!({
                    "input": {"command": "gh pr create --title \"Fix #123\" --fill"},
                    "result": "https://github.com/mentimeter/argmax/pull/762"
                }),
                created_at: Some("2026-05-24T10:00:00Z".to_owned()),
            },
        )
        .unwrap();
        persist_timeline_event(
            &conn,
            &PersistTimelineEventInput {
                id: "cursor-create".to_owned(),
                session_id: session_id.clone(),
                r#type: "command.completed".to_owned(),
                message: "Shell".to_owned(),
                payload: serde_json::json!({
                    "input": {"command": "PR_URL=$(gh pr create --fill); echo \"$PR_URL\""},
                    "result": {"content": [{"text": "https://github.com/mentimeter/argmax/pull/763"}]},
                    "status": "completed"
                }),
                created_at: Some("2026-05-24T10:01:00Z".to_owned()),
            },
        )
        .unwrap();

        assert_eq!(
            repair_session_pr_evidence(&conn, &session_id).unwrap(),
            vec![762, 763]
        );
        let prs = crate::persistence::gh::list_session_prs(&conn, &session_id).unwrap();
        assert_eq!(prs.len(), 2);
        assert!(prs.iter().all(|pr| pr.relationship == "worked"));
        assert!(prs.iter().all(|pr| pr.pr_number != 123));
    }

    #[test]
    fn evidence_repair_upgrades_when_a_correlated_heredoc_command_arrives_late() {
        let (_dir, database) = open_db();
        let (session_id, _) = fixture(&database, "/tmp/argmax-gh-late-command");
        let conn = database.connection();
        crate::persistence::projects::update_project_remote(
            &conn,
            "p1",
            Some(&ProjectRemote {
                owner: "mentimeter".to_owned(),
                name: "argmax".to_owned(),
            }),
        )
        .unwrap();
        persist_timeline_event(
            &conn,
            &PersistTimelineEventInput {
                id: "create-completed".to_owned(),
                session_id: session_id.clone(),
                r#type: "command.completed".to_owned(),
                message: "tool_result".to_owned(),
                payload: serde_json::json!({
                    "content": "https://github.com/mentimeter/argmax/pull/42",
                    "is_error": false,
                    "providerInvocationId": "invocation-1",
                    "id": "tool-create"
                }),
                created_at: Some("2026-05-24T10:00:00Z".to_owned()),
            },
        )
        .unwrap();

        assert_eq!(
            repair_session_pr_evidence(&conn, &session_id).unwrap(),
            vec![42]
        );
        assert_eq!(
            crate::persistence::gh::list_session_prs(&conn, &session_id).unwrap()[0].relationship,
            "unverified"
        );

        persist_timeline_event(
            &conn,
            &PersistTimelineEventInput {
                id: "create-started".to_owned(),
                session_id: session_id.clone(),
                r#type: "command.started".to_owned(),
                message: "Bash".to_owned(),
                payload: serde_json::json!({
                    "id": "tool-create",
                    "providerInvocationId": "invocation-1",
                    "input": {
                        "command": "cat > /tmp/pr-body.md <<'EOF'\nBody mentions gh pr view 99\nEOF\ngh pr create --base main --head feature/x --body-file /tmp/pr-body.md 2>&1 | tail -5"
                    }
                }),
                created_at: Some("2026-05-24T09:59:00Z".to_owned()),
            },
        )
        .unwrap();

        assert_eq!(
            repair_session_pr_evidence(&conn, &session_id).unwrap(),
            vec![42]
        );
        let prs = crate::persistence::gh::list_session_prs(&conn, &session_id).unwrap();
        assert_eq!(prs[0].relationship, "worked");
        assert_eq!(
            prs[0].activity_at, "2026-05-24T10:00:00Z",
            "the completed event time remains the meaningful activity time"
        );

        persist_timeline_event(
            &conn,
            &PersistTimelineEventInput {
                id: "view-completed".to_owned(),
                session_id: session_id.clone(),
                r#type: "command.completed".to_owned(),
                message: "command_execution".to_owned(),
                payload: serde_json::json!({
                    "command": "/bin/zsh -lc \"gh pr view 48 --repo mentimeter/argmax --json state\"",
                    "aggregated_output": "{\"state\":\"OPEN\"}",
                    "exit_code": 0
                }),
                created_at: Some("2026-05-24T10:02:00Z".to_owned()),
            },
        )
        .unwrap();
        persist_timeline_event(
            &conn,
            &PersistTimelineEventInput {
                id: "other-repo-view".to_owned(),
                session_id: session_id.clone(),
                r#type: "command.completed".to_owned(),
                message: "command_execution".to_owned(),
                payload: serde_json::json!({
                    "command": "gh pr view 49 --repo other/argmax --json state",
                    "aggregated_output": "{\"state\":\"OPEN\"}",
                    "exit_code": 0
                }),
                created_at: Some("2026-05-24T10:03:00Z".to_owned()),
            },
        )
        .unwrap();
        assert_eq!(
            repair_session_pr_evidence(&conn, &session_id).unwrap(),
            vec![48]
        );
        let prs = crate::persistence::gh::list_session_prs(&conn, &session_id).unwrap();
        let viewed_pr = prs
            .iter()
            .find(|pr| pr.pr_number == 48)
            .expect("explicit numeric view creates a reference without a URL");
        assert_eq!(viewed_pr.relationship, "referenced");
        assert_eq!(viewed_pr.activity_at, "2026-05-24T10:02:00Z");
        assert!(prs.iter().all(|pr| pr.pr_number != 49));
        assert!(repair_session_pr_evidence(&conn, &session_id)
            .unwrap()
            .is_empty());
    }

    #[tokio::test]
    async fn refresh_propagates_record_not_found_for_unknown_session() {
        let (_dir, database) = open_db();
        let stub = StubRunner::new(Vec::new());
        let service = GhService::with_runner(Arc::clone(&database), stub.runner());
        let err = service
            .refresh("missing")
            .await
            .expect_err("session lookup fails");
        match err {
            ArgmaxError::RecordNotFound { kind, .. } => assert_eq!(kind, "session"),
            other => panic!("unexpected error: {other:?}"),
        }
    }

    #[test]
    fn collapse_rollup_failure_dominates() {
        let rollup = vec![
            RollupEntry {
                state: Some("PENDING".to_string()),
                status: None,
                conclusion: None,
            },
            RollupEntry {
                state: None,
                status: None,
                conclusion: Some("FAILURE".to_string()),
            },
        ];
        assert_eq!(collapse_rollup(Some(&rollup)), GhCheckState::Failure);
    }

    #[test]
    fn collapse_rollup_all_skipped_is_skipped() {
        let rollup = vec![
            RollupEntry {
                state: None,
                status: None,
                conclusion: Some("skipped".to_string()),
            },
            RollupEntry {
                state: None,
                status: None,
                conclusion: Some("neutral".to_string()),
            },
        ];
        assert_eq!(collapse_rollup(Some(&rollup)), GhCheckState::Skipped);
    }

    #[test]
    fn collapse_rollup_empty_is_unknown() {
        assert_eq!(collapse_rollup(None), GhCheckState::Unknown);
        assert_eq!(collapse_rollup(Some(&[])), GhCheckState::Unknown);
    }

    #[test]
    fn normalize_pr_state_passes_canonical_values() {
        assert_eq!(normalize_pr_state(Some("open")).as_deref(), Some("OPEN"));
        assert_eq!(
            normalize_pr_state(Some("MERGED")).as_deref(),
            Some("MERGED")
        );
        assert!(normalize_pr_state(Some("draft")).is_none());
        assert!(normalize_pr_state(None).is_none());
    }

    #[test]
    fn gh_error_category_buckets_known_messages() {
        let auth = ArgmaxError::service("GH_NON_ZERO_EXIT", "gh failed: not authenticated");
        assert_eq!(gh_error_category(&auth), GhErrorCategory::Auth);
        let rate = ArgmaxError::service("GH_NON_ZERO_EXIT", "gh failed: API rate limit exceeded");
        assert_eq!(gh_error_category(&rate), GhErrorCategory::RateLimit);
        let no_pr = ArgmaxError::service("GH_NON_ZERO_EXIT", "gh failed: no pull requests found");
        assert_eq!(gh_error_category(&no_pr), GhErrorCategory::NoPr);
        let unknown = ArgmaxError::service("GH_NON_ZERO_EXIT", "something completely different");
        assert_eq!(gh_error_category(&unknown), GhErrorCategory::Unknown);
    }
}
