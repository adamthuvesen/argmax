use serde::{Deserialize, Serialize};
use specta::Type;

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct UsageCounts {
    pub input: u64,
    pub output: u64,
    pub cache_read: u64,
    pub cache_write: u64,
}

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

    /// Every token the call was billed for. `reasoning` is left out because it
    /// is already part of `output`.
    pub fn processed(&self) -> i64 {
        self.input_uncached + self.cache_read + self.cache_write() + self.output
    }
}
