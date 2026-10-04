// Named linked repositories: other checkouts on this machine a project's
// agents may read and edit (docs/memory.md#linked-repositories). They are not
// project sources: a source is a project-relative file or URL, while a linked
// repository is a canonical directory root with a name an agent can address.
//
// The stored `root_path` is canonical and is the allowlist. Nothing that holds
// one may attach a filesystem watcher to it: Argmax reads these roots on
// demand and never observes them.

use std::path::{Path, PathBuf};

use rusqlite::{Connection, Row};
use serde::{Deserialize, Serialize};
use specta::Type;
use uuid::Uuid;

use super::{sqlite_error, time::now_iso};
use crate::error::{ArgmaxError, ArgmaxResult, InvalidInputIssue};

pub const MAX_LINKED_REPOS_PER_PROJECT: i64 = 10;
pub const MAX_LINKED_REPO_NAME_CHARS: usize = 40;
pub const MAX_LINKED_REPO_SUMMARY_CHARS: usize = 600;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct LinkedRepo {
    pub id: String,
    pub project_id: String,
    /// The handle an agent passes as `linked_repo`. Unique within the project.
    pub name: String,
    /// Canonical absolute directory, resolved when the root was added.
    pub root_path: String,
    #[serde(default)]
    pub summary: Option<String>,
    pub enabled: bool,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LinkedRepoInput {
    /// Defaults to the directory's name.
    #[serde(default)]
    pub name: Option<String>,
    pub path: String,
}

pub fn list_linked_repos(
    connection: &Connection,
    project_id: &str,
) -> ArgmaxResult<Vec<LinkedRepo>> {
    let mut statement = connection
        .prepare_cached(&format!(
            "SELECT {COLUMNS} FROM project_linked_repos WHERE project_id = ? \
             ORDER BY name ASC, id ASC"
        ))
        .map_err(sqlite_error)?;
    let rows = statement
        .query_map([project_id], row_to_linked_repo)
        .map_err(sqlite_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(sqlite_error)?;
    Ok(rows)
}

/// What a launch hands the provider: the roots the user has left switched on.
pub fn list_enabled_linked_repos(
    connection: &Connection,
    project_id: &str,
) -> ArgmaxResult<Vec<LinkedRepo>> {
    Ok(list_linked_repos(connection, project_id)?
        .into_iter()
        .filter(|repo| repo.enabled)
        .collect())
}

pub fn find_linked_repo_by_name(
    connection: &Connection,
    project_id: &str,
    name: &str,
) -> ArgmaxResult<LinkedRepo> {
    let mut statement = connection
        .prepare_cached(&format!(
            "SELECT {COLUMNS} FROM project_linked_repos WHERE project_id = ? AND name = ?"
        ))
        .map_err(sqlite_error)?;
    match statement.query_row((project_id, name), row_to_linked_repo) {
        Ok(repo) => Ok(repo),
        Err(rusqlite::Error::QueryReturnedNoRows) => Err(ArgmaxError::service(
            "LINKED_REPO_NOT_FOUND",
            format!("This project has no linked repository named '{name}'."),
        )),
        Err(error) => Err(sqlite_error(error)),
    }
}

pub fn add_linked_repo(
    connection: &Connection,
    project_id: &str,
    input: &LinkedRepoInput,
) -> ArgmaxResult<LinkedRepo> {
    let repo_path: String = connection
        .query_row(
            "SELECT repo_path FROM projects WHERE id = ?",
            [project_id],
            |row| row.get(0),
        )
        .map_err(|error| match error {
            rusqlite::Error::QueryReturnedNoRows => {
                ArgmaxError::record_not_found("project", project_id)
            }
            other => sqlite_error(other),
        })?;
    let root = canonical_root(&repo_path, &input.path)?;
    let name = match input
        .name
        .as_deref()
        .map(str::trim)
        .filter(|n| !n.is_empty())
    {
        Some(name) => {
            validate_name(name)?;
            name.to_owned()
        }
        None => name_from_root(connection, project_id, &root)?,
    };
    let count: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM project_linked_repos WHERE project_id = ?",
            [project_id],
            |row| row.get(0),
        )
        .map_err(sqlite_error)?;
    if count >= MAX_LINKED_REPOS_PER_PROJECT {
        return Err(ArgmaxError::service(
            "LINKED_REPO_LIMIT",
            format!("A project can link at most {MAX_LINKED_REPOS_PER_PROJECT} repositories."),
        ));
    }
    let root_text = root.to_string_lossy().into_owned();
    let id = Uuid::new_v4().to_string();
    let now = now_iso();
    connection
        .prepare_cached(
            "INSERT INTO project_linked_repos \
             (id, project_id, name, root_path, enabled, created_at, updated_at) \
             VALUES (?, ?, ?, ?, 1, ?, ?)",
        )
        .map_err(sqlite_error)?
        .execute((&id, project_id, &name, &root_text, &now, &now))
        .map_err(|error| map_insert_error(error, &name, &root_text))?;
    find_linked_repo_by_id(connection, project_id, &id)
}

pub fn set_linked_repo_enabled(
    connection: &Connection,
    project_id: &str,
    id: &str,
    enabled: bool,
) -> ArgmaxResult<LinkedRepo> {
    let changes = connection
        .prepare_cached(
            "UPDATE project_linked_repos SET enabled = ?, updated_at = ? \
             WHERE project_id = ? AND id = ?",
        )
        .map_err(sqlite_error)?
        .execute((enabled, now_iso(), project_id, id))
        .map_err(sqlite_error)?;
    if changes == 0 {
        return Err(ArgmaxError::record_not_found("linked repository", id));
    }
    find_linked_repo_by_id(connection, project_id, id)
}

pub fn set_linked_repo_summary(
    connection: &Connection,
    project_id: &str,
    id: &str,
    summary: &str,
) -> ArgmaxResult<LinkedRepo> {
    if summary.trim().is_empty() {
        return Err(ArgmaxError::invalid(InvalidInputIssue::at(
            vec!["summary".to_owned()],
            "LINKED_REPO_SUMMARY_REQUIRED",
            "A linked repository summary cannot be blank.",
        )));
    }
    if summary.chars().count() > MAX_LINKED_REPO_SUMMARY_CHARS {
        return Err(ArgmaxError::invalid(InvalidInputIssue::at(
            vec!["summary".to_owned()],
            "LINKED_REPO_SUMMARY_TOO_LONG",
            format!("A linked repository summary has at most {MAX_LINKED_REPO_SUMMARY_CHARS} characters."),
        )));
    }
    let changes = connection
        .prepare_cached(
            "UPDATE project_linked_repos SET summary = ?, updated_at = ? \
             WHERE project_id = ? AND id = ?",
        )
        .map_err(sqlite_error)?
        .execute((summary, now_iso(), project_id, id))
        .map_err(sqlite_error)?;
    if changes == 0 {
        return Err(ArgmaxError::record_not_found("linked repository", id));
    }
    find_linked_repo_by_id(connection, project_id, id)
}

pub fn delete_linked_repo(connection: &Connection, project_id: &str, id: &str) -> ArgmaxResult<()> {
    let changes = connection
        .prepare_cached("DELETE FROM project_linked_repos WHERE project_id = ? AND id = ?")
        .map_err(sqlite_error)?
        .execute((project_id, id))
        .map_err(sqlite_error)?;
    if changes == 0 {
        return Err(ArgmaxError::record_not_found("linked repository", id));
    }
    Ok(())
}

pub fn find_linked_repo_by_id(
    connection: &Connection,
    project_id: &str,
    id: &str,
) -> ArgmaxResult<LinkedRepo> {
    connection
        .prepare_cached(&format!(
            "SELECT {COLUMNS} FROM project_linked_repos WHERE project_id = ? AND id = ?"
        ))
        .map_err(sqlite_error)?
        .query_row((project_id, id), row_to_linked_repo)
        .map_err(|error| match error {
            rusqlite::Error::QueryReturnedNoRows => {
                ArgmaxError::record_not_found("linked repository", id)
            }
            other => sqlite_error(other),
        })
}

/// Resolves a user-supplied directory to the canonical root that gets stored.
/// The project's own checkout is refused in both directions: the agent already
/// works there, and a root that contains or sits inside it would let a "linked"
/// read reach files the project's own paths already govern.
fn canonical_root(project_repo_path: &str, candidate: &str) -> ArgmaxResult<PathBuf> {
    let candidate = candidate.trim();
    if candidate.is_empty() || candidate.contains('\0') {
        return Err(invalid_root(
            "LINKED_REPO_PATH_REQUIRED",
            "Choose a directory to link.",
        ));
    }
    let path = Path::new(candidate);
    if !path.is_absolute() {
        return Err(invalid_root(
            "LINKED_REPO_PATH_RELATIVE",
            "A linked repository path must be absolute.",
        ));
    }
    let root = path.canonicalize().map_err(|error| {
        invalid_root(
            "LINKED_REPO_PATH_MISSING",
            format!("Cannot resolve {candidate}: {error}"),
        )
    })?;
    if !root.is_dir() {
        return Err(invalid_root(
            "LINKED_REPO_NOT_A_DIRECTORY",
            format!("{} is not a directory.", root.display()),
        ));
    }
    // The filesystem root, the home folder, and anything that contains the home
    // folder (`/Users`, `/home`) are not repositories.
    if root.parent().is_none() || home_directory().is_some_and(|home| home.starts_with(&root)) {
        return Err(invalid_root(
            "LINKED_REPO_TOO_BROAD",
            "Link a repository directory, not the filesystem root or your home folder.",
        ));
    }
    if let Ok(project_root) = Path::new(project_repo_path).canonicalize() {
        if root.starts_with(&project_root) || project_root.starts_with(&root) {
            return Err(invalid_root(
                "LINKED_REPO_OVERLAPS_PROJECT",
                "A linked repository cannot be, contain, or sit inside the project's own checkout.",
            ));
        }
    }
    Ok(root)
}

fn home_directory() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .and_then(|home| home.canonicalize().ok())
}

