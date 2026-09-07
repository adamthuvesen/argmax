use std::{
    collections::HashMap,
    fs,
    path::PathBuf,
    sync::{Arc, LazyLock, Mutex, MutexGuard},
    time::SystemTime,
};

use crate::util::sync::LockOrRecover;

/// Size and modified time of a child trace file when it was last imported.
pub(super) type TraceFileStamp = (u64, SystemTime);

/// Identity of one imported child trace file. The resolved path is part of the
/// key so a transcript Codex rotates into `archived_sessions` re-imports under
/// its new path, and so two sessions reading the same file never skip each
/// other's import.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub(super) struct TraceFileKey {
    pub(super) session_id: String,
    pub(super) parent_tool_use_id: String,
    pub(super) run_revision: String,
    pub(super) path: PathBuf,
}

/// What one poll has to do with a resolved trace file.
pub(super) enum TraceFileStep {
    /// The last import already covered exactly these bytes.
    UpToDate,
    /// Read and parse it, then remember `stamp` once the rows persist.
    Read(Option<TraceFileStamp>),
}

/// Trace files already imported. `session:agent-events` imports before every
/// read and the renderer polls it every 1.5 s per open agent tab, so without
/// this each poll re-read and re-parsed every multi-MB child transcript and ran
/// an insert-if-absent statement per row against the shared connection.
///
/// Dropped wholesale past the cap instead of growing for the process lifetime;
/// the cost is one extra re-import round.
static IMPORTED_TRACE_FILES: LazyLock<Mutex<HashMap<TraceFileKey, TraceFileStamp>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));
const MAX_REMEMBERED_TRACE_FILES: usize = 512;
static TRACE_SESSION_LOCKS: LazyLock<Mutex<HashMap<String, Arc<Mutex<()>>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

fn imported_trace_files() -> MutexGuard<'static, HashMap<TraceFileKey, TraceFileStamp>> {
    IMPORTED_TRACE_FILES.lock_or_recover("imported trace files")
}

pub(super) fn with_trace_session_lock<T>(session_id: &str, run: impl FnOnce() -> T) -> T {
    let lock = {
        let mut locks = TRACE_SESSION_LOCKS.lock_or_recover("trace session locks");
        Arc::clone(
            locks
                .entry(session_id.to_string())
                .or_insert_with(|| Arc::new(Mutex::new(()))),
        )
    };
    let guard = lock.lock_or_recover("trace session");
    let result = run();
    drop(guard);
    let mut locks = TRACE_SESSION_LOCKS.lock_or_recover("trace session locks");
    if Arc::strong_count(&lock) == 2 {
        locks.remove(session_id);
    }
    result
}

pub(super) fn trace_file_step(key: &TraceFileKey) -> TraceFileStep {
    let stamp = fs::metadata(&key.path)
        .and_then(|metadata| Ok((metadata.len(), metadata.modified()?)))
        .ok();
    let mut remembered = imported_trace_files();
    let Some(stamp) = stamp else {
        // Unreadable now (rotated away, deleted): forget it so the next
        // resolved path imports from scratch instead of matching a frozen entry.
        remembered.remove(key);
        return TraceFileStep::Read(None);
    };
    if remembered.get(key) == Some(&stamp) {
        return TraceFileStep::UpToDate;
    }
    TraceFileStep::Read(Some(stamp))
}

/// Recorded only after the parsed rows persist, so a failed write re-imports on
/// the next poll instead of being skipped as up to date.
pub(super) fn remember_imported_trace_files(stamps: Vec<(TraceFileKey, TraceFileStamp)>) {
    if stamps.is_empty() {
        return;
    }
    let mut remembered = imported_trace_files();
    if remembered.len() + stamps.len() > MAX_REMEMBERED_TRACE_FILES {
        remembered.clear();
    }
    remembered.extend(stamps);
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        sync::{
            atomic::{AtomicUsize, Ordering},
            Barrier,
        },
        thread,
        time::Duration as StdDuration,
    };
    use tempfile::TempDir;

    #[test]
    fn unchanged_trace_file_is_skipped_until_it_changes() {
        let dir = TempDir::new().expect("dir");
        let path = dir.path().join("child-thread.jsonl");
        fs::write(&path, "one\n").expect("write trace");
        let key = TraceFileKey {
            session_id: "s1".to_string(),
            parent_tool_use_id: "spawn-1".to_string(),
            run_revision: String::new(),
            path: path.clone(),
        };

        let TraceFileStep::Read(Some(stamp)) = trace_file_step(&key) else {
            panic!("first poll must read the trace");
        };
        remember_imported_trace_files(vec![(key.clone(), stamp)]);
        assert!(matches!(trace_file_step(&key), TraceFileStep::UpToDate));

        fs::write(&path, "one\ntwo\n").expect("grow trace");
        assert!(matches!(
            trace_file_step(&key),
            TraceFileStep::Read(Some(_))
        ));

        // A rotated or deleted transcript forgets its stamp instead of freezing.
        fs::remove_file(&path).expect("remove trace");
        assert!(matches!(trace_file_step(&key), TraceFileStep::Read(None)));
        assert!(!imported_trace_files().contains_key(&key));
    }

    #[test]
    fn trace_work_for_one_session_is_serialized() {
        let barrier = Arc::new(Barrier::new(3));
        let active = Arc::new(AtomicUsize::new(0));
        let mut threads = Vec::new();
        for _ in 0..2 {
            let barrier = Arc::clone(&barrier);
            let active = Arc::clone(&active);
            threads.push(thread::spawn(move || {
                barrier.wait();
                with_trace_session_lock("serialized-session", || {
                    assert_eq!(active.fetch_add(1, Ordering::SeqCst), 0);
                    thread::sleep(StdDuration::from_millis(10));
                    active.fetch_sub(1, Ordering::SeqCst);
                });
            }));
        }
        barrier.wait();
        for thread in threads {
            thread.join().expect("trace worker");
        }
    }
}
