// Exclusive ownership of the local-state directory. Two Argmax processes on
// one database corrupt each other: the second instance's boot recovery marks
// the first instance's live sessions "failed" (`recover_orphaned_sessions`),
// its orphan sweep hunts the first instance's provider CLIs, and both fight
// over the remote-bridge port. An advisory `flock` on a sentinel file inside
// `local-state` lets a booting instance detect a live owner before it touches
// the database. The lock dies with the process, so a crashed instance never
// leaves a stale lock behind.

use std::fs::{File, OpenOptions};
use std::path::Path;

use nix::errno::Errno;
use nix::fcntl::{Flock, FlockArg};

/// Held for the app's lifetime; dropping it (or process exit) releases the lock.
pub struct InstanceLock {
    _file: Flock<File>,
}

/// `Ok(Some)` — this process now owns `data_dir`; keep the value alive.
/// `Ok(None)` — another live Argmax instance holds the lock.
/// `Err` — the lock file itself could not be created or locked.
pub fn acquire(data_dir: &Path) -> std::io::Result<Option<InstanceLock>> {
    let file = OpenOptions::new()
        .create(true)
        .write(true)
        // The file is a pure sentinel; nothing reads or writes its contents,
        // so neither truncating nor keeping the old bytes matters.
        .truncate(false)
        .open(data_dir.join("argmax.lock"))?;
    match Flock::lock(file, FlockArg::LockExclusiveNonblock) {
        Ok(lock) => Ok(Some(InstanceLock { _file: lock })),
        Err((_, errno)) if errno == Errno::EWOULDBLOCK => Ok(None),
        Err((_, errno)) => Err(std::io::Error::from_raw_os_error(errno as i32)),
    }
}

#[cfg(test)]
mod tests {
    use super::acquire;

    #[test]
    fn second_acquire_in_the_same_process_is_refused() {
        let dir = tempfile::tempdir().expect("tempdir");
        let first = acquire(dir.path()).expect("first acquire");
        assert!(first.is_some(), "fresh directory must lock");
        // flock is per open file description, so a second open + lock models a
        // second process closely enough for a unit test.
        let second = acquire(dir.path()).expect("second acquire");
        assert!(second.is_none(), "held lock must be refused");
        drop(first);
        let third = acquire(dir.path()).expect("third acquire");
        assert!(third.is_some(), "released lock must be reacquirable");
    }
}
