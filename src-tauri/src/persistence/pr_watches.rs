// PR watches: a session's request to be woken about one pull request until it
// merges, closes, or is unwatched (docs/gh.md#pr-watch). The gh poller reads
// these rows on its own tick and is the only writer of their cursors.

use std::collections::BTreeMap;

use rusqlite::{params, Connection, OptionalExtension, Row};

use super::{json_error, sqlite_error, time::now_iso};
use crate::error::ArgmaxResult;

/// Registered by migration v62. `seen_feedback_ids` stays NULL until the
/// poller's first pass seeds it with the feedback that predates the watch.
/// `pending_notice_*` is an outbox: a notice is staged together with the
/// cursors it advances, then delivered, then cleared, so a crash between the
/// two redelivers that exact notice instead of rebuilding it.
pub const MIGRATION_SQL: &str = r#"
CREATE TABLE pr_watches (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  pr_number INTEGER NOT NULL CHECK (pr_number > 0),
  cleanup_on_merge INTEGER NOT NULL DEFAULT 0 CHECK (cleanup_on_merge IN (0, 1)),
  head_sha TEXT NOT NULL DEFAULT '',
  seen_check_failures TEXT NOT NULL DEFAULT '[]',
  seen_feedback_ids TEXT,
  reported_ready_sha TEXT,
  last_pr_updated_at TEXT,
  notice_seq INTEGER NOT NULL DEFAULT 0,
  pending_notice_id TEXT,
  pending_notice_body TEXT,
  pending_ends_watch INTEGER NOT NULL DEFAULT 0 CHECK (pending_ends_watch IN (0, 1)),
  not_found_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (session_id, project_id, pr_number)
);
CREATE INDEX idx_pr_watches_project_pr ON pr_watches(project_id, pr_number);
"#;

/// Whether the last decisive `mergeable` read said the PR conflicts with its
/// base. A watch holds `None` until a read says `MERGEABLE` or `CONFLICTING`.
/// `UNKNOWN`, which GitHub reports while it recomputes, never writes one, so a
/// slow recompute cannot invent a transition. Added by migration v63.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConflictState {
    Clean,
    Conflicting,
}