/// Lowercase letters, digits, `-`, `_` and `.`, starting with a letter or
/// digit. The name travels in tool arguments and prompt text, so it stays
/// plain.
pub fn validate_name(name: &str) -> ArgmaxResult<()> {
    let valid = !name.is_empty()
        && name.chars().count() <= MAX_LINKED_REPO_NAME_CHARS
        && name.starts_with(|c: char| c.is_ascii_lowercase() || c.is_ascii_digit())
        && name
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, '-' | '_' | '.'));
    if valid {
        return Ok(());
    }
    Err(ArgmaxError::invalid(InvalidInputIssue::at(
        vec!["name".to_owned()],
        "LINKED_REPO_NAME_INVALID",
        format!(
            "A linked repository name uses lowercase letters, digits, '-', '_' and '.', starts \
             with a letter or digit, and has at most {MAX_LINKED_REPO_NAME_CHARS} characters."
        ),
    )))
}

fn name_from_root(connection: &Connection, project_id: &str, root: &Path) -> ArgmaxResult<String> {
    let base = root
        .file_name()
        .map(|name| name.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_default();
    let cleaned: String = base
        .chars()
        .map(|c| {
            if c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, '-' | '_' | '.') {
                c
            } else {
                '-'
            }
        })
        .collect();
    let cleaned: String = cleaned
        .trim_start_matches(|c: char| !(c.is_ascii_lowercase() || c.is_ascii_digit()))
        .chars()
        .take(MAX_LINKED_REPO_NAME_CHARS)
        .collect();
    let base = if cleaned.is_empty() {
        "repository".to_owned()
    } else {
        cleaned
    };
    let existing = list_linked_repos(connection, project_id)?;
    let mut name = base.clone();
    let mut next_suffix = 2;
    while existing.iter().any(|repo| repo.name == name) {
        let suffix = format!("-{next_suffix}");
        // The sanitized base is ASCII, so byte and character limits agree.
        let prefix = &base[..base.len().min(MAX_LINKED_REPO_NAME_CHARS - suffix.len())];
        name = format!("{prefix}{suffix}");
        next_suffix += 1;
    }
    Ok(name)
}

