use std::path::{Path, PathBuf};

use rusqlite::{Connection, OptionalExtension, Row};
use serde::Serialize;
use specta::Type;
use uuid::Uuid;

use super::projects::{ProjectRemote, ProjectSettings, ProjectSummary};
use super::{sqlite_error, time::now_iso};
use crate::error::{ArgmaxError, ArgmaxResult};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ProjectFolderSummary {
    pub id: String,
    pub project_id: String,
    pub name: String,
    pub root_path: String,
    pub is_primary: bool,
    pub enabled: bool,
    pub summary: Option<String>,
}

pub struct PersistProjectFolderInput {
    pub root_path: String,
    pub current_branch: String,
    pub default_branch: Option<String>,
    pub remote: Option<ProjectRemote>,
    pub settings: ProjectSettings,
}

fn folder_row(row: &Row<'_>) -> rusqlite::Result<ProjectFolderSummary> {
    Ok(ProjectFolderSummary {
        id: row.get("id")?,
        project_id: row.get("project_id")?,
        name: row.get("name")?,
        root_path: row.get("root_path")?,
        is_primary: row.get("is_primary")?,
        enabled: row.get("enabled")?,
        summary: row.get("summary")?,
    })
}

pub fn list_project_folders(
    connection: &Connection,
    project_id: &str,
) -> ArgmaxResult<Vec<ProjectFolderSummary>> {
    super::projects::require_project(connection, project_id)?;
    let mut statement = connection.prepare_cached(
        "SELECT id, project_id, name, root_path, is_primary, enabled, summary FROM project_folders \
         WHERE project_id = ? AND removed = 0 ORDER BY is_primary DESC, name, id",
    ).map_err(sqlite_error)?;
    let folders = statement
        .query_map([project_id], folder_row)
        .map_err(sqlite_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(sqlite_error)?;
    Ok(folders)
}

pub fn require_project_folder(
    connection: &Connection,
    id: &str,
) -> ArgmaxResult<ProjectFolderSummary> {
    connection.query_row(
        "SELECT id, project_id, name, root_path, is_primary, enabled, summary FROM project_folders WHERE id = ?",
        [id], folder_row,
    ).optional().map_err(sqlite_error)?
        .ok_or_else(|| ArgmaxError::record_not_found("project folder", id))
}

pub fn primary_folder_id(
    connection: &Connection,
    project_id: &str,
) -> ArgmaxResult<Option<String>> {
    connection
        .query_row(
            "SELECT id FROM project_folders WHERE project_id = ? AND is_primary = 1",
            [project_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(sqlite_error)
}

pub fn project_for_folder(
    connection: &Connection,
    folder_id: &str,
) -> ArgmaxResult<ProjectSummary> {
    let folder = require_project_folder(connection, folder_id)?;
    let mut project = super::projects::require_project(connection, &folder.project_id)?;
    connection.query_row("SELECT current_branch, default_branch, worktree_location, setup_command, check_commands_json, merge_cleanup, branch_template FROM project_folders WHERE id = ?", [folder_id], |row| {
        project.current_branch = row.get(0)?;
        project.default_branch = row.get(1)?;
        project.settings.worktree_location = row.get(2)?;
        project.settings.setup_command = row.get(3)?;
        let commands: String = row.get(4)?;
        project.settings.check_commands = serde_json::from_str(&commands).map_err(|error| rusqlite::Error::FromSqlConversionFailure(4, rusqlite::types::Type::Text, Box::new(error)))?;
        let cleanup: String = row.get(5)?;
        project.settings.merge_cleanup = super::projects::MergeCleanup::from_wire(&cleanup).ok_or_else(|| rusqlite::Error::InvalidParameterName(cleanup))?;
        project.branch_template = row.get(6)?;
        Ok(())
    }).map_err(sqlite_error)?;
    project.repo_path = folder.root_path;
    Ok(project)
}

pub fn project_for_launch(
    connection: &Connection,
    project_id: &str,
    folder_id: Option<&str>,
) -> ArgmaxResult<(ProjectSummary, String)> {
    let folder_id = folder_id
        .map(str::to_owned)
        .or(primary_folder_id(connection, project_id)?)
        .ok_or_else(|| ArgmaxError::record_not_found("project folder", project_id))?;
    let folder = list_project_folders(connection, project_id)?
        .into_iter()
        .find(|folder| folder.id == folder_id)
        .ok_or_else(|| {
            ArgmaxError::service(
                "PROJECT_FOLDER_UNAVAILABLE",
                "That folder is no longer in this project. Choose another folder.",
            )
        })?;
    let path = Path::new(&folder.root_path);
    if !path.is_dir()
        || path
            .symlink_metadata()
            .is_ok_and(|metadata| metadata.file_type().is_symlink())
    {
        return Err(ArgmaxError::service(
            "PROJECT_FOLDER_UNAVAILABLE",
            "That project folder is unavailable or its location changed.",
        ));
    }
    Ok((project_for_folder(connection, &folder.id)?, folder.id))
}

pub fn folder_is_git(root: &str) -> ArgmaxResult<bool> {
    if !Path::new(root).join(".git").exists() {
        return Ok(false);
    }
    crate::git::exec::run_git_text_blocking(
        Path::new(root),
        ["rev-parse", "--is-inside-work-tree"],
        crate::git::exec::GIT_DEFAULT_TIMEOUT,
    )?;
    Ok(true)
}

pub fn update_folder_branch(
    connection: &Connection,
    project_id: &str,
    folder_id: &str,
    branch: &str,
) -> ArgmaxResult<ProjectSummary> {
    connection.execute("UPDATE project_folders SET current_branch = ?1, updated_at = ?2 WHERE id = ?3 AND project_id = ?4 AND removed = 0", (branch, now_iso(), folder_id, project_id)).map_err(sqlite_error)?;
    if primary_folder_id(connection, project_id)?.as_deref() == Some(folder_id) {
        return super::projects::update_project_branch(connection, project_id, branch);
    }
    super::projects::require_project(connection, project_id)
}

pub fn require_workspace_project(
    connection: &Connection,
    workspace_id: &str,
) -> ArgmaxResult<ProjectSummary> {
    let (project_id, folder_id): (String, Option<String>) = connection
        .query_row(
            "SELECT project_id, project_folder_id FROM workspaces WHERE id = ?",
            [workspace_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .map_err(sqlite_error)?;
    match folder_id {
        Some(folder_id) => project_for_folder(connection, &folder_id),
        None => super::projects::require_project(connection, &project_id),
    }
}

pub fn workspace_remote(
    connection: &Connection,
    workspace_id: &str,
) -> ArgmaxResult<Option<ProjectRemote>> {
    let project = require_workspace_project(connection, workspace_id)?;
    let remote = connection.query_row("SELECT f.repo_remote_owner, f.repo_remote_name FROM project_folders f JOIN workspaces w ON w.project_folder_id = f.id WHERE w.id = ?", [workspace_id], |row| {
        Ok((row.get::<_, Option<String>>(0)?, row.get::<_, Option<String>>(1)?))
    }).optional().map_err(sqlite_error)?;
    if let Some((Some(owner), Some(name))) = remote {
        return Ok(Some(ProjectRemote { owner, name }));
    }
    Ok(super::projects::discover_repo_remote(&project.repo_path))
}

pub fn folder_for_checkout(
    connection: &Connection,
    project_id: &str,
    path: &str,
) -> ArgmaxResult<Option<String>> {
    let mut statement = connection.prepare_cached("SELECT id, project_id, name, root_path, is_primary, enabled, summary FROM project_folders WHERE project_id = ? ORDER BY removed, is_primary DESC, id").map_err(sqlite_error)?;
    let folders = statement
        .query_map([project_id], folder_row)
        .map_err(sqlite_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(sqlite_error)?;
    let checkout = Path::new(path)
        .canonicalize()
        .unwrap_or_else(|_| PathBuf::from(path));
    if let Some(folder) = folders
        .iter()
        .find(|folder| Path::new(&folder.root_path) == checkout)
    {
        return Ok(Some(folder.id.clone()));
    }
    let existing: Option<String> = connection.query_row("SELECT project_folder_id FROM workspaces WHERE project_id = ? AND path = ? AND project_folder_id IS NOT NULL ORDER BY created_at LIMIT 1", (project_id, path), |row| row.get(0)).optional().map_err(sqlite_error)?;
    if existing.is_some() {
        return Ok(existing);
    }
    let common = git_common_directory(&checkout);
    if let Some(common) = common {
        let matching = folders
            .into_iter()
            .filter(|folder| {
                git_common_directory(Path::new(&folder.root_path)).as_ref() == Some(&common)
            })
            .collect::<Vec<_>>();
        if matching.len() > 1 {
            return Err(ArgmaxError::service("PROJECT_FOLDER_AMBIGUOUS", "This checkout belongs to several project folders. Start from a folder's own checkout."));
        }
        if let Some(folder) = matching.first() {
            return Ok(Some(folder.id.clone()));
        }
    }
    primary_folder_id(connection, project_id)
}

fn git_common_directory(path: &Path) -> Option<PathBuf> {
    let output = crate::git::exec::run_git_text_blocking(
        path,
        ["rev-parse", "--git-common-dir"],
        crate::git::exec::GIT_DEFAULT_TIMEOUT,
    )
    .ok()?;
    path.join(output.trim()).canonicalize().ok()
}

pub fn configure_project_folders(
    connection: &Connection,
    project_id: &str,
    name: &str,
    folders: &[PersistProjectFolderInput],
    primary_path: &str,
) -> ArgmaxResult<ProjectSummary> {
    let transaction = connection.unchecked_transaction().map_err(sqlite_error)?;
    let project = configure_project_folders_in_transaction(
        &transaction,
        project_id,
        name,
        folders,
        primary_path,
    )?;
    transaction.commit().map_err(sqlite_error)?;
    Ok(project)
}

pub fn configure_project_folders_in_transaction(
    transaction: &Connection,
    project_id: &str,
    name: &str,
    folders: &[PersistProjectFolderInput],
    primary_path: &str,
) -> ArgmaxResult<ProjectSummary> {
    super::projects::require_project(transaction, project_id)?;
    if name.trim().is_empty()
        || !folders
            .iter()
            .any(|folder| folder.root_path == primary_path)
    {
        return Err(ArgmaxError::service(
            "PROJECT_INVALID",
            "A project needs a name and a primary folder from its folders.",
        ));
    }
    let now = now_iso();
    transaction
        .execute(
            "UPDATE project_folders SET is_primary = 0, removed = 1 WHERE project_id = ?",
            [project_id],
        )
        .map_err(sqlite_error)?;
    for folder in folders {
        let id = Uuid::new_v4().to_string();
        let root = Path::new(&folder.root_path);
        let name = super::linked_repos::name_from_root(transaction, project_id, root)?;
        transaction.execute("INSERT INTO project_folders (id, project_id, name, root_path, current_branch, default_branch, repo_remote_owner, repo_remote_name, worktree_location, setup_command, check_commands_json, merge_cleanup, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?13) ON CONFLICT(project_id, root_path) DO UPDATE SET removed = 0, current_branch = excluded.current_branch, default_branch = excluded.default_branch, repo_remote_owner = excluded.repo_remote_owner, repo_remote_name = excluded.repo_remote_name, updated_at = excluded.updated_at", rusqlite::params![id, project_id, name, folder.root_path, folder.current_branch, folder.default_branch, folder.remote.as_ref().map(|remote| &remote.owner), folder.remote.as_ref().map(|remote| &remote.name), folder.settings.worktree_location, folder.settings.setup_command, serde_json::to_string(&folder.settings.check_commands).map_err(super::json_error)?, folder.settings.merge_cleanup.as_wire(), now]).map_err(sqlite_error)?;
    }
    transaction.execute("UPDATE project_folders SET is_primary = 1, enabled = 1 WHERE project_id = ? AND root_path = ?", (project_id, primary_path)).map_err(sqlite_error)?;
    transaction.execute("UPDATE projects SET name = ?1, repo_path = ?2, current_branch = f.current_branch, default_branch = f.default_branch, repo_remote_owner = f.repo_remote_owner, repo_remote_name = f.repo_remote_name, worktree_location = f.worktree_location, setup_command = f.setup_command, check_commands_json = f.check_commands_json, merge_cleanup = f.merge_cleanup, branch_template = f.branch_template, updated_at = ?3 FROM project_folders f WHERE projects.id = ?4 AND f.project_id = projects.id AND f.is_primary = 1", (name.trim(), primary_path, now, project_id)).map_err(sqlite_error)?;
    super::projects::require_project(transaction, project_id)
}

pub fn sync_primary_from_project(connection: &Connection, project_id: &str) -> ArgmaxResult<()> {
    connection.execute("UPDATE project_folders SET current_branch = p.current_branch, default_branch = p.default_branch, repo_remote_owner = p.repo_remote_owner, repo_remote_name = p.repo_remote_name, worktree_location = p.worktree_location, setup_command = p.setup_command, check_commands_json = p.check_commands_json, merge_cleanup = p.merge_cleanup, branch_template = p.branch_template FROM projects p WHERE project_folders.project_id = p.id AND p.id = ? AND is_primary = 1", [project_id]).map_err(sqlite_error)?;
    Ok(())
}

pub fn workspace_tracks_prs(connection: &Connection, workspace_id: &str) -> ArgmaxResult<bool> {
    let supported: Option<bool> = connection.query_row("SELECT w.kind = 'git' AND w.project_folder_id IS p.pr_repository_folder_id FROM workspaces w JOIN projects p ON p.id = w.project_id WHERE w.id = ?", [workspace_id], |row| row.get(0)).optional().map_err(sqlite_error)?;
    Ok(supported.unwrap_or(false))
}

pub fn assert_workspace_pr_repository(
    connection: &Connection,
    workspace_id: &str,
) -> ArgmaxResult<()> {
    if !workspace_tracks_prs(connection, workspace_id)? {
        return Err(ArgmaxError::service("MULTI_REPO_PR_UNSUPPORTED", "This preview tracks pull requests only for the project's original primary repository. Use a separate project to track pull requests for this folder."));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::persistence::{
        database::Database,
        projects::{persist_project, PersistProjectInput},
        workspaces::{persist_workspace, PersistWorkspaceInput},
    };

    fn settings(label: &str) -> ProjectSettings {
        ProjectSettings {
            worktree_location: format!("/tmp/worktrees/{label}"),
            setup_command: label.to_owned(),
            check_commands: vec![format!("check-{label}")],
            merge_cleanup: Default::default(),
        }
    }

    fn project(connection: &Connection, id: &str, root: &str) {
        persist_project(
            connection,
            &PersistProjectInput {
                id: id.to_owned(),
                name: id.to_owned(),
                repo_path: root.to_owned(),
                current_branch: "main".to_owned(),
                default_branch: Some("main".to_owned()),
                settings: settings(id),
            },
        )
        .unwrap();
    }

    fn folder(root: &str, label: &str) -> PersistProjectFolderInput {
        PersistProjectFolderInput {
            root_path: root.to_owned(),
            current_branch: "main".to_owned(),
            default_branch: Some("main".to_owned()),
            remote: None,
            settings: settings(label),
        }
    }

    #[test]
    fn changing_primary_keeps_existing_workspace_folder_and_settings() {
        let database = Database::open_in_memory().unwrap();
        let connection = database.connection();
        project(&connection, "p1", "/not-present/application");
        persist_workspace(
            &connection,
            &PersistWorkspaceInput {
                id: "w1".to_owned(),
                project_id: "p1".to_owned(),
                task_label: "old chat".to_owned(),
                branch: "main".to_owned(),
                base_ref: "main".to_owned(),
                path: "/not-present/application".to_owned(),
                state: "created".to_owned(),
                shared_workspace: true,
                kind: "git".to_owned(),
                dirty: false,
                changed_files: 0,
            },
        )
        .unwrap();
        let configured = configure_project_folders(
            &connection,
            "p1",
            "Analytics",
            &[
                folder("/not-present/application", "unused"),
                folder("/not-present/data", "data"),
            ],
            "/not-present/data",
        )
        .unwrap();
        assert_eq!(configured.repo_path, "/not-present/data");
        assert_eq!(configured.settings.setup_command, "data");
        let original = require_workspace_project(&connection, "w1").unwrap();
        assert_eq!(original.repo_path, "/not-present/application");
        assert_eq!(original.settings.setup_command, "p1");
        assert_eq!(
            super::super::workspaces::find_workspace_by_id(&connection, "w1")
                .unwrap()
                .check_commands,
            Some(vec!["check-p1".to_owned()])
        );
        assert_workspace_pr_repository(&connection, "w1").unwrap();
        persist_workspace(
            &connection,
            &PersistWorkspaceInput {
                id: "w2".to_owned(),
                project_id: "p1".to_owned(),
                task_label: "new chat".to_owned(),
                branch: "main".to_owned(),
                base_ref: "main".to_owned(),
                path: "/not-present/data".to_owned(),
                state: "created".to_owned(),
                shared_workspace: true,
                kind: "git".to_owned(),
                dirty: false,
                changed_files: 0,
            },
        )
        .unwrap();
        for workspace_id in ["w2", "missing"] {
            let error = assert_workspace_pr_repository(&connection, workspace_id).unwrap_err();
            assert!(
                matches!(error, ArgmaxError::ServiceError { sub_code, .. } if sub_code == "MULTI_REPO_PR_UNSUPPORTED")
            );
        }

        configure_project_folders(
            &connection,
            "p1",
            "Analytics",
            &[folder("/not-present/data", "data")],
            "/not-present/data",
        )
        .unwrap();
        assert_eq!(list_project_folders(&connection, "p1").unwrap().len(), 1);
        assert_eq!(
            require_workspace_project(&connection, "w1")
                .unwrap()
                .repo_path,
            "/not-present/application"
        );
    }

    #[test]
    fn configure_reserves_retained_aliases_when_new_primary_comes_first() {
        let database = Database::open_in_memory().unwrap();
        let connection = database.connection();
        project(&connection, "p1", "/one/research");
        configure_project_folders(
            &connection,
            "p1",
            "Research",
            &[folder("/one/research", "old")],
            "/one/research",
        )
        .unwrap();
        connection
            .execute(
                "UPDATE project_folders SET name = 'research' WHERE project_id = 'p1'",
                [],
            )
            .unwrap();
        configure_project_folders(
            &connection,
            "p1",
            "Research",
            &[
                folder("/two/research", "new"),
                folder("/one/research", "old"),
            ],
            "/two/research",
        )
        .unwrap();
        let folders = list_project_folders(&connection, "p1").unwrap();
        assert_eq!(
            folders
                .iter()
                .find(|folder| folder.root_path == "/one/research")
                .unwrap()
                .name,
            "research"
        );
        assert_eq!(
            folders
                .iter()
                .find(|folder| folder.root_path == "/two/research")
                .unwrap()
                .name,
            "research-2"
        );
    }

    #[test]
    fn projects_can_share_a_root_without_merging_their_identities() {
        let database = Database::open_in_memory().unwrap();
        let connection = database.connection();
        project(&connection, "p1", "/not-present/shared");
        project(&connection, "p2", "/not-present/shared");
        assert_eq!(
            super::super::projects::list_projects(&connection)
                .unwrap()
                .len(),
            2
        );
        assert!(super::super::projects::find_project_by_repo_path(
            &connection,
            "/not-present/shared"
        )
        .is_err());
        assert_ne!(
            primary_folder_id(&connection, "p1").unwrap(),
            primary_folder_id(&connection, "p2").unwrap()
        );
    }

    #[test]
    fn pr_remote_stays_on_original_repository_after_primary_changes() {
        let database = Database::open_in_memory().unwrap();
        let connection = database.connection();
        project(&connection, "p1", "/not-present/application");
        let remote = ProjectRemote {
            owner: "owner".to_owned(),
            name: "application".to_owned(),
        };
        super::super::projects::update_project_remote(&connection, "p1", Some(&remote)).unwrap();
        configure_project_folders(
            &connection,
            "p1",
            "Analytics",
            &[
                folder("/not-present/application", "app"),
                folder("/not-present/data", "data"),
            ],
            "/not-present/data",
        )
        .unwrap();
        super::super::projects::update_project_remote(&connection, "p1", Some(&remote)).unwrap();
        assert_eq!(
            super::super::projects::get_project_remote(&connection, "p1").unwrap(),
            Some(remote)
        );
        let current_remote: Option<String> = connection
            .query_row(
                "SELECT repo_remote_name FROM projects WHERE id = 'p1'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(current_remote, None);
    }
}
