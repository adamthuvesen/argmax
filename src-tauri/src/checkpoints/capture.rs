//! What a checkpoint records about a checkout, read with as few git processes
//! as the checkout allows.
//!
//! One `git status` answers most of it: HEAD, the branch, unmerged entries,
//! the untracked files, and which paths differ from the index. Only those
//! paths are staged into the worktree snapshot. When status, and the stat of
//! every path it names, match the last capture of the same checkout, nothing
//! that decides the trees moved, and the last capture's trees are reused.

use std::{
    collections::HashMap,
    io::ErrorKind,
    os::unix::fs::MetadataExt,
    path::{Path, PathBuf},
    sync::Mutex,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use argmax_contracts::error::{ArgmaxError, ArgmaxResult};
use argmax_store::sync::LockOrRecover;

use super::service::CheckoutFingerprint;

/// `--no-renames` keeps every record to one path, so a staged rename reads as
/// the deletion and the addition `add --all` would stage.
pub(super) const STATUS_ARGS: [&str; 7] = [
    "status",
    "--porcelain=v2",
    "--branch",
    "--no-ahead-behind",
    "--no-renames",
    "--untracked-files=all",
    "-z",
];

/// A file written this close to its stat may be written again without its
/// stat moving on a filesystem with coarse timestamps. Such a capture is not
/// reused, as git treats a racily clean index entry.
const RACY_WINDOW: Duration = Duration::from_secs(1);

#[derive(Debug, Clone, PartialEq)]
pub(super) struct CheckoutState {
    pub fingerprint: CheckoutFingerprint,
    pub untracked_paths: Vec<String>,
}

/// `git status --porcelain=v2 --branch -z`, read for a checkpoint.
#[derive(Debug, Default, PartialEq)]
pub(super) struct StatusReport {
    /// `None` on an unborn HEAD.
    pub head_sha: Option<String>,
    /// `None` on a detached HEAD.
    pub branch: Option<String>,
    pub unmerged: bool,
    /// Every record that decides the trees, in git's order. Upstream and
    /// ahead/behind headers are left out: a fetch moves them, not the trees.
    pub records: Vec<String>,
    /// Tracked paths whose worktree side differs from the index.
    pub worktree_changes: Vec<String>,
    pub untracked: Vec<String>,
    /// Index entries `HEAD` does not have.
    pub added_in_index: Vec<String>,
}

pub(super) fn parse_status(raw: &str) -> ArgmaxResult<StatusReport> {
    let mut report = StatusReport::default();
    for record in raw.split('\0').filter(|record| !record.is_empty()) {
        if let Some(header) = record.strip_prefix("# ") {
            if let Some(oid) = header.strip_prefix("branch.oid ") {
                report.head_sha = (oid != "(initial)").then(|| oid.to_string());
            } else if let Some(head) = header.strip_prefix("branch.head ") {
                report.branch = (head != "(detached)").then(|| head.to_string());
            } else {
                continue;
            }
        } else if let Some(path) = record.strip_prefix("? ") {
            report.untracked.push(path.to_string());
        } else if record.starts_with("u ") {
            report.unmerged = true;
        } else if let Some(fields) = record.strip_prefix("1 ") {
            // XY sub mH mI mW hH hI path
            let mut fields = fields.splitn(8, ' ');
            let xy = fields.next().unwrap_or_default().as_bytes();
            let path = fields.nth(6).ok_or_else(|| malformed(record))?;
            if xy.len() != 2 {
                return Err(malformed(record));
            }
            if xy[0] == b'A' {
                report.added_in_index.push(path.to_string());
            }
            if xy[1] != b'.' {
                report.worktree_changes.push(path.to_string());
            }
        } else if record.starts_with('!') {
            continue;
        } else {
            // A rename record cannot appear under `--no-renames`; anything
            // unread would make a reuse decision on partial information.
            return Err(malformed(record));
        }
        report.records.push(record.to_string());
    }
    Ok(report)
}

fn malformed(record: &str) -> ArgmaxError {
    ArgmaxError::service(
        "CHECKPOINT_STATUS_MALFORMED",
        format!("git status returned an unreadable record: {record}"),
    )
}

/// The parts of `stat` that move when a file's content can have changed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct FileIdentity {
    device: u64,
    inode: u64,
    mode: u32,
    len: u64,
    modified_ns: i128,
    changed_ns: i128,
}

