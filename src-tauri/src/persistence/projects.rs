use rusqlite::{named_params, Connection, Row};
use serde::{Deserialize, Serialize};
use specta::Type;
use std::path::Path;

use super::{json_error, sqlite_error, time::now_iso};
use crate::error::{ArgmaxError, ArgmaxResult};

/// Upgrade only the old default setting. Workspace paths are write-once and
/// continue to identify the checkouts that already exist on disk.
pub fn migrate_default_worktree_locations(
    connection: &Connection,
    root: &Path,
) -> ArgmaxResult<usize> {
    let transaction = connection.unchecked_transaction().map_err(sqlite_error)?;
    let first_run = transaction
        .execute(
            "INSERT OR IGNORE INTO data_migrations (name, applied_at) VALUES (?1, ?2)",
            ["external_worktree_locations", now_iso().as_str()],
        )
        .map_err(sqlite_error)?;
    if first_run == 0 {
        return Ok(0);
    }
    let updated = transaction
        .execute(
            "UPDATE projects SET worktree_location = ?1 || '/' || id \
         WHERE worktree_location = repo_path || '/.argmax/worktrees'",
            [root.to_string_lossy().as_ref()],
        )
        .map_err(sqlite_error)?;
    transaction.commit().map_err(sqlite_error)?;
    Ok(updated)
}

