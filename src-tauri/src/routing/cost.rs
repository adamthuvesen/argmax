//! Router cost: what each Auto tier spent over a Usage window, for the Router
//! card on the Usage page. Every `turn_routes` row opens a window that runs
//! from its `created_at` to the chat's next route row, and the window's turns
//! are charged to the tier on its own row, so a chat that escalated mid-way
//! splits across tiers. A `pinned` row only closes the window before it: the
//! user took the chat off Auto. See docs/usage.md → Router cost.

use std::collections::{BTreeMap, HashSet};

use chrono::{DateTime, SecondsFormat, Utc};
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use specta::Type;

use super::{parse_tier, table::AutoTier};
use crate::error::{ArgmaxError, ArgmaxResult};
use crate::ipc::validation::ProviderId;
use crate::persistence::sqlite_error;
use crate::providers::pricing::{cost_of, list_price, UsageCounts};
use crate::providers::runtime::parse_provider;
use crate::usage::{summary::bucket_starts, UsageWindow};

// Cursor's ACP reports no tokens, so a Cursor turn is estimated from its
// transcript. The shape: every model call re-reads a base prompt plus the
// whole conversation so far (cache read) and adds what arrived since the last
// call (input); the call's own event is its output. Checked against real
// Claude sessions with recorded usage, this estimate had median
// estimate/actual ≈ 1.0 for cache reads, with the middle half of chats between
// 0.75x and 2x — which is why every Cursor figure is labelled an estimate.

/// Characters per token for transcript text.
const CHARS_PER_TOKEN: i64 = 4;
/// Cursor's system prompt and tools, re-read by every call: a one-shot
/// `cursor-agent -p` "reply ok" reported 14,868 input + 3,906 cache read
/// tokens on 2026-09-27.
const CURSOR_BASE_CONTEXT_TOKENS: u64 = 20_000;
/// Transcript events that carry model context.
const CURSOR_CONTEXT_EVENTS: [&str; 6] = [
    "user.message",
    "message.completed",
    "command.started",
    "command.completed",
    "agent.started",
    "agent.completed",
];
/// Events that mark one model call; their own text is that call's output.
const CURSOR_CALL_EVENTS: [&str; 3] = ["command.started", "agent.started", "message.completed"];

/// Cursor's published per-million list rates (https://cursor.com/docs/models,
/// fetched 2026-09-27). Standard rates only: routed chats never run Fast.
/// Kept here, not in `providers::pricing`, whose Cursor rows are deliberate
/// zero placeholders the Usage ledger relies on.
struct CursorRates {
    input: f64,
    cache_read: f64,
    output: f64,
}

