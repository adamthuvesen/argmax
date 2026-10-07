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
use crate::usage::cursor::{cursor_rates, estimate_calls};
use crate::usage::{summary::bucket_starts, UsageWindow};

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
    /// Tokens processed (uncached input, cache reads and writes, output) in
    /// the priced turns: the denominator of cost per million tokens.
    pub priced_tokens: u64,
    /// Median tokens processed per turn, over the turns that recorded usage.
    /// `None` when none did.
    pub median_turn_tokens: Option<f64>,
    /// Most turns first.
    pub models: Vec<RouterModelCost>,
    /// Route decisions behind the counted turns, most decisions first.
    pub decisions: Vec<RouterDecisionSummary>,
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

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RouterDecisionSummary {
    pub provider: ProviderId,
    pub model_id: String,
    pub reasoning_effort: Option<String>,
    pub kind: Option<String>,
    pub difficulty: Option<String>,
    pub decision: String,
    pub reason: String,
    /// Number of admitted route windows with this decision.
    pub count: u32,
    /// Answered turns in those windows, including continuations.
    pub turns: u32,
}

struct RouteRow {
    session_id: String,
    created_at: String,
    tier: AutoTier,
    provider: ProviderId,
    model_id: String,
    reasoning_effort: Option<String>,
    kind: Option<String>,
    difficulty: Option<String>,
    decision: String,
    reason: String,
}

