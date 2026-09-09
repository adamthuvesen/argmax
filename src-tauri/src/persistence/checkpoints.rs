use rusqlite::{Connection, Row};
use serde::Serialize;
use specta::Type;

use super::{json_error, sqlite_error, time::now_iso};
use crate::error::{ArgmaxError, ArgmaxResult};

/// Append-only migration body for the former, incomplete checkpoint marker.
/// The original table never retained a tree or an index, so old rows remain
/// listable as legacy markers but cannot be rewound (`head_sha` is empty).
pub const MIGRATION_SQL: &str = r#"
ALTER TABLE checkpoints ADD COLUMN session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL;
ALTER TABLE checkpoints ADD COLUMN head_sha TEXT NOT NULL DEFAULT '';
ALTER TABLE checkpoints ADD COLUMN worktree_tree TEXT NOT NULL DEFAULT '';
ALTER TABLE checkpoints ADD COLUMN index_tree TEXT NOT NULL DEFAULT '';
ALTER TABLE checkpoints ADD COLUMN untracked_paths_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE checkpoints ADD COLUMN turn_boundary TEXT;
ALTER TABLE checkpoints ADD COLUMN provider_conversation_id TEXT;
ALTER TABLE checkpoints ADD COLUMN recovery_of TEXT REFERENCES checkpoints(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_checkpoints_workspace_created_id
  ON checkpoints(workspace_id, created_at DESC, id DESC);

CREATE TABLE checkpoint_rewinds (
  id TEXT PRIMARY KEY,
  checkpoint_id TEXT NOT NULL REFERENCES checkpoints(id) ON DELETE RESTRICT,
  recovery_checkpoint_id TEXT NOT NULL REFERENCES checkpoints(id) ON DELETE RESTRICT,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('running', 'complete', 'failed')),
  failure TEXT,
  started_at TEXT NOT NULL,
  completed_at TEXT
);
CREATE INDEX idx_checkpoint_rewinds_running
  ON checkpoint_rewinds(status, started_at);
"#;

#[derive(Debug, Clone, PartialEq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Checkpoint {
    pub id: String,
    pub workspace_id: String,
    pub session_id: Option<String>,
    pub label: String,
    pub branch: String,
    pub head_sha: String,
    pub worktree_tree: String,
    pub index_tree: String,
    pub untracked_paths: Vec<String>,
    pub turn_boundary: Option<String>,
    pub provider_conversation_id: Option<String>,
    pub recovery_of: Option<String>,
    pub created_at: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct PersistCheckpointInput {
    pub checkpoint: Checkpoint,
}