fn cursor_rates(model_id: &str) -> Option<CursorRates> {
    match model_id {
        // Composer has no cache-write rate; writes would bill as input.
        "composer-2.5" => Some(CursorRates {
            input: 0.50,
            cache_read: 0.20,
            output: 2.50,
        }),
        // Opus 5.5 on Cursor. Its $5 cache-write rate goes unused: the
        // estimate has no cache writes.
        "claude-opus-5-5-medium" => Some(CursorRates {
            input: 4.0,
            cache_read: 0.20,
            output: 20.0,
        }),
        _ => None,
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RouterCostSummary {
    /// Frontier, Balance, Speed, in that order; a tier with no turns in the
    /// window is left out.
    pub tiers: Vec<RouterTierCost>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RouterTierCost {
    pub tier: AutoTier,
    /// Distinct chats with at least one turn on this tier.
    pub chats: u32,
    pub turns: u32,
    pub escalations: u32,
    pub reroutes: u32,
    /// Priced from recorded provider usage.
    pub measured_cost_usd: f64,
    /// Cursor turns, estimated from the transcript at Cursor's list prices.
    pub estimated_cost_usd: f64,
    /// Answered turns with no usage recorded, or on a model no price table
    /// knows: counted, never $0. A turn the model never answered is not
    /// counted anywhere.
    pub unpriced_turns: u32,
    /// Most turns first.
    pub models: Vec<RouterModelCost>,
    /// Median seconds from send to the end of a turn, less any time an
    /// approval waited on the user. `None` until a turn has finished.
    pub median_turn_seconds: Option<f64>,
    /// Median seconds from send to the model's first text, reasoning, or tool
    /// call.
    pub median_first_answer_seconds: Option<f64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RouterModelCost {
    pub provider: ProviderId,
    pub model_id: String,
    pub turns: u32,
    pub cost_usd: f64,
    /// True when the cost is a transcript estimate (Cursor).
    pub estimated: bool,
}

struct RouteRow {
    session_id: String,
    created_at: String,
    tier: AutoTier,
    provider: ProviderId,
    model_id: String,
    decision: String,
}

/// One turn's cost. `None` is a turn whose model no price table knows.
type TurnCost = Option<f64>;

/// `None` when no route row falls inside the window.
pub fn router_cost(
    connection: &Connection,
    window: UsageWindow,
    now: DateTime<Utc>,
) -> ArgmaxResult<Option<RouterCostSummary>> {
    // The window starts where the Usage page's range does, so the card and
    // the ledger above it cover the same span.
    let start = bucket_starts(window, now)
        .first()
        .copied()
        .unwrap_or(now)
        .to_rfc3339_opts(SecondsFormat::Millis, true);
    let routes = routes_of_sessions_routed_since(connection, &start)?;
    if !routes.iter().any(|route| route.created_at >= start) {
        return Ok(None);
    }

    let mut tiers: BTreeMap<u8, TierTally> = BTreeMap::new();
    for session_routes in routes.chunk_by(|left, right| left.session_id == right.session_id) {
        // A chat can escalate from Cursor to another provider, so each row is
        // priced by its own provider.
        let measured = price_session(connection, session_routes, &start)?;
        let estimated = if session_routes
            .iter()
            .any(|route| route.provider == ProviderId::Cursor)
        {
            estimate_cursor_session(connection, session_routes, &start)?
        } else {
            vec![None; session_routes.len()]
        };
        for (index, route) in session_routes.iter().enumerate() {
            let cost = if route.provider == ProviderId::Cursor {
                estimated[index]
            } else {
                measured[index]
            };
            let Some(cost) = cost else { continue };
            if route.decision == "pinned" {
                continue;
            }
            let until = session_routes
                .get(index + 1)
                .map(|next| next.created_at.as_str());
            let Some(turns) = answered_turns(connection, route, until)? else {
                continue;
            };
            let timings = turn_timings(connection, route, until)?;
            tiers
                .entry(tier_rank(route.tier))
                .or_insert_with(|| TierTally::new(route.tier))
                .add(route, turns, cost, &timings);
        }
    }
    if tiers.is_empty() {
        return Ok(None);
    }
    Ok(Some(RouterCostSummary {
        tiers: tiers.into_values().map(TierTally::finish).collect(),
    }))
}

/// Timeline events that only exist once the model has answered: text or
/// reasoning, or a tool call.
const ANSWER_EVENTS: [&str; 3] = ["message.delta", "message.completed", "command.started"];

/// Timeline events that end a turn. A failed turn ends in a plain `error`,
/// which other failures share, so it is only counted by the floor of one.
const TURN_END_EVENTS: [&str; 2] = ["session.completed", "session.cancelled"];

/// The turns inside a route row's window: one per turn that ended there, at
/// least one. Goal continuations and a turn that re-runs a queued message
/// carry no route row of their own, so they share the window before them.
///
/// `None` when the model never answered in the window: cancelled, or failed,
/// before any reply or usage. That cost nothing, so the card leaves it out
/// entirely rather than listing it as unpriced. A turn still waiting on its
/// first reply is left out too, until that reply lands.
fn answered_turns(
    connection: &Connection,
    route: &RouteRow,
    until: Option<&str>,
) -> ArgmaxResult<Option<u32>> {
    let [a, b, c] = ANSWER_EVENTS;
    let [completed, cancelled] = TURN_END_EVENTS;
    let (answered, ended) = connection
        .prepare_cached(
            r#"
            SELECT
              EXISTS (
                SELECT 1 FROM events
                WHERE session_id = ?1 AND created_at >= ?2 AND (?3 IS NULL OR created_at < ?3)
                  AND type IN (?4, ?5, ?6)
              ) OR EXISTS (
                SELECT 1 FROM usage_events
                WHERE session_id = ?1 AND created_at >= ?2 AND (?3 IS NULL OR created_at < ?3)
              ),
              (
                SELECT COUNT(*) FROM events
                WHERE session_id = ?1 AND created_at >= ?2 AND (?3 IS NULL OR created_at < ?3)
                  AND type IN (?7, ?8)
              )
            "#,
        )
        .map_err(sqlite_error)?
        .query_row(
            (
                route.session_id.as_str(),
                route.created_at.as_str(),
                until,
                a,
                b,
                c,
                completed,
                cancelled,
            ),
            |row| Ok((row.get::<_, bool>(0)?, row.get::<_, u32>(1)?)),
        )
        .map_err(sqlite_error)?;
    Ok(answered.then_some(ended.max(1)))
}

struct TurnTiming {
    turn_seconds: f64,
    first_answer_seconds: f64,
}

/// Every finished, answered turn in a route row's window. The window's first
/// turn starts at the row, which is the send; a later one (a goal
/// continuation) at its own `user.message`. A message sent mid-turn starts
/// nothing. Time an approval spent waiting on the user comes off the turn.
fn turn_timings(
    connection: &Connection,
    route: &RouteRow,
    until: Option<&str>,
) -> ArgmaxResult<Vec<TurnTiming>> {
    let [completed, cancelled] = TURN_END_EVENTS;
    let marks = connection
        .prepare_cached(
            r#"
            SELECT created_at, type = 'user.message' FROM events
            WHERE session_id = ?1 AND created_at >= ?2 AND (?3 IS NULL OR created_at < ?3)
              AND type IN ('user.message', ?4, ?5)
            ORDER BY created_at, rowid
            "#,
        )
        .map_err(sqlite_error)?
        .query_map(
            (
                route.session_id.as_str(),
                route.created_at.as_str(),
                until,
                completed,
                cancelled,
            ),
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, bool>(1)?)),
        )
        .map_err(sqlite_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(sqlite_error)?;

    let mut timings = Vec::new();
    let mut started = Some(route.created_at.clone());
    for (at, is_message) in marks {
        if is_message {
            started.get_or_insert(at);
            continue;
        }
        let Some(start) = started.take() else {
            continue;
        };
        let Some(first_answer) = first_answer_at(connection, &route.session_id, &start, &at)?
        else {
            continue;
        };
        let waited = approval_wait_seconds(connection, &route.session_id, &start, &at)?;
        if let (Some(turn), Some(first)) = (
            seconds_between(&start, &at),
            seconds_between(&start, &first_answer),
        ) {
            timings.push(TurnTiming {
                turn_seconds: (turn - waited).max(0.0),
                first_answer_seconds: first,
            });
        }
    }
    Ok(timings)
}

fn first_answer_at(
    connection: &Connection,
    session_id: &str,
    start: &str,
    end: &str,
) -> ArgmaxResult<Option<String>> {
    let [a, b, c] = ANSWER_EVENTS;
    connection
        .prepare_cached(
            r#"
            SELECT MIN(created_at) FROM events
            WHERE session_id = ?1 AND created_at >= ?2 AND created_at <= ?3
              AND type IN (?4, ?5, ?6)
            "#,
        )
        .map_err(sqlite_error)?
        .query_row((session_id, start, end, a, b, c), |row| row.get(0))
        .map_err(sqlite_error)
}

/// Seconds within `start..end` that an approval spent waiting on the user.
fn approval_wait_seconds(
    connection: &Connection,
    session_id: &str,
    start: &str,
    end: &str,
) -> ArgmaxResult<f64> {
    let waits = connection
        .prepare_cached(
            r#"
            SELECT MAX(created_at, ?2), MIN(COALESCE(resolved_at, ?3), ?3) FROM approvals
            WHERE session_id = ?1 AND created_at < ?3 AND COALESCE(resolved_at, ?3) > ?2
            "#,
        )
        .map_err(sqlite_error)?
        .query_map((session_id, start, end), |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(sqlite_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(sqlite_error)?;
    Ok(waits
        .iter()
        .filter_map(|(from, to)| seconds_between(from, to))
        .sum())
}

fn seconds_between(from: &str, to: &str) -> Option<f64> {
    let from = DateTime::parse_from_rfc3339(from).ok()?;
    let to = DateTime::parse_from_rfc3339(to).ok()?;
    Some((to - from).num_milliseconds() as f64 / 1000.0)
}

fn median(mut values: Vec<f64>) -> Option<f64> {
    if values.is_empty() {
        return None;
    }
    values.sort_by(f64::total_cmp);
    let middle = values.len() / 2;
    Some(if values.len().is_multiple_of(2) {
        (values[middle - 1] + values[middle]) / 2.0
    } else {
        values[middle]
    })
}

/// Frontier, Balance, Speed.
fn tier_rank(tier: AutoTier) -> u8 {
    match tier {
        AutoTier::Intelligence => 0,
        AutoTier::Balanced => 1,
        AutoTier::Cost => 2,
    }
}

struct TierTally {
    cost: RouterTierCost,
    chats: HashSet<String>,
    turn_seconds: Vec<f64>,
    first_answer_seconds: Vec<f64>,
}

impl TierTally {
    fn new(tier: AutoTier) -> Self {
        Self {
            cost: RouterTierCost {
                tier,
                chats: 0,
                turns: 0,
                escalations: 0,
                reroutes: 0,
                measured_cost_usd: 0.0,
                estimated_cost_usd: 0.0,
                unpriced_turns: 0,
                models: Vec::new(),
                median_turn_seconds: None,
                median_first_answer_seconds: None,
            },
            chats: HashSet::new(),
            turn_seconds: Vec::new(),
            first_answer_seconds: Vec::new(),
        }
    }

    /// `cost` covers all `turns` of the window.
    fn add(&mut self, route: &RouteRow, turns: u32, cost: TurnCost, timings: &[TurnTiming]) {
        for timing in timings {
            self.turn_seconds.push(timing.turn_seconds);
            self.first_answer_seconds.push(timing.first_answer_seconds);
        }
        let tally = &mut self.cost;
        self.chats.insert(route.session_id.clone());
        tally.turns += turns;
        match route.decision.as_str() {
            "escalate" => tally.escalations += 1,
            "reroute" => tally.reroutes += 1,
            _ => {}
        }
        let estimated = route.provider == ProviderId::Cursor;
        match cost {
            Some(usd) if estimated => tally.estimated_cost_usd += usd,
            Some(usd) => tally.measured_cost_usd += usd,
            None => tally.unpriced_turns += turns,
        }
        let model = match tally
            .models
            .iter_mut()
            .find(|model| model.provider == route.provider && model.model_id == route.model_id)
        {
            Some(model) => model,
            None => {
                tally.models.push(RouterModelCost {
                    provider: route.provider,
                    model_id: route.model_id.clone(),
                    turns: 0,
                    cost_usd: 0.0,
                    estimated,
                });
                tally.models.last_mut().expect("just pushed")
            }
        };
        model.turns += turns;
        model.cost_usd += cost.unwrap_or(0.0);
    }

    fn finish(mut self) -> RouterTierCost {
        self.cost.chats = self.chats.len() as u32;
        self.cost.median_turn_seconds = median(self.turn_seconds);
        self.cost.median_first_answer_seconds = median(self.first_answer_seconds);
        self.cost.models.sort_by(|left, right| {
            right
                .turns
                .cmp(&left.turns)
                .then_with(|| left.model_id.cmp(&right.model_id))
        });
        self.cost
    }
}

/// Every route row of every chat routed inside the window, grouped by chat
/// and in turn order. Rows before the window are kept: they close nothing
/// inside it, but the Cursor estimate needs the whole conversation as context.
fn routes_of_sessions_routed_since(
    connection: &Connection,
    start: &str,
) -> ArgmaxResult<Vec<RouteRow>> {
    let mut statement = connection
        .prepare_cached(
            r#"
            SELECT session_id, created_at, tier, provider, model_id, decision
            FROM turn_routes
            WHERE session_id IN (SELECT session_id FROM turn_routes WHERE created_at >= ?1)
            ORDER BY session_id, created_at, id
            "#,
        )
        .map_err(sqlite_error)?;
    let rows = statement
        .query_map([start], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, String>(4)?,
                row.get::<_, String>(5)?,
            ))
        })
        .map_err(sqlite_error)?;
    let mut routes = Vec::new();
    for row in rows {
        let (session_id, created_at, tier, provider, model_id, decision) =
            row.map_err(sqlite_error)?;
        let tier = parse_tier(&tier).ok_or_else(|| {
            ArgmaxError::service("ROUTE_TIER_UNKNOWN", format!("unknown route tier {tier}"))
        })?;
        routes.push(RouteRow {
            session_id,
            created_at,
            tier,
            provider: parse_provider(&provider)?,
            model_id,
            decision,
        });
    }
    Ok(routes)
}

/// Per route row: `None` when the turn falls before the window, else its cost.
fn price_session(
    connection: &Connection,
    routes: &[RouteRow],
    start: &str,
) -> ArgmaxResult<Vec<Option<TurnCost>>> {
    let mut statement = connection
        .prepare_cached(
            r#"
            SELECT model_id, input_tokens, output_tokens, cache_read_tokens,
                   cache_write_tokens, cost_usd
            FROM usage_events
            WHERE session_id = ?1 AND created_at >= ?2 AND (?3 IS NULL OR created_at < ?3)
            "#,
        )
        .map_err(sqlite_error)?;
    let mut costs = Vec::with_capacity(routes.len());
    for (index, route) in routes.iter().enumerate() {
        if route.created_at.as_str() < start {
            costs.push(None);
            continue;
        }
        let until = routes.get(index + 1).map(|next| next.created_at.as_str());
        let rows = statement
            .query_map(
                (route.session_id.as_str(), route.created_at.as_str(), until),
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        UsageCounts {
                            input: row.get::<_, i64>(1)?.max(0) as u64,
                            output: row.get::<_, i64>(2)?.max(0) as u64,
                            cache_read: row.get::<_, i64>(3)?.max(0) as u64,
                            cache_write: row.get::<_, i64>(4)?.max(0) as u64,
                        },
                        row.get::<_, f64>(5)?,
                    ))
                },
            )
            .map_err(sqlite_error)?;
        // No usage rows yet (a cancelled turn, or a scan still behind) is
        // unknown, not $0.
        let mut turn: TurnCost = None;
        for (index, row) in rows.enumerate() {
            let (model_id, counts, reported) = row.map_err(sqlite_error)?;
            let call = usage_cost(route.provider, &model_id, counts, reported);
            turn = if index == 0 {
                call
            } else {
                turn.zip(call).map(|(sum, usd)| sum + usd)
            };
        }
        costs.push(Some(turn));
    }
    Ok(costs)
}