/// One turn's cost. `None` means no recorded call or an unknown price.
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
        let cursor_calls = if session_routes
            .iter()
            .any(|route| route.provider == ProviderId::Cursor)
        {
            estimate_calls(connection, &session_routes[0].session_id)?
        } else {
            Vec::new()
        };
        for (index, route) in session_routes.iter().enumerate() {
            if route.created_at < start || route.decision == "pinned" {
                continue;
            }
            let until = session_routes
                .get(index + 1)
                .map(|next| next.created_at.as_str());
            let mut turns = turns_in_route(connection, route, until)?;
            if route.provider == ProviderId::Cursor {
                price_cursor_turns(route, until, &cursor_calls, &mut turns);
            } else {
                price_measured_turns(connection, route, until, &mut turns)?;
            }
            // A cancelled turn is left out entirely, cost included.
            turns.retain(|turn| turn.answered() && !turn.cancelled);
            if turns.is_empty() {
                continue;
            }
            let timings = turn_timings(connection, route, &turns)?;
            tiers
                .entry(tier_rank(route.tier))
                .or_insert_with(|| TierTally::new(route.tier))
                .add(route, &turns, &timings);
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

/// Timeline events that reliably end a turn. A plain `error` may describe
/// other failures, so activity or usage is enough to count an unended turn.
const TURN_END_EVENTS: [&str; 2] = ["session.completed", "session.cancelled"];

/// A completed turn owns late usage until the next genuine turn starts. This
/// matters because usage rows are inserted after timeline events are flushed.
struct RouteTurn {
    start_at: String,
    ended_at: Option<String>,
    cancelled: bool,
    first_answer_at: Option<String>,
    has_usage: bool,
    cost: TurnCost,
    /// Tokens processed across the turn's calls, priced or not.
    tokens: u64,
    unknown_usage: bool,
}

impl RouteTurn {
    fn new(start_at: String) -> Self {
        Self {
            start_at,
            ended_at: None,
            cancelled: false,
            first_answer_at: None,
            has_usage: false,
            cost: None,
            tokens: 0,
            unknown_usage: false,
        }
    }

    fn answered(&self) -> bool {
        self.first_answer_at.is_some() || self.has_usage
    }

    fn add_usage(&mut self, cost: TurnCost, tokens: u64) {
        self.has_usage = true;
        self.tokens += tokens;
        match cost {
            Some(usd) if !self.unknown_usage => {
                self.cost = Some(self.cost.unwrap_or(0.0) + usd);
            }
            _ => {
                self.unknown_usage = true;
                self.cost = None;
            }
        }
    }
}

/// A route starts one turn. Only a user message after an end marker opens a
/// continuation; a message sent mid-turn is steering, not another turn.
fn turns_in_route(
    connection: &Connection,
    route: &RouteRow,
    until: Option<&str>,
) -> ArgmaxResult<Vec<RouteTurn>> {
    let [a, b, c] = ANSWER_EVENTS;
    let [completed, cancelled] = TURN_END_EVENTS;
    let events = connection
        .prepare_cached(
            r#"
            SELECT created_at, type FROM events
            WHERE session_id = ?1 AND created_at >= ?2 AND (?3 IS NULL OR created_at < ?3)
              AND type IN ('user.message', ?4, ?5, ?6, ?7, ?8)
            ORDER BY created_at, rowid
            "#,
        )
        .map_err(sqlite_error)?
        .query_map(
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
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        )
        .map_err(sqlite_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(sqlite_error)?;
    let mut turns = vec![RouteTurn::new(route.created_at.clone())];
    for (at, kind) in events {
        let turn = turns.last_mut().expect("route opens a turn");
        if kind == "user.message" {
            if turn.ended_at.is_some() {
                turns.push(RouteTurn::new(at));
            }
        } else if kind == completed || kind == cancelled {
            if turn.ended_at.is_none() {
                turn.ended_at = Some(at);
                turn.cancelled = kind == cancelled;
            }
        } else if turn.first_answer_at.is_none() {
            turn.first_answer_at = Some(at);
        }
    }
    Ok(turns)
}

struct TurnTiming {
    turn_seconds: f64,
    first_answer_seconds: f64,
}

/// Finished turns with visible activity have latency. Usage without a visible
/// timeline event still counts for pricing, but has no first-activity time.
fn turn_timings(
    connection: &Connection,
    route: &RouteRow,
    turns: &[RouteTurn],
) -> ArgmaxResult<Vec<TurnTiming>> {
    let mut timings = Vec::new();
    for turn in turns {
        let (Some(end), Some(first_answer)) = (&turn.ended_at, &turn.first_answer_at) else {
            continue;
        };
        if first_answer > end {
            continue;
        }
        let waited = approval_wait_seconds(connection, &route.session_id, &turn.start_at, end)?;
        if let (Some(turn), Some(first)) = (
            seconds_between(&turn.start_at, end),
            seconds_between(&turn.start_at, first_answer),
        ) {
            timings.push(TurnTiming {
                turn_seconds: (turn - waited).max(0.0),
                first_answer_seconds: first,
            });
        }
    }
    Ok(timings)
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

/// Frontier, Balance, Speed, Cost.
fn tier_rank(tier: AutoTier) -> u8 {
    match tier {
        AutoTier::Intelligence => 0,
        AutoTier::Balanced => 1,
        AutoTier::Cost => 2,
        AutoTier::Economy => 3,
    }
}

struct TierTally {
    cost: RouterTierCost,
    chats: HashSet<String>,
    turn_seconds: Vec<f64>,
    first_answer_seconds: Vec<f64>,
    turn_tokens: Vec<f64>,
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
                priced_tokens: 0,
                median_turn_tokens: None,
                models: Vec::new(),
                decisions: Vec::new(),
                median_turn_seconds: None,
                median_first_answer_seconds: None,
            },
            chats: HashSet::new(),
            turn_seconds: Vec::new(),
            first_answer_seconds: Vec::new(),
            turn_tokens: Vec::new(),
        }
    }

    fn add(&mut self, route: &RouteRow, turns: &[RouteTurn], timings: &[TurnTiming]) {
        for timing in timings {
            self.turn_seconds.push(timing.turn_seconds);
            self.first_answer_seconds.push(timing.first_answer_seconds);
        }
        let tally = &mut self.cost;
        self.chats.insert(route.session_id.clone());
        tally.turns += turns.len() as u32;
        let decision = match tally.decisions.iter_mut().find(|decision| {
            decision.provider == route.provider
                && decision.model_id == route.model_id
                && decision.reasoning_effort == route.reasoning_effort
                && decision.kind == route.kind
                && decision.difficulty == route.difficulty
                && decision.decision == route.decision
                && decision.reason == route.reason
        }) {
            Some(decision) => decision,
            None => {
                tally.decisions.push(RouterDecisionSummary {
                    provider: route.provider,
                    model_id: route.model_id.clone(),
                    reasoning_effort: route.reasoning_effort.clone(),
                    kind: route.kind.clone(),
                    difficulty: route.difficulty.clone(),
                    decision: route.decision.clone(),
                    reason: route.reason.clone(),
                    count: 0,
                    turns: 0,
                });
                tally.decisions.last_mut().expect("just pushed")
            }
        };
        decision.count += 1;
        decision.turns += turns.len() as u32;
        match route.decision.as_str() {
            "escalate" => tally.escalations += 1,
            "reroute" => tally.reroutes += 1,
            _ => {}
        }
        let estimated = route.provider == ProviderId::Cursor;
        let mut route_cost = 0.0;
        for turn in turns {
            match turn.cost {
                Some(usd) => {
                    route_cost += usd;
                    tally.priced_tokens += turn.tokens;
                }
                None => tally.unpriced_turns += 1,
            }
            if turn.tokens > 0 {
                self.turn_tokens.push(turn.tokens as f64);
            }
        }
        if estimated {
            tally.estimated_cost_usd += route_cost;
        } else {
            tally.measured_cost_usd += route_cost;
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
        model.turns += turns.len() as u32;
        model.cost_usd += route_cost;
    }

    fn finish(mut self) -> RouterTierCost {
        self.cost.chats = self.chats.len() as u32;
        self.cost.median_turn_seconds = median(self.turn_seconds);
        self.cost.median_first_answer_seconds = median(self.first_answer_seconds);
        self.cost.median_turn_tokens = median(self.turn_tokens);
        self.cost.models.sort_by(|left, right| {
            right
                .turns
                .cmp(&left.turns)
                .then_with(|| left.model_id.cmp(&right.model_id))
        });
        self.cost.decisions.sort_by(|left, right| {
            right
                .count
                .cmp(&left.count)
                .then_with(|| (left.provider as u8).cmp(&(right.provider as u8)))
                .then_with(|| left.model_id.cmp(&right.model_id))
                .then_with(|| left.reasoning_effort.cmp(&right.reasoning_effort))
                .then_with(|| left.kind.cmp(&right.kind))
                .then_with(|| left.difficulty.cmp(&right.difficulty))
                .then_with(|| left.decision.cmp(&right.decision))
                .then_with(|| left.reason.cmp(&right.reason))
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
            SELECT session_id, created_at, tier, provider, model_id,
                   reasoning_effort, kind, difficulty, decision, reason
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
                row.get::<_, Option<String>>(5)?,
                row.get::<_, Option<String>>(6)?,
                row.get::<_, Option<String>>(7)?,
                row.get::<_, String>(8)?,
                row.get::<_, String>(9)?,
            ))
        })
        .map_err(sqlite_error)?;
    let mut routes = Vec::new();
    for row in rows {
        let (
            session_id,
            created_at,
            tier,
            provider,
            model_id,
            reasoning_effort,
            kind,
            difficulty,
            decision,
            reason,
        ) = row.map_err(sqlite_error)?;
        let tier = parse_tier(&tier).ok_or_else(|| {
            ArgmaxError::service("ROUTE_TIER_UNKNOWN", format!("unknown route tier {tier}"))
        })?;
        routes.push(RouteRow {
            session_id,
            created_at,
            tier,
            provider: parse_provider(&provider)?,
            model_id,
            reasoning_effort,
            kind,
            difficulty,
            decision,
            reason,
        });
    }
    Ok(routes)
}

