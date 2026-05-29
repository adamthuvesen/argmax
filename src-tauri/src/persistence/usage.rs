use rusqlite::Connection;
use serde::Serialize;
use specta::Type;

use super::prepared::prepared;
use super::sessions::UsageCounts;
use super::time::now_iso;
use crate::error::{ArgmaxError, ArgmaxResult};

#[derive(Debug, Clone, PartialEq)]
pub struct InsertUsageEventInput {
    pub session_id: String,
    pub event_id: Option<String>,
    pub model_id: String,
    pub tokens: UsageCounts,
    pub cost_usd: f64,
    pub created_at: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SessionCostSummary {
    pub session_id: String,
    pub model_id: Option<String>,
    pub tokens: UsageCounts,
    pub cost_usd: f64,
}

pub fn insert_usage_event(
    connection: &Connection,
    input: &InsertUsageEventInput,
) -> ArgmaxResult<()> {
    let created_at = input.created_at.clone().unwrap_or_else(now_iso);
    connection
        .execute_batch("SAVEPOINT insert_usage_event")
        .map_err(sqlite_error)?;

    let result = (|| {
        let mut insert_statement = prepared(
            connection,
            r#"
            INSERT INTO usage_events (
              session_id, event_id, model_id, input_tokens, output_tokens,
              cache_read_tokens, cache_write_tokens, cost_usd, created_at
            ) VALUES (
              ?, ?, ?, ?, ?, ?, ?, ?, ?
            )
            "#,
        )
        .map_err(sqlite_error)?;
        insert_statement
            .execute((
                input.session_id.as_str(),
                input.event_id.as_deref(),
                input.model_id.as_str(),
                input.tokens.input,
                input.tokens.output,
                input.tokens.cache_read,
                input.tokens.cache_write,
                input.cost_usd,
                created_at.as_str(),
            ))
            .map_err(sqlite_error)?;

        let mut update_statement = prepared(
            connection,
            r#"
            UPDATE sessions
            SET
              input_tokens = input_tokens + ?,
              output_tokens = output_tokens + ?,
              cache_read_tokens = cache_read_tokens + ?,
              cache_write_tokens = cache_write_tokens + ?,
              cost_usd = cost_usd + ?
            WHERE id = ?
            "#,
        )
        .map_err(sqlite_error)?;
        let changes = update_statement
            .execute((
                input.tokens.input,
                input.tokens.output,
                input.tokens.cache_read,
                input.tokens.cache_write,
                input.cost_usd,
                input.session_id.as_str(),
            ))
            .map_err(sqlite_error)?;
        if changes == 0 {
            return Err(ArgmaxError::record_not_found("session", &input.session_id));
        }

        if !input.model_id.is_empty() {
            let mut model_statement = prepared(
                connection,
                "UPDATE sessions SET last_model_id = ? WHERE id = ?",
            )
            .map_err(sqlite_error)?;
            model_statement
                .execute((input.model_id.as_str(), input.session_id.as_str()))
                .map_err(sqlite_error)?;
        }

        Ok(())
    })();

    match result {
        Ok(()) => connection
            .execute_batch("RELEASE insert_usage_event")
            .map_err(sqlite_error),
        Err(error) => {
            let _ = connection.execute_batch("ROLLBACK TO insert_usage_event");
            let _ = connection.execute_batch("RELEASE insert_usage_event");
            Err(error)
        }
    }
}

pub fn get_session_cost_summary(
    connection: &Connection,
    session_id: &str,
) -> ArgmaxResult<SessionCostSummary> {
    let mut session_statement = prepared(
        connection,
        "SELECT input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd, last_model_id FROM sessions WHERE id = ?",
    )
    .map_err(sqlite_error)?;
    let session_row = match session_statement.query_row([session_id], |row| {
        Ok((
            UsageCounts {
                input: row.get("input_tokens")?,
                output: row.get("output_tokens")?,
                cache_read: row.get("cache_read_tokens")?,
                cache_write: row.get("cache_write_tokens")?,
            },
            row.get::<_, f64>("cost_usd")?,
            row.get::<_, Option<String>>("last_model_id")?,
        ))
    }) {
        Ok(row) => row,
        Err(rusqlite::Error::QueryReturnedNoRows) => {
            return Err(ArgmaxError::record_not_found("session", session_id));
        }
        Err(error) => return Err(sqlite_error(error)),
    };

    let mut latest_statement = prepared(
        connection,
        "SELECT model_id FROM usage_events WHERE session_id = ? ORDER BY id DESC LIMIT 1",
    )
    .map_err(sqlite_error)?;
    let latest_model_id =
        match latest_statement.query_row([session_id], |row| row.get::<_, String>("model_id")) {
            Ok(model_id) => Some(model_id),
            Err(rusqlite::Error::QueryReturnedNoRows) => None,
            Err(error) => return Err(sqlite_error(error)),
        };

    Ok(SessionCostSummary {
        session_id: session_id.to_owned(),
        model_id: latest_model_id.or(session_row.2),
        tokens: session_row.0,
        cost_usd: session_row.1,
    })
}

fn sqlite_error(error: rusqlite::Error) -> ArgmaxError {
    ArgmaxError::service("SQLITE", error.to_string())
}
