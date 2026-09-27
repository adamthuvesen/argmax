// Auto routing decisions: one `turn_routes` row per decision, mirrored onto
// `sessions.auto_tier` / `auto_route` so dashboard reads need no join.

use rusqlite::Connection;

use super::{sqlite_error, time::now_iso};
use crate::error::ArgmaxResult;
use crate::providers::pricing::UsageCounts;
use crate::routing::{difficulty_label, kind_label, tier_label, RouteDecision, RouteDecisionKind};

pub fn record_route(
    connection: &Connection,
    session_id: &str,
    route: &RouteDecision,
) -> ArgmaxResult<()> {
    connection
        .prepare_cached(
            r#"
            INSERT INTO turn_routes (
              session_id, created_at, tier, provider, model_id, reasoning_effort, kind,
              difficulty, kind_confidence, difficulty_confidence, decision, reason
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            "#,
        )
        .map_err(sqlite_error)?
        .execute((
            session_id,
            now_iso(),
            tier_label(route.tier),
            route.provider.as_str(),
            route.model_id.as_str(),
            route.effort.map(|effort| effort.as_str()),
            route.kind.map(kind_label),
            route.difficulty.map(difficulty_label),
            route.kind_confidence,
            route.difficulty_confidence,
            route.decision.as_str(),
            route.reason.as_str(),
        ))
        .map_err(sqlite_error)?;
    // A kept decision now explains why the same route still fits. A pin ends
    // Auto routing and `clear_auto_tier` removes the chip instead.
    if route.decision != RouteDecisionKind::Pinned {
        connection
            .prepare_cached("UPDATE sessions SET auto_tier = ?, auto_route = ? WHERE id = ?")
            .map_err(sqlite_error)?
            .execute((tier_label(route.tier), route.reason.as_str(), session_id))
            .map_err(sqlite_error)?;
    }
    Ok(())
}

/// A hand-picked model pins the chat: the router stops driving it.
pub fn clear_auto_tier(connection: &Connection, session_id: &str) -> ArgmaxResult<()> {
    connection
        .prepare_cached("UPDATE sessions SET auto_tier = NULL, auto_route = NULL WHERE id = ?")
        .map_err(sqlite_error)?
        .execute([session_id])
        .map_err(sqlite_error)?;
    Ok(())
}

/// Tokens the chat's latest turn billed: every usage row since its most
/// recent user message. Walks the (session_id, created_at) index backwards,
/// so it reads only the last turn's events.
pub fn last_turn_usage(connection: &Connection, session_id: &str) -> ArgmaxResult<UsageCounts> {
    connection
        .prepare_cached(
            r#"
            SELECT COALESCE(SUM(input_tokens), 0), COALESCE(SUM(output_tokens), 0),
                   COALESCE(SUM(cache_read_tokens), 0), COALESCE(SUM(cache_write_tokens), 0)
            FROM usage_events
            WHERE session_id = ?1
              AND created_at >= COALESCE((
                SELECT created_at FROM events
                WHERE session_id = ?1 AND type = 'user.message'
                ORDER BY created_at DESC LIMIT 1
              ), '')
            "#,
        )
        .map_err(sqlite_error)?
        .query_row([session_id], |row| {
            Ok(UsageCounts {
                input: row.get::<_, i64>(0)?.max(0) as u64,
                output: row.get::<_, i64>(1)?.max(0) as u64,
                cache_read: row.get::<_, i64>(2)?.max(0) as u64,
                cache_write: row.get::<_, i64>(3)?.max(0) as u64,
            })
        })
        .map_err(sqlite_error)
}

/// When the router last moved this chat to another model or effort.
pub fn last_switch_at(connection: &Connection, session_id: &str) -> ArgmaxResult<Option<String>> {
    connection
        .prepare_cached(
            "SELECT MAX(created_at) FROM turn_routes WHERE session_id = ? AND decision IN ('reroute', 'escalate')",
        )
        .map_err(sqlite_error)?
        .query_row([session_id], |row| row.get(0))
        .map_err(sqlite_error)
}

/// The latest decisions since Clear, newest first. This is classifier context,
/// not a persisted route or a UI API.
#[derive(Debug, Clone)]
pub struct RecentRoutingDecision {
    pub provider: String,
    pub model_id: String,
    pub effort: Option<String>,
    pub kind: String,
    pub difficulty: String,
    pub decision: String,
    pub reason: String,
    pub reason_truncated: bool,
    pub user_task: Option<String>,
    pub user_task_truncated: bool,
}

pub fn recent_routing_decisions(
    connection: &Connection,
    session_id: &str,
) -> ArgmaxResult<Vec<RecentRoutingDecision>> {
    let mut statement = connection.prepare_cached(
        r#"
        SELECT route.provider, route.model_id, route.reasoning_effort,
               COALESCE(route.kind, ''), COALESCE(route.difficulty, ''),
               route.decision, substr(route.reason, 1, 91), length(route.reason) > 90,
               CASE WHEN route.decision IN ('launch', 'fallback')
                 THEN substr(session.prompt, 1, 191)
                 ELSE (SELECT substr(message, 1, 191) FROM events user_task
                WHERE user_task.session_id = route.session_id
                  AND user_task.type = 'user.message'
                  AND user_task.created_at >= route.created_at
                  AND julianday(user_task.created_at) <= julianday(route.created_at) + (10.0 / 86400.0)
                  AND json_extract(user_task.payload_json, '$.parent_tool_use_id') IS NULL
                  AND json_extract(user_task.payload_json, '$.traceImported') IS NULL
                ORDER BY user_task.created_at, user_task.rowid LIMIT 1)
               END,
               CASE WHEN route.decision IN ('launch', 'fallback')
                 THEN length(session.prompt) > 190
                 ELSE COALESCE((SELECT length(message) > 190 FROM events user_task
                WHERE user_task.session_id = route.session_id
                  AND user_task.type = 'user.message'
                  AND user_task.created_at >= route.created_at
                  AND julianday(user_task.created_at) <= julianday(route.created_at) + (10.0 / 86400.0)
                  AND json_extract(user_task.payload_json, '$.parent_tool_use_id') IS NULL
                  AND json_extract(user_task.payload_json, '$.traceImported') IS NULL
                ORDER BY user_task.created_at, user_task.rowid LIMIT 1), 0)
               END
        FROM turn_routes route
        JOIN sessions session ON session.id = route.session_id
        WHERE route.session_id = ?1
          AND route.created_at > COALESCE((
            SELECT MAX(created_at) FROM events
            WHERE session_id = ?1 AND type = 'session.cleared'
          ), '')
          AND route.decision != 'pinned'
        ORDER BY route.id DESC LIMIT 6
        "#,
    ).map_err(sqlite_error)?;
    let rows = statement.query_map([session_id], |row| {
        Ok(RecentRoutingDecision {
            provider: row.get(0)?, model_id: row.get(1)?, effort: row.get(2)?,
            kind: row.get(3)?, difficulty: row.get(4)?, decision: row.get(5)?,
            reason: row.get(6)?, reason_truncated: row.get(7)?,
            user_task: row.get(8)?, user_task_truncated: row.get(9)?,
        })
    }).map_err(sqlite_error)?;
    rows.collect::<Result<Vec<_>, _>>().map_err(sqlite_error)
}

#[cfg(test)]
mod routing_context_tests {
    use super::*;

    #[test]
    fn launch_route_keeps_its_original_task_until_clear() {
        let connection = Connection::open_in_memory().unwrap();
        connection.execute_batch(r#"
            CREATE TABLE sessions (id TEXT PRIMARY KEY, prompt TEXT NOT NULL);
            CREATE TABLE events (session_id TEXT, type TEXT, message TEXT, payload_json TEXT, created_at TEXT);
            CREATE TABLE turn_routes (id INTEGER PRIMARY KEY, session_id TEXT, created_at TEXT,
                provider TEXT, model_id TEXT, reasoning_effort TEXT, kind TEXT, difficulty TEXT,
                decision TEXT, reason TEXT);
            INSERT INTO sessions VALUES ('s', 'Investigate the hard bug');
            INSERT INTO events VALUES ('s', 'user.message', 'Investigate the hard bug', '{}', '2026-09-27T10:00:00.000Z');
            INSERT INTO turn_routes VALUES (1, 's', '2026-09-27T10:00:01.000Z',
                'codex', 'gpt-6-astra', 'high', 'coding', 'heavy', 'launch', 'hard task');
            INSERT INTO turn_routes VALUES (2, 's', '2026-09-27T11:00:00.000Z',
                'codex', 'gpt-6-astra', 'low', 'mechanical', 'light', 'reroute', 'simple task');
            INSERT INTO events VALUES ('s', 'user.message', 'Rename the label', '{}', '2026-09-27T11:00:01.000Z');
        "#).unwrap();

        let routes = recent_routing_decisions(&connection, "s").unwrap();
        assert_eq!(routes[0].user_task.as_deref(), Some("Rename the label"));
        assert_eq!(routes[1].user_task.as_deref(), Some("Investigate the hard bug"));
        assert_eq!(routes[1].effort.as_deref(), Some("high"));

        connection.execute("INSERT INTO events VALUES ('s', 'session.cleared', '', '{}', '2026-09-27T12:00:00.000Z')", []).unwrap();
        assert!(recent_routing_decisions(&connection, "s").unwrap().is_empty());
    }
}