/// A usage row belongs to the latest turn started at or before it. The caller
/// clips rows to the route window, including a pin or same-time next route.
fn turn_index(turns: &[RouteTurn], at: &str) -> Option<usize> {
    turns
        .partition_point(|turn| turn.start_at.as_str() <= at)
        .checked_sub(1)
}

fn price_measured_turns(
    connection: &Connection,
    route: &RouteRow,
    until: Option<&str>,
    turns: &mut [RouteTurn],
) -> ArgmaxResult<()> {
    let mut statement = connection
        .prepare_cached(
            r#"
            SELECT created_at, model_id, input_tokens, output_tokens, cache_read_tokens,
                   cache_write_tokens, cost_usd
            FROM usage_events
            WHERE session_id = ?1 AND created_at >= ?2 AND (?3 IS NULL OR created_at < ?3)
            ORDER BY created_at, rowid
            "#,
        )
        .map_err(sqlite_error)?;
    let rows = statement
        .query_map(
            (route.session_id.as_str(), route.created_at.as_str(), until),
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    UsageCounts {
                        input: row.get::<_, i64>(2)?.max(0) as u64,
                        output: row.get::<_, i64>(3)?.max(0) as u64,
                        cache_read: row.get::<_, i64>(4)?.max(0) as u64,
                        cache_write: row.get::<_, i64>(5)?.max(0) as u64,
                    },
                    row.get::<_, f64>(6)?,
                ))
            },
        )
        .map_err(sqlite_error)?;
    for row in rows {
        let (at, model_id, counts, reported) = row.map_err(sqlite_error)?;
        if let Some(index) = turn_index(turns, &at) {
            let tokens = counts.input + counts.output + counts.cache_read + counts.cache_write;
            turns[index].add_usage(
                usage_cost(route.provider, &model_id, counts, reported),
                tokens,
            );
        }
    }
    Ok(())
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

