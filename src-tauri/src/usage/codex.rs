//! Codex rollouts: `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`.
//!
//! Usage rides on `event_msg` lines whose `payload.type` is `token_count`,
//! under `payload.info.last_token_usage`. `total_token_usage` on the same line
//! is the session running total and summing it would bill every turn again.

use serde_json::{Map, Value};

use crate::ipc::validation::ProviderId;
use crate::providers::normalizer::{number_value, object_value, string_value};
use crate::usage::records::{
    line_may_carry_usage, rfc3339_to_ms, TranscriptContext, UsageRecord, UsageRecordTokens,
};

/// A forked or subagent rollout opens with the parent's history rewritten in
/// one burst, every copied line stamped within milliseconds of the last. The
/// first line that lands more than this far after its predecessor is the
/// child's own work.
const COPY_BURST_GAP_MS: i64 = 1000;

/// Model attributed to a turn that reached the model before any `turn_context`
/// named one.
const UNKNOWN_MODEL: &str = "unknown";

/// Turns one Codex rollout (or the tail of one) into usage records.
pub fn parse_codex_rollout(text: &str, ctx: &TranscriptContext) -> Vec<UsageRecord> {
    let mut state = RolloutState::new(ctx);
    let mut records = Vec::new();

    for line in text.lines() {
        let Ok(Value::Object(row)) = serde_json::from_str::<Value>(line) else {
            // A line we cannot parse still moved the clock forward for anyone
            // else's purposes, but we know nothing about it. Skip it whole.
            continue;
        };
        let at_ms = rfc3339_to_ms(string_value(row.get("timestamp")));
        let inside_burst = state.advance_clock(at_ms);

        match string_value(row.get("type")) {
            Some("session_meta") => state.read_session_meta(&row),
            Some("turn_context") => state.read_turn_context(&row),
            _ => {}
        }

        if !line_may_carry_usage(line) {
            continue;
        }
        let Some(usage) = token_count_usage(&row) else {
            continue;
        };
        let signature = usage_signature(usage);
        let repeated = state.last_signature == Some(signature);
        state.last_signature = Some(signature);
        // A rollout repeats the previous `token_count` verbatim when a turn
        // ends without another model call. Counting it would bill the turn
        // twice.
        if repeated || inside_burst {
            continue;
        }
        let Some(at_ms) = at_ms else {
            continue;
        };
        let tokens = tokens_from_signature(signature);
        if tokens.is_empty() {
            continue;
        }

        records.push(UsageRecord {
            provider: ProviderId::Codex,
            model_id: state.model_id(),
            session_id: state.session_id.clone(),
            at_ms,
            tokens,
            // The rollout carries no dollar figure.
            reported_cost_usd: None,
            dedupe_key: Some(state.dedupe_key(row.get("ordinal"), &row, signature)),
            project_path: state.cwd.clone(),
        });
    }

    records
}

/// `payload.info.last_token_usage` of a `token_count` event, if this row is
/// one. Both the wrapped (`event_msg`) and bare (`token_count`) shapes appear
/// in rollouts written by different CLI versions.
fn token_count_usage(row: &Map<String, Value>) -> Option<&Map<String, Value>> {
    let payload = object_value(row.get("payload"));
    let is_token_count = string_value(row.get("type")) == Some("token_count")
        || payload.and_then(|inner| string_value(inner.get("type"))) == Some("token_count");
    if !is_token_count {
        return None;
    }
    let info = payload
        .and_then(|inner| object_value(inner.get("info")))
        .or_else(|| object_value(row.get("info")))?;
    object_value(info.get("last_token_usage"))
}

/// The five numbers that identify one billed Codex call, in report order.
type UsageSignature = (i64, i64, i64, i64, i64);

fn usage_signature(usage: &Map<String, Value>) -> UsageSignature {
    (
        number_value(usage.get("input_tokens")) as i64,
        number_value(usage.get("cached_input_tokens")) as i64,
        number_value(usage.get("cache_write_input_tokens")) as i64,
        number_value(usage.get("output_tokens")) as i64,
        number_value(usage.get("reasoning_output_tokens")) as i64,
    )
}

fn tokens_from_signature(signature: UsageSignature) -> UsageRecordTokens {
    let (input, cached, cache_write, output, reasoning) = signature;
    UsageRecordTokens {
        // Codex's `input_tokens` is the whole prompt, cache included.
        input_uncached: (input - cached - cache_write).max(0),
        cache_read: cached,
        cache_write_5m: cache_write,
        cache_write_1h: 0,
        output,
        reasoning,
    }
}