/// `None` when nothing is at `path`, including when a parent is now a file.
pub(super) fn file_identity(path: &Path) -> ArgmaxResult<Option<FileIdentity>> {
    match std::fs::symlink_metadata(path) {
        Ok(metadata) => Ok(Some(FileIdentity {
            device: metadata.dev(),
            inode: metadata.ino(),
            mode: metadata.mode(),
            len: metadata.len(),
            modified_ns: i128::from(metadata.mtime()) * 1_000_000_000
                + i128::from(metadata.mtime_nsec()),
            changed_ns: i128::from(metadata.ctime()) * 1_000_000_000
                + i128::from(metadata.ctime_nsec()),
        })),
        // A parent that became a file reads as ENOTDIR: nothing is at `path`.
        Err(error) if matches!(error.kind(), ErrorKind::NotFound | ErrorKind::NotADirectory) => {
            Ok(None)
        }
        Err(error) => Err(ArgmaxError::service(
            "CHECKPOINT_STAT_FAILED",
            format!("could not stat {}: {error}", path.display()),
        )),
    }
}

pub(super) type PathStats = Vec<(String, Option<FileIdentity>)>;

/// Stat every path status named, before anything stages them: a write after
/// this moves the stat, so the next capture cannot mistake it for no change.
pub(super) fn stat_paths(
    workspace_path: &Path,
    paths: &[String],
) -> ArgmaxResult<(PathStats, bool)> {
    let taken_ns = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_nanos() as i128)
        .unwrap_or_default();
    let racy_after = taken_ns - RACY_WINDOW.as_nanos() as i128;
    let mut racy = false;
    let mut stats = Vec::with_capacity(paths.len());
    for path in paths {
        let identity = file_identity(&workspace_path.join(path))?;
        if let Some(identity) = &identity {
            racy |= identity.modified_ns >= racy_after;
        }
        stats.push((path.clone(), identity));
    }
    Ok((stats, racy))
}

/// Whether a capture read from `report` may be reused.
///
/// Status reports an embedded git repository as one `? nested/` record.
/// A commit inside it moves the gitlink `add` stages, but neither the record
/// nor the directory's stat, so such a capture is never reused.
pub(super) fn reusable(report: &StatusReport, racy: bool) -> bool {
    !racy && !report.untracked.iter().any(|path| path.ends_with('/'))
}

/// The last capture of one checkout, and what it was read from.
#[derive(Debug, Clone)]
pub(super) struct CaptureRecord {
    pub records: Vec<String>,
    pub path_stats: PathStats,
    /// False when a path was written inside [`RACY_WINDOW`] of its stat, or
    /// status reported an untracked directory (see [`reusable`]).
    pub reusable: bool,
    /// The checkout's index file when it was read. While it holds, the index
    /// tree and the submodule answer hold too.
    pub index_identity: Option<FileIdentity>,
    pub added_in_index: Vec<String>,
    /// What the force-staged-ignored rule dropped from `added_in_index`.
    pub dropped: Vec<String>,
    pub state: CheckoutState,
}

impl CaptureRecord {
    /// Whether this capture still describes a checkout that now reports
    /// `report` and `path_stats`. The ignore rule is the one input neither
    /// covers, so a caller with `added_in_index` re-reads it before reusing.
    pub fn matches(&self, report: &StatusReport, path_stats: &PathStats) -> bool {
        self.reusable && self.records == report.records && &self.path_stats == path_stats
    }
}

/// Checkouts whose last capture is kept. Past this, the least recently used
/// is dropped; its next capture reads the checkout in full.
const MAX_RECORDS: usize = 64;

/// Captures per checkout path, for this app run.
#[derive(Default)]
pub(super) struct CaptureRecords {
    records: Mutex<RecordMap>,
}

#[derive(Default)]
struct RecordMap {
    clock: u64,
    by_path: HashMap<PathBuf, (u64, CaptureRecord)>,
}

