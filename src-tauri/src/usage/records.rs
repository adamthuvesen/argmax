//! One usage record per billed model call. Every provider parser produces
//! these; the scanner buckets them by hour and the summary prices them.

use crate::ipc::validation::ProviderId;

/// Token counts as the provider reported them, split the way pricing needs.
/// `input_uncached` never includes cache reads or writes. Claude bills 5 m
/// and 1 h cache writes at different rates, so they stay apart here and only
/// merge in the wire contract. `reasoning` is part of `output`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct UsageRecordTokens {
    pub input_uncached: i64,
    pub cache_read: i64,
    pub cache_write_5m: i64,
    pub cache_write_1h: i64,
    pub output: i64,
    pub reasoning: i64,
}

impl UsageRecordTokens {
    pub fn cache_write(&self) -> i64 {
        self.cache_write_5m + self.cache_write_1h
    }

    pub fn is_empty(&self) -> bool {
        self.input_uncached == 0
            && self.cache_read == 0
            && self.cache_write_5m == 0
            && self.cache_write_1h == 0
            && self.output == 0
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct UsageRecord {
    pub provider: ProviderId,
    /// The model id as the provider wrote it. Pricing normalizes it
    /// (`providers::pricing::normalize_model_id`); the breakdown table shows
    /// the normalized form.
    pub model_id: String,
    /// The provider's own session id. Subagent transcripts carry the parent's.
    pub session_id: String,
    /// Unix milliseconds of the call.
    pub at_ms: i64,
    pub tokens: UsageRecordTokens,
    /// The CLI's own dollar figure when it keeps one (Grok ticks, OpenCode
    /// cost). Wins over the list-price table.
    pub reported_cost_usd: Option<f64>,
    /// Stable across files for the same billed call, so a resumed or forked
    /// session that repeats history counts once. `None` means the record
    /// cannot be told apart from a repeat and is counted as seen.
    pub dedupe_key: Option<String>,
    /// The working directory the session ran in, when the transcript says.
    pub project_path: Option<String>,
}

/// What the caller knows about the file a batch of lines came from. The
/// scanner may hand a parser a whole transcript or only the tail it has not
/// read yet, so nothing here depends on the text starting at line one.
pub struct TranscriptContext<'a> {
    pub source_path: &'a std::path::Path,
    /// The session the file belongs to, when the caller already resolved it.
    /// Parsers fall back to `source_path` and then to the line itself.
    pub session_id_hint: Option<&'a str>,
}

/// Cheap gate before `serde_json`: a transcript line that carries usage always
/// contains one of these. Claude writes `"usage"`, Codex `token_count` (and
/// `last_token_usage`), Grok `turn_completed`. Parsing every line of a
/// multi-hundred-megabyte rollout is the whole cost of a cold scan, and this
/// rejects the overwhelming majority of them on a substring search.
pub fn line_may_carry_usage(line: &str) -> bool {
    line.contains("usage") || line.contains("token_count") || line.contains("turn_completed")
}

/// Unix milliseconds for an RFC 3339 instant, `None` when it is missing or
/// unparseable. A record we cannot place in time cannot be bucketed, so every
/// parser drops it rather than guessing.
pub(crate) fn rfc3339_to_ms(value: Option<&str>) -> Option<i64> {
    chrono::DateTime::parse_from_rfc3339(value?)
        .ok()
        .map(|at| at.timestamp_millis())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_prefilter_accepts_every_provider_usage_line_and_rejects_prose() {
        let claude = include_str!("../../tests/fixtures/usage/claude-three-blocks.jsonl")
            .lines()
            .next()
            .expect("line");
        let codex = include_str!("../../tests/fixtures/usage/codex-duplicate-token-count.jsonl")
            .lines()
            .nth(2)
            .expect("token_count line");
        let grok = include_str!("../../tests/fixtures/usage/grok-single-model.jsonl")
            .lines()
            .next()
            .expect("line");
        assert!(line_may_carry_usage(claude));
        assert!(line_may_carry_usage(codex));
        assert!(line_may_carry_usage(grok));

        let user_line = r#"{"type":"user","message":{"role":"user","content":"run the tests"},"timestamp":"2026-09-03T06:00:12.614Z"}"#;
        assert!(!line_may_carry_usage(user_line));
        assert!(!line_may_carry_usage(""));
    }

    #[test]
    fn processed_tokens_ignore_reasoning_which_is_already_inside_output() {
        let tokens = UsageRecordTokens {
            output: 100,
            reasoning: 60,
            ..UsageRecordTokens::default()
        };
        assert!(!tokens.is_empty());
        assert_eq!(tokens.cache_write(), 0);
    }

    #[test]
    fn a_record_with_only_reasoning_is_still_empty() {
        let tokens = UsageRecordTokens {
            reasoning: 42,
            ..UsageRecordTokens::default()
        };
        assert!(tokens.is_empty());
    }
}