fn invalid_root(code: &'static str, message: impl Into<String>) -> ArgmaxError {
    ArgmaxError::invalid(InvalidInputIssue::at(
        vec!["path".to_owned()],
        code,
        message,
    ))
}

fn map_insert_error(error: rusqlite::Error, name: &str, root: &str) -> ArgmaxError {
    if error
        .sqlite_error()
        .is_some_and(|details| details.extended_code == rusqlite::ffi::SQLITE_CONSTRAINT_UNIQUE)
    {
        // Two unique constraints (name, root) share one error code. The
        // message names both, which is the whole diagnosis for a user.
        return ArgmaxError::service(
            "LINKED_REPO_CONFLICT",
            format!(
                "This project already links a repository named '{name}' or the directory {root}."
            ),
        );
    }
    sqlite_error(error)
}

const COLUMNS: &str = "id, project_id, name, root_path, enabled, created_at, updated_at, summary";

fn row_to_linked_repo(row: &Row<'_>) -> rusqlite::Result<LinkedRepo> {
    Ok(LinkedRepo {
        id: row.get(0)?,
        project_id: row.get(1)?,
        name: row.get(2)?,
        root_path: row.get(3)?,
        enabled: row.get::<_, i64>(4)? == 1,
        created_at: row.get(5)?,
        updated_at: row.get(6)?,
        summary: row.get(7)?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::persistence::database::Database;
    use crate::persistence::projects::{persist_project, PersistProjectInput, ProjectSettings};
    use tempfile::TempDir;

    fn database(repo_path: &Path) -> Database {
        let database = Database::open_in_memory().unwrap();
        persist_project(
            &database.connection(),
            &PersistProjectInput {
                id: "p1".to_owned(),
                name: "p1".to_owned(),
                repo_path: repo_path.to_string_lossy().into_owned(),
                current_branch: "main".to_owned(),
                default_branch: Some("main".to_owned()),
                settings: ProjectSettings {
                    worktree_location: "/tmp/worktrees".to_owned(),
                    setup_command: String::new(),
                    check_commands: Vec::new(),
                    archive_on_merge: false,
                },
            },
        )
        .unwrap();
        database
    }

    fn input(name: Option<&str>, path: &Path) -> LinkedRepoInput {
        LinkedRepoInput {
            name: name.map(str::to_owned),
            path: path.to_string_lossy().into_owned(),
        }
    }

    fn code(error: ArgmaxError) -> String {
        match error {
            ArgmaxError::InvalidInput { issues } => issues[0].code.to_owned(),
            ArgmaxError::ServiceError { sub_code, .. } => sub_code,
            other => panic!("unexpected error {other:?}"),
        }
    }

    #[test]
    fn adds_a_canonical_root_with_a_derived_name_and_toggles_it() {
        let project = TempDir::new().unwrap();
        let sibling = TempDir::new().unwrap();
        let database = database(project.path());
        let connection = database.connection();
        // A path with a `.` segment still stores the canonical form.
        let spelled = sibling.path().join(".");
        let repo = add_linked_repo(&connection, "p1", &input(None, &spelled)).unwrap();
        assert_eq!(
            repo.root_path,
            sibling.path().canonicalize().unwrap().to_string_lossy()
        );
        assert!(repo.enabled);
        assert_eq!(repo.summary, None);
        assert!(validate_name(&repo.name).is_ok());

        let off = set_linked_repo_enabled(&connection, "p1", &repo.id, false).unwrap();
        assert!(!off.enabled);
        assert!(list_enabled_linked_repos(&connection, "p1")
            .unwrap()
            .is_empty());
        assert_eq!(list_linked_repos(&connection, "p1").unwrap().len(), 1);

        delete_linked_repo(&connection, "p1", &repo.id).unwrap();
        assert!(list_linked_repos(&connection, "p1").unwrap().is_empty());
    }

    #[test]
    fn rejects_bad_roots_with_a_specific_code() {
        let project = TempDir::new().unwrap();
        let other = TempDir::new().unwrap();
        let file = other.path().join("a.txt");
        std::fs::write(&file, "x").unwrap();
        let nested = project.path().join("inner");
        std::fs::create_dir(&nested).unwrap();
        let database = database(project.path());
        let connection = database.connection();
        let add = |path: &str| {
            add_linked_repo(
                &connection,
                "p1",
                &LinkedRepoInput {
                    name: Some("ref".to_owned()),
                    path: path.to_owned(),
                },
            )
            .map(|_| ())
            .map_err(code)
        };
        assert_eq!(
            add("relative/dir").unwrap_err(),
            "LINKED_REPO_PATH_RELATIVE"
        );
        assert_eq!(
            add("/definitely/not/here").unwrap_err(),
            "LINKED_REPO_PATH_MISSING"
        );
        assert_eq!(
            add(&file.to_string_lossy()).unwrap_err(),
            "LINKED_REPO_NOT_A_DIRECTORY"
        );
        assert_eq!(add("/").unwrap_err(), "LINKED_REPO_TOO_BROAD");
        // The home folder and what contains it (`/Users`) are too broad too.
        if let Some(home) = home_directory() {
            assert_eq!(
                add(&home.to_string_lossy()).unwrap_err(),
                "LINKED_REPO_TOO_BROAD"
            );
            if let Some(above) = home.parent() {
                assert_eq!(
                    add(&above.to_string_lossy()).unwrap_err(),
                    "LINKED_REPO_TOO_BROAD"
                );
            }
        }
        assert_eq!(
            add(&project.path().to_string_lossy()).unwrap_err(),
            "LINKED_REPO_OVERLAPS_PROJECT"
        );
        assert_eq!(
            add(&nested.to_string_lossy()).unwrap_err(),
            "LINKED_REPO_OVERLAPS_PROJECT"
        );
        let parent = project.path().parent().unwrap();
        assert_eq!(
            add(&parent.to_string_lossy()).unwrap_err(),
            "LINKED_REPO_OVERLAPS_PROJECT"
        );
    }

    #[test]
    fn rejects_duplicate_names_and_roots_and_invalid_names() {
        let project = TempDir::new().unwrap();
        let first = TempDir::new().unwrap();
        let second = TempDir::new().unwrap();
        let database = database(project.path());
        let connection = database.connection();
        add_linked_repo(&connection, "p1", &input(Some("docs"), first.path())).unwrap();
        let same_name =
            add_linked_repo(&connection, "p1", &input(Some("docs"), second.path())).unwrap_err();
        assert_eq!(code(same_name), "LINKED_REPO_CONFLICT");
        let same_root =
            add_linked_repo(&connection, "p1", &input(Some("other"), first.path())).unwrap_err();
        assert_eq!(code(same_root), "LINKED_REPO_CONFLICT");
        for bad in ["Docs", "-docs", "a b", "a/b", ""] {
            let name = if bad.is_empty() { Some(" ") } else { Some(bad) };
            let result = add_linked_repo(&connection, "p1", &input(name, second.path()));
            // A blank name falls back to the directory name; the rest are rejected.
            if bad.is_empty() {
                assert!(result.is_ok());
            } else {
                assert_eq!(
                    code(result.unwrap_err()),
                    "LINKED_REPO_NAME_INVALID",
                    "{bad}"
                );
            }
        }
    }

    #[test]
    fn lookup_by_name_names_the_missing_repository() {
        let project = TempDir::new().unwrap();
        let database = database(project.path());
        let error = find_linked_repo_by_name(&database.connection(), "p1", "nope").unwrap_err();
        assert_eq!(code(error), "LINKED_REPO_NOT_FOUND");
    }

    #[test]
    fn picker_selections_with_duplicate_basenames_get_unique_bounded_names() {
        let project = TempDir::new().unwrap();
        let siblings = TempDir::new().unwrap();
        let database = database(project.path());
        let connection = database.connection();
        for base in ["api".to_owned(), "a".repeat(MAX_LINKED_REPO_NAME_CHARS)] {
            for (index, suffix) in [(1, ""), (2, "-2"), (3, "-3")] {
                let root = siblings.path().join(format!("org-{index}")).join(&base);
                std::fs::create_dir_all(&root).unwrap();
                let repo = add_linked_repo(&connection, "p1", &input(None, &root)).unwrap();
                let prefix = &base[..base.len().min(MAX_LINKED_REPO_NAME_CHARS - suffix.len())];
                assert_eq!(repo.name, format!("{prefix}{suffix}"));
                assert!(validate_name(&repo.name).is_ok());
                assert_eq!(
                    code(add_linked_repo(&connection, "p1", &input(None, &root)).unwrap_err()),
                    "LINKED_REPO_CONFLICT"
                );
            }
        }
    }

    #[test]
    fn picker_selections_without_ascii_names_get_usable_fallbacks() {
        let project = TempDir::new().unwrap();
        let siblings = TempDir::new().unwrap();
        let database = database(project.path());
        let connection = database.connection();
        for (base, expected_name) in [("資料", "repository"), ("日本語", "repository-2")] {
            let root = siblings.path().join(base);
            std::fs::create_dir_all(&root).unwrap();
            let repo = add_linked_repo(&connection, "p1", &input(None, &root)).unwrap();
            assert_eq!(repo.name, expected_name);
            assert_eq!(
                repo.root_path,
                root.canonicalize().unwrap().to_string_lossy()
            );
        }
    }

    #[test]
    fn summary_updates_roundtrip_and_are_scoped_to_the_project() {
        let project = TempDir::new().unwrap();
        let sibling = TempDir::new().unwrap();
        let database = database(project.path());
        let connection = database.connection();
        let repo =
            add_linked_repo(&connection, "p1", &input(Some("shared"), sibling.path())).unwrap();
        assert!(matches!(
            find_linked_repo_by_id(&connection, "other-project", &repo.id),
            Err(ArgmaxError::RecordNotFound { .. })
        ));
        assert!(matches!(
            set_linked_repo_summary(&connection, "other-project", &repo.id, "Wrong project"),
            Err(ArgmaxError::RecordNotFound { .. })
        ));
        assert_eq!(
            find_linked_repo_by_id(&connection, "p1", &repo.id)
                .unwrap()
                .summary,
            None
        );

        let summary = "Shared Rust API contracts for the desktop and phone apps.";
        let updated = set_linked_repo_summary(&connection, "p1", &repo.id, summary).unwrap();
        assert_eq!(updated.summary.as_deref(), Some(summary));
        assert_eq!(
            find_linked_repo_by_name(&connection, "p1", "shared").unwrap(),
            updated
        );
        assert_eq!(
            list_enabled_linked_repos(&connection, "p1").unwrap(),
            vec![updated]
        );
    }

    #[test]
    fn summary_rejects_blank_and_oversize_values_without_replacing_stored_context() {
        let project = TempDir::new().unwrap();
        let sibling = TempDir::new().unwrap();
        let database = database(project.path());
        let connection = database.connection();
        let repo =
            add_linked_repo(&connection, "p1", &input(Some("shared"), sibling.path())).unwrap();
        let summary = "é".repeat(MAX_LINKED_REPO_SUMMARY_CHARS);
        set_linked_repo_summary(&connection, "p1", &repo.id, &summary).unwrap();
        for blank in ["", " \n\t"] {
            assert_eq!(
                code(set_linked_repo_summary(&connection, "p1", &repo.id, blank).unwrap_err()),
                "LINKED_REPO_SUMMARY_REQUIRED"
            );
        }
        assert_eq!(
            code(
                set_linked_repo_summary(&connection, "p1", &repo.id, &format!("{summary}é"))
                    .unwrap_err()
            ),
            "LINKED_REPO_SUMMARY_TOO_LONG"
        );
        assert_eq!(
            find_linked_repo_by_id(&connection, "p1", &repo.id)
                .unwrap()
                .summary,
            Some(summary)
        );
    }
}
