//! Recovery for Chrome profiles left with a hot rollback journal.
//!
//! SQLite cannot roll a journal back through a read-only connection. For that
//! one error, copy a stable source set into a private directory and let SQLite
//! recover the copy. Chrome's database and journal are never opened writable.

use std::fs;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

use rusqlite::Connection;
use tempfile::TempDir;

use crate::error::{ArgmaxError, ArgmaxResult};

const SQLITE_READONLY_ROLLBACK: i32 = 776;
const CHANGED_SET_RETRIES: usize = 2;

pub(super) struct RecoveredHistory {
    connection: Connection,
    _directory: TempDir,
}

impl RecoveredHistory {
    pub(super) fn connection(&mut self) -> &mut Connection {
        &mut self.connection
    }
}

pub(super) fn is_readonly_rollback(error: &rusqlite::Error) -> bool {
    matches!(
        error,
        rusqlite::Error::SqliteFailure(code, _)
            if code.extended_code == SQLITE_READONLY_ROLLBACK
    )
}

pub(super) fn recover_copy(history_path: &Path) -> ArgmaxResult<RecoveredHistory> {
    for attempt in 0..=CHANGED_SET_RETRIES {
        match copy_once(history_path) {
            Ok(recovered) => return Ok(recovered),
            Err(CopyError::Changed) if attempt < CHANGED_SET_RETRIES => continue,
            Err(CopyError::Changed) => break,
            Err(CopyError::Fatal(error)) => return Err(error),
        }
    }
    Err(ArgmaxError::service(
        "CHROME_HISTORY_CHANGED",
        "Chrome history changed while importing. Close Chrome and try again.",
    ))
}

fn copy_once(history_path: &Path) -> Result<RecoveredHistory, CopyError> {
    let before = inspect_source_set(history_path)?;
    let directory = tempfile::tempdir().map_err(|error| {
        CopyError::Fatal(ArgmaxError::service(
            "CHROME_HISTORY_COPY_FAILED",
            format!("cannot create a private Chrome history copy: {error}"),
        ))
    })?;
    let copied_history = directory.path().join("History");
    let copied_journal = directory.path().join("History-journal");

    copy_source_file(history_path, &copied_history, history_path, &before)?;
    copy_source_file(&before.journal_path, &copied_journal, history_path, &before)?;
    let after = inspect_source_set(history_path)?;
    if before != after {
        return Err(CopyError::Changed);
    }

    let connection = Connection::open(&copied_history)
        .map_err(|error| CopyError::Fatal(recovery_error("open the private copy", error)))?;
    connection
        .query_row("SELECT COUNT(*) FROM sqlite_master", [], |row| {
            row.get::<_, i64>(0)
        })
        .map_err(|error| CopyError::Fatal(recovery_error("recover the private copy", error)))?;
    let quick_check: String = connection
        .query_row("PRAGMA quick_check(1)", [], |row| row.get(0))
        .map_err(|error| CopyError::Fatal(recovery_error("check the private copy", error)))?;
    if quick_check != "ok" {
        return Err(CopyError::Fatal(ArgmaxError::service(
            "CHROME_HISTORY_RECOVERY_FAILED",
            format!(
                "recovered Chrome history copy failed its integrity check: {quick_check}. \
                 Close Chrome and try again."
            ),
        )));
    }

    Ok(RecoveredHistory {
        connection,
        _directory: directory,
    })
}

fn copy_source_file(
    source: &Path,
    destination: &Path,
    history_path: &Path,
    before: &SourceSet,
) -> Result<(), CopyError> {
    if let Err(error) = fs::copy(source, destination) {
        match inspect_source_set(history_path) {
            Ok(after) if &after == before => {}
            Ok(_) | Err(CopyError::Changed) => return Err(CopyError::Changed),
            Err(CopyError::Fatal(source_error)) => {
                return Err(CopyError::Fatal(source_error));
            }
        }
        return Err(CopyError::Fatal(ArgmaxError::service(
            "CHROME_HISTORY_COPY_FAILED",
            format!("cannot copy {}: {error}", source.display()),
        )));
    }
    Ok(())
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct SourceSet {
    history: FileIdentity,
    journal_path: PathBuf,
    journal: FileIdentity,
}

fn inspect_source_set(history_path: &Path) -> Result<SourceSet, CopyError> {
    ensure_no_wal(history_path)?;
    let history = file_identity(history_path, "Chrome History database")?;
    let journal_path = sibling_with_suffix(history_path, "-journal");
    let journal = file_identity(&journal_path, "Chrome History rollback journal")?;
    Ok(SourceSet {
        history,
        journal_path,
        journal,
    })
}

fn ensure_no_wal(history_path: &Path) -> Result<(), CopyError> {
    let wal_path = sibling_with_suffix(history_path, "-wal");
    match fs::symlink_metadata(&wal_path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Ok(_) => Err(CopyError::Changed),
        Err(error) => Err(CopyError::Fatal(source_error(
            "inspect the Chrome History WAL",
            error,
        ))),
    }
}

fn file_identity(path: &Path, label: &str) -> Result<FileIdentity, CopyError> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Err(CopyError::Changed);
        }
        Err(error) => {
            return Err(CopyError::Fatal(source_error(
                &format!("inspect the {label}"),
                error,
            )));
        }
    };
    if !metadata.file_type().is_file() {
        return Err(CopyError::Fatal(ArgmaxError::service(
            "CHROME_HISTORY_SOURCE_UNSAFE",
            format!("{label} is not a regular file"),
        )));
    }
    Ok(FileIdentity::from_metadata(&metadata))
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct FileIdentity {
    len: u64,
    modified: Option<SystemTime>,
    #[cfg(unix)]
    device: u64,
    #[cfg(unix)]
    inode: u64,
    #[cfg(unix)]
    changed_seconds: i64,
    #[cfg(unix)]
    changed_nanoseconds: i64,
}

