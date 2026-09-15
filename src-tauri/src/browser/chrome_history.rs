//! Read Chrome's on-disk history without changing the browser profile.

use std::collections::HashMap;
use std::env;
use std::fs;
use std::path::{Component, Path, PathBuf};

use rusqlite::{params, Connection, OpenFlags};
use serde::Serialize;
use specta::Type;

use crate::browser::chrome_history_snapshot;
use crate::error::{ArgmaxError, ArgmaxResult, InvalidInputIssue};

const MAX_IMPORTED_ENTRIES: usize = 10_000;
const CHROME_TO_UNIX_EPOCH_MICROS: i64 = 11_644_473_600_000_000;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ChromeProfile {
    pub id: String,
    pub name: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ChromeHistoryEntry {
    pub url: String,
    pub title: Option<String>,
    pub visited_at: f64,
    pub visit_count: u32,
}

#[derive(Debug, Clone, PartialEq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ChromeHistoryImport {
    pub entries: Vec<ChromeHistoryEntry>,
    pub total_available: u32,
}

pub fn default_profile_root() -> ArgmaxResult<PathBuf> {
    #[cfg(target_os = "macos")]
    {
        let home = env::var_os("HOME").ok_or_else(|| {
            ArgmaxError::service(
                "CHROME_HOME_UNAVAILABLE",
                "cannot locate Chrome profiles because HOME is not set",
            )
        })?;
        return Ok(PathBuf::from(home).join("Library/Application Support/Google/Chrome"));
    }

    #[cfg(target_os = "windows")]
    {
        let local_app_data = env::var_os("LOCALAPPDATA").ok_or_else(|| {
            ArgmaxError::service(
                "CHROME_HOME_UNAVAILABLE",
                "cannot locate Chrome profiles because LOCALAPPDATA is not set",
            )
        })?;
        return Ok(PathBuf::from(local_app_data).join("Google/Chrome/User Data"));
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    {
        if let Some(config) = env::var_os("XDG_CONFIG_HOME") {
            return Ok(PathBuf::from(config).join("google-chrome"));
        }
        let home = env::var_os("HOME").ok_or_else(|| {
            ArgmaxError::service(
                "CHROME_HOME_UNAVAILABLE",
                "cannot locate Chrome profiles because HOME is not set",
            )
        })?;
        return Ok(PathBuf::from(home).join(".config/google-chrome"));
    }

    #[allow(unreachable_code)]
    Err(ArgmaxError::service(
        "CHROME_PLATFORM_UNSUPPORTED",
        "Chrome history import is unavailable on this platform",
    ))
}

pub fn discover_profiles(root: &Path) -> ArgmaxResult<Vec<ChromeProfile>> {
    match fs::metadata(root) {
        Ok(metadata) if metadata.is_dir() => {}
        Ok(_) => {
            return Err(ArgmaxError::service(
                "CHROME_PROFILE_ROOT_UNAVAILABLE",
                "Chrome profile path is not a directory",
            ));
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => {
            return Err(ArgmaxError::service(
                "CHROME_PROFILE_READ_FAILED",
                format!("cannot inspect Chrome profile directory: {error}"),
            ));
        }
    }
    let canonical_root = canonical_root(root)?;
    let names = profile_names(&canonical_root);
    let directory = fs::read_dir(&canonical_root).map_err(|error| {
        ArgmaxError::service(
            "CHROME_PROFILE_READ_FAILED",
            format!("cannot read Chrome profile directory: {error}"),
        )
    })?;

    let mut profiles = Vec::new();
    for entry in directory {
        let entry = entry.map_err(|error| {
            ArgmaxError::service(
                "CHROME_PROFILE_READ_FAILED",
                format!("cannot read a Chrome profile directory entry: {error}"),
            )
        })?;
        let Some(id) = entry.file_name().to_str().map(str::to_owned) else {
            continue;
        };
        let file_type = entry.file_type().map_err(|error| {
            ArgmaxError::service(
                "CHROME_PROFILE_READ_FAILED",
                format!("cannot inspect Chrome profile candidate {id}: {error}"),
            )
        })?;
        if !file_type.is_dir() && !file_type.is_symlink() {
            continue;
        }
        let profile_path = match entry.path().canonicalize() {
            Ok(path) => path,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => {
                return Err(ArgmaxError::service(
                    "CHROME_PROFILE_READ_FAILED",
                    format!("cannot resolve Chrome profile {id}: {error}"),
                ));
            }
        };
        if !profile_path.starts_with(&canonical_root) || !profile_path.is_dir() {
            continue;
        }
        let history_candidate = profile_path.join("History");
        match fs::symlink_metadata(&history_candidate) {
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => {
                return Err(ArgmaxError::service(
                    "CHROME_PROFILE_READ_FAILED",
                    format!("cannot inspect Chrome profile {id}: {error}"),
                ));
            }
        }
        let history_path = history_candidate.canonicalize().map_err(|error| {
            ArgmaxError::service(
                "CHROME_PROFILE_READ_FAILED",
                format!("cannot resolve Chrome history for profile {id}: {error}"),
            )
        })?;
        if !history_path.starts_with(&canonical_root) {
            continue;
        }
        if !history_path.is_file() {
            continue;
        }
        profiles.push(ChromeProfile {
            name: names.get(&id).cloned().unwrap_or_else(|| id.clone()),
            id,
        });
    }

    profiles.sort_by(|left, right| {
        (left.id != "Default", left.name.to_lowercase(), &left.id).cmp(&(
            right.id != "Default",
            right.name.to_lowercase(),
            &right.id,
        ))
    });
    Ok(profiles)
}

pub fn import_history(root: &Path, profile_id: &str) -> ArgmaxResult<ChromeHistoryImport> {
    let history_path = resolve_history_path(root, profile_id)?;
    let mut connection = Connection::open_with_flags(
        &history_path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|error| history_database_error(&history_path, error))?;
    match read_direct(&mut connection, &history_path) {
        Ok(imported) => Ok(imported),
        Err(DirectReadError::Other(error)) => Err(error),
        Err(DirectReadError::ReadonlyRollback) => {
            drop(connection);
            let mut recovered = chrome_history_snapshot::recover_copy(&history_path)?;
            read_history(recovered.connection(), &history_path)
        }
    }
}

enum DirectReadError {
    ReadonlyRollback,
    Other(ArgmaxError),
}

fn read_direct(
    connection: &mut Connection,
    source_path: &Path,
) -> Result<ChromeHistoryImport, DirectReadError> {
    let transaction = connection.transaction().map_err(|error| {
        if chrome_history_snapshot::is_readonly_rollback(&error) {
            DirectReadError::ReadonlyRollback
        } else {
            DirectReadError::Other(history_database_error(source_path, error))
        }
    })?;
    transaction
        .query_row("SELECT COUNT(*) FROM sqlite_master", [], |row| {
            row.get::<_, i64>(0)
        })
        .map_err(|error| {
            if chrome_history_snapshot::is_readonly_rollback(&error) {
                DirectReadError::ReadonlyRollback
            } else {
                DirectReadError::Other(history_database_error(source_path, error))
            }
        })?;
    read_history(&transaction, source_path).map_err(DirectReadError::Other)
}

fn read_history(connection: &Connection, source_path: &Path) -> ArgmaxResult<ChromeHistoryImport> {
    // Chrome uses zero for a URL that has no real visit time. It is not
    // browser history and would turn into a date before the Unix epoch.
    let (total, earliest_visit, minimum_count, maximum_count): (i64, i64, i64, i64) = connection
        .query_row(
            "SELECT COUNT(*), COALESCE(MIN(last_visit_time), ?1), \
             COALESCE(MIN(visit_count), 0), COALESCE(MAX(visit_count), 0) \
             FROM urls \
             WHERE hidden = 0 AND last_visit_time != 0 \
             AND (url LIKE 'http://%' OR url LIKE 'https://%')",
            params![CHROME_TO_UNIX_EPOCH_MICROS],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .map_err(|error| history_database_error(source_path, error))?;
    if earliest_visit < CHROME_TO_UNIX_EPOCH_MICROS {
        return Err(ArgmaxError::service(
            "CHROME_HISTORY_INVALID_TIMESTAMP",
            "Chrome history contains a visit time before the Unix epoch",
        ));
    }
    if minimum_count < 0 || maximum_count > u32::MAX as i64 {
        return Err(ArgmaxError::service(
            "CHROME_HISTORY_INVALID_VISIT_COUNT",
            "Chrome history contains a visit count outside the supported range",
        ));
    }
    let mut statement = connection
        .prepare(
            "SELECT url, NULLIF(title, ''), last_visit_time, visit_count \
             FROM urls \
             WHERE hidden = 0 AND last_visit_time != 0 \
             AND (url LIKE 'http://%' OR url LIKE 'https://%') \
             ORDER BY last_visit_time DESC, id DESC LIMIT ?1",
        )
        .map_err(|error| history_database_error(source_path, error))?;
    let rows = statement
        .query_map(params![MAX_IMPORTED_ENTRIES as i64], |row| {
            let chrome_time: i64 = row.get(2)?;
            let visit_count: i64 = row.get(3)?;
            Ok(ChromeHistoryEntry {
                url: row.get(0)?,
                title: row.get(1)?,
                visited_at: (chrome_time - CHROME_TO_UNIX_EPOCH_MICROS) as f64 / 1_000.0,
                visit_count: visit_count as u32,
            })
        })
        .map_err(|error| history_database_error(source_path, error))?;
    let entries = rows
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| history_database_error(source_path, error))?;

    Ok(ChromeHistoryImport {
        entries,
        total_available: u32::try_from(total).map_err(|_| {
            ArgmaxError::service(
                "CHROME_HISTORY_TOO_LARGE",
                "Chrome history contains more URLs than can be reported",
            )
        })?,
    })
}

fn resolve_history_path(root: &Path, profile_id: &str) -> ArgmaxResult<PathBuf> {
    let mut components = Path::new(profile_id).components();
    if !matches!(components.next(), Some(Component::Normal(_))) || components.next().is_some() {
        return Err(ArgmaxError::invalid(InvalidInputIssue::at(
            vec!["profileId".into()],
            "CHROME_PROFILE_ID_INVALID",
            "Chrome profile id must be one directory name",
        )));
    }

    let canonical_root = canonical_root(root)?;
    let profile_path = canonical_root
        .join(profile_id)
        .canonicalize()
        .map_err(|_| ArgmaxError::record_not_found("Chrome profile", profile_id))?;
    if !profile_path.starts_with(&canonical_root) || !profile_path.is_dir() {
        return Err(profile_path_outside_root());
    }
    let history_candidate = profile_path.join("History");
    let history_metadata = fs::symlink_metadata(&history_candidate)
        .map_err(|_| ArgmaxError::record_not_found("Chrome profile history", profile_id))?;
    if !history_metadata.file_type().is_file() {
        return Err(ArgmaxError::invalid(InvalidInputIssue::at(
            vec!["profileId".into()],
            "CHROME_HISTORY_SOURCE_UNSAFE",
            "Chrome History must be a regular file inside the profile directory",
        )));
    }
    let history_path = history_candidate
        .canonicalize()
        .map_err(|_| ArgmaxError::record_not_found("Chrome profile history", profile_id))?;
    if !history_path.starts_with(&canonical_root) || !history_path.is_file() {
        return Err(profile_path_outside_root());
    }
    Ok(history_path)
}

fn canonical_root(root: &Path) -> ArgmaxResult<PathBuf> {
    root.canonicalize().map_err(|error| {
        ArgmaxError::service(
            "CHROME_PROFILE_ROOT_UNAVAILABLE",
            format!("cannot open Chrome profile directory: {error}"),
        )
    })
}

fn profile_path_outside_root() -> ArgmaxError {
    ArgmaxError::invalid(InvalidInputIssue::at(
        vec!["profileId".into()],
        "CHROME_PROFILE_PATH_OUTSIDE_ROOT",
        "Chrome profile must stay inside the Chrome profile directory",
    ))
}

fn profile_names(root: &Path) -> HashMap<String, String> {
    let Ok(local_state_path) = root.join("Local State").canonicalize() else {
        return HashMap::new();
    };
    if !local_state_path.starts_with(root) || !local_state_path.is_file() {
        return HashMap::new();
    }
    let Ok(body) = fs::read_to_string(local_state_path) else {
        return HashMap::new();
    };
    let Ok(document) = serde_json::from_str::<serde_json::Value>(&body) else {
        return HashMap::new();
    };
    let Some(cache) = document
        .get("profile")
        .and_then(|profile| profile.get("info_cache"))
        .and_then(serde_json::Value::as_object)
    else {
        return HashMap::new();
    };
    cache
        .iter()
        .filter_map(|(id, profile)| {
            profile
                .get("name")
                .and_then(serde_json::Value::as_str)
                .filter(|name| !name.trim().is_empty())
                .map(|name| (id.clone(), name.to_owned()))
        })
        .collect()
}

fn history_database_error(path: &Path, error: rusqlite::Error) -> ArgmaxError {
    ArgmaxError::service(
        "CHROME_HISTORY_READ_FAILED",
        format!("cannot read Chrome history at {}: {error}", path.display()),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn create_history(path: &Path) -> Connection {
        let connection = Connection::open(path).expect("create History database");
        let journal_mode: String = connection
            .query_row("PRAGMA journal_mode=WAL", [], |row| row.get(0))
            .expect("enable WAL");
        assert_eq!(journal_mode, "wal");
        let _: i64 = connection
            .query_row("PRAGMA wal_autocheckpoint=0", [], |row| row.get(0))
            .expect("disable automatic checkpoint");
        connection
            .execute_batch(
                "CREATE TABLE urls (
                   id INTEGER PRIMARY KEY,
                   url TEXT NOT NULL,
                   title TEXT,
                   visit_count INTEGER NOT NULL DEFAULT 0,
                   last_visit_time INTEGER NOT NULL,
                   hidden INTEGER NOT NULL DEFAULT 0
                 );",
            )
            .expect("create Chrome schema");
        connection
            .query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |_| Ok(()))
            .expect("checkpoint schema");
        connection
    }

    #[test]
    fn discovers_profiles_with_local_state_names_and_history_only() {
        let temp = tempdir().expect("tempdir");
        let root = temp.path();
        fs::create_dir(root.join("Default")).expect("Default profile");
        fs::create_dir(root.join("Profile 1")).expect("second profile");
        fs::create_dir(root.join("Profile 2")).expect("profile without history");
        fs::write(root.join("Default/History"), []).expect("Default History");
        fs::write(root.join("Profile 1/History"), []).expect("Profile 1 History");
        fs::write(
            root.join("Local State"),
            r#"{"profile":{"info_cache":{"Default":{"name":"Personal"},"Profile 1":{"name":"Work"}}}}"#,
        )
        .expect("Local State");
        #[cfg(unix)]
        std::os::unix::fs::symlink(root.join("missing"), root.join("RunningChromeVersion"))
            .expect("dangling Chrome runtime symlink");

        assert_eq!(
            discover_profiles(root).expect("discover profiles"),
            vec![
                ChromeProfile {
                    id: "Default".into(),
                    name: "Personal".into(),
                },
                ChromeProfile {
                    id: "Profile 1".into(),
                    name: "Work".into(),
                },
            ]
        );
    }

    #[test]
    fn imports_a_read_only_snapshot_including_uncheckpointed_wal_rows() {
        let temp = tempdir().expect("tempdir");
        let profile = temp.path().join("Default");
        fs::create_dir(&profile).expect("profile");
        let connection = create_history(&profile.join("History"));
        let unix_ms = 1_700_000_000_000_i64;
        let chrome_time = unix_ms * 1_000 + CHROME_TO_UNIX_EPOCH_MICROS;
        connection
            .execute(
                "INSERT INTO urls (url, title, visit_count, last_visit_time, hidden)
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                params!["https://example.com", "Example", 7, chrome_time, 0],
            )
            .expect("insert visible row into WAL");
        connection
            .execute(
                "INSERT INTO urls (url, title, visit_count, last_visit_time, hidden)
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                params!["file:///tmp/private", "File", 4, chrome_time + 1, 0],
            )
            .expect("insert non-http row");
        connection
            .execute(
                "INSERT INTO urls (url, title, visit_count, last_visit_time, hidden)
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                params!["https://hidden.example", "Hidden", 2, chrome_time + 2, 1],
            )
            .expect("insert hidden row");
        assert!(profile.join("History-wal").exists());

        let imported = import_history(temp.path(), "Default").expect("import history");
        assert_eq!(imported.total_available, 1);
        assert_eq!(imported.entries.len(), 1);
        assert_eq!(imported.entries[0].url, "https://example.com");
        assert_eq!(imported.entries[0].title.as_deref(), Some("Example"));
        assert_eq!(imported.entries[0].visited_at, unix_ms as f64);
        assert_eq!(imported.entries[0].visit_count, 7);
    }

    #[test]
    fn rejects_profile_traversal_and_symlink_escapes() {
        let temp = tempdir().expect("tempdir");
        fs::create_dir(temp.path().join("Default")).expect("profile");
        fs::write(temp.path().join("Default/History"), []).expect("History");

        assert!(matches!(
            import_history(temp.path(), "../Default"),
            Err(ArgmaxError::InvalidInput { .. })
        ));

        #[cfg(unix)]
        {
            use std::os::unix::fs::symlink;

            let outside = tempdir().expect("outside tempdir");
            fs::create_dir(outside.path().join("Escaped")).expect("outside profile");
            fs::write(outside.path().join("Escaped/History"), []).expect("outside History");
            symlink(
                outside.path().join("Escaped"),
                temp.path().join("Profile 1"),
            )
            .expect("profile symlink");
            assert!(matches!(
                import_history(temp.path(), "Profile 1"),
                Err(ArgmaxError::InvalidInput { .. })
            ));
        }
    }

    #[test]
    fn rejects_visit_counts_outside_the_wire_type() {
        let temp = tempdir().expect("tempdir");
        let profile = temp.path().join("Default");
        fs::create_dir(&profile).expect("profile");
        let connection = create_history(&profile.join("History"));
        connection
            .execute(
                "INSERT INTO urls (url, title, visit_count, last_visit_time, hidden)
                 VALUES (?1, ?2, ?3, ?4, 0)",
                params![
                    "https://invalid.example",
                    "Invalid",
                    -1_i64,
                    CHROME_TO_UNIX_EPOCH_MICROS
                ],
            )
            .expect("insert malformed row");

        assert!(matches!(
            import_history(temp.path(), "Default"),
            Err(ArgmaxError::ServiceError { sub_code, .. })
                if sub_code == "CHROME_HISTORY_INVALID_VISIT_COUNT"
        ));
    }

    #[test]
    fn caps_entries_at_the_newest_ten_thousand_and_reports_all_available() {
        let temp = tempdir().expect("tempdir");
        let profile = temp.path().join("Default");
        fs::create_dir(&profile).expect("profile");
        let mut connection = create_history(&profile.join("History"));
        let transaction = connection.transaction().expect("write transaction");
        {
            let mut insert = transaction
                .prepare(
                    "INSERT INTO urls (url, title, visit_count, last_visit_time, hidden)
                     VALUES (?1, NULL, 1, ?2, 0)",
                )
                .expect("prepare insert");
            for index in 0..=MAX_IMPORTED_ENTRIES {
                insert
                    .execute(params![
                        format!("https://example.com/{index}"),
                        CHROME_TO_UNIX_EPOCH_MICROS + index as i64
                    ])
                    .expect("insert history row");
            }
        }
        transaction.commit().expect("commit history rows");

        let imported = import_history(temp.path(), "Default").expect("import history");
        assert_eq!(imported.total_available, 10_001);
        assert_eq!(imported.entries.len(), MAX_IMPORTED_ENTRIES);
        assert_eq!(imported.entries[0].url, "https://example.com/10000");
        assert_eq!(
            imported.entries.last().map(|entry| entry.url.as_str()),
            Some("https://example.com/1")
        );
    }
}