impl ConflictState {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Clean => "clean",
            Self::Conflicting => "conflicting",
        }
    }

    fn from_column(value: Option<String>) -> Option<Self> {
        match value.as_deref() {
            Some("clean") => Some(Self::Clean),
            Some("conflicting") => Some(Self::Conflicting),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PrWatchRecord {
    pub id: String,
    pub session_id: String,
    pub project_id: String,
    pub pr_number: i64,
    /// Run PR cleanup when the PR merges, before the merged notice.
    pub cleanup_on_merge: bool,
    pub head_sha: String,
    /// `name@sha` of every failing check already reported for `head_sha`.
    pub seen_check_failures: Vec<String>,
    /// Review, comment, and review-thread comment ids already reported or
    /// seeded. `None` until the first pass has seeded it.
    pub seen_feedback_ids: Option<Vec<String>>,
    /// Full feedback content hashes. NULL until the first pass after v70.
    pub feedback_fingerprints: Option<BTreeMap<String, String>>,
    pub fetch_failure_count: i64,
    /// Whether a degraded-watch notice was staged for this failure streak.
    pub fetch_degraded: bool,
    pub reported_ready_sha: Option<String>,
    pub last_pr_updated_at: Option<String>,
    /// The conflict state last reported or seeded; see [`ConflictState`].
    pub conflict_state: Option<ConflictState>,
    /// Notices staged so far. Each notice id carries the next value, so a head
    /// that returns to an earlier sha still gets a fresh id.
    pub notice_seq: i64,
    /// A notice staged but not yet confirmed delivered.
    pub pending_notice: Option<PendingPrWatchNotice>,
    /// Consecutive ticks on which GitHub had no such PR.
    pub not_found_count: i64,
    pub created_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PendingPrWatchNotice {
    pub id: String,
    pub body: String,
    pub ends_watch: bool,
}

/// The cursors one watch pass moves forward, written only after its notice is
/// stored (or when the pass had nothing to report).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PrWatchCursors {
    pub head_sha: String,
    pub seen_check_failures: Vec<String>,
    pub seen_feedback_ids: Vec<String>,
    pub feedback_fingerprints: BTreeMap<String, String>,
    pub fetch_failure_count: i64,
    pub fetch_degraded: bool,
    pub reported_ready_sha: Option<String>,
    pub last_pr_updated_at: Option<String>,
    pub conflict_state: Option<ConflictState>,
}

/// Creates the watch, or updates its options when this session already
/// watches this PR. The cursors of an existing watch are kept.
pub fn upsert_pr_watch(
    connection: &Connection,
    id: &str,
    session_id: &str,
    project_id: &str,
    pr_number: i64,
    cleanup_on_merge: bool,
    head_sha: &str,
) -> ArgmaxResult<PrWatchRecord> {
    let timestamp = now_iso();
    connection
        .prepare_cached(
            r#"
            INSERT INTO pr_watches (
              id, session_id, project_id, pr_number, cleanup_on_merge, head_sha,
              created_at, updated_at
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)
            ON CONFLICT(session_id, project_id, pr_number) DO UPDATE SET
              cleanup_on_merge = excluded.cleanup_on_merge,
              updated_at = excluded.updated_at
            "#,
        )
        .map_err(sqlite_error)?
        .execute(params![
            id,
            session_id,
            project_id,
            pr_number,
            cleanup_on_merge,
            head_sha,
            timestamp
        ])
        .map_err(sqlite_error)?;
    find_pr_watch(connection, session_id, project_id, pr_number)?.ok_or_else(|| {
        crate::error::ArgmaxError::service("PR_WATCH_MISSING", "the PR watch was not stored")
    })
}

pub fn find_pr_watch(
    connection: &Connection,
    session_id: &str,
    project_id: &str,
    pr_number: i64,
) -> ArgmaxResult<Option<PrWatchRecord>> {
    connection
        .prepare_cached(&format!(
            "SELECT {COLUMNS} FROM pr_watches
             WHERE session_id = ?1 AND project_id = ?2 AND pr_number = ?3"
        ))
        .map_err(sqlite_error)?
        .query_row(params![session_id, project_id, pr_number], row_to_watch)
        .optional()
        .map_err(sqlite_error)?
        .transpose()
}

pub fn delete_pr_watch(
    connection: &Connection,
    session_id: &str,
    project_id: &str,
    pr_number: i64,
) -> ArgmaxResult<bool> {
    let removed = connection
        .prepare_cached(
            "DELETE FROM pr_watches WHERE session_id = ?1 AND project_id = ?2 AND pr_number = ?3",
        )
        .map_err(sqlite_error)?
        .execute(params![session_id, project_id, pr_number])
        .map_err(sqlite_error)?;
    Ok(removed > 0)
}

pub fn delete_pr_watch_by_id(connection: &Connection, id: &str) -> ArgmaxResult<()> {
    connection
        .prepare_cached("DELETE FROM pr_watches WHERE id = ?1")
        .map_err(sqlite_error)?
        .execute([id])
        .map_err(sqlite_error)?;
    Ok(())
}

pub fn list_pr_watches(connection: &Connection) -> ArgmaxResult<Vec<PrWatchRecord>> {
    let mut statement = connection
        .prepare_cached(&format!(
            "SELECT {COLUMNS} FROM pr_watches ORDER BY created_at ASC, id ASC"
        ))
        .map_err(sqlite_error)?;
    let rows = statement
        .query_map([], row_to_watch)
        .map_err(sqlite_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(sqlite_error)?;
    rows.into_iter().collect()
}

/// Any watch on this PR, from any session. The watching session owns the fix,
/// so the check-failure follow-up stands down.
pub fn pr_has_watch(
    connection: &Connection,
    project_id: &str,
    pr_number: i64,
) -> ArgmaxResult<bool> {
    connection
        .prepare_cached(
            "SELECT EXISTS(SELECT 1 FROM pr_watches WHERE project_id = ?1 AND pr_number = ?2)",
        )
        .map_err(sqlite_error)?
        .query_row(params![project_id, pr_number], |row| row.get(0))
        .map_err(sqlite_error)
}

pub fn update_pr_watch_cursors(
    connection: &Connection,
    id: &str,
    cursors: &PrWatchCursors,
) -> ArgmaxResult<()> {
    connection
        .prepare_cached(
            r#"
            UPDATE pr_watches SET
              head_sha = ?2,
              seen_check_failures = ?3,
              seen_feedback_ids = ?4,
              reported_ready_sha = ?5,
              last_pr_updated_at = ?6,
              conflict_state = ?8,
              feedback_fingerprints = ?9,
              fetch_failure_count = ?10,
              fetch_degraded = ?11,
              updated_at = ?7
            WHERE id = ?1
            "#,
        )
        .map_err(sqlite_error)?
        .execute(params![
            id,
            cursors.head_sha,
            serde_json::to_string(&cursors.seen_check_failures).map_err(json_error)?,
            serde_json::to_string(&cursors.seen_feedback_ids).map_err(json_error)?,
            cursors.reported_ready_sha,
            cursors.last_pr_updated_at,
            now_iso(),
            cursors.conflict_state.map(ConflictState::as_str),
            serde_json::to_string(&cursors.feedback_fingerprints).map_err(json_error)?,
            cursors.fetch_failure_count,
            cursors.fetch_degraded,
        ])
        .map_err(sqlite_error)?;
    Ok(())
}

/// Advances the cursors and stages one notice in a single statement, so the
/// notice exists exactly when its cursors have moved.
pub fn stage_pr_watch_notice(
    connection: &Connection,
    id: &str,
    cursors: &PrWatchCursors,
    notice: &PendingPrWatchNotice,
) -> ArgmaxResult<()> {
    connection
        .prepare_cached(
            r#"
            UPDATE pr_watches SET
              head_sha = ?2,
              seen_check_failures = ?3,
              seen_feedback_ids = ?4,
              reported_ready_sha = ?5,
              last_pr_updated_at = ?6,
              notice_seq = notice_seq + 1,
              pending_notice_id = ?7,
              pending_notice_body = ?8,
              pending_ends_watch = ?9,
              updated_at = ?10,
              conflict_state = ?11,
              feedback_fingerprints = ?12,
              fetch_failure_count = ?13,
              fetch_degraded = ?14
            WHERE id = ?1
            "#,
        )
        .map_err(sqlite_error)?
        .execute(params![
            id,
            cursors.head_sha,
            serde_json::to_string(&cursors.seen_check_failures).map_err(json_error)?,
            serde_json::to_string(&cursors.seen_feedback_ids).map_err(json_error)?,
            cursors.reported_ready_sha,
            cursors.last_pr_updated_at,
            notice.id,
            notice.body,
            notice.ends_watch,
            now_iso(),
            cursors.conflict_state.map(ConflictState::as_str),
            serde_json::to_string(&cursors.feedback_fingerprints).map_err(json_error)?,
            cursors.fetch_failure_count,
            cursors.fetch_degraded,
        ])
        .map_err(sqlite_error)?;
    Ok(())
}

/// The staged notice reached the inbox.
pub fn clear_pr_watch_notice(connection: &Connection, id: &str) -> ArgmaxResult<()> {
    connection
        .prepare_cached(
            "UPDATE pr_watches SET pending_notice_id = NULL, pending_notice_body = NULL,
             pending_ends_watch = 0 WHERE id = ?1",
        )
        .map_err(sqlite_error)?
        .execute([id])
        .map_err(sqlite_error)?;
    Ok(())
}

pub fn set_pr_watch_not_found_count(
    connection: &Connection,
    id: &str,
    count: i64,
) -> ArgmaxResult<()> {
    connection
        .prepare_cached("UPDATE pr_watches SET not_found_count = ?2 WHERE id = ?1")
        .map_err(sqlite_error)?
        .execute(params![id, count])
        .map_err(sqlite_error)?;
    Ok(())
}

/// A failed read must preserve unseeded feedback cursors. Stage its health
/// notice with the failure state in one write, using the same outbox.
pub fn record_pr_watch_fetch_failure(
    connection: &Connection,
    id: &str,
    count: i64,
    degraded: bool,
    notice: Option<&PendingPrWatchNotice>,
) -> ArgmaxResult<()> {
    connection
        .prepare_cached(
            "UPDATE pr_watches SET fetch_failure_count = ?2, fetch_degraded = ?3,
             notice_seq = notice_seq + CASE WHEN ?4 IS NULL THEN 0 ELSE 1 END,
             pending_notice_id = ?4, pending_notice_body = ?5, pending_ends_watch = 0,
             updated_at = ?6 WHERE id = ?1",
        )
        .map_err(sqlite_error)?
        .execute(params![
            id,
            count,
            degraded,
            notice.map(|notice| notice.id.as_str()),
            notice.map(|notice| notice.body.as_str()),
            now_iso(),
        ])
        .map_err(sqlite_error)?;
    Ok(())
}

const COLUMNS: &str = "id, session_id, project_id, pr_number, cleanup_on_merge, head_sha, \
     seen_check_failures, seen_feedback_ids, reported_ready_sha, last_pr_updated_at, created_at, \
     notice_seq, pending_notice_id, pending_notice_body, pending_ends_watch, not_found_count, \
     conflict_state, feedback_fingerprints, fetch_failure_count, fetch_degraded";

/// The JSON cursors decode outside rusqlite's error type, so a corrupt row
/// surfaces as an `ArgmaxError` rather than a column-type error.
fn row_to_watch(row: &Row<'_>) -> rusqlite::Result<ArgmaxResult<PrWatchRecord>> {
    let seen_check_failures: String = row.get(6)?;
    let seen_feedback_ids: Option<String> = row.get(7)?;
    let fingerprints: Option<String> = row.get(17)?;
    let feedback_fingerprints = match fingerprints
        .as_deref()
        .map(serde_json::from_str)
        .transpose()
    {
        Ok(value) => value,
        Err(error) => return Ok(Err(json_error(error))),
    };
    let decoded = serde_json::from_str(&seen_check_failures).and_then(|failures| {
        seen_feedback_ids
            .as_deref()
            .map(serde_json::from_str)
            .transpose()
            .map(|ids| (failures, ids))
    });
    let (seen_check_failures, seen_feedback_ids) = match decoded {
        Ok(cursors) => cursors,
        Err(error) => return Ok(Err(json_error(error))),
    };
    let pending_id: Option<String> = row.get(12)?;
    let pending_body: Option<String> = row.get(13)?;
    let pending_notice = match (pending_id, pending_body) {
        (Some(id), Some(body)) => Some(PendingPrWatchNotice {
            id,
            body,
            ends_watch: row.get(14)?,
        }),
        _ => None,
    };
    Ok(Ok(PrWatchRecord {
        id: row.get(0)?,
        session_id: row.get(1)?,
        project_id: row.get(2)?,
        pr_number: row.get(3)?,
        cleanup_on_merge: row.get(4)?,
        head_sha: row.get(5)?,
        seen_check_failures,
        seen_feedback_ids,
        feedback_fingerprints,
        fetch_failure_count: row.get(18)?,
        fetch_degraded: row.get(19)?,
        reported_ready_sha: row.get(8)?,
        last_pr_updated_at: row.get(9)?,
        created_at: row.get(10)?,
        notice_seq: row.get(11)?,
        pending_notice,
        not_found_count: row.get(15)?,
        conflict_state: ConflictState::from_column(row.get(16)?),
    }))
}

/// The canonical GitHub state a watch pass reads, as the poller's own refresh
/// left it this tick.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WatchedPrState {
    pub head_sha: String,
    pub check_state: String,
    pub pr_state: Option<String>,
    pub title: Option<String>,
    pub url: Option<String>,
    pub refreshed_at: String,
    pub refresh_error: Option<String>,
}

pub fn watched_pr_state(
    connection: &Connection,
    project_id: &str,
    pr_number: i64,
) -> ArgmaxResult<Option<WatchedPrState>> {
    connection
        .prepare_cached(
            "SELECT head_sha, last_seen_check_state, pr_state, title, url, refreshed_at, refresh_error
             FROM gh_pull_requests WHERE project_id = ?1 AND pr_number = ?2",
        )
        .map_err(sqlite_error)?
        .query_row(params![project_id, pr_number], |row| {
            Ok(WatchedPrState {
                head_sha: row.get(0)?,
                check_state: row.get(1)?,
                pr_state: row.get(2)?,
                title: row.get(3)?,
                url: row.get(4)?,
                refreshed_at: row.get(5)?,
                refresh_error: row.get(6)?,
            })
        })
        .optional()
        .map_err(sqlite_error)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::persistence::database::Database;

    fn seed(connection: &Connection) {
        connection
            .execute_batch(
                "INSERT INTO projects (id, name, repo_path, current_branch, worktree_location, created_at, updated_at)
                   VALUES ('p1', 'p1', '/tmp/p1', 'main', 'sibling', '2026-01-01', '2026-01-01');
                 INSERT INTO workspaces (id, project_id, task_label, branch, base_ref, path, state, last_activity_at, created_at, updated_at)
                   VALUES ('w1', 'p1', 'w', 'b', 'main', '/tmp/p1', 'running', '2026-01-01', '2026-01-01', '2026-01-01');
                 INSERT INTO sessions (id, workspace_id, provider, model_label, prompt, state, attention, started_at, last_activity_at)
                   VALUES ('s1', 'w1', 'claude', 'm', 'p', 'running', 'normal', '2026-01-01', '2026-01-01');",
            )
            .expect("seed");
    }

    #[test]
    fn a_second_watch_updates_options_and_keeps_cursors() {
        let database = Database::open_in_memory().expect("database");
        let connection = database.connection();
        seed(&connection);

        let watch =
            upsert_pr_watch(&connection, "w-1", "s1", "p1", 42, false, "aaa").expect("watch");
        update_pr_watch_cursors(
            &connection,
            &watch.id,
            &PrWatchCursors {
                head_sha: "bbb".into(),
                seen_check_failures: vec!["build@bbb".into()],
                seen_feedback_ids: vec!["IC_1".into()],
                feedback_fingerprints: BTreeMap::from([("IC_1".into(), "hash".into())]),
                fetch_failure_count: 0,
                fetch_degraded: false,
                reported_ready_sha: None,
                last_pr_updated_at: Some("2026-10-01T00:00:00Z".into()),
                conflict_state: Some(ConflictState::Conflicting),
            },
        )
        .expect("cursors");

        let again =
            upsert_pr_watch(&connection, "w-2", "s1", "p1", 42, true, "ccc").expect("rewatch");
        assert_eq!(again.id, "w-1", "the same watch, not a second one");
        assert!(again.cleanup_on_merge);
        assert_eq!(again.head_sha, "bbb");
        assert_eq!(again.seen_check_failures, vec!["build@bbb".to_string()]);
        assert_eq!(again.seen_feedback_ids, Some(vec!["IC_1".to_string()]));
        assert_eq!(again.conflict_state, Some(ConflictState::Conflicting));
        assert!(pr_has_watch(&connection, "p1", 42).expect("lookup"));

        assert!(delete_pr_watch(&connection, "s1", "p1", 42).expect("unwatch"));
        assert!(!delete_pr_watch(&connection, "s1", "p1", 42).expect("unwatch twice"));
        assert!(list_pr_watches(&connection).expect("list").is_empty());
    }
}