impl CaptureRecords {
    pub fn get(&self, workspace_path: &Path) -> Option<CaptureRecord> {
        let mut records = self.records.lock_or_recover("checkpoint captures");
        records.clock += 1;
        let clock = records.clock;
        let (used, record) = records.by_path.get_mut(workspace_path)?;
        *used = clock;
        Some(record.clone())
    }

    pub fn put(&self, workspace_path: &Path, record: CaptureRecord) {
        let mut records = self.records.lock_or_recover("checkpoint captures");
        records.clock += 1;
        let clock = records.clock;
        if records.by_path.len() >= MAX_RECORDS && !records.by_path.contains_key(workspace_path) {
            if let Some(oldest) = records
                .by_path
                .iter()
                .min_by_key(|(_, (used, _))| *used)
                .map(|(path, _)| path.clone())
            {
                records.by_path.remove(&oldest);
            }
        }
        records
            .by_path
            .insert(workspace_path.to_path_buf(), (clock, record));
    }

    #[cfg(test)]
    pub fn len(&self) -> usize {
        self.records
            .lock_or_recover("checkpoint captures")
            .by_path
            .len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn status_records_split_into_what_a_checkpoint_needs() {
        let raw = [
            "# branch.oid 1111111111111111111111111111111111111111",
            "# branch.head main",
            "# branch.upstream origin/main",
            "# branch.ab +? -?",
            "1 M. N... 100644 100644 100644 aaaa bbbb staged.txt",
            "1 .M N... 100644 100644 100644 aaaa aaaa with space.txt",
            "1 AD N... 000000 100644 000000 0000 cccc added then removed.txt",
            "? new dir/file.txt",
        ]
        .join("\0");
        let report = parse_status(&raw).unwrap();
        assert_eq!(
            report.head_sha.as_deref(),
            Some("1111111111111111111111111111111111111111")
        );
        assert_eq!(report.branch.as_deref(), Some("main"));
        assert!(!report.unmerged);
        assert_eq!(
            report.worktree_changes,
            vec!["with space.txt", "added then removed.txt"]
        );
        assert_eq!(report.added_in_index, vec!["added then removed.txt"]);
        assert_eq!(report.untracked, vec!["new dir/file.txt"]);
        assert_eq!(report.records.len(), 6, "upstream headers are not recorded");
    }

    #[test]
    fn status_reports_unborn_detached_and_unmerged_heads() {
        let report = parse_status(
            "# branch.oid (initial)\0# branch.head (detached)\0u UU N... 1 2 3 4 a b c both.txt\0",
        )
        .unwrap();
        assert_eq!(report.head_sha, None);
        assert_eq!(report.branch, None);
        assert!(report.unmerged);
    }

    fn record(tree: &str) -> CaptureRecord {
        CaptureRecord {
            records: Vec::new(),
            path_stats: Vec::new(),
            reusable: true,
            index_identity: None,
            added_in_index: Vec::new(),
            dropped: Vec::new(),
            state: CheckoutState {
                fingerprint: CheckoutFingerprint {
                    head_sha: String::new(),
                    branch: String::new(),
                    worktree_tree: tree.into(),
                    index_tree: tree.into(),
                },
                untracked_paths: Vec::new(),
            },
        }
    }

    #[test]
    fn records_past_the_cap_drop_the_least_recently_used() {
        let records = CaptureRecords::default();
        for n in 0..MAX_RECORDS {
            records.put(Path::new(&format!("/repo/{n}")), record("old"));
        }
        // Touch the first so the second becomes the oldest.
        assert!(records.get(Path::new("/repo/0")).is_some());
        records.put(Path::new("/repo/new"), record("new"));
        assert_eq!(records.len(), MAX_RECORDS);
        assert!(records.get(Path::new("/repo/0")).is_some());
        assert!(records.get(Path::new("/repo/1")).is_none());
        assert!(records.get(Path::new("/repo/new")).is_some());
    }

    #[test]
    fn a_parent_that_became_a_file_reads_as_missing() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("dir"), "a file").unwrap();
        assert_eq!(file_identity(&dir.path().join("dir/a")).unwrap(), None);
    }

    #[test]
    fn an_unreadable_status_record_fails_rather_than_guessing() {
        assert!(parse_status("2 R. N... 1 2 3 a b R100 new\0old\0").is_err());
    }
}
