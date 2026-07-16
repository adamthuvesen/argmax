use std::collections::{BTreeMap, VecDeque};
use std::sync::Mutex;

use crate::util::sync::LockOrRecover;
use chrono::Utc;
use serde::Serialize;
use specta::Type;

pub const LOG_BUFFER_CAPACITY: usize = 1000;

#[derive(Debug, Clone, PartialEq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct LogEntry {
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
        let mut entries = self.entries.lock_or_recover("log buffer");
        while entries.len() >= self.capacity {
            entries.pop_front();
        }
        entries.push_back(LogEntry {
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
}
