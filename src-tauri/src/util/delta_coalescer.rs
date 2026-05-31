// Per-key emit throttle. Used to bound `dashboard:delta` publish rate
// to ~60 fps (default 16 ms cadence) so streaming bursts don't flood
// the renderer's event loop. Other push channels emit immediately.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

pub const DEFAULT_CADENCE_MS: u64 = 16;

#[derive(Debug)]
pub struct DeltaCoalescer {
    cadence: Duration,
    last_emit: Mutex<HashMap<String, Instant>>,
}

impl DeltaCoalescer {
    pub fn new(cadence_ms: u64) -> Self {
        Self {
            cadence: Duration::from_millis(cadence_ms),
            last_emit: Mutex::new(HashMap::new()),
        }
    }

    /// Returns true if `cadence` has elapsed since the last emit for
    /// `key`, AND records the new emit time. False otherwise.
    pub fn should_emit(&self, key: &str) -> bool {
        let now = Instant::now();
        let mut map = self.last_emit.lock().expect("delta coalescer poisoned");
        match map.get(key) {
            Some(prev) if now.duration_since(*prev) < self.cadence => false,
            _ => {
                map.insert(key.to_owned(), now);
                true
            }
        }
    }

    /// Force-emit on next `should_emit` regardless of cadence (e.g.,
    /// after the streaming turn completes and we want a final flush).
    pub fn reset(&self, key: &str) {
        self.last_emit
            .lock()
            .expect("delta coalescer poisoned")
            .remove(key);
    }
}

impl Default for DeltaCoalescer {
    fn default() -> Self {
        Self::new(DEFAULT_CADENCE_MS)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn first_emit_passes_then_throttles() {
        let c = DeltaCoalescer::new(50);
        assert!(c.should_emit("dashboard:delta"));
        assert!(!c.should_emit("dashboard:delta"));
        std::thread::sleep(Duration::from_millis(60));
        assert!(c.should_emit("dashboard:delta"));
    }

    #[test]
    fn reset_allows_immediate_reemit() {
        let c = DeltaCoalescer::new(60_000);
        assert!(c.should_emit("k"));
        c.reset("k");
        assert!(c.should_emit("k"));
    }

    #[test]
    fn keys_are_independent() {
        let c = DeltaCoalescer::new(60_000);
        assert!(c.should_emit("a"));
        assert!(c.should_emit("b"));
    }
}
