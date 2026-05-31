use rusqlite::{named_params, Connection, Row};
use serde::Serialize;
use specta::Type;

use super::prepared::prepared;
use super::time::now_iso;
use crate::error::{ArgmaxError, ArgmaxResult};

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
    pub default_provider: String,
    pub default_model_label: String,
    pub worktree_location: String,
    pub setup_command: String,
    pub check_commands: Vec<String>,
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
    pub counts: ProjectCounts,
    pub latest_activity_at: Option<String>,
}

pub fn list_projects(connection: &Connection) -> ArgmaxResult<Vec<ProjectSummary>> {
    let mut statement = prepared(
        connection,
        r#"
        SELECT
          p.*,
          COALESCE(ws.active_count,         0) AS active_count,
          COALESCE(ws.workspace_blocked,    0) AS workspace_blocked,
          COALESCE(ws.workspace_failed,     0) AS workspace_failed,
          COALESCE(ws.workspace_complete,   0) AS workspace_complete,
          COALESCE(ss.session_blocked,      0) AS session_blocked,
          COALESCE(ss.session_failed,       0) AS session_failed,
          COALESCE(ss.session_review_ready, 0) AS session_review_ready,
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
            SUM(CASE WHEN s.attention = 'blocked'      THEN 1 ELSE 0 END) AS session_blocked,
            SUM(CASE WHEN s.attention = 'failed'       THEN 1 ELSE 0 END) AS session_failed,
            SUM(CASE WHEN s.attention = 'review-ready' THEN 1 ELSE 0 END) AS session_review_ready,
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
    let mut statement = prepared(
        connection,
        r#"
        INSERT INTO projects (
          id, name, repo_path, current_branch, default_branch, default_provider,
          default_model_label, worktree_location, setup_command, check_commands_json,
          ui_preferences_json, created_at, updated_at
        ) VALUES (
          @id, @name, @repo_path, @current_branch, @default_branch, @default_provider,
          @default_model_label, @worktree_location, @setup_command, @check_commands_json,
          '{}', @created_at, @updated_at
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
            "@default_provider": input.settings.default_provider,
            "@default_model_label": input.settings.default_model_label,
            "@worktree_location": input.settings.worktree_location,
            "@setup_command": input.settings.setup_command,
            "@check_commands_json": check_commands_json,
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
    let mut statement = prepared(
        connection,
        r#"
        UPDATE projects
        SET
          default_provider = @default_provider,
          default_model_label = @default_model_label,
          worktree_location = @worktree_location,
          setup_command = @setup_command,
          check_commands_json = @check_commands_json,
          updated_at = @updated_at
        WHERE id = @project_id
        "#,
    )
    .map_err(sqlite_error)?;
    statement
        .execute(named_params! {
            "@project_id": project_id,
            "@default_provider": settings.default_provider,
            "@default_model_label": settings.default_model_label,
            "@worktree_location": settings.worktree_location,
            "@setup_command": settings.setup_command,
            "@check_commands_json": check_commands_json,
            "@updated_at": now_iso(),
        })
        .map_err(sqlite_error)?;
    require_project(connection, project_id)
}

pub fn update_project_branch(
    connection: &Connection,
    project_id: &str,
    branch: &str,
) -> ArgmaxResult<ProjectSummary> {
    let mut statement = prepared(
        connection,
        "UPDATE projects SET current_branch = ?, updated_at = ? WHERE id = ?",
    )
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
    let mut statement =
        prepared(connection, "SELECT * FROM projects WHERE repo_path = ?").map_err(sqlite_error)?;
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
    let mut statement =
        prepared(connection, "SELECT * FROM projects WHERE id = ?").map_err(sqlite_error)?;
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
    let mut statement =
        prepared(connection, "DELETE FROM projects WHERE id = ?").map_err(sqlite_error)?;
    statement.execute([project_id]).map_err(sqlite_error)?;
    Ok(())
}

pub fn update_project_remote(
    connection: &Connection,
    project_id: &str,
    remote: Option<&ProjectRemote>,
) -> ArgmaxResult<()> {
    let mut statement = prepared(
        connection,
        "UPDATE projects SET repo_remote_owner = ?, repo_remote_name = ?, updated_at = ? WHERE id = ?",
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

pub fn get_project_remote(
    connection: &Connection,
    project_id: &str,
) -> ArgmaxResult<Option<ProjectRemote>> {
    let mut statement = prepared(
        connection,
        "SELECT repo_remote_owner, repo_remote_name FROM projects WHERE id = ?",
    )
    .map_err(sqlite_error)?;
    match statement.query_row([project_id], |row| {
        let owner: Option<String> = row.get("repo_remote_owner")?;
        let name: Option<String> = row.get("repo_remote_name")?;
        Ok((owner, name))
    }) {
        Ok((Some(owner), Some(name))) => Ok(Some(ProjectRemote { owner, name })),
        Ok(_) => Ok(None),
        Err(rusqlite::Error::QueryReturnedNoRows) => {
            Err(ArgmaxError::record_not_found("project", project_id))
        }
        Err(error) => Err(sqlite_error(error)),
    }
}

fn project_row_to_summary(row: &Row<'_>) -> rusqlite::Result<ProjectSummary> {
    let workspace_blocked: i64 = row.get("workspace_blocked")?;
    let session_blocked: i64 = row.get("session_blocked")?;
    let workspace_failed: i64 = row.get("workspace_failed")?;
    let session_failed: i64 = row.get("session_failed")?;
    let workspace_complete: i64 = row.get("workspace_complete")?;
    let session_review_ready: i64 = row.get("session_review_ready")?;
    let workspace_latest: Option<String> = row.get("workspace_latest")?;
    let session_latest: Option<String> = row.get("session_latest")?;
    let updated_at: Option<String> = row.get("updated_at")?;

    let counts = ProjectCounts {
        active: row.get("active_count")?,
        blocked: workspace_blocked + session_blocked,
        failed: workspace_failed + session_failed,
        review_ready: workspace_complete + session_review_ready,
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
            default_provider: row.get("default_provider")?,
            default_model_label: row.get("default_model_label")?,
            worktree_location: row.get("worktree_location")?,
            setup_command: row.get("setup_command")?,
            check_commands: parse_string_array(row.get("check_commands_json")?),
        },
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

fn sqlite_error(error: rusqlite::Error) -> ArgmaxError {
    ArgmaxError::service("SQLITE", error.to_string())
}

fn json_error(error: serde_json::Error) -> ArgmaxError {
    ArgmaxError::service("JSON", error.to_string())
}
