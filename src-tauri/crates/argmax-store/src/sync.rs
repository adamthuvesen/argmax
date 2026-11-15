// Poison-recovering lock for the mutexes shared across parallel sessions.

use std::sync::{Mutex, MutexGuard};

/// Locks a `std::sync::Mutex`, recovering the guard when the lock is poisoned
/// instead of panicking.
///
/// The session runtime shares its mutexes (handles, queues, flush state,
/// terminals, …) across every parallel session. If one session's task panics
/// while holding a lock, the mutex poisons permanently and a panicking
/// `.expect()` on the next access cascades the failure into every other
/// session — one bad session takes down all of them. The protected values are
/// plain collections with no cross-field invariants that a mid-panic writer
/// could break, so recovering the guard (like `Database::connection` already
/// does) is safe; we log the recovery so the original panic stays visible.
///
/// Poisoning requires unwinding, so this only matters in dev and test builds:
/// the release profile sets `panic = "abort"` (Cargo.toml), where any panic
/// kills the whole process before a lock can poison.
pub trait LockOrRecover<T> {
    /// `what` names the lock in the recovery log line, e.g. `"handles"`.
    fn lock_or_recover(&self, what: &str) -> MutexGuard<'_, T>;
}

impl<T> LockOrRecover<T> for Mutex<T> {
    fn lock_or_recover(&self, what: &str) -> MutexGuard<'_, T> {
        self.lock().unwrap_or_else(|poisoned| {
            tracing::warn!("{what} mutex poisoned; recovering");
            poisoned.into_inner()
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    #[test]
    fn recovers_poisoned_mutex_with_data_intact() {
        let mutex = Arc::new(Mutex::new(vec![1, 2, 3]));
        let poisoner = Arc::clone(&mutex);
        std::thread::spawn(move || {
            let _guard = poisoner.lock().expect("lock is clean before the panic");
            panic!("poison the mutex");
        })
        .join()
        .expect_err("poisoning thread panics");
        assert!(mutex.is_poisoned());

        assert_eq!(*mutex.lock_or_recover("test data"), vec![1, 2, 3]);
    }
}
