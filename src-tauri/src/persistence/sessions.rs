use std::collections::HashSet;

use rusqlite::{Connection, Row};
use serde::Serialize;

use super::prepared::prepared;
use super::time::now_iso;
use super::workspaces::find_workspace_by_id;
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

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageCounts {
    pub input: i64,
    pub output: i64,
    pub cache_read: i64,
    pub cache_write: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
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
    pub started_at: String,
    pub completed_at: Option<String>,
    pub last_activity_at: String,
    pub preferred: bool,
    pub cost_usd: f64,
    pub tokens: UsageCounts,
}

pub fn list_sessions_for_dashboard(
    connection: &Connection,
    workspace_ids: Option<&[String]>,
    limit: usize,
) -> ArgmaxResult<Vec<SessionSummary>> {
    let preferred = load_preferred_session_ids(connection)?;
    match workspace_ids {
        Some(ids) if !ids.is_empty() => {
            let json = serde_json::to_string(ids).map_err(json_error)?;
            let mut statement = prepared(
                connection,
                "SELECT * FROM sessions WHERE workspace_id IN (SELECT value FROM json_each(?)) ORDER BY last_activity_at DESC LIMIT ?",
            )
            .map_err(sqlite_error)?;
            let rows = statement
                .query_map((json, limit as i64), |row| {
                    session_row_to_summary(row, &preferred)
                })
                .map_err(sqlite_error)?
                .collect::<Result<Vec<_>, _>>()
                .map_err(sqlite_error)?;
            Ok(rows)
        }
        _ => {
            let mut statement = prepared(
                connection,
                r#"
                SELECT outer_s.*
                FROM sessions outer_s
                WHERE outer_s.id IN (
                    SELECT id FROM sessions
                    ORDER BY last_activity_at DESC
                    LIMIT ?
                  )
                  OR (
                    outer_s.workspace_id IN (
                      SELECT id FROM workspaces
                      ORDER BY last_activity_at DESC
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
                ORDER BY outer_s.last_activity_at DESC
                "#,
            )
            .map_err(sqlite_error)?;
            let rows = statement
                .query_map((limit as i64, limit as i64), |row| {
                    session_row_to_summary(row, &preferred)
                })
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
    let mut statement = prepared(
        connection,
        r#"
        INSERT INTO sessions (
          id, workspace_id, provider, model_label, model_id, reasoning_effort, permission_mode, agent_mode,
          provider_conversation_id, prompt, state, attention,
          started_at, completed_at, last_activity_at
        ) VALUES (
          ?, ?, ?, ?, ?, ?, ?, ?,
          NULL, ?, ?, ?,
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
        ))
        .map_err(sqlite_error)?;
    find_session_by_id_no_preferred(connection, &input.id)
}

pub fn update_session_agent_mode(
    connection: &Connection,
    session_id: &str,
    input: &SessionAgentModeInput,
) -> ArgmaxResult<SessionSummary> {
    let mut statement = prepared(
        connection,
        "UPDATE sessions SET agent_mode = ?, last_activity_at = ? WHERE id = ?",
    )
    .map_err(sqlite_error)?;
    statement
        .execute((input.agent_mode.as_str(), now_iso(), session_id))
        .map_err(sqlite_error)?;
    find_session_by_id_no_preferred(connection, session_id)
}

pub fn update_session_model(
    connection: &Connection,
    session_id: &str,
    input: &SessionModelInput,
) -> ArgmaxResult<SessionSummary> {
    let mut statement = prepared(
        connection,
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
    find_session_by_id_no_preferred(connection, session_id)
}

pub fn update_session_state(
    connection: &Connection,
    session_id: &str,
    input: &SessionStateInput,
) -> ArgmaxResult<SessionSummary> {
    let timestamp = input.last_activity_at.clone().unwrap_or_else(now_iso);
    let mut statement = prepared(
        connection,
        "UPDATE sessions SET state = ?, attention = ?, completed_at = ?, last_activity_at = ? WHERE id = ?",
    )
    .map_err(sqlite_error)?;
    statement
        .execute((
            input.state.as_str(),
            input.attention.as_str(),
            input.completed_at.as_deref(),
            timestamp.as_str(),
            session_id,
        ))
        .map_err(sqlite_error)?;
    find_session_by_id_no_preferred(connection, session_id)
}

pub fn update_session_provider_conversation_id(
    connection: &Connection,
    session_id: &str,
    provider_conversation_id: &str,
) -> ArgmaxResult<SessionSummary> {
    let mut statement = prepared(
        connection,
        "UPDATE sessions SET provider_conversation_id = ?, last_activity_at = ? WHERE id = ?",
    )
    .map_err(sqlite_error)?;
    statement
        .execute((provider_conversation_id, now_iso(), session_id))
        .map_err(sqlite_error)?;
    find_session_by_id_no_preferred(connection, session_id)
}

pub fn find_session_by_id(
    connection: &Connection,
    session_id: &str,
) -> ArgmaxResult<SessionSummary> {
    let mut statement =
        prepared(connection, "SELECT * FROM sessions WHERE id = ?").map_err(sqlite_error)?;
    match statement.query_row([session_id], |row| {
        session_row_to_summary(row, &HashSet::new())
    }) {
        Ok(session) => {
            let preferred =
                is_preferred_session(connection, session.id.clone(), session.workspace_id.clone())?;
            Ok(SessionSummary {
                preferred,
                ..session
            })
        }
        Err(rusqlite::Error::QueryReturnedNoRows) => {
            Err(ArgmaxError::record_not_found("session", session_id))
        }
        Err(error) => Err(sqlite_error(error)),
    }
}

fn find_session_by_id_no_preferred(
    connection: &Connection,
    session_id: &str,
) -> ArgmaxResult<SessionSummary> {
    let mut statement =
        prepared(connection, "SELECT * FROM sessions WHERE id = ?").map_err(sqlite_error)?;
    match statement.query_row([session_id], |row| {
        session_row_to_summary(row, &HashSet::new())
    }) {
        Ok(session) => Ok(session),
        Err(rusqlite::Error::QueryReturnedNoRows) => {
            Err(ArgmaxError::record_not_found("session", session_id))
        }
        Err(error) => Err(sqlite_error(error)),
    }
}

pub fn update_session_last_model_id(
    connection: &Connection,
    session_id: &str,
    model_id: &str,
) -> ArgmaxResult<()> {
    if model_id.is_empty() {
        return Ok(());
    }
    let mut statement = prepared(
        connection,
        "UPDATE sessions SET last_model_id = ? WHERE id = ?",
    )
    .map_err(sqlite_error)?;
    statement
        .execute((model_id, session_id))
        .map_err(sqlite_error)?;
    Ok(())
}

pub fn update_session_last_activity(
    connection: &Connection,
    session_id: &str,
    last_activity_at: &str,
) -> ArgmaxResult<SessionSummary> {
    let mut statement = prepared(
        connection,
        "UPDATE sessions SET last_activity_at = ? WHERE id = ?",
    )
    .map_err(sqlite_error)?;
    let changes = statement
        .execute((last_activity_at, session_id))
        .map_err(sqlite_error)?;
    if changes == 0 {
        return Err(ArgmaxError::record_not_found("session", session_id));
    }
    find_session_by_id_no_preferred(connection, session_id)
}

pub fn select_preferred_attempt(
    connection: &Connection,
    session_id: &str,
) -> ArgmaxResult<SessionSummary> {
    let tx = connection.unchecked_transaction().map_err(sqlite_error)?;
    let session = find_session_by_id_no_preferred(&tx, session_id)?;
    let workspace = find_workspace_by_id(&tx, &session.workspace_id)?;
    let key = preferred_attempt_key(&workspace.project_id, &workspace.task_label);
    let value_json = serde_json::json!({ "sessionId": session_id }).to_string();
    {
        let mut statement = prepared(
            &tx,
            r#"
            INSERT INTO ui_state (key, value_json, updated_at)
            VALUES (?, ?, ?)
            ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at
            "#,
        )
        .map_err(sqlite_error)?;
        statement
            .execute((key.as_str(), value_json.as_str(), now_iso()))
            .map_err(sqlite_error)?;
    }
    tx.commit().map_err(sqlite_error)?;
    find_session_by_id(connection, session_id)
}

pub fn list_session_ids_for_workspace(
    connection: &Connection,
    workspace_id: &str,
) -> ArgmaxResult<Vec<String>> {
    let mut statement = prepared(connection, "SELECT id FROM sessions WHERE workspace_id = ?")
        .map_err(sqlite_error)?;
    let rows = statement
        .query_map([workspace_id], |row| row.get::<_, String>("id"))
        .map_err(sqlite_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(sqlite_error)?;
    Ok(rows)
}

pub fn load_preferred_session_ids(connection: &Connection) -> ArgmaxResult<HashSet<String>> {
    let mut statement = prepared(
        connection,
        "SELECT value_json FROM ui_state WHERE key >= 'preferred-attempt:' AND key < 'preferred-attempt;'",
    )
    .map_err(sqlite_error)?;
    let values = statement
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(sqlite_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(sqlite_error)?;

    Ok(values
        .into_iter()
        .filter_map(|value| {
            serde_json::from_str::<serde_json::Value>(&value)
                .ok()
                .and_then(|json| {
                    json.get("sessionId")
                        .and_then(|id| id.as_str())
                        .map(str::to_owned)
                })
        })
        .collect())
}

fn session_row_to_summary(
    row: &Row<'_>,
    preferred: &HashSet<String>,
) -> rusqlite::Result<SessionSummary> {
    let id: String = row.get("id")?;
    let model_id: Option<String> = row.get("model_id")?;
    Ok(SessionSummary {
        id: id.clone(),
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
        started_at: row.get("started_at")?,
        completed_at: row.get("completed_at")?,
        last_activity_at: row.get("last_activity_at")?,
        preferred: preferred.contains(&id),
        cost_usd: row.get("cost_usd")?,
        tokens: UsageCounts {
            input: row.get("input_tokens")?,
            output: row.get("output_tokens")?,
            cache_read: row.get("cache_read_tokens")?,
            cache_write: row.get("cache_write_tokens")?,
        },
    })
}

fn is_preferred_session(
    connection: &Connection,
    session_id: String,
    workspace_id: String,
) -> ArgmaxResult<bool> {
    let workspace = find_workspace_by_id(connection, &workspace_id)?;
    let key = preferred_attempt_key(&workspace.project_id, &workspace.task_label);
    let mut statement = prepared(connection, "SELECT value_json FROM ui_state WHERE key = ?")
        .map_err(sqlite_error)?;
    match statement.query_row([key], |row| row.get::<_, String>("value_json")) {
        Ok(value) => {
            let parsed = serde_json::from_str::<serde_json::Value>(&value).unwrap_or_default();
            Ok(parsed.get("sessionId").and_then(|id| id.as_str()) == Some(session_id.as_str()))
        }
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(false),
        Err(error) => Err(sqlite_error(error)),
    }
}

fn preferred_attempt_key(project_id: &str, task_label: &str) -> String {
    format!(
        "preferred-attempt:{}:{}",
        project_id,
        encode_uri_component(task_label)
    )
}

fn encode_uri_component(value: &str) -> String {
    let mut out = String::new();
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z'
            | b'a'..=b'z'
            | b'0'..=b'9'
            | b'-'
            | b'_'
            | b'.'
            | b'!'
            | b'~'
            | b'*'
            | b'\''
            | b'('
            | b')' => out.push(byte as char),
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

fn sqlite_error(error: rusqlite::Error) -> ArgmaxError {
    ArgmaxError::service("SQLITE", error.to_string())
}

fn json_error(error: serde_json::Error) -> ArgmaxError {
    ArgmaxError::service("JSON", error.to_string())
}