pub fn persist_checkpoint(
    connection: &Connection,
    input: &PersistCheckpointInput,
) -> ArgmaxResult<Checkpoint> {
    let checkpoint = &input.checkpoint;
    let untracked_paths = serde_json::to_string(&checkpoint.untracked_paths).map_err(json_error)?;
    connection
        .prepare_cached(
            r#"
            INSERT INTO checkpoints (
                id, workspace_id, session_id, label, branch, head_sha,
                worktree_tree, index_tree, untracked_paths_json, turn_boundary,
                provider_conversation_id, recovery_of, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            "#,
        )
        .map_err(sqlite_error)?
        .execute((
            checkpoint.id.as_str(),
            checkpoint.workspace_id.as_str(),
            checkpoint.session_id.as_deref(),
            checkpoint.label.as_str(),
            checkpoint.branch.as_str(),
            checkpoint.head_sha.as_str(),
            checkpoint.worktree_tree.as_str(),
            checkpoint.index_tree.as_str(),
            untracked_paths,
            checkpoint.turn_boundary.as_deref(),
            checkpoint.provider_conversation_id.as_deref(),
            checkpoint.recovery_of.as_deref(),
            checkpoint.created_at.as_str(),
        ))
        .map_err(sqlite_error)?;
    Ok(checkpoint.clone())
}

pub fn find_checkpoint(connection: &Connection, checkpoint_id: &str) -> ArgmaxResult<Checkpoint> {
    let mut statement = connection
        .prepare_cached("SELECT * FROM checkpoints WHERE id = ?")
        .map_err(sqlite_error)?;
    match statement.query_row([checkpoint_id], checkpoint_from_row) {
        Ok(checkpoint) => Ok(checkpoint),
        Err(rusqlite::Error::QueryReturnedNoRows) => {
            Err(ArgmaxError::record_not_found("checkpoint", checkpoint_id))
        }
        Err(error) => Err(sqlite_error(error)),
    }
}

pub fn list_checkpoints(
    connection: &Connection,
    workspace_id: &str,
    limit: usize,
) -> ArgmaxResult<Vec<Checkpoint>> {
    let mut statement = connection
        .prepare_cached(
            "SELECT * FROM checkpoints WHERE workspace_id = ? ORDER BY created_at DESC, id DESC LIMIT ?",
        )
        .map_err(sqlite_error)?;
    let checkpoints = statement
        .query_map((workspace_id, limit as i64), checkpoint_from_row)
        .map_err(sqlite_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(sqlite_error)?;
    Ok(checkpoints)
}

pub fn start_rewind(
    connection: &Connection,
    rewind_id: &str,
    checkpoint_id: &str,
    recovery_checkpoint_id: &str,
    workspace_id: &str,
) -> ArgmaxResult<()> {
    connection
        .prepare_cached(
            "INSERT INTO checkpoint_rewinds (id, checkpoint_id, recovery_checkpoint_id, workspace_id, status, failure, started_at, completed_at) VALUES (?, ?, ?, ?, 'running', NULL, ?, NULL)",
        )
        .map_err(sqlite_error)?
        .execute((rewind_id, checkpoint_id, recovery_checkpoint_id, workspace_id, now_iso()))
        .map_err(sqlite_error)?;
    Ok(())
}

pub fn finish_rewind(
    connection: &Connection,
    rewind_id: &str,
    failure: Option<&str>,
) -> ArgmaxResult<()> {
    let status = if failure.is_some() {
        "failed"
    } else {
        "complete"
    };
    let changed = connection
        .prepare_cached(
            "UPDATE checkpoint_rewinds SET status = ?, failure = ?, completed_at = ? WHERE id = ? AND status = 'running'",
        )
        .map_err(sqlite_error)?
        .execute((status, failure, now_iso(), rewind_id))
        .map_err(sqlite_error)?;
    if changed == 0 {
        return Err(ArgmaxError::service(
            "CHECKPOINT_REWIND_JOURNAL_MISSING",
            "rewind journal was not running",
        ));
    }
    Ok(())
}

/// A process cannot prove where a filesystem restore stopped after a crash.
/// Preserve that uncertainty for the recovery UI instead of calling it a
/// success on the next boot.
pub fn mark_interrupted_rewinds(connection: &Connection) -> ArgmaxResult<usize> {
    connection
        .prepare_cached(
            "UPDATE checkpoint_rewinds SET status = 'failed', failure = 'Interrupted by application restart; restore the recovery checkpoint before continuing.', completed_at = ? WHERE status = 'running'",
        )
        .map_err(sqlite_error)?
        .execute([now_iso()])
        .map_err(sqlite_error)
}

fn checkpoint_from_row(row: &Row<'_>) -> rusqlite::Result<Checkpoint> {
    let untracked_paths_json: String = row.get("untracked_paths_json")?;
    let untracked_paths = serde_json::from_str(&untracked_paths_json).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(error))
    })?;
    Ok(Checkpoint {
        id: row.get("id")?,
        workspace_id: row.get("workspace_id")?,
        session_id: row.get("session_id")?,
        label: row.get("label")?,
        branch: row.get("branch")?,
        head_sha: row.get("head_sha")?,
        worktree_tree: row.get("worktree_tree")?,
        index_tree: row.get("index_tree")?,
        untracked_paths,
        turn_boundary: row.get("turn_boundary")?,
        provider_conversation_id: row.get("provider_conversation_id")?,
        recovery_of: row.get("recovery_of")?,
        created_at: row.get("created_at")?,
    })
}
