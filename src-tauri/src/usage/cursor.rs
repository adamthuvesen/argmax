//! Cursor keeps no token log: ACP reports no usage and `cursor-agent` stores
//! no counts on disk. So a Cursor chat Argmax ran is estimated from its own
//! transcript in the `events` table. The shape: every model call re-reads a
//! base prompt plus the whole conversation so far (cache read) and adds what
//! arrived since the last call (input); the call's own event is its output.
//! Checked against Claude and Codex chats with recorded usage, summed cache
//! reads land within 0.7x–1.6x of the bill — which is why every Cursor figure
//! is labelled an estimate. The Usage page and the Router card share it; see
//! docs/usage.md → Cursor estimate.

use rusqlite::Connection;

use crate::error::ArgmaxResult;
use crate::persistence::sqlite_error;

/// Characters per token for transcript text.
const CHARS_PER_TOKEN: i64 = 4;
/// The most one event adds to the conversation. Cursor writes a command's
/// output past 40 KB (`fileOutputThresholdBytes`) to a file and shows the
/// model a preview, so a huge log is not huge context.
const EVENT_TOKEN_CAP: i64 = 10_000;
/// Every Cursor model Argmax offers has a 1M window. A conversation that
/// outgrows it is compacted, so the estimate starts it over.
const CONTEXT_WINDOW_TOKENS: u64 = 1_000_000;
/// Cursor's system prompt and tools, re-read by every call: a one-shot
/// `cursor-agent -p` "reply ok" reported 14,868 input + 3,906 cache read
/// tokens on 2026-09-27.
const BASE_CONTEXT_TOKENS: u64 = 20_000;
/// Transcript events that carry model context.
const CONTEXT_EVENTS: [&str; 6] = [
    "user.message",
    "message.completed",
    "command.started",
    "command.completed",
    "agent.started",
    "agent.completed",
];
/// Events that mark one model call; their own text is that call's output.
const CALL_EVENTS: [&str; 3] = ["command.started", "agent.started", "message.completed"];
/// `/clear` starts a fresh conversation, so nothing before it is context.
const CLEARED_EVENT: &str = "session.cleared";

/// One model call rebuilt from the transcript.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EstimatedCall {
    pub created_at: String,
    pub input: u64,
    pub cache_read: u64,
    pub output: u64,
}

/// Every model call in a chat, in order. The whole conversation is read,
/// whatever window the caller wants, because earlier turns are context.
pub fn estimate_calls(
    connection: &Connection,
    session_id: &str,
) -> ArgmaxResult<Vec<EstimatedCall>> {
    let mut statement = connection
        .prepare_cached(
            r#"
            SELECT created_at, type, MIN(?3, (LENGTH(message) + LENGTH(
                CASE WHEN json_valid(payload_json)
                  -- Cursor's payload repeats a command's output under `raw`
                  -- and again as `interleavedOutput`; the model sees it once.
                  THEN json_remove(payload_json, '$.raw', '$.result.success.interleavedOutput')
                  ELSE payload_json
                END)) / ?2)
            FROM events
            WHERE session_id = ?1 AND type IN (?4, ?5, ?6, ?7, ?8, ?9, ?10)
            ORDER BY created_at, rowid
            "#,
        )
        .map_err(sqlite_error)?;
    let [a, b, c, d, e, f] = CONTEXT_EVENTS;
    let events = statement
        .query_map(
            (
                session_id,
                CHARS_PER_TOKEN,
                EVENT_TOKEN_CAP,
                a,
                b,
                c,
                d,
                e,
                f,
                CLEARED_EVENT,
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

    let mut calls = Vec::new();
    let mut content = 0_u64;
    let mut content_at_last_call = 0_u64;
    for event in events {
        let (created_at, event_type, event_tokens) = event.map_err(sqlite_error)?;
        if event_type == CLEARED_EVENT {
            content = 0;
            content_at_last_call = 0;
            continue;
        }
        if CALL_EVENTS.contains(&event_type.as_str()) {
            let fresh = content - content_at_last_call;
            calls.push(EstimatedCall {
                created_at,
                input: fresh,
                cache_read: BASE_CONTEXT_TOKENS + content - fresh,
                output: event_tokens,
            });
            // The call's own output reaches the next call as fresh input.
            content_at_last_call = content;
        }
        content += event_tokens;
        if content > CONTEXT_WINDOW_TOKENS {
            content = 0;
            content_at_last_call = 0;
        }
    }
    Ok(calls)
}

/// Model id for a Cursor stretch whose model is no longer recorded: a chat
/// that left Cursor without Router rows keeps only its current model.
const UNKNOWN_MODEL: &str = "unknown";

/// One estimated call a chat made while it was on Cursor.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CursorCall {
    pub session_id: String,
    pub model_id: String,
    pub call: EstimatedCall,
}

/// Every call made on Cursor within `from..to` (RFC 3339 UTC, end exclusive),
/// across the chats Argmax ran. A call's provider and model come from the
/// chat's latest Router row at or before it; without one, from its provider
/// switches, priced at the chat's current model while it is still on Cursor.
pub fn calls_between(
    connection: &Connection,
    from: &str,
    to: &str,
) -> ArgmaxResult<Vec<CursorCall>> {
    // A chat is found by its current provider or a Router row. One that left
    // Cursor by a plain provider switch is missed: finding it means walking
    // every recent chat's whole event history, which the page cannot afford.
    let sessions = connection
        .prepare_cached(
            r#"
            SELECT s.id, s.provider, COALESCE(s.model_id, '') FROM sessions s
            WHERE s.last_activity_at >= ?1 AND (
              s.provider = 'cursor'
              OR EXISTS (
                SELECT 1 FROM turn_routes r WHERE r.session_id = s.id AND r.provider = 'cursor'
              )
            )
            "#,
        )
        .map_err(sqlite_error)?
        .query_map([from], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ))
        })
        .map_err(sqlite_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(sqlite_error)?;

    let mut calls = Vec::new();
    for (session_id, provider, model_id) in sessions {
        let routes = timeline(
            connection,
            "SELECT created_at, provider, model_id FROM turn_routes
             WHERE session_id = ?1 ORDER BY created_at, id",
            &session_id,
        )?;
        let switches = timeline(
            connection,
            "SELECT created_at, json_extract(payload_json, '$.from'),
                    json_extract(payload_json, '$.provider')
             FROM events WHERE session_id = ?1 AND type = 'session.provider-changed'
             ORDER BY created_at, rowid",
            &session_id,
        )?;
        // Before its first switch a chat was on the provider it switched from.
        let first_provider = switches
            .first()
            .map_or(provider.as_str(), |switch| switch.1.as_str());
        let current_model = if provider == "cursor" {
            model_id.as_str()
        } else {
            UNKNOWN_MODEL
        };
        for call in estimate_calls(connection, &session_id)? {
            if call.created_at.as_str() < from || call.created_at.as_str() >= to {
                continue;
            }
            let latest = |rows: &[(String, String, String)]| {
                rows.iter().rposition(|row| row.0 <= call.created_at)
            };
            let (call_provider, call_model) = match latest(&routes) {
                Some(index) => (routes[index].1.as_str(), routes[index].2.as_str()),
                None => (
                    latest(&switches).map_or(first_provider, |index| switches[index].2.as_str()),
                    current_model,
                ),
            };
            if call_provider == "cursor" {
                calls.push(CursorCall {
                    session_id: session_id.clone(),
                    model_id: call_model.to_owned(),
                    call,
                });
            }
        }
    }
    Ok(calls)
}