/// The Usage page's rule: Grok and OpenCode's own dollar figure wins, then
/// the list-price table; a model neither knows is unpriced.
fn usage_cost(
    provider: ProviderId,
    model_id: &str,
    counts: UsageCounts,
    reported: f64,
) -> TurnCost {
    let reports_cost = matches!(provider, ProviderId::Grok | ProviderId::Opencode);
    if reports_cost && reported > 0.0 {
        return Some(reported);
    }
    if list_price(model_id).is_some() {
        return Some(cost_of(counts, model_id));
    }
    (reported > 0.0).then_some(reported)
}

#[derive(Default)]
struct EstimatedTokens {
    input: u64,
    cache_read: u64,
    output: u64,
}

/// Per route row: `None` when the turn falls before the window, else its
/// estimated cost (itself `None` for a Cursor model without a known rate).
fn estimate_cursor_session(
    connection: &Connection,
    routes: &[RouteRow],
    start: &str,
) -> ArgmaxResult<Vec<Option<TurnCost>>> {
    let mut statement = connection
        .prepare_cached(
            r#"
            SELECT created_at, type, (LENGTH(message) + LENGTH(payload_json)) / ?2
            FROM events
            WHERE session_id = ?1 AND type IN (?3, ?4, ?5, ?6, ?7, ?8)
            ORDER BY created_at, rowid
            "#,
        )
        .map_err(sqlite_error)?;
    let [a, b, c, d, e, f] = CURSOR_CONTEXT_EVENTS;
    let events = statement
        .query_map(
            (
                routes[0].session_id.as_str(),
                CHARS_PER_TOKEN,
                a,
                b,
                c,
                d,
                e,
                f,
            ),
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, i64>(2)?.max(0) as u64,
                ))
            },
        )
        .map_err(sqlite_error)?;

    let mut tokens: Vec<EstimatedTokens> =
        routes.iter().map(|_| EstimatedTokens::default()).collect();
    let mut content = 0_u64;
    let mut content_at_last_call = 0_u64;
    for event in events {
        let (created_at, event_type, event_tokens) = event.map_err(sqlite_error)?;
        if CURSOR_CALL_EVENTS.contains(&event_type.as_str()) {
            // The latest route row at or before this call owns it.
            let owner = routes
                .iter()
                .rposition(|route| route.created_at <= created_at)
                .filter(|&index| routes[index].created_at.as_str() >= start);
            if let Some(index) = owner {
                let fresh = content - content_at_last_call;
                let turn = &mut tokens[index];
                turn.cache_read += CURSOR_BASE_CONTEXT_TOKENS + content - fresh;
                turn.input += fresh;
                turn.output += event_tokens;
            }
            // The call's own output reaches the next call as fresh input.
            content_at_last_call = content;
        }
        content += event_tokens;
    }

    Ok(routes
        .iter()
        .zip(tokens)
        .map(|(route, turn)| {
            if route.created_at.as_str() < start {
                return None;
            }
            let million = 1_000_000.0;
            Some(cursor_rates(&route.model_id).map(|rate| {
                (turn.input as f64 * rate.input
                    + turn.cache_read as f64 * rate.cache_read
                    + turn.output as f64 * rate.output)
                    / million
            }))
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use chrono::TimeZone;

    use super::*;
    use crate::persistence::database::Database;

    fn now() -> DateTime<Utc> {
        Utc.with_ymd_and_hms(2026, 9, 27, 12, 0, 0).unwrap()
    }

    fn open() -> Database {
        let database = Database::open_in_memory().expect("open db");
        // Rows here stand alone: no project, workspace, or session behind them.
        database
            .connection()
            .execute_batch("PRAGMA foreign_keys = OFF")
            .expect("foreign keys off");
        database
    }

    fn route(
        connection: &Connection,
        session: &str,
        at: &str,
        tier: &str,
        provider: &str,
        model: &str,
        decision: &str,
    ) {
        connection
            .execute(
                "INSERT INTO turn_routes (session_id, created_at, tier, provider, model_id, decision, reason)
                 VALUES (?, ?, ?, ?, ?, ?, 'test')",
                (session, at, tier, provider, model, decision),
            )
            .expect("insert route");
    }

    fn usage(connection: &Connection, session: &str, at: &str, model: &str, output: i64) {
        connection
            .execute(
                "INSERT INTO usage_events (session_id, model_id, input_tokens, output_tokens, created_at)
                 VALUES (?, ?, 0, ?, ?)",
                (session, model, output, at),
            )
            .expect("insert usage");
    }

    fn event(connection: &Connection, id: &str, session: &str, at: &str, kind: &str, chars: usize) {
        connection
            .execute(
                "INSERT INTO events (id, session_id, type, message, payload_json, created_at)
                 VALUES (?, ?, ?, ?, '', ?)",
                (id, session, kind, "x".repeat(chars), at),
            )
            .expect("insert event");
    }

    fn output_cost(model: &str, output: u64) -> f64 {
        cost_of(
            UsageCounts {
                input: 0,
                output,
                cache_read: 0,
                cache_write: 0,
            },
            model,
        )
    }

    #[test]
    fn no_routes_in_the_window_is_none() {
        let database = open();
        let connection = database.connection();
        assert_eq!(
            router_cost(&connection, UsageWindow::Past24h, now()).unwrap(),
            None
        );
        route(
            &connection,
            "old",
            "2026-09-20T10:00:00.000Z",
            "balanced",
            "claude",
            "claude-opus-5-5",
            "launch",
        );
        assert_eq!(
            router_cost(&connection, UsageWindow::Past24h, now()).unwrap(),
            None
        );
    }

    #[test]
    fn a_turn_the_model_never_answered_is_left_out() {
        let database = open();
        let connection = database.connection();
        // Cancelled seconds after launch: the prompt and nothing else.
        route(
            &connection,
            "gone",
            "2026-09-27T10:00:00.000Z",
            "intelligence",
            "claude",
            "claude-opus-5-5",
            "launch",
        );
        event(
            &connection,
            "e1",
            "gone",
            "2026-09-27T10:00:00.001Z",
            "user.message",
            40,
        );
        assert_eq!(
            router_cost(&connection, UsageWindow::Past24h, now()).unwrap(),
            None
        );

        // Answered, then cancelled before any usage landed: billed, so unpriced.
        route(
            &connection,
            "cut",
            "2026-09-27T11:00:00.000Z",
            "balanced",
            "grok",
            "grok-4.7",
            "launch",
        );
        event(
            &connection,
            "e2",
            "cut",
            "2026-09-27T11:00:03.000Z",
            "message.delta",
            40,
        );
        let summary = router_cost(&connection, UsageWindow::Past24h, now())
            .unwrap()
            .expect("summary");
        assert_eq!(summary.tiers.len(), 1);
        let balance = &summary.tiers[0];
        assert_eq!(balance.tier, AutoTier::Balanced);
        assert_eq!((balance.turns, balance.unpriced_turns), (1, 1));
    }

    #[test]
    fn turn_time_runs_from_send_to_end_less_approval_waits() {
        let database = open();
        let connection = database.connection();
        let model = "claude-opus-5-5";
        route(
            &connection,
            "s1",
            "2026-09-27T10:00:00.000Z",
            "balanced",
            "claude",
            model,
            "launch",
        );
        let at = |id: &str, time: &str, kind: &str| {
            event(
                &connection,
                id,
                "s1",
                &format!("2026-09-27T10:{time}Z"),
                kind,
                4,
            )
        };
        // Turn 1: answers after 4s, ends at 30s, 10s of it waiting on an approval;
        // a message sent mid-turn starts nothing.
        at("e1", "00:00.001", "user.message");
        at("e2", "00:04.000", "message.delta");
        at("e3", "00:12.000", "user.message");
        at("e4", "00:30.000", "session.completed");
        connection
            .execute(
                "INSERT INTO approvals (id, session_id, command, cwd, provider, risk_level, status, created_at, resolved_at)
                 VALUES ('a1', 's1', 'rm', '/', 'claude', 'high', 'approved', '2026-09-27T10:00:15.000Z', '2026-09-27T10:00:25.000Z')",
                [],
            )
            .expect("insert approval");
        // Turn 2, a goal continuation: answers after 2s, ends after 10s.
        at("e5", "01:00.000", "user.message");
        at("e6", "01:02.000", "command.started");
        at("e7", "01:10.000", "session.completed");
        // Turn 3 is still running: no time yet.
        at("e8", "02:00.000", "user.message");
        at("e9", "02:01.000", "message.delta");
        usage(&connection, "s1", "2026-09-27T10:00:05.000Z", model, 1_000);

        let summary = router_cost(&connection, UsageWindow::Past24h, now())
            .unwrap()
            .expect("summary");
        let balance = &summary.tiers[0];
        assert_eq!(balance.turns, 2);
        // Turns of 20s and 10s; first answers after 4s and 2s.
        assert_eq!(balance.median_turn_seconds, Some(15.0));
        assert_eq!(balance.median_first_answer_seconds, Some(3.0));
    }

    #[test]
    fn a_pin_closes_the_window_and_later_turns_share_it() {
        let database = open();
        let connection = database.connection();
        let model = "claude-opus-5-5";
        route(
            &connection,
            "s1",
            "2026-09-27T10:00:00.000Z",
            "balanced",
            "claude",
            model,
            "launch",
        );
        usage(&connection, "s1", "2026-09-27T10:01:00.000Z", model, 1_000);
        event(
            &connection,
            "e1",
            "s1",
            "2026-09-27T10:02:00.000Z",
            "session.completed",
            0,
        );
        // A goal continuation: no route row, so it shares the launch window.
        usage(&connection, "s1", "2026-09-27T10:03:00.000Z", model, 1_000);
        event(
            &connection,
            "e2",
            "s1",
            "2026-09-27T10:04:00.000Z",
            "session.completed",
            0,
        );
        // The user picks Fable: everything after is off the Router.
        route(
            &connection,
            "s1",
            "2026-09-27T10:10:00.000Z",
            "balanced",
            "claude",
            "claude-fable-5-1",
            "pinned",
        );
        usage(
            &connection,
            "s1",
            "2026-09-27T10:11:00.000Z",
            "claude-fable-5-1",
            50_000,
        );

        let summary = router_cost(&connection, UsageWindow::Past24h, now())
            .unwrap()
            .expect("summary");
        let balance = &summary.tiers[0];
        assert_eq!((balance.chats, balance.turns), (1, 2));
        assert!((balance.measured_cost_usd - output_cost(model, 2_000)).abs() < 1e-9);
        assert_eq!(balance.models.len(), 1);
        assert_eq!(balance.models[0].turns, 2);
    }

    #[test]
    fn a_cursor_chat_escalated_to_claude_prices_each_row_by_its_provider() {
        let database = open();
        let connection = database.connection();
        route(
            &connection,
            "c1",
            "2026-09-27T10:00:00.000Z",
            "cost",
            "cursor",
            "composer-2.5",
            "launch",
        );
        event(
            &connection,
            "e1",
            "c1",
            "2026-09-27T10:00:05.000Z",
            "message.completed",
            400,
        );
        route(
            &connection,
            "c1",
            "2026-09-27T10:10:00.000Z",
            "cost",
            "claude",
            "claude-opus-5-5",
            "escalate",
        );
        usage(
            &connection,
            "c1",
            "2026-09-27T10:11:00.000Z",
            "claude-opus-5-5",
            1_000,
        );

        let summary = router_cost(&connection, UsageWindow::Past24h, now())
            .unwrap()
            .expect("summary");
        let speed = &summary.tiers[0];
        assert_eq!((speed.turns, speed.unpriced_turns), (2, 0));
        assert!(speed.estimated_cost_usd > 0.0);
        assert!((speed.measured_cost_usd - output_cost("claude-opus-5-5", 1_000)).abs() < 1e-9);
    }

    #[test]
    fn each_turn_is_priced_on_the_tier_of_its_own_route_row() {
        let database = open();
        let connection = database.connection();
        let model = "claude-opus-5-5";
        route(
            &connection,
            "s1",
            "2026-09-27T10:00:00.000Z",
            "balanced",
            "claude",
            model,
            "launch",
        );
        usage(&connection, "s1", "2026-09-27T10:01:00.000Z", model, 1_000);
        route(
            &connection,
            "s1",
            "2026-09-27T10:10:00.000Z",
            "intelligence",
            "claude",
            model,
            "escalate",
        );
        usage(&connection, "s1", "2026-09-27T10:11:00.000Z", model, 5_000);
        usage(&connection, "s1", "2026-09-27T10:12:00.000Z", model, 2_000);

        let summary = router_cost(&connection, UsageWindow::Past24h, now())
            .unwrap()
            .expect("summary");
        let tiers: Vec<AutoTier> = summary.tiers.iter().map(|tier| tier.tier).collect();
        assert_eq!(tiers, vec![AutoTier::Intelligence, AutoTier::Balanced]);

        let frontier = &summary.tiers[0];
        assert_eq!(
            (frontier.chats, frontier.turns, frontier.escalations),
            (1, 1, 1)
        );
        assert!((frontier.measured_cost_usd - output_cost(model, 7_000)).abs() < 1e-9);
        assert!(frontier.measured_cost_usd > 0.0);
        let balance = &summary.tiers[1];
        assert_eq!(
            (balance.chats, balance.turns, balance.escalations),
            (1, 1, 0)
        );
        assert!((balance.measured_cost_usd - output_cost(model, 1_000)).abs() < 1e-9);
        assert_eq!(balance.estimated_cost_usd, 0.0);
        assert!(!balance.models[0].estimated);
    }

    #[test]
    fn a_cursor_turn_is_estimated_from_its_transcript() {
        let database = open();
        let connection = database.connection();
        // Context from before the window still counts as context.
        route(
            &connection,
            "c1",
            "2026-09-20T09:00:00.000Z",
            "cost",
            "cursor",
            "composer-2.5",
            "launch",
        );
        event(
            &connection,
            "e1",
            "c1",
            "2026-09-20T09:00:01.000Z",
            "user.message",
            4_000,
        );
        event(
            &connection,
            "e2",
            "c1",
            "2026-09-20T09:00:05.000Z",
            "message.completed",
            400,
        );
        route(
            &connection,
            "c1",
            "2026-09-27T10:00:00.000Z",
            "cost",
            "cursor",
            "composer-2.5",
            "kept",
        );
        event(
            &connection,
            "e3",
            "c1",
            "2026-09-27T10:00:01.000Z",
            "user.message",
            800,
        );
        event(
            &connection,
            "e4",
            "c1",
            "2026-09-27T10:00:05.000Z",
            "command.started",
            40,
        );
        event(
            &connection,
            "e5",
            "c1",
            "2026-09-27T10:00:09.000Z",
            "message.completed",
            80,
        );

        let summary = router_cost(&connection, UsageWindow::Past24h, now())
            .unwrap()
            .expect("summary");
        let speed = &summary.tiers[0];
        assert_eq!(speed.tier, AutoTier::Cost);
        assert_eq!((speed.chats, speed.turns, speed.unpriced_turns), (1, 1, 0));
        assert_eq!(speed.measured_cost_usd, 0.0);
        // Tokens are chars / 4. Call e4: 1300 of context, 300 fresh (e2's
        // output + e3); output 10. Call e5: 1310 of context, 10 fresh (e4's
        // output); output 20.
        let input = 310.0;
        let cache_read = (20_000.0 + 1_000.0) + (20_000.0 + 1_300.0);
        let output = 30.0;
        let expected = (input * 0.50 + cache_read * 0.20 + output * 2.50) / 1_000_000.0;
        assert!((speed.estimated_cost_usd - expected).abs() < 1e-12);
        assert!(speed.models[0].estimated);
    }

    #[test]
    fn an_unknown_cursor_model_is_counted_unpriced() {
        let database = open();
        let connection = database.connection();
        route(
            &connection,
            "c2",
            "2026-09-27T10:00:00.000Z",
            "balanced",
            "cursor",
            "gpt-9-cursor",
            "launch",
        );
        event(
            &connection,
            "e1",
            "c2",
            "2026-09-27T10:00:01.000Z",
            "user.message",
            400,
        );
        event(
            &connection,
            "e2",
            "c2",
            "2026-09-27T10:00:05.000Z",
            "message.completed",
            400,
        );

        let summary = router_cost(&connection, UsageWindow::Past24h, now())
            .unwrap()
            .expect("summary");
        let balance = &summary.tiers[0];
        assert_eq!((balance.turns, balance.unpriced_turns), (1, 1));
        assert_eq!(balance.estimated_cost_usd, 0.0);
        assert_eq!(balance.models[0].model_id, "gpt-9-cursor");
    }
}
