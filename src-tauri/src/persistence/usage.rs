use rusqlite::Connection;
use serde::Serialize;
use specta::Type;

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
    /// Input-side tokens occupying the current context. When absent, the
    /// session keeps its prior occupancy.
    pub context_tokens: Option<i64>,
    /// The model's context-window size when the provider reports it (Codex).
    /// Persisted on the session when present; leaves the prior value otherwise.
    pub context_window: Option<i64>,
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
        // Claude's stream-json emits one `assistant` event per content block of a
        // single message, and every one repeats that message's full `usage` under
        // the same `message.id`. Counting each would bill one turn N times.
        if let Some(event_id) = input.event_id.as_deref() {
            let mut seen_statement = connection
                .prepare_cached(
                    "SELECT 1 FROM usage_events WHERE session_id = ? AND event_id = ? LIMIT 1",
                )
                .map_err(sqlite_error)?;
            if seen_statement
                .exists((input.session_id.as_str(), event_id))
                .map_err(sqlite_error)?
            {
                return Ok(());
            }
        }

        let mut insert_statement = connection
            .prepare_cached(
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

        // Billing counters accumulate. Context occupancy and window size update
        // only when the provider reports them.
        let mut update_statement = connection
            .prepare_cached(
                r#"
            UPDATE sessions
            SET
              input_tokens = input_tokens + ?,
              output_tokens = output_tokens + ?,
              cache_read_tokens = cache_read_tokens + ?,
              cache_write_tokens = cache_write_tokens + ?,
              cost_usd = cost_usd + ?,
              context_tokens = COALESCE(?, context_tokens),
              context_window = COALESCE(?, context_window)
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
                input.context_tokens,
                input.context_window,
                input.session_id.as_str(),
            ))
            .map_err(sqlite_error)?;
        if changes == 0 {
            return Err(ArgmaxError::record_not_found("session", &input.session_id));
        }

        if !input.model_id.is_empty() {
            let mut model_statement = connection
                .prepare_cached("UPDATE sessions SET last_model_id = ? WHERE id = ?")
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
    let mut session_statement = connection.prepare_cached("SELECT input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd, last_model_id FROM sessions WHERE id = ?",
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

    let mut latest_statement = connection.prepare_cached("SELECT model_id FROM usage_events WHERE session_id = ? ORDER BY created_at DESC, id DESC LIMIT 1",
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

/// Billing totals recorded since the session's current provider conversation
/// began — everything after the last `/clear` or provider switch, or the whole
/// session when neither has happened.
///
/// The session row's own counters keep accumulating across `/clear`, so using
/// them to seed a resumed thread's cumulative baseline under-bills: the new
/// thread's totals restart near zero and every `saturating_sub` yields nothing
/// until they pass the old lifetime total.
pub fn session_usage_since_conversation_start(
    connection: &Connection,
    session_id: &str,
) -> ArgmaxResult<UsageCounts> {
    let mut statement = connection
        .prepare_cached(
            r#"
            SELECT
              COALESCE(SUM(input_tokens), 0) AS input_tokens,
              COALESCE(SUM(output_tokens), 0) AS output_tokens,
              COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens,
              COALESCE(SUM(cache_write_tokens), 0) AS cache_write_tokens
            FROM usage_events
            WHERE session_id = ?
              AND created_at > COALESCE((
                SELECT created_at FROM events
                WHERE events.session_id = usage_events.session_id
                  AND events.type IN ('session.cleared', 'session.provider-changed')
                ORDER BY rowid DESC
                LIMIT 1
              ), '')
            "#,
        )
        .map_err(sqlite_error)?;
    statement
        .query_row([session_id], |row| {
            Ok(UsageCounts {
                input: row.get("input_tokens")?,
                output: row.get("output_tokens")?,
                cache_read: row.get("cache_read_tokens")?,
                cache_write: row.get("cache_write_tokens")?,
            })
        })
        .map_err(sqlite_error)
}

fn sqlite_error(error: rusqlite::Error) -> ArgmaxError {
    ArgmaxError::service("SQLITE", error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::persistence::database::Database;

    fn seed_session(connection: &Connection) {
        connection
            .execute(
                "INSERT INTO projects (id, name, repo_path, current_branch, default_provider, default_model_label, worktree_location, created_at, updated_at) VALUES ('p1', 'p1', '/tmp/p1', 'main', 'codex', 'GPT', '~/.argmax', '2026-09-01T09:00:00.000Z', '2026-09-01T09:00:00.000Z')",
                [],
            )
            .expect("insert project");
        connection
            .execute(
                "INSERT INTO workspaces (id, project_id, task_label, branch, base_ref, path, state, last_activity_at, created_at, updated_at) VALUES ('w1', 'p1', 'task', 'branch', 'main', '/tmp/ws', 'running', '2026-09-01T09:00:00.000Z', '2026-09-01T09:00:00.000Z', '2026-09-01T09:00:00.000Z')",
                [],
            )
            .expect("insert workspace");
        connection
            .execute(
                "INSERT INTO sessions (id, workspace_id, provider, model_label, model_id, prompt, state, attention, started_at, last_activity_at) VALUES ('s1', 'w1', 'codex', 'GPT', 'gpt-5.6-terra', 'hello', 'running', 'normal', '2026-09-01T09:00:00.000Z', '2026-09-01T09:00:00.000Z')",
                [],
            )
            .expect("insert session");
    }

    fn record_usage(connection: &Connection, created_at: &str, input: i64, output: i64) {
        insert_usage_event(
            connection,
            &InsertUsageEventInput {
                session_id: "s1".to_string(),
                event_id: None,
                model_id: "gpt-5.6-terra".to_string(),
                tokens: UsageCounts {
                    input,
                    output,
                    cache_read: 0,
                    cache_write: 0,
                },
                cost_usd: 0.5,
                context_tokens: None,
                context_window: None,
                created_at: Some(created_at.to_string()),
            },
        )
        .expect("insert usage event");
    }

    /// The Codex resume baseline is read from this, so it must follow the
    /// current provider conversation and not the session's lifetime totals:
    /// `/clear` keeps the counters but starts the provider's own cumulative
    /// usage over at zero.
    #[test]
    fn conversation_usage_restarts_at_the_clear_watermark() {
        let database = Database::open_in_memory().expect("open db");
        let connection = database.connection();
        seed_session(&connection);

        record_usage(&connection, "2026-09-01T10:00:00.000Z", 5_000, 400);
        assert_eq!(
            session_usage_since_conversation_start(&connection, "s1").expect("usage"),
            UsageCounts {
                input: 5_000,
                output: 400,
                cache_read: 0,
                cache_write: 0,
            }
        );

        connection
            .execute(
                "INSERT INTO events (id, session_id, type, message, payload_json, created_at) VALUES ('e1', 's1', 'session.cleared', '', '{}', '2026-09-01T10:05:00.000Z')",
                [],
            )
            .expect("insert cleared marker");
        assert_eq!(
            session_usage_since_conversation_start(&connection, "s1").expect("usage after clear"),
            UsageCounts {
                input: 0,
                output: 0,
                cache_read: 0,
                cache_write: 0,
            },
            "a fresh conversation starts from nothing"
        );

        record_usage(&connection, "2026-09-01T10:06:00.000Z", 900, 30);
        let conversation = session_usage_since_conversation_start(&connection, "s1")
            .expect("usage on the new conversation");
        assert_eq!(conversation.input, 900);
        assert_eq!(conversation.output, 30);

        // The session row still carries both threads, which is exactly what
        // made the old baseline over-count.
        let lifetime = get_session_cost_summary(&connection, "s1").expect("summary");
        assert_eq!(lifetime.tokens.input, 5_900);

        // A provider switch is the same kind of boundary.
        connection
            .execute(
                "INSERT INTO events (id, session_id, type, message, payload_json, created_at) VALUES ('e2', 's1', 'session.provider-changed', '', '{}', '2026-09-01T10:07:00.000Z')",
                [],
            )
            .expect("insert provider-changed marker");
        assert_eq!(
            session_usage_since_conversation_start(&connection, "s1").expect("usage after switch"),
            UsageCounts {
                input: 0,
                output: 0,
                cache_read: 0,
                cache_write: 0,
            }
        );
    }
}
