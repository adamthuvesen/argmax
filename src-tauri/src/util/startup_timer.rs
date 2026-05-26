// Records named instants from process boot onward so `system:diagnostics`
// can surface the cold-start phase breakdown. Today's TS impl exposes the
// same set of phase names: boot, db.open, services.construct,
// ipc.register, window.create, window.ready-to-show.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Instant;

#[derive(Debug)]
pub struct StartupTimer {
    boot: Instant,
    marks: Mutex<HashMap<&'static str, Instant>>,
}

impl StartupTimer {
    pub fn new() -> Self {
        Self {
            boot: Instant::now(),
            marks: Mutex::new(HashMap::new()),
        }
    }

    /// Records `name` at the current instant. Subsequent calls overwrite.
    pub fn mark(&self, name: &'static str) {
        self.marks
            .lock()
            .expect("startup timer poisoned")
            .insert(name, Instant::now());
    }

    /// Returns the ordered (mark, milliseconds-from-boot) list.
    pub fn snapshot(&self) -> Vec<(&'static str, u128)> {
        let marks = self.marks.lock().expect("startup timer poisoned");
        let mut out: Vec<_> = marks
            .iter()
            .map(|(name, inst)| (*name, inst.duration_since(self.boot).as_millis()))
            .collect();
        out.sort_by_key(|(_, ms)| *ms);
        out
    }

    pub fn boot_to_now_ms(&self) -> u128 {
        Instant::now().duration_since(self.boot).as_millis()
    }
}

impl Default for StartupTimer {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn marks_are_ordered_by_recorded_instant() {
        let t = StartupTimer::new();
        t.mark("db.open");
        std::thread::sleep(std::time::Duration::from_millis(2));
        t.mark("services.construct");
        let snap = t.snapshot();
        assert_eq!(snap.len(), 2);
        assert_eq!(snap[0].0, "db.open");
        assert_eq!(snap[1].0, "services.construct");
        assert!(snap[1].1 >= snap[0].1);
    }
}
