use rusqlite::{Connection, Row};
use serde::Serialize;

use super::prepared::prepared;
use crate::error::{ArgmaxError, ArgmaxResult};

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSettings {
    pub default_provider: String,
    pub default_model_label: String,
    pub worktree_location: String,
    pub setup_command: String,
    pub check_commands: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectCounts {
    pub active: i64,
    pub blocked: i64,
    pub failed: i64,
    pub review_ready: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
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
        counts: ProjectCounts {
            active: row.get("active_count")?,
            blocked: workspace_blocked + session_blocked,
            failed: workspace_failed + session_failed,
            review_ready: workspace_complete + session_review_ready,
        },
        latest_activity_at: max_nullable_iso(workspace_latest, session_latest).or(updated_at),
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