struct RolloutState {
    session_id: String,
    cwd: Option<String>,
    session_model: Option<String>,
    turn_model: Option<String>,
    /// True while the opening copy burst of a forked or subagent rollout is
    /// still running. Always false for a rollout that is nobody's copy.
    copies_parent_history: bool,
    burst_open: bool,
    previous_at_ms: Option<i64>,
    last_signature: Option<UsageSignature>,
}

impl RolloutState {
    fn new(ctx: &TranscriptContext) -> Self {
        Self {
            session_id: ctx
                .session_id_hint
                .map(str::to_string)
                .or_else(|| session_id_from_path(ctx.source_path))
                .unwrap_or_default(),
            cwd: None,
            session_model: None,
            turn_model: None,
            copies_parent_history: false,
            burst_open: true,
            previous_at_ms: None,
            last_signature: None,
        }
    }

    /// Records this line's timestamp and reports whether the line is still
    /// inside a copied-history burst.
    fn advance_clock(&mut self, at_ms: Option<i64>) -> bool {
        if let (Some(at_ms), Some(previous)) = (at_ms, self.previous_at_ms) {
            if at_ms - previous > COPY_BURST_GAP_MS {
                self.burst_open = false;
            }
        }
        if at_ms.is_some() {
            self.previous_at_ms = at_ms;
        }
        self.copies_parent_history && self.burst_open
    }

    fn read_session_meta(&mut self, row: &Map<String, Value>) {
        let Some(payload) = object_value(row.get("payload")) else {
            return;
        };
        if let Some(id) = string_value(payload.get("id")).or(string_value(payload.get("session_id")))
        {
            self.session_id = id.to_string();
        }
        if let Some(cwd) = string_value(payload.get("cwd")) {
            self.cwd = Some(cwd.to_string());
        }
        if let Some(model) = string_value(payload.get("model")) {
            self.session_model = Some(model.to_string());
        }
        self.copies_parent_history =
            payload.get("forked_from_id").is_some() || mentions_parent_thread(payload.get("source"));
    }

    fn read_turn_context(&mut self, row: &Map<String, Value>) {
        let Some(payload) = object_value(row.get("payload")) else {
            return;
        };
        if let Some(model) = string_value(payload.get("model")) {
            self.turn_model = Some(model.to_string());
        }
        if self.cwd.is_none() {
            self.cwd = string_value(payload.get("cwd")).map(str::to_string);
        }
    }

    fn model_id(&self) -> String {
        self.turn_model
            .clone()
            .or_else(|| self.session_model.clone())
            .unwrap_or_else(|| UNKNOWN_MODEL.to_string())
    }

    /// Codex never repeats a billed call across files, so the key only has to
    /// separate the calls inside one rollout. It must not depend on where the
    /// caller started reading: the scanner hands us tails, so a line's index
    /// in `text` is not available. Newer rollouts number every line with
    /// `ordinal`; older ones get the timestamp plus the call's own token
    /// counts, which two distinct calls of the same session share only if they
    /// billed identically in the same millisecond.
    fn dedupe_key(
        &self,
        ordinal: Option<&Value>,
        row: &Map<String, Value>,
        signature: UsageSignature,
    ) -> String {
        let session = &self.session_id;
        if let Some(ordinal) = ordinal.and_then(Value::as_u64) {
            return format!("codex:{session}:{ordinal}");
        }
        let at = string_value(row.get("timestamp")).unwrap_or_default();
        let (input, cached, write, output, reasoning) = signature;
        format!("codex:{session}:{at}:{input}-{cached}-{write}-{output}-{reasoning}")
    }
}

/// True when `session_meta.source` names this rollout as somebody's subagent.
/// `source` is either a plain string (`"exec"`, `"vscode"`, `"cli"`) or an
/// object naming the parent thread. The sibling `thread_source` field is not
/// consulted: 129 rollouts on this machine carry `thread_source: "subagent"`
/// with an ordinary `"vscode"` source and no parent thread at all, and
/// suppressing their opening turn would lose real tokens.
fn mentions_parent_thread(value: Option<&Value>) -> bool {
    match value {
        Some(Value::String(_)) | None => false,
        Some(other) => {
            let text = other.to_string();
            text.contains("subagent") || text.contains("parent_thread_id")
        }
    }
}

