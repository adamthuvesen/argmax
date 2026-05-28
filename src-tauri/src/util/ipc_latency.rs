// Per-channel ring buffer of recent IPC handler latencies.
//
// Fed by the tracing layer in `util::tracing_init` whenever a Tauri command
// emits a `channel=… latency_ms=…` event. `system:diagnostics` reads p50 /
// p99 / count via the getters below.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Duration;

pub const RING_CAPACITY: usize = 100;

#[derive(Debug)]
struct LatencyRing {
    samples: Vec<Duration>,
    cursor: usize,
    len: usize,
}

impl LatencyRing {
    fn new() -> Self {
        Self {
            samples: vec![Duration::ZERO; RING_CAPACITY],
            cursor: 0,
            len: 0,
        }
    }

    fn record(&mut self, latency: Duration) {
        self.samples[self.cursor] = latency;
        self.cursor = (self.cursor + 1) % RING_CAPACITY;
        if self.len < RING_CAPACITY {
            self.len += 1;
        }
    }

    fn percentile(&self, p: f64) -> Option<Duration> {
        if self.len == 0 {
            return None;
        }
        let mut sorted: Vec<Duration> = self.samples.iter().take(self.len).copied().collect();
        sorted.sort();
        let idx = ((self.len as f64 - 1.0) * p).round() as usize;
        Some(sorted[idx])
    }
}

#[derive(Debug, Default)]
pub struct IpcLatencyRegistry {
    per_channel: Mutex<HashMap<String, LatencyRing>>,
    total_recorded: Mutex<HashMap<String, usize>>,
}

impl IpcLatencyRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn record(&self, channel: &str, latency: Duration) {
        let mut map = self.per_channel.lock().expect("ipc latency poisoned");
        map.entry(channel.to_owned())
            .or_insert_with(LatencyRing::new)
            .record(latency);
        let mut totals = self.total_recorded.lock().expect("ipc latency poisoned");
        *totals.entry(channel.to_owned()).or_insert(0) += 1;
    }

    pub fn p50(&self, channel: &str) -> Option<Duration> {
        self.per_channel
            .lock()
            .expect("ipc latency poisoned")
            .get(channel)
            .and_then(|ring| ring.percentile(0.50))
    }

    pub fn p99(&self, channel: &str) -> Option<Duration> {
        self.per_channel
            .lock()
            .expect("ipc latency poisoned")
            .get(channel)
            .and_then(|ring| ring.percentile(0.99))
    }

    pub fn count(&self, channel: &str) -> usize {
        self.per_channel
            .lock()
            .expect("ipc latency poisoned")
            .get(channel)
            .map(|ring| ring.len)
            .unwrap_or(0)
    }

    pub fn total_recorded(&self, channel: &str) -> usize {
        self.total_recorded
            .lock()
            .expect("ipc latency poisoned")
            .get(channel)
            .copied()
            .unwrap_or(0)
    }

    pub fn known_channels(&self) -> Vec<String> {
        self.per_channel
            .lock()
            .expect("ipc latency poisoned")
            .keys()
            .cloned()
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn percentiles_are_monotonic() {
        let reg = IpcLatencyRegistry::new();
        for ms in 1u64..=100 {
            reg.record("dashboard:list", Duration::from_millis(ms));
        }
        let p50 = reg.p50("dashboard:list").unwrap();
        let p99 = reg.p99("dashboard:list").unwrap();
        assert!(p50 < p99);
        assert_eq!(reg.count("dashboard:list"), 100);
    }

    #[test]
    fn ring_wraps_past_capacity() {
        let reg = IpcLatencyRegistry::new();
        for ms in 0u64..(RING_CAPACITY as u64 * 2) {
            reg.record("ch", Duration::from_millis(ms));
        }
        // Wrapping keeps only the most recent RING_CAPACITY samples.
        assert_eq!(reg.count("ch"), RING_CAPACITY);
        // p99 should reflect the recent high values, not the early low ones.
        let p99 = reg.p99("ch").unwrap();
        assert!(p99 >= Duration::from_millis(RING_CAPACITY as u64));
    }

    #[test]
    fn empty_channel_returns_none() {
        let reg = IpcLatencyRegistry::new();
        assert!(reg.p50("nothing").is_none());
        assert_eq!(reg.count("nothing"), 0);
    }
}
