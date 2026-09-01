use std::collections::{BTreeMap, VecDeque};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

use crate::util::sync::LockOrRecover;
use chrono::Utc;
use serde::Serialize;
use specta::Type;

pub const LOG_BUFFER_CAPACITY: usize = 1000;

#[derive(Debug, Clone, PartialEq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct LogEntry {
    /// Monotonic, process-lifetime sequence number. The debug panel polls with
    /// the highest `seq` it has seen so each tick ships only new lines instead
    /// of the whole 1000-entry ring.
    pub seq: u64,
    pub timestamp: String,
    pub level: String,
    pub scope: String,
    pub message: String,
    pub fields: BTreeMap<String, String>,
}

#[derive(Debug)]
pub struct LogBuffer {
    entries: Mutex<VecDeque<LogEntry>>,
    capacity: usize,
    next_seq: AtomicU64,
}

impl Default for LogBuffer {
    fn default() -> Self {
        Self::new(LOG_BUFFER_CAPACITY)
    }
}

impl LogBuffer {
    pub fn new(capacity: usize) -> Self {
        Self {
            entries: Mutex::new(VecDeque::with_capacity(capacity)),
            capacity,
            next_seq: AtomicU64::new(1),
        }
    }

    pub fn record(
        &self,
        level: impl Into<String>,
        scope: impl Into<String>,
        message: impl Into<String>,
        fields: BTreeMap<String, String>,
    ) {
        if self.capacity == 0 {
            return;
        }
        let seq = self.next_seq.fetch_add(1, Ordering::Relaxed);
        let mut entries = self.entries.lock_or_recover("log buffer");
        while entries.len() >= self.capacity {
            entries.pop_front();
        }
        entries.push_back(LogEntry {
            seq,
            timestamp: Utc::now().to_rfc3339(),
            level: level.into(),
            scope: scope.into(),
            message: message.into(),
            fields,
        });
    }

    pub fn read(&self) -> Vec<LogEntry> {
        self.entries
            .lock_or_recover("log buffer")
            .iter()
            .cloned()
            .collect()
    }

    /// Entries recorded after `after_seq`. `None` returns the whole ring, which
    /// is what a freshly opened panel (or the diagnostics report) wants.
    pub fn read_since(&self, after_seq: Option<u64>) -> Vec<LogEntry> {
        let entries = self.entries.lock_or_recover("log buffer");
        match after_seq {
            None => entries.iter().cloned().collect(),
            Some(after) => entries
                .iter()
                .skip_while(|entry| entry.seq <= after)
                .cloned()
                .collect(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn log_buffer_keeps_recent_entries() {
        let buffer = LogBuffer::new(2);
        buffer.record("info", "test", "one", BTreeMap::new());
        buffer.record("warn", "test", "two", BTreeMap::new());
        buffer.record("error", "test", "three", BTreeMap::new());

        let entries = buffer.read();
        assert_eq!(
            entries
                .iter()
                .map(|entry| entry.message.as_str())
                .collect::<Vec<_>>(),
            vec!["two", "three"]
        );
    }

    #[test]
    fn read_since_returns_only_newer_entries() {
        let buffer = LogBuffer::new(8);
        buffer.record("info", "test", "one", BTreeMap::new());
        buffer.record("info", "test", "two", BTreeMap::new());

        let all = buffer.read_since(None);
        assert_eq!(all.len(), 2);

        let after_first = buffer.read_since(Some(all[0].seq));
        assert_eq!(
            after_first
                .iter()
                .map(|entry| entry.message.as_str())
                .collect::<Vec<_>>(),
            vec!["two"]
        );

        let after_last = buffer.read_since(Some(all[1].seq));
        assert!(after_last.is_empty());
    }

    #[test]
    fn read_since_survives_ring_eviction() {
        let buffer = LogBuffer::new(2);
        for message in ["one", "two", "three"] {
            buffer.record("info", "test", message, BTreeMap::new());
        }
        // A cursor older than the oldest surviving entry yields everything left.
        assert_eq!(buffer.read_since(Some(0)).len(), 2);
    }
}
