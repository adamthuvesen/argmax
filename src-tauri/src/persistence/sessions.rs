use std::collections::HashSet;

use rusqlite::{Connection, Row};
use serde::Serialize;

use super::prepared::prepared;
use crate::error::{ArgmaxError, ArgmaxResult};

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

fn sqlite_error(error: rusqlite::Error) -> ArgmaxError {
    ArgmaxError::service("SQLITE", error.to_string())
}

fn json_error(error: serde_json::Error) -> ArgmaxError {
    ArgmaxError::service("JSON", error.to_string())
}