/// Estimate once for the whole Cursor chat, then assign calls to actual
/// turns. A known model rate without a call is still an unpriced turn.
fn price_cursor_turns(
    route: &RouteRow,
    until: Option<&str>,
    calls: &[crate::usage::cursor::EstimatedCall],
    turns: &mut [RouteTurn],
) {
    for call in calls {
        if call.created_at < route.created_at
            || until.is_some_and(|end| call.created_at.as_str() >= end)
        {
            continue;
        }
        if let Some(index) = turn_index(turns, &call.created_at) {
            let rate = cursor_rates(&route.model_id, &call.created_at);
            turns[index].add_usage(
                rate.map(|rate| rate.cost(call)),
                call.input + call.cache_read + call.output,
            );
        }
    }
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

        // Answered, then cancelled: the turn is left out of the card, even
        // when usage landed.
        usage(
            &connection,
            "cut",
            "2026-09-27T11:00:05.000Z",
            "grok-4.7",
            100,
        );
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
        event(
            &connection,
            "e3",
            "cut",
            "2026-09-27T11:00:04.000Z",
            "session.cancelled",
            0,
        );
        assert_eq!(
            router_cost(&connection, UsageWindow::Past24h, now()).unwrap(),
            None
        );

        // Answered and finished with no usage recorded: still unpriced.
        route(
            &connection,
            "done",
            "2026-09-27T12:00:00.000Z",
            "balanced",
            "grok",
            "grok-4.7",
            "launch",
        );
        event(
            &connection,
            "e4",
            "done",
            "2026-09-27T12:00:03.000Z",
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
        // Turn 3 is still running: counted after activity, but no time yet.
        at("e8", "02:00.000", "user.message");
        at("e9", "02:01.000", "message.delta");
        usage(&connection, "s1", "2026-09-27T10:00:05.000Z", model, 1_000);

        let summary = router_cost(&connection, UsageWindow::Past24h, now())
            .unwrap()
            .expect("summary");
        let balance = &summary.tiers[0];
        assert_eq!((balance.turns, balance.unpriced_turns), (3, 2));
        // Turns of 20s and 10s; first answers after 4s and 2s.
        assert_eq!(balance.median_turn_seconds, Some(15.0));
        assert_eq!(balance.median_first_answer_seconds, Some(3.0));
        // Only turn 1 recorded usage; the others have no tokens to median.
        assert_eq!(balance.priced_tokens, 1_000);
        assert_eq!(balance.median_turn_tokens, Some(1_000.0));
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
        event(
            &connection,
            "e1b",
            "s1",
            "2026-09-27T10:02:30.000Z",
            "user.message",
            20,
        );
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
        assert_eq!(balance.decisions.len(), 1);
        assert_eq!(
            (balance.decisions[0].count, balance.decisions[0].turns),
            (1, 2)
        );
        assert_eq!(balance.decisions[0].decision, "launch");
    }

    #[test]
    fn decisions_group_matching_route_windows_and_keep_stored_metadata() {
        let database = open();
        let connection = database.connection();
        let model = "claude-opus-5-5";
        for (session, minute) in [("s1", "00"), ("s2", "10"), ("s3", "20"), ("s4", "30")] {
            route(
                &connection,
                session,
                &format!("2026-09-27T10:{minute}:00.000Z"),
                "balanced",
                "claude",
                model,
                "launch",
            );
        }
        connection
            .execute(
                "UPDATE turn_routes SET reasoning_effort = 'medium', kind = 'coding',
                 difficulty = 'standard', reason = 'coding · standard'
                 WHERE session_id IN ('s1', 's2', 's4')",
                [],
            )
            .unwrap();
        connection
            .execute(
                "UPDATE turn_routes SET reasoning_effort = 'high', kind = 'review',
                 difficulty = 'heavy', reason = 'review · heavy' WHERE session_id = 's3'",
                [],
            )
            .unwrap();

        usage(&connection, "s1", "2026-09-27T10:01:00.000Z", model, 100);
        event(
            &connection,
            "e1",
            "s1",
            "2026-09-27T10:02:00.000Z",
            "session.completed",
            0,
        );
        event(
            &connection,
            "e1b",
            "s1",
            "2026-09-27T10:02:30.000Z",
            "user.message",
            20,
        );
        event(
            &connection,
            "e1c",
            "s1",
            "2026-09-27T10:02:40.000Z",
            "message.delta",
            4,
        );
        event(
            &connection,
            "e2",
            "s1",
            "2026-09-27T10:03:00.000Z",
            "session.completed",
            0,
        );
        usage(&connection, "s2", "2026-09-27T10:11:00.000Z", model, 100);
        usage(&connection, "s3", "2026-09-27T10:21:00.000Z", model, 100);
        // An unanswered route and a subsequent pin do not enter the breakdown.
        route(
            &connection,
            "s1",
            "2026-09-27T10:04:00.000Z",
            "balanced",
            "claude",
            model,
            "pinned",
        );
        usage(&connection, "s1", "2026-09-27T10:05:00.000Z", model, 100);

        let summary = router_cost(&connection, UsageWindow::Past24h, now())
            .unwrap()
            .expect("summary");
        let balance = &summary.tiers[0];
        assert_eq!(balance.turns, 4);
        assert_eq!(balance.decisions.len(), 2);
        let matching = &balance.decisions[0];
        assert_eq!((matching.count, matching.turns), (2, 3));
        assert_eq!(matching.provider, ProviderId::Claude);
        assert_eq!(matching.model_id, model);
        assert_eq!(matching.reasoning_effort.as_deref(), Some("medium"));
        assert_eq!(matching.kind.as_deref(), Some("coding"));
        assert_eq!(matching.difficulty.as_deref(), Some("standard"));
        assert_eq!(matching.decision, "launch");
        assert_eq!(matching.reason, "coding · standard");
        let review = &balance.decisions[1];
        assert_eq!((review.count, review.turns), (1, 1));
        assert_eq!(review.reasoning_effort.as_deref(), Some("high"));
        assert_eq!(review.kind.as_deref(), Some("review"));
        // The second s1 turn answered without usage, so coverage is per turn.
        assert_eq!(balance.unpriced_turns, 1);
        assert!((balance.measured_cost_usd - output_cost(model, 300)).abs() < 1e-9);
    }

    #[test]
    fn measured_coverage_uses_real_turn_starts_and_keeps_late_usage() {
        let database = open();
        let connection = database.connection();
        let model = "claude-opus-5-5";
        for (session, minute) in [("first", "00"), ("second", "10"), ("unknown", "20")] {
            route(
                &connection,
                session,
                &format!("2026-09-27T10:{minute}:00.000Z"),
                "balanced",
                "claude",
                model,
                "launch",
            );
        }
        event(
            &connection,
            "f1",
            "first",
            "2026-09-27T10:00:05.000Z",
            "message.delta",
            4,
        );
        // Steering before completion does not open another turn.
        event(
            &connection,
            "f2",
            "first",
            "2026-09-27T10:00:07.000Z",
            "user.message",
            4,
        );
        event(
            &connection,
            "f3",
            "first",
            "2026-09-27T10:00:10.000Z",
            "session.completed",
            0,
        );
        // The usage scanner can insert final usage after the terminal event.
        usage(&connection, "first", "2026-09-27T10:00:11.000Z", model, 100);
        event(
            &connection,
            "f4",
            "first",
            "2026-09-27T10:01:00.000Z",
            "user.message",
            4,
        );
        event(
            &connection,
            "f5",
            "first",
            "2026-09-27T10:01:05.000Z",
            "message.delta",
            4,
        );
        event(
            &connection,
            "f6",
            "first",
            "2026-09-27T10:01:10.000Z",
            "session.completed",
            0,
        );

        event(
            &connection,
            "s1",
            "second",
            "2026-09-27T10:10:05.000Z",
            "message.delta",
            4,
        );
        event(
            &connection,
            "s2",
            "second",
            "2026-09-27T10:10:10.000Z",
            "session.completed",
            0,
        );
        event(
            &connection,
            "s3",
            "second",
            "2026-09-27T10:11:00.000Z",
            "user.message",
            4,
        );
        event(
            &connection,
            "s4",
            "second",
            "2026-09-27T10:11:05.000Z",
            "message.delta",
            4,
        );
        event(
            &connection,
            "s5",
            "second",
            "2026-09-27T10:11:10.000Z",
            "session.completed",
            0,
        );
        usage(
            &connection,
            "second",
            "2026-09-27T10:11:11.000Z",
            model,
            200,
        );

        usage(
            &connection,
            "unknown",
            "2026-09-27T10:20:05.000Z",
            model,
            300,
        );
        event(
            &connection,
            "u1",
            "unknown",
            "2026-09-27T10:20:10.000Z",
            "session.completed",
            0,
        );
        event(
            &connection,
            "u2",
            "unknown",
            "2026-09-27T10:21:00.000Z",
            "user.message",
            4,
        );
        usage(
            &connection,
            "unknown",
            "2026-09-27T10:21:05.000Z",
            "unknown-model",
            400,
        );
        event(
            &connection,
            "u3",
            "unknown",
            "2026-09-27T10:21:10.000Z",
            "session.completed",
            0,
        );

        let summary = router_cost(&connection, UsageWindow::Past24h, now())
            .unwrap()
            .expect("summary");
        let balance = &summary.tiers[0];
        assert_eq!(
            (balance.chats, balance.turns, balance.unpriced_turns),
            (3, 6, 3)
        );
        assert!((balance.measured_cost_usd - output_cost(model, 600)).abs() < 1e-9);
        assert_eq!(
            (balance.decisions[0].count, balance.decisions[0].turns),
            (3, 6)
        );
    }

    #[test]
    fn cursor_continuation_without_a_model_call_is_unpriced() {
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
            "2026-09-27T10:00:01.000Z",
            "user.message",
            80,
        );
        event(
            &connection,
            "e2",
            "c1",
            "2026-09-27T10:00:05.000Z",
            "message.completed",
            80,
        );
        event(
            &connection,
            "e3",
            "c1",
            "2026-09-27T10:00:10.000Z",
            "session.completed",
            0,
        );
        event(
            &connection,
            "e4",
            "c1",
            "2026-09-27T10:01:00.000Z",
            "user.message",
            80,
        );
        event(
            &connection,
            "e5",
            "c1",
            "2026-09-27T10:01:05.000Z",
            "message.delta",
            80,
        );
        event(
            &connection,
            "e6",
            "c1",
            "2026-09-27T10:01:10.000Z",
            "session.completed",
            0,
        );

        let speed = &router_cost(&connection, UsageWindow::Past24h, now())
            .unwrap()
            .expect("summary")
            .tiers[0];
        assert_eq!((speed.turns, speed.unpriced_turns), (2, 1));
        assert!(speed.estimated_cost_usd > 0.0);
        assert_eq!((speed.decisions[0].count, speed.decisions[0].turns), (1, 2));
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
        assert_eq!(speed.decisions.len(), 1);
        assert_eq!(speed.decisions[0].decision, "kept");
        assert_eq!((speed.decisions[0].count, speed.decisions[0].turns), (1, 1));
        assert_eq!(speed.decisions[0].reasoning_effort, None);
        assert_eq!(speed.decisions[0].kind, None);
        assert_eq!(speed.decisions[0].difficulty, None);
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