#[derive(Debug, Clone, PartialEq)]
pub struct PersistProjectInput {
    pub id: String,
    pub name: String,
    pub repo_path: String,
    pub current_branch: String,
    pub default_branch: Option<String>,
    pub settings: ProjectSettings,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ProjectRemote {
    pub owner: String,
    pub name: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSettings {
    pub worktree_location: String,
    pub setup_command: String,
    pub check_commands: Vec<String>,
    /// What a merged PR does to the isolated workspace on its branch. Off
    /// unless the project opts in.
    pub merge_cleanup: MergeCleanup,
}

/// What the gh poller does to an isolated workspace once the PR on its branch
/// merges. Shared checkouts are never touched, whatever the setting.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "kebab-case")]
pub enum MergeCleanup {
    /// Nothing happens; the sidebar row only shows the merged marker.
    #[default]
    Off,
    /// Archive the workspace: the chat moves to the Archived section and its
    /// checkout and branch are retained in recovery storage.
    Archive,
    /// Remove the checkout, then run PR cleanup: delete the remote and local
    /// branch and fast-forward the base where it is checked out. The chat
    /// stays in its sidebar section and becomes read-only.
    RemoveCheckout,
}

impl MergeCleanup {
    pub fn as_wire(self) -> &'static str {
        match self {
            Self::Off => "off",
            Self::Archive => "archive",
            Self::RemoveCheckout => "remove-checkout",
        }
    }

    pub fn from_wire(value: &str) -> Option<Self> {
        match value {
            "off" => Some(Self::Off),
            "archive" => Some(Self::Archive),
            "remove-checkout" => Some(Self::RemoveCheckout),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ProjectCounts {
    pub active: i64,
    pub blocked: i64,
    pub failed: i64,
    pub review_ready: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSummary {
    pub id: String,
    pub name: String,
    pub repo_path: String,
    pub current_branch: String,
    pub default_branch: Option<String>,
    pub settings: ProjectSettings,
    /// This project's branch template for new isolated workspaces, overriding
    /// the app-wide one. Kept beside `settings` rather than inside it: the
    /// settings form saves through `projects:update-settings`, and this value
    /// has its own validated channel.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub branch_template: Option<String>,
    pub counts: ProjectCounts,
    pub latest_activity_at: Option<String>,
}

pub fn list_projects(connection: &Connection) -> ArgmaxResult<Vec<ProjectSummary>> {
    let mut statement = connection.prepare_cached(r#"
        SELECT
          p.*,
          COALESCE(ws.active_count,         0) AS active_count,
          COALESCE(ws.workspace_blocked,    0) AS workspace_blocked,
          COALESCE(ws.workspace_failed,     0) AS workspace_failed,
          COALESCE(ws.workspace_complete,   0) AS workspace_complete,
          ws.workspace_latest               AS workspace_latest,
          ss.session_latest                 AS session_latest,
          COALESCE(
            NULLIF(max(COALESCE(ws.workspace_latest, ''), COALESCE(ss.session_latest, '')), ''),
            p.updated_at,
            ''
          ) AS latest_sort
        FROM projects p
        LEFT JOIN (
          SELECT
            project_id,
            SUM(CASE WHEN state IN ('created', 'running', 'waiting', 'blocked') THEN 1 ELSE 0 END) AS active_count,
            SUM(CASE WHEN state = 'blocked'  THEN 1 ELSE 0 END) AS workspace_blocked,
            SUM(CASE WHEN state = 'failed'   THEN 1 ELSE 0 END) AS workspace_failed,
            SUM(CASE WHEN state = 'complete' THEN 1 ELSE 0 END) AS workspace_complete,
            MAX(last_activity_at) AS workspace_latest
          FROM workspaces
          GROUP BY project_id
        ) ws ON ws.project_id = p.id
        LEFT JOIN (
          SELECT
            w.project_id AS project_id,
            MAX(s.last_activity_at) AS session_latest
          FROM sessions s
          JOIN workspaces w ON w.id = s.workspace_id
          GROUP BY w.project_id
        ) ss ON ss.project_id = p.id
        ORDER BY latest_sort DESC
        "#,
    )
    .map_err(sqlite_error)?;
    let rows = statement
        .query_map([], project_row_to_summary)
        .map_err(sqlite_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(sqlite_error)?;
    Ok(rows)
}

pub fn persist_project(
    connection: &Connection,
    input: &PersistProjectInput,
) -> ArgmaxResult<ProjectSummary> {
    let timestamp = now_iso();
    let check_commands_json =
        serde_json::to_string(&input.settings.check_commands).map_err(json_error)?;
    let mut statement = connection
        .prepare_cached(
            r#"
        INSERT INTO projects (
          id, name, repo_path, current_branch, default_branch,
          worktree_location, setup_command,
          check_commands_json, merge_cleanup, ui_preferences_json,
          created_at, updated_at
        ) VALUES (
          @id, @name, @repo_path, @current_branch, @default_branch,
          @worktree_location, @setup_command,
          @check_commands_json, @merge_cleanup, '{}',
          @created_at, @updated_at
        )
        ON CONFLICT(repo_path) DO UPDATE SET
          name = excluded.name,
          current_branch = excluded.current_branch,
          default_branch = excluded.default_branch,
          updated_at = excluded.updated_at
        "#,
        )
        .map_err(sqlite_error)?;
    statement
        .execute(named_params! {
            "@id": input.id,
            "@name": input.name,
            "@repo_path": input.repo_path,
            "@current_branch": input.current_branch,
            "@default_branch": input.default_branch,
            "@worktree_location": input.settings.worktree_location,
            "@setup_command": input.settings.setup_command,
            "@check_commands_json": check_commands_json,
            "@merge_cleanup": input.settings.merge_cleanup.as_wire(),
            "@created_at": timestamp,
            "@updated_at": timestamp,
        })
        .map_err(sqlite_error)?;

    require_project_by_repo_path(connection, &input.repo_path)
}

pub fn update_project_settings(
    connection: &Connection,
    project_id: &str,
    settings: &ProjectSettings,
) -> ArgmaxResult<ProjectSummary> {
    let check_commands_json =
        serde_json::to_string(&settings.check_commands).map_err(json_error)?;
    let mut statement = connection
        .prepare_cached(
            r#"
        UPDATE projects
        SET
          worktree_location = @worktree_location,
          setup_command = @setup_command,
          check_commands_json = @check_commands_json,
          merge_cleanup = @merge_cleanup,
          updated_at = @updated_at
        WHERE id = @project_id
        "#,
        )
        .map_err(sqlite_error)?;
    statement
        .execute(named_params! {
            "@project_id": project_id,
            "@worktree_location": settings.worktree_location,
            "@setup_command": settings.setup_command,
            "@check_commands_json": check_commands_json,
            "@merge_cleanup": settings.merge_cleanup.as_wire(),
            "@updated_at": now_iso(),
        })
        .map_err(sqlite_error)?;
    require_project(connection, project_id)
}

/// Sets or clears the project's branch template after validating it.
pub fn set_project_branch_template(
    connection: &Connection,
    project_id: &str,
    template: Option<&str>,
) -> ArgmaxResult<ProjectSummary> {
    if let Some(template) = template {
        crate::workspaces::branch_names::validate_branch_template(template)?;
    }
    let changes = connection
        .prepare_cached("UPDATE projects SET branch_template = ?, updated_at = ? WHERE id = ?")
        .map_err(sqlite_error)?
        .execute((template, now_iso(), project_id))
        .map_err(sqlite_error)?;
    if changes == 0 {
        return Err(ArgmaxError::record_not_found("project", project_id));
    }
    require_project(connection, project_id)
}

/// What a merged pull request should do to this workspace on its own.
/// Resolved from the workspace so the gh poller, which only knows the
/// workspace, does not need a second lookup.
///
/// Isolated workspaces only. The setting exists to stop merged worktrees piling
/// up on disk. A shared checkout is not Argmax's to dispose of: archiving one
/// deletes nothing and would only close a chat the user is still sitting in,
/// so it always reads `Off`.
pub fn workspace_merge_cleanup(
    connection: &Connection,
    workspace_id: &str,
) -> ArgmaxResult<MergeCleanup> {
    let mut statement = connection
        .prepare_cached(
            r#"
        SELECT CASE WHEN w.shared_workspace THEN 'off' ELSE p.merge_cleanup END
        FROM workspaces w
        JOIN projects p ON p.id = w.project_id
        WHERE w.id = ?
        "#,
        )
        .map_err(sqlite_error)?;
    let value = match statement.query_row([workspace_id], |row| row.get::<_, String>(0)) {
        Ok(value) => value,
        Err(rusqlite::Error::QueryReturnedNoRows) => {
            return Err(ArgmaxError::record_not_found("workspace", workspace_id))
        }
        Err(error) => return Err(sqlite_error(error)),
    };
    MergeCleanup::from_wire(&value).ok_or_else(|| {
        ArgmaxError::service(
            "PROJECT_SETTING_INVALID",
            format!("unknown merge cleanup setting {value}"),
        )
    })
}

pub fn update_project_branch(
    connection: &Connection,
    project_id: &str,
    branch: &str,
) -> ArgmaxResult<ProjectSummary> {
    let mut statement = connection
        .prepare_cached("UPDATE projects SET current_branch = ?, updated_at = ? WHERE id = ?")
        .map_err(sqlite_error)?;
    statement
        .execute((branch, now_iso(), project_id))
        .map_err(sqlite_error)?;
    require_project(connection, project_id)
}

pub fn find_project_by_repo_path(
    connection: &Connection,
    repo_path: &str,
) -> ArgmaxResult<Option<ProjectSummary>> {
    let mut statement = connection
        .prepare_cached("SELECT * FROM projects WHERE repo_path = ?")
        .map_err(sqlite_error)?;
    match statement.query_row([repo_path], bare_project_row_to_summary) {
        Ok(project) => Ok(Some(project)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(error) => Err(sqlite_error(error)),
    }
}

pub fn find_project_by_id(
    connection: &Connection,
    project_id: &str,
) -> ArgmaxResult<Option<ProjectSummary>> {
    let mut statement = connection
        .prepare_cached("SELECT * FROM projects WHERE id = ?")
        .map_err(sqlite_error)?;
    match statement.query_row([project_id], bare_project_row_to_summary) {
        Ok(project) => Ok(Some(project)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(error) => Err(sqlite_error(error)),
    }
}

pub fn require_project(connection: &Connection, project_id: &str) -> ArgmaxResult<ProjectSummary> {
    find_project_by_id(connection, project_id)?
        .ok_or_else(|| ArgmaxError::record_not_found("project", project_id))
}

pub fn delete_project(connection: &Connection, project_id: &str) -> ArgmaxResult<()> {
    let mut statement = connection
        .prepare_cached("DELETE FROM projects WHERE id = ?")
        .map_err(sqlite_error)?;
    statement.execute([project_id]).map_err(sqlite_error)?;
    Ok(())
}

pub fn update_project_remote(
    connection: &Connection,
    project_id: &str,
    remote: Option<&ProjectRemote>,
) -> ArgmaxResult<()> {
    let mut statement = connection.prepare_cached("UPDATE projects SET repo_remote_owner = ?, repo_remote_name = ?, updated_at = ? WHERE id = ?",
    )
    .map_err(sqlite_error)?;
    let changes = statement
        .execute((
            remote.map(|value| value.owner.as_str()),
            remote.map(|value| value.name.as_str()),
            now_iso(),
            project_id,
        ))
        .map_err(sqlite_error)?;
    if changes == 0 {
        return Err(ArgmaxError::record_not_found("project", project_id));
    }
    Ok(())
}

pub fn parse_github_remote(url: &str) -> Option<ProjectRemote> {
    let url = url.trim();
    let path = if let Some(stripped) = url.strip_prefix("git@github.com:") {
        stripped
    } else if let Some(stripped) = url.strip_prefix("https://github.com/") {
        stripped
    } else if let Some(stripped) = url.strip_prefix("http://github.com/") {
        stripped
    } else {
        url.strip_prefix("ssh://git@github.com/")?
    };
    let path = path.strip_suffix(".git").unwrap_or(path).trim_matches('/');
    let (owner, name) = path.split_once('/')?;
    if owner.is_empty() || name.is_empty() || name.contains('/') {
        return None;
    }
    Some(ProjectRemote {
        owner: owner.to_string(),
        name: name.to_string(),
    })
}

fn discover_repo_remote(repo_path: &str) -> Option<ProjectRemote> {
    let path = std::path::Path::new(repo_path);
    if !path.exists() {
        return None;
    }
    let output = std::process::Command::new("git")
        .args(["config", "--get", "remote.origin.url"])
        .current_dir(path)
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let url = String::from_utf8_lossy(&output.stdout);
    parse_github_remote(&url)
}

pub fn get_project_remote(
    connection: &Connection,
    project_id: &str,
) -> ArgmaxResult<Option<ProjectRemote>> {
    let mut statement = connection
        .prepare_cached(
            "SELECT repo_path, repo_remote_owner, repo_remote_name FROM projects WHERE id = ?",
        )
        .map_err(sqlite_error)?;
    let (repo_path, remote) = match statement.query_row([project_id], |row| {
        let repo_path: String = row.get("repo_path")?;
        let owner: Option<String> = row.get("repo_remote_owner")?;
        let name: Option<String> = row.get("repo_remote_name")?;
        let remote = match (owner, name) {
            (Some(owner), Some(name)) => Some(ProjectRemote { owner, name }),
            _ => None,
        };
        Ok((repo_path, remote))
    }) {
        Ok(result) => result,
        Err(rusqlite::Error::QueryReturnedNoRows) => {
            return Err(ArgmaxError::record_not_found("project", project_id));
        }
        Err(error) => return Err(sqlite_error(error)),
    };

    if let Some(remote) = remote {
        return Ok(Some(remote));
    }

    if let Some(discovered) = discover_repo_remote(&repo_path) {
        let _ = update_project_remote(connection, project_id, Some(&discovered));
        return Ok(Some(discovered));
    }

    Ok(None)
}

fn project_row_to_summary(row: &Row<'_>) -> rusqlite::Result<ProjectSummary> {
    let workspace_latest: Option<String> = row.get("workspace_latest")?;
    let session_latest: Option<String> = row.get("session_latest")?;
    let updated_at: Option<String> = row.get("updated_at")?;

    // Counted at the workspace grain, like `active`. A session's terminal state
    // is mirrored onto its workspace, so adding the session tally on top would
    // count the same agent twice — and session `attention` is never cleared,
    // so it also keeps counting archived work.
    let counts = ProjectCounts {
        active: row.get("active_count")?,
        blocked: row.get("workspace_blocked")?,
        failed: row.get("workspace_failed")?,
        review_ready: row.get("workspace_complete")?,
    };
    let latest_activity_at = max_nullable_iso(workspace_latest, session_latest).or(updated_at);
    project_summary_from_row(row, counts, latest_activity_at)
}

fn require_project_by_repo_path(
    connection: &Connection,
    repo_path: &str,
) -> ArgmaxResult<ProjectSummary> {
    find_project_by_repo_path(connection, repo_path)?
        .ok_or_else(|| ArgmaxError::service("PROJECT_NOT_PERSISTED", repo_path.to_owned()))
}

fn bare_project_row_to_summary(row: &Row<'_>) -> rusqlite::Result<ProjectSummary> {
    // No JOINed aggregate columns in this query shape, so counts are zero.
    let latest_activity_at = row.get("updated_at")?;
    project_summary_from_row(
        row,
        ProjectCounts {
            active: 0,
            blocked: 0,
            failed: 0,
            review_ready: 0,
        },
        latest_activity_at,
    )
}

/// Shared base mapper for the two project query shapes. The base columns
/// (id/name/repo_path/branches/settings) are identical; counts and
/// latest-activity differ per query, so they're computed by the caller.
fn project_summary_from_row(
    row: &Row<'_>,
    counts: ProjectCounts,
    latest_activity_at: Option<String>,
) -> rusqlite::Result<ProjectSummary> {
    Ok(ProjectSummary {
        id: row.get("id")?,
        name: row.get("name")?,
        repo_path: row.get("repo_path")?,
        current_branch: row.get("current_branch")?,
        default_branch: row.get("default_branch")?,
        settings: ProjectSettings {
            worktree_location: row.get("worktree_location")?,
            setup_command: row.get("setup_command")?,
            check_commands: parse_string_array(row.get("check_commands_json")?),
            merge_cleanup: {
                let value: String = row.get("merge_cleanup")?;
                MergeCleanup::from_wire(&value).ok_or_else(|| {
                    rusqlite::Error::FromSqlConversionFailure(
                        0,
                        rusqlite::types::Type::Text,
                        format!("unknown merge cleanup setting {value}").into(),
                    )
                })?
            },
        },
        branch_template: row.get("branch_template")?,
        counts,
        latest_activity_at,
    })
}

fn parse_string_array(value: String) -> Vec<String> {
    serde_json::from_str::<Vec<String>>(&value).unwrap_or_default()
}

fn max_nullable_iso(left: Option<String>, right: Option<String>) -> Option<String> {
    match (left, right) {
        (Some(left), Some(right)) => Some(if left > right { left } else { right }),
        (Some(left), None) => Some(left),
        (None, Some(right)) => Some(right),
        (None, None) => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_github_remote_handles_ssh_and_https() {
        assert_eq!(
            parse_github_remote("git@github.com:menti/argmax.git"),
            Some(ProjectRemote {
                owner: "menti".to_string(),
                name: "argmax".to_string(),
            })
        );
        assert_eq!(
            parse_github_remote("https://github.com/menti/argmax.git"),
            Some(ProjectRemote {
                owner: "menti".to_string(),
                name: "argmax".to_string(),
            })
        );
        assert_eq!(
            parse_github_remote("https://github.com/menti/argmax"),
            Some(ProjectRemote {
                owner: "menti".to_string(),
                name: "argmax".to_string(),
            })
        );
        assert_eq!(
            parse_github_remote("ssh://git@github.com/menti/argmax.git"),
            Some(ProjectRemote {
                owner: "menti".to_string(),
                name: "argmax".to_string(),
            })
        );
        assert_eq!(parse_github_remote("git@gitlab.com:menti/argmax.git"), None);
        assert_eq!(parse_github_remote(""), None);
    }

    #[test]
    fn a_project_branch_template_is_validated_on_save_and_can_be_cleared() {
        let database = crate::persistence::Database::open_in_memory().expect("db");
        let connection = database.connection();
        let project = persist_project(
            &connection,
            &PersistProjectInput {
                id: "p1".to_owned(),
                name: "p1".to_owned(),
                repo_path: "/tmp/p1".to_owned(),
                current_branch: "main".to_owned(),
                default_branch: Some("main".to_owned()),
                settings: ProjectSettings {
                    worktree_location: "/tmp/w".to_owned(),
                    setup_command: String::new(),
                    check_commands: Vec::new(),
                    merge_cleanup: Default::default(),
                },
            },
        )
        .expect("project");
        assert_eq!(project.branch_template, None);

        let saved = set_project_branch_template(&connection, "p1", Some("adam/{type}-{slug}"))
            .expect("valid template");
        assert_eq!(saved.branch_template.as_deref(), Some("adam/{type}-{slug}"));

        for bad in [
            "adam/{nope}",
            "adam/{slug",
            "adam//{slug}",
            " ",
            "-x/{slug}",
        ] {
            assert!(
                set_project_branch_template(&connection, "p1", Some(bad)).is_err(),
                "{bad}"
            );
        }
        assert_eq!(
            require_project(&connection, "p1")
                .unwrap()
                .branch_template
                .as_deref(),
            Some("adam/{type}-{slug}"),
            "a rejected template leaves the saved one"
        );

        let cleared = set_project_branch_template(&connection, "p1", None).expect("clear");
        assert_eq!(cleared.branch_template, None);
        assert!(set_project_branch_template(&connection, "missing", None).is_err());
    }
}