impl FileIdentity {
    fn from_metadata(metadata: &fs::Metadata) -> Self {
        #[cfg(unix)]
        use std::os::unix::fs::MetadataExt;

        Self {
            len: metadata.len(),
            modified: metadata.modified().ok(),
            #[cfg(unix)]
            device: metadata.dev(),
            #[cfg(unix)]
            inode: metadata.ino(),
            #[cfg(unix)]
            changed_seconds: metadata.ctime(),
            #[cfg(unix)]
            changed_nanoseconds: metadata.ctime_nsec(),
        }
    }
}

enum CopyError {
    Changed,
    Fatal(ArgmaxError),
}

fn sibling_with_suffix(path: &Path, suffix: &str) -> PathBuf {
    let mut name = path.as_os_str().to_owned();
    name.push(suffix);
    PathBuf::from(name)
}

fn source_error(action: &str, error: std::io::Error) -> ArgmaxError {
    ArgmaxError::service(
        "CHROME_HISTORY_SOURCE_READ_FAILED",
        format!("cannot {action}: {error}"),
    )
}

fn recovery_error(action: &str, error: rusqlite::Error) -> ArgmaxError {
    ArgmaxError::service(
        "CHROME_HISTORY_RECOVERY_FAILED",
        format!("cannot {action}: {error}. Close Chrome and try again."),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::browser::chrome_history::import_history;
    use rusqlite::{params, OpenFlags, TransactionBehavior};
    use tempfile::tempdir;

    const CHROME_EPOCH_MICROS: i64 = 11_644_473_600_000_000;

    #[test]
    fn recovers_a_hot_journal_copy_without_touching_the_source() {
        let staging = tempdir().expect("staging tempdir");
        let staging_history = staging.path().join("History");
        let mut writer = Connection::open(&staging_history).expect("staging database");
        let journal_mode: String = writer
            .query_row("PRAGMA journal_mode=DELETE", [], |row| row.get(0))
            .expect("enable rollback journal");
        assert_eq!(journal_mode, "delete");
        writer
            .execute_batch(
                "PRAGMA synchronous=FULL;
                 PRAGMA cache_size=1;
                 CREATE TABLE urls (
                   id INTEGER PRIMARY KEY,
                   url TEXT NOT NULL,
                   title TEXT,
                   visit_count INTEGER NOT NULL DEFAULT 0,
                   last_visit_time INTEGER NOT NULL,
                   hidden INTEGER NOT NULL DEFAULT 0
                 );",
            )
            .expect("create Chrome schema");
        writer
            .execute(
                "INSERT INTO urls (url, title, visit_count, last_visit_time, hidden)
                 VALUES (?1, ?2, 1, ?3, 0)",
                params![
                    "https://committed.example",
                    "Committed",
                    CHROME_EPOCH_MICROS
                ],
            )
            .expect("insert committed row");

        let transaction = writer
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .expect("begin uncommitted write");
        transaction
            .execute(
                "UPDATE urls SET title = ?1 WHERE url = ?2",
                params!["Uncommitted", "https://committed.example"],
            )
            .expect("update committed row");
        let large_title = "x".repeat(8_192);
        for index in 0..64 {
            transaction
                .execute(
                    "INSERT INTO urls (url, title, visit_count, last_visit_time, hidden)
                     VALUES (?1, ?2, 1, ?3, 0)",
                    params![
                        format!("https://uncommitted.example/{index}"),
                        &large_title,
                        CHROME_EPOCH_MICROS + index + 1
                    ],
                )
                .expect("insert uncommitted row");
        }

        let source = tempdir().expect("source tempdir");
        let profile = source.path().join("Default");
        fs::create_dir(&profile).expect("source profile");
        let source_history = profile.join("History");
        let source_journal = profile.join("History-journal");
        fs::copy(&staging_history, &source_history).expect("copy hot database");
        fs::copy(
            sibling_with_suffix(&staging_history, "-journal"),
            &source_journal,
        )
        .expect("copy hot journal");
        let history_before = fs::read(&source_history).expect("read source database");
        let journal_before = fs::read(&source_journal).expect("read source journal");

        let read_only = Connection::open_with_flags(
            &source_history,
            OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )
        .expect("open source read-only");
        let error = read_only
            .query_row("SELECT COUNT(*) FROM sqlite_master", [], |row| {
                row.get::<_, i64>(0)
            })
            .expect_err("hot journal requires rollback");
        assert!(is_readonly_rollback(&error));
        drop(read_only);

        let imported = import_history(source.path(), "Default").expect("recover copied history");
        assert_eq!(imported.total_available, 1);
        assert_eq!(imported.entries.len(), 1);
        assert_eq!(imported.entries[0].url, "https://committed.example");
        assert_eq!(imported.entries[0].title.as_deref(), Some("Committed"));
        assert_eq!(
            fs::read(&source_history).expect("reread source database"),
            history_before
        );
        assert_eq!(
            fs::read(&source_journal).expect("reread source journal"),
            journal_before
        );

        drop(transaction);
    }
}