/// `rollout-2026-09-03T10-54-42-<uuid>.jsonl` names the session after the
/// timestamp. Only a fallback: `session_meta` states it outright.
fn session_id_from_path(path: &std::path::Path) -> Option<String> {
    let stem = path.file_stem()?.to_str()?;
    let rest = stem.strip_prefix("rollout-")?;
    // The uuid is the last five dash-separated groups.
    let parts: Vec<&str> = rest.split('-').collect();
    if parts.len() < 5 {
        return None;
    }
    Some(parts[parts.len() - 5..].join("-"))
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use super::*;

    fn context(path: &Path) -> TranscriptContext<'_> {
        TranscriptContext {
            source_path: path,
            session_id_hint: None,
        }
    }

    #[test]
    fn drops_a_repeated_token_count_and_derives_uncached_input() {
        let text = include_str!("../../tests/fixtures/usage/codex-duplicate-token-count.jsonl");
        let path =
            Path::new("/s/rollout-2026-06-15T07-49-15-019ec9d3-b501-7370-8f2e-46d4d7a504c4.jsonl");
        let records = parse_codex_rollout(text, &context(path));

        assert_eq!(records.len(), 2, "the middle event repeats its predecessor");
        // 87_409 prompt tokens of which 80_768 came from the cache.
        assert_eq!(records[0].tokens.input_uncached, 6_641);
        assert_eq!(records[0].tokens.cache_read, 80_768);
        assert_eq!(records[0].tokens.output, 856);
        assert_eq!(records[0].tokens.reasoning, 516);
        assert_eq!(records[0].model_id, "gpt-5.5");
        assert_eq!(records[0].session_id, "019ec9d3-b501-7370-8f2e-46d4d7a504c4");
        assert_eq!(
            records[0].project_path.as_deref(),
            Some("/Users/adamthuvesen/dev/menti/dbt-transform")
        );

        assert_eq!(records[1].tokens.input_uncached, 366);
        assert_eq!(records[1].tokens.cache_read, 85_888);
        assert_eq!(records[1].tokens.output, 405);
        assert_ne!(records[0].dedupe_key, records[1].dedupe_key);
    }

    #[test]
    fn a_repeat_that_is_not_consecutive_still_counts() {
        // Two turns can legitimately bill the same numbers; only a verbatim
        // repeat of the event immediately before is the rollout restating
        // itself.
        let text = include_str!("../../tests/fixtures/usage/codex-duplicate-token-count.jsonl");
        let lines: Vec<&str> = text.lines().collect();
        let reordered = format!(
            "{}\n{}\n{}\n{}\n{}\n",
            lines[0], lines[1], lines[2], lines[4], lines[3]
        );
        let path =
            Path::new("/s/rollout-2026-06-15T07-49-15-019ec9d3-b501-7370-8f2e-46d4d7a504c4.jsonl");
        assert_eq!(parse_codex_rollout(&reordered, &context(path)).len(), 3);
    }

    #[test]
    fn suppresses_the_forked_copy_burst_and_counts_the_first_real_turn() {
        let text = include_str!("../../tests/fixtures/usage/codex-forked-rollout.jsonl");
        let path =
            Path::new("/s/rollout-2026-07-01T18-14-25-019f1e75-d155-7ad3-b46d-577e83e6014f.jsonl");
        let records = parse_codex_rollout(text, &context(path));

        assert_eq!(
            records.len(),
            1,
            "only the turn that ran after the copied history counts"
        );
        assert_eq!(records[0].tokens.input_uncached, 23_610 - 4_992);
        assert_eq!(records[0].tokens.output, 491);
        assert_eq!(records[0].tokens.reasoning, 376);
        assert_eq!(
            records[0].model_id, "gpt-5.6-terra",
            "the turn_context after the burst owns the turn"
        );
        assert_eq!(
            records[0].session_id, "019f1e75-d155-7ad3-b46d-577e83e6014f",
            "a subagent rollout counts under its own id, not the parent's"
        );
    }

    #[test]
    fn an_unforked_rollout_keeps_its_opening_turn() {
        // The same six lines with the fork markers off: nothing is a copy, so
        // every token_count counts.
        let text = include_str!("../../tests/fixtures/usage/codex-unforked-rollout.jsonl");
        let path =
            Path::new("/s/rollout-2026-07-01T18-14-25-019f1e75-d155-7ad3-b46d-577e83e6014f.jsonl");
        assert_eq!(parse_codex_rollout(text, &context(path)).len(), 3);
    }

    #[test]
    fn malformed_lines_are_skipped_without_panicking() {
        let path = Path::new("/s/rollout-2026-09-03T10-54-42-01a0667a-3cb1-7d41-ade5-d51ba5f88419.jsonl");
        let text = "{\"type\":\"event_msg\",\"payload\":{\"type\":\"token_count\"\n\ngarbage\n{\"type\":\"event_msg\",\"payload\":{\"type\":\"token_count\",\"info\":{}}}\n";
        assert!(parse_codex_rollout(text, &context(path)).is_empty());
    }
}