/// `(created_at, a, b)` rows for one chat, in order.
fn timeline(
    connection: &Connection,
    sql: &str,
    session_id: &str,
) -> ArgmaxResult<Vec<(String, String, String)>> {
    connection
        .prepare_cached(sql)
        .map_err(sqlite_error)?
        .query_map([session_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, Option<String>>(1)?.unwrap_or_default(),
                row.get::<_, Option<String>>(2)?.unwrap_or_default(),
            ))
        })
        .map_err(sqlite_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(sqlite_error)
}

/// Cursor's published per-million list rates (https://cursor.com/docs/models,
/// fetched 2026-09-27), Standard rather than Fast. Kept here, not in
/// `providers::pricing`, whose Cursor rows are deliberate zero placeholders.
/// No estimated call writes cache, so cache-write rates are left out.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct CursorRates {
    pub input: f64,
    pub cache_read: f64,
    pub output: f64,
}

impl CursorRates {
    pub fn cost(&self, call: &EstimatedCall) -> f64 {
        (call.input as f64 * self.input
            + call.cache_read as f64 * self.cache_read
            + call.output as f64 * self.output)
            / 1_000_000.0
    }

    /// What the cache reads saved against paying the input rate for them.
    pub fn cache_savings(&self, call: &EstimatedCall) -> f64 {
        call.cache_read as f64 * (self.input - self.cache_read) / 1_000_000.0
    }
}

/// `None` for a model Cursor publishes no fixed rate for — Auto bills
/// whichever model it routed each request to — or one this table predates.
pub fn cursor_rates(model_id: &str) -> Option<CursorRates> {
    let rates = |input, cache_read, output| {
        Some(CursorRates {
            input,
            cache_read,
            output,
        })
    };
    // Argmax's ids carry an effort alias (`grok-4.7-medium`) and some a
    // `cursor-` prefix; the rate belongs to the family.
    let family = model_id.strip_prefix("cursor-").unwrap_or(model_id);
    let family = ["-none", "-low", "-medium", "-high", "-xhigh", "-max"]
        .iter()
        .find_map(|effort| family.strip_suffix(effort))
        .unwrap_or(family);
    match family {
        "composer-2.5" => rates(0.50, 0.20, 2.50),
        "grok-4.7" | "grok-4.6" | "grok-4.5" => rates(2.0, 0.50, 6.0),
        "claude-opus-5-5" => rates(4.0, 0.20, 20.0),
        "gemini-3.8-flash" => rates(0.75, 0.075, 3.50),
        "gemini-2.5-flash" => rates(0.30, 0.03, 2.50),
        "gpt-5.4" => rates(2.50, 0.25, 15.0),
        "gpt-5.6-sol" => rates(4.0, 0.40, 20.0),
        "gpt-5.6-terra" => rates(2.0, 0.20, 12.0),
        "gpt-5.6-luna" => rates(0.20, 0.02, 1.20),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rates_follow_the_family_not_the_effort_alias() {
        assert_eq!(cursor_rates("grok-4.7-medium"), cursor_rates("grok-4.7"));
        assert_eq!(
            cursor_rates("cursor-grok-4.6-medium"),
            cursor_rates("grok-4.6")
        );
        assert_eq!(
            cursor_rates("claude-opus-5-5-medium").map(|rate| rate.output),
            Some(20.0)
        );
        assert_eq!(cursor_rates("auto-smart[optimize_for=cost]"), None);
        assert_eq!(cursor_rates("composer-2"), None);
    }
}
