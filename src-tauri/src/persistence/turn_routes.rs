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
    // A kept route leaves the chat on its model, so the chip's reason stays;
    // a pinned one ends routing, which `clear_auto_tier` records.
    if !matches!(
        route.decision,
        RouteDecisionKind::Kept | RouteDecisionKind::Pinned
    ) {
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
