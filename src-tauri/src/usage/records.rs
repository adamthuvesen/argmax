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
