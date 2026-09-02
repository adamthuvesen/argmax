use rusqlite::{Connection, Row};
use serde::Serialize;
use specta::Type;

use super::time::now_iso;
use crate::error::{ArgmaxError, ArgmaxResult};

#[derive(Debug, Clone, PartialEq)]
pub struct PersistSessionInput {
    pub id: String,
    pub workspace_id: String,
    pub provider: String,
    pub model_label: String,
    pub model_id: String,
    pub reasoning_effort: Option<String>,
    pub permission_mode: Option<String>,
    pub agent_mode: Option<String>,
    pub prompt: String,
    pub state: String,
    pub attention: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct SessionModelInput {
    pub model_label: String,
    pub model_id: String,
    pub reasoning_effort: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct SessionProviderInput {
    pub provider: String,
    pub model_label: String,
    pub model_id: String,
    pub reasoning_effort: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct SessionAgentModeInput {
    pub agent_mode: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct SessionStateInput {
    pub state: String,
    pub attention: String,
    pub completed_at: Option<String>,
    pub last_activity_at: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct UsageCounts {
    pub input: i64,
    pub output: i64,
    pub cache_read: i64,
    pub cache_write: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SessionSummary {
    pub id: String,
    pub workspace_id: String,
    pub provider: String,
    pub model_label: String,
    pub model_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reasoning_effort: Option<String>,
    pub permission_mode: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent_mode: Option<String>,
    pub provider_conversation_id: Option<String>,
    pub prompt: String,
    pub state: String,
    pub attention: String,
    /// When `attention` last changed value. NULL on rows that predate the
    /// column. The sidebar's Priority section compares this against
    /// `WorkspaceSummary.priority_dismissed_at` to decide whether a dismissal
    /// is still current.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub attention_changed_at: Option<String>,
    pub started_at: String,
    pub completed_at: Option<String>,
    pub last_activity_at: String,
    pub cost_usd: f64,
    pub tokens: UsageCounts,
    /// Input-side tokens of the latest turn — the live context-window occupancy
    /// (overwritten each turn, not cumulative like `tokens`).
    pub context_tokens: i64,
    /// True when the session was imported from a provider CLI's own
    /// transcript store rather than launched by Argmax. Denormalized onto the
    /// row so dashboard reads need no join; see `synced_sessions`.
    pub imported: bool,
    /// The model's context-window size, when the provider reports it (Codex).
    /// The renderer falls back to a per-model table when this is null.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub context_window: Option<i64>,
    /// The session whose agent launched this one with the `argmax` MCP tools.
    /// Null for a session the user or a routine started.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub launched_by_session_id: Option<String>,
}

/// How far a session sits from a human-started one, and how many sessions it
/// has launched — the two numbers the launch caps are checked against.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct SessionLaunchLineage {
    pub depth: i64,
    pub launched: i64,
}

pub fn session_launch_lineage(
    connection: &Connection,
    session_id: &str,
) -> ArgmaxResult<SessionLaunchLineage> {
    connection
        .prepare_cached(
            r#"
        SELECT
          (SELECT launch_depth FROM sessions WHERE id = ?1),
          (SELECT COUNT(*) FROM sessions WHERE launched_by_session_id = ?1)
        "#,
        )
        .map_err(sqlite_error)?
        .query_row([session_id], |row| {
            Ok(SessionLaunchLineage {
                depth: row.get::<_, Option<i64>>(0)?.unwrap_or_default(),
                launched: row.get(1)?,
            })
        })
        .map_err(sqlite_error)
}

/// Record which session launched this one. Written after the launch settles,
/// so the launch path itself stays the one the sidebar and routines use.
pub fn record_session_launch(
    connection: &Connection,
    session_id: &str,
    launched_by_session_id: &str,
    depth: i64,
) -> ArgmaxResult<()> {
    connection
        .prepare_cached(
            "UPDATE sessions SET launched_by_session_id = ?, launch_depth = ? WHERE id = ?",
        )
        .map_err(sqlite_error)?
        .execute((launched_by_session_id, depth, session_id))
        .map_err(sqlite_error)?;
    Ok(())
}

pub fn list_sessions_for_dashboard(
    connection: &Connection,
    workspace_ids: Option<&[String]>,
    limit: usize,
) -> ArgmaxResult<Vec<SessionSummary>> {
    match workspace_ids {
        Some(ids) if !ids.is_empty() => {
            let json = serde_json::to_string(ids).map_err(json_error)?;
            let mut statement = connection.prepare_cached("SELECT * FROM sessions WHERE workspace_id IN (SELECT value FROM json_each(?)) ORDER BY last_activity_at DESC, id DESC LIMIT ?",
            )
            .map_err(sqlite_error)?;
            let rows = statement
                .query_map((json, limit as i64), session_row_to_summary)
                .map_err(sqlite_error)?
                .collect::<Result<Vec<_>, _>>()
                .map_err(sqlite_error)?;
            Ok(rows)
        }
        _ => {
            let mut statement = connection
                .prepare_cached(
                    r#"
                SELECT outer_s.*
                FROM sessions outer_s
                WHERE outer_s.id IN (
                    SELECT id FROM sessions
                    ORDER BY last_activity_at DESC, id DESC
                    LIMIT ?
                  )
                  OR (
                    outer_s.workspace_id IN (
                      SELECT id FROM workspaces
                      ORDER BY last_activity_at DESC, id DESC
                      LIMIT ?
                    )
                    AND NOT EXISTS (
                      SELECT 1 FROM sessions s2
                      WHERE s2.workspace_id = outer_s.workspace_id
                        AND (
                          s2.last_activity_at > outer_s.last_activity_at
                          OR (s2.last_activity_at = outer_s.last_activity_at AND s2.id > outer_s.id)
                        )
                    )
                  )
                ORDER BY outer_s.last_activity_at DESC, outer_s.id DESC
                "#,
                )
                .map_err(sqlite_error)?;
            let rows = statement
                .query_map((limit as i64, limit as i64), session_row_to_summary)
                .map_err(sqlite_error)?
                .collect::<Result<Vec<_>, _>>()
                .map_err(sqlite_error)?;
            Ok(rows)
        }
    }
}

pub fn persist_session(
    connection: &Connection,
    input: &PersistSessionInput,
) -> ArgmaxResult<SessionSummary> {
    let timestamp = now_iso();
    let mut statement = connection.prepare_cached(r#"
        INSERT INTO sessions (
          id, workspace_id, provider, model_label, model_id, reasoning_effort, permission_mode, agent_mode,
          provider_conversation_id, prompt, state, attention, attention_changed_at,
          started_at, completed_at, last_activity_at
        ) VALUES (
          ?, ?, ?, ?, ?, ?, ?, ?,
          NULL, ?, ?, ?, ?,
          ?, NULL, ?
        )
        "#,
    )
    .map_err(sqlite_error)?;
    statement
        .execute((
            input.id.as_str(),
            input.workspace_id.as_str(),
            input.provider.as_str(),
            input.model_label.as_str(),
            input.model_id.as_str(),
            input.reasoning_effort.as_deref(),
            input.permission_mode.as_deref().unwrap_or("auto-approve"),
            input.agent_mode.as_deref().unwrap_or("auto"),
            input.prompt.as_str(),
            input.state.as_str(),
            input.attention.as_str(),
            timestamp.as_str(),
            timestamp.as_str(),
            timestamp.as_str(),
        ))
        .map_err(sqlite_error)?;
    find_session_by_id(connection, &input.id)
}

/// A session reconstructed from a provider CLI's own transcript. Unlike
/// `persist_session` the timestamps come from the transcript (not `now`), the
/// provider conversation id is known up front (it is what makes the session
/// resumable), and the row is flagged `imported`.
#[derive(Debug, Clone, PartialEq)]
pub struct PersistImportedSessionInput {
    pub id: String,
    pub workspace_id: String,
    pub provider: String,
    pub model_label: String,
    pub model_id: String,
    pub provider_conversation_id: String,
    pub prompt: String,
    pub started_at: String,
    pub last_activity_at: String,
}

pub fn persist_imported_session(
    connection: &Connection,
    input: &PersistImportedSessionInput,
) -> ArgmaxResult<SessionSummary> {
    let mut statement = connection
        .prepare_cached(
            r#"
        INSERT INTO sessions (
          id, workspace_id, provider, model_label, model_id, reasoning_effort, permission_mode, agent_mode,
          provider_conversation_id, prompt, state, attention, attention_changed_at,
          started_at, completed_at, last_activity_at, imported
        ) VALUES (
          ?, ?, ?, ?, ?, NULL, 'auto-approve', 'auto',
          ?, ?, 'complete', 'normal', ?,
          ?, ?, ?, 1
        )
        "#,
        )
        .map_err(sqlite_error)?;
    statement
        .execute((
            input.id.as_str(),
            input.workspace_id.as_str(),
            input.provider.as_str(),
            input.model_label.as_str(),
            input.model_id.as_str(),
            input.provider_conversation_id.as_str(),
            input.prompt.as_str(),
            input.last_activity_at.as_str(),
            input.started_at.as_str(),
            input.last_activity_at.as_str(),
            input.last_activity_at.as_str(),
        ))
        .map_err(sqlite_error)?;
    find_session_by_id(connection, &input.id)
}

/// Move an imported session's clock forward as later transcript lines arrive.
pub fn touch_imported_session(
    connection: &Connection,
    session_id: &str,
    last_activity_at: &str,
) -> ArgmaxResult<SessionSummary> {
    connection
        .prepare_cached("UPDATE sessions SET last_activity_at = ?, completed_at = ? WHERE id = ?")
        .map_err(sqlite_error)?
        .execute((last_activity_at, last_activity_at, session_id))
        .map_err(sqlite_error)?;
    find_session_by_id(connection, session_id)
}

/// Hard-delete a session. Events, raw output, approvals, and the
/// `synced_sessions` row cascade. Only the sync pruner calls this: sessions
/// Argmax launched are archived through their workspace, never deleted.
pub fn delete_session(connection: &Connection, session_id: &str) -> ArgmaxResult<()> {
    connection
        .prepare_cached("DELETE FROM sessions WHERE id = ?")
        .map_err(sqlite_error)?
        .execute([session_id])
        .map_err(sqlite_error)?;
    Ok(())
}

pub fn update_session_agent_mode(
    connection: &Connection,
    session_id: &str,
    input: &SessionAgentModeInput,
) -> ArgmaxResult<SessionSummary> {
    let mut statement = connection
        .prepare_cached("UPDATE sessions SET agent_mode = ?, last_activity_at = ? WHERE id = ?")
        .map_err(sqlite_error)?;
    statement
        .execute((input.agent_mode.as_str(), now_iso(), session_id))
        .map_err(sqlite_error)?;
    find_session_by_id(connection, session_id)
}

pub fn update_session_model(
    connection: &Connection,
    session_id: &str,
    input: &SessionModelInput,
) -> ArgmaxResult<SessionSummary> {
    let mut statement = connection
        .prepare_cached(
            r#"
        UPDATE sessions
        SET model_label = ?, model_id = ?, reasoning_effort = ?,
            last_model_id = ?, last_activity_at = ?
        WHERE id = ?
        "#,
        )
        .map_err(sqlite_error)?;
    let timestamp = now_iso();
    statement
        .execute((
            input.model_label.as_str(),
            input.model_id.as_str(),
            input.reasoning_effort.as_deref(),
            input.model_id.as_str(),
            timestamp.as_str(),
            session_id,
        ))
        .map_err(sqlite_error)?;
    find_session_by_id(connection, session_id)
}

/// Switch a session to a different provider. The new provider's model must be
/// supplied (provider model lists don't overlap), and the source provider's
/// native resume id is cleared: Claude/Codex/Cursor conversation ids are mutually
/// unintelligible, so the next launch starts the new provider fresh and rebuilds
/// context from the visible transcript (`compose_follow_up_prompt`).
pub fn update_session_provider(
    connection: &Connection,
    session_id: &str,
    input: &SessionProviderInput,
) -> ArgmaxResult<SessionSummary> {
    let mut statement = connection
        .prepare_cached(
            r#"
        UPDATE sessions
        SET provider = ?, model_label = ?, model_id = ?, reasoning_effort = ?,
            last_model_id = ?, provider_conversation_id = NULL, last_activity_at = ?
        WHERE id = ?
        "#,
        )
        .map_err(sqlite_error)?;
    let timestamp = now_iso();
    statement
        .execute((
            input.provider.as_str(),
            input.model_label.as_str(),
            input.model_id.as_str(),
            input.reasoning_effort.as_deref(),
            input.model_id.as_str(),
            timestamp.as_str(),
            session_id,
        ))
        .map_err(sqlite_error)?;
    find_session_by_id(connection, session_id)
}

pub fn update_session_state(
    connection: &Connection,
    session_id: &str,
    input: &SessionStateInput,
) -> ArgmaxResult<SessionSummary> {
    let timestamp = input.last_activity_at.clone().unwrap_or_else(now_iso);
    // `attention` on the right-hand side of the CASE reads the pre-update
    // column value, so `attention_changed_at` only advances when the attention
    // value actually changes — the timestamp the Priority section's dismissal
    // check compares against.
    let mut statement = connection
        .prepare_cached(
            r#"
        UPDATE sessions
        SET state = ?1, completed_at = ?2, last_activity_at = ?3,
            attention_changed_at = CASE WHEN attention = ?4 THEN attention_changed_at ELSE ?3 END,
            attention = ?4
        WHERE id = ?5
        "#,
        )
        .map_err(sqlite_error)?;
    statement
        .execute((
            input.state.as_str(),
            input.completed_at.as_deref(),
            timestamp.as_str(),
            input.attention.as_str(),
            session_id,
        ))
        .map_err(sqlite_error)?;
    find_session_by_id(connection, session_id)
}

pub fn update_session_provider_conversation_id(
    connection: &Connection,
    session_id: &str,
    provider_conversation_id: &str,
) -> ArgmaxResult<SessionSummary> {
    // A fresh provider conversation id also spends any pending fork flag: the
    // forked launch has diverged, and later resumes must NOT fork again.
    let mut statement = connection
        .prepare_cached(
            "UPDATE sessions SET provider_conversation_id = ?, resume_fork = 0, last_activity_at = ? WHERE id = ?",
        )
        .map_err(sqlite_error)?;
    statement
        .execute((provider_conversation_id, now_iso(), session_id))
        .map_err(sqlite_error)?;
    find_session_by_id(connection, session_id)
}

/// Drop the native resume id so the next turn starts a fresh provider
/// conversation. Occupancy resets because the live context window is empty;
/// cumulative cost stays, since that work already happened.
pub fn clear_session_conversation(
    connection: &Connection,
    session_id: &str,
) -> ArgmaxResult<SessionSummary> {
    let mut statement = connection
        .prepare_cached(
            "UPDATE sessions SET provider_conversation_id = NULL, resume_fork = 0, context_tokens = 0, last_activity_at = ? WHERE id = ?",
        )
        .map_err(sqlite_error)?;
    let changes = statement
        .execute((now_iso(), session_id))
        .map_err(sqlite_error)?;
    if changes == 0 {
        return Err(ArgmaxError::record_not_found("session", session_id));
    }
    find_session_by_id(connection, session_id)
}

/// Mark a session so its next resumed launch forks the provider conversation
/// (`--fork-session` for Claude) instead of appending to the original's.
pub fn set_session_resume_fork(connection: &Connection, session_id: &str) -> ArgmaxResult<()> {
    let changes = connection
        .prepare_cached("UPDATE sessions SET resume_fork = 1 WHERE id = ?")
        .map_err(sqlite_error)?
        .execute([session_id])
        .map_err(sqlite_error)?;
    if changes == 0 {
        return Err(ArgmaxError::record_not_found("session", session_id));
    }
    Ok(())
}

pub fn session_resume_fork(connection: &Connection, session_id: &str) -> ArgmaxResult<bool> {
    connection
        .prepare_cached("SELECT resume_fork FROM sessions WHERE id = ?")
        .map_err(sqlite_error)?
        .query_row([session_id], |row| row.get::<_, i64>(0))
        .map(|value| value != 0)
        .map_err(sqlite_error)
}

pub fn find_session_by_id(
    connection: &Connection,
    session_id: &str,
) -> ArgmaxResult<SessionSummary> {
    let mut statement = connection
        .prepare_cached("SELECT * FROM sessions WHERE id = ?")
        .map_err(sqlite_error)?;
    match statement.query_row([session_id], session_row_to_summary) {
        Ok(session) => Ok(session),
        Err(rusqlite::Error::QueryReturnedNoRows) => {
            Err(ArgmaxError::record_not_found("session", session_id))
        }
        Err(error) => Err(sqlite_error(error)),
    }
}

pub fn update_session_last_activity(
    connection: &Connection,
    session_id: &str,
    last_activity_at: &str,
) -> ArgmaxResult<SessionSummary> {
    let mut statement = connection
        .prepare_cached("UPDATE sessions SET last_activity_at = ? WHERE id = ?")
        .map_err(sqlite_error)?;
    let changes = statement
        .execute((last_activity_at, session_id))
        .map_err(sqlite_error)?;
    if changes == 0 {
        return Err(ArgmaxError::record_not_found("session", session_id));
    }
    find_session_by_id(connection, session_id)
}

pub fn list_session_ids_for_workspace(
    connection: &Connection,
    workspace_id: &str,
) -> ArgmaxResult<Vec<String>> {
    let mut statement = connection
        .prepare_cached("SELECT id FROM sessions WHERE workspace_id = ?")
        .map_err(sqlite_error)?;
    let rows = statement
        .query_map([workspace_id], |row| row.get::<_, String>("id"))
        .map_err(sqlite_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(sqlite_error)?;
    Ok(rows)
}

fn session_row_to_summary(row: &Row<'_>) -> rusqlite::Result<SessionSummary> {
    let model_id: Option<String> = row.get("model_id")?;
    Ok(SessionSummary {
        id: row.get("id")?,
        workspace_id: row.get("workspace_id")?,
        provider: row.get("provider")?,
        model_label: row.get("model_label")?,
        model_id: model_id.unwrap_or_default(),
        reasoning_effort: row.get("reasoning_effort")?,
        permission_mode: row.get("permission_mode")?,
        agent_mode: row.get("agent_mode")?,
        provider_conversation_id: row.get("provider_conversation_id")?,
        prompt: row.get("prompt")?,
        state: row.get("state")?,
        attention: row.get("attention")?,
        attention_changed_at: row.get("attention_changed_at")?,
        started_at: row.get("started_at")?,
        completed_at: row.get("completed_at")?,
        last_activity_at: row.get("last_activity_at")?,
        cost_usd: row.get("cost_usd")?,
        tokens: UsageCounts {
            input: row.get("input_tokens")?,
            output: row.get("output_tokens")?,
            cache_read: row.get("cache_read_tokens")?,
            cache_write: row.get("cache_write_tokens")?,
        },
        imported: row.get::<_, i64>("imported")? != 0,
        context_tokens: row.get("context_tokens")?,
        context_window: row.get("context_window")?,
        launched_by_session_id: row.get("launched_by_session_id")?,
    })
}

fn sqlite_error(error: rusqlite::Error) -> ArgmaxError {
    ArgmaxError::service("SQLITE", error.to_string())
}

fn json_error(error: serde_json::Error) -> ArgmaxError {
    ArgmaxError::service("JSON", error.to_string())
}
