//! Registering a local repository as a project. The desktop picker, the remote
//! bridge, and the session-control socket all land here.

use std::path::{Path, PathBuf};

use uuid::Uuid;

use argmax_contracts::error::{ArgmaxError, ArgmaxResult};
use argmax_process::git_exec::{run_git_text, GIT_DEFAULT_TIMEOUT};
use argmax_store::database::Database;
use argmax_store::projects::{
    parse_github_remote, persist_project, PersistProjectInput, ProjectRemote, ProjectSettings,
    ProjectSummary,
};

pub(crate) struct GitMetadata {
    pub(crate) repo_path: PathBuf,
    pub(crate) current_branch: String,
    pub(crate) default_branch: Option<String>,
    pub(crate) remote: Option<ProjectRemote>,
}

/// Add the repository at `candidate_path`, or return the project already
/// registered for it. Takes the database rather than the app state so the
/// session-control socket, which has no `AppState`, can register a repository
/// an agent named for the first time.
pub(crate) async fn register_repo_path(
    database: &Database,
    candidate_path: PathBuf,
) -> ArgmaxResult<ProjectSummary> {
    let canonical_path = canonicalize_repo_path(&candidate_path).await?;
    {
        let connection = database.connection();
        if let Some(project) = argmax_store::projects::find_project_by_repo_path(
            &connection,
            &canonical_path.to_string_lossy(),
        )? {
            return Ok(project);
        }
    }
    let metadata = read_git_metadata(&canonical_path).await?;
    if let Some(default_branch) = metadata.default_branch.as_deref() {
        assert_valid_ref_name(&metadata.repo_path, default_branch).await?;
    }

    let project_id = Uuid::new_v4().to_string();
    let settings = default_settings(&project_id)?;
    let project = PersistProjectInput {
        id: project_id,
        name: metadata
            .repo_path
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("Project")
            .to_string(),
        repo_path: metadata.repo_path.to_string_lossy().to_string(),
        current_branch: metadata.current_branch,
        default_branch: metadata.default_branch,
        settings,
    };

    let project = {
        let connection = database.connection();
        if let Some(existing) =
            argmax_store::projects::find_project_by_repo_path(&connection, &project.repo_path)?
        {
            return Ok(existing);
        }
        persist_project(&connection, &project)?
    };
    let remote = match metadata.remote {
        Some(remote) => Some(remote),
        None => crate::git::ops::resolve_project_remote(&canonical_path).await,
    };
    if let Some(remote) = remote.as_ref() {
        let connection = database.connection();
        let _ =
            argmax_store::projects::update_project_remote(&connection, &project.id, Some(remote));
    }
    Ok(project)
}

pub(crate) async fn canonicalize_repo_path(candidate_path: &Path) -> ArgmaxResult<PathBuf> {
    let resolved = tokio::fs::canonicalize(candidate_path)
        .await
        .map_err(|error| {
            ArgmaxError::service(
                "PROJECT_PATH",
                format!(
                    "Argmax could not resolve {}. {error}",
                    candidate_path.display()
                ),
            )
        })?;
    let metadata = tokio::fs::metadata(&resolved).await.map_err(|error| {
        ArgmaxError::service(
            "PROJECT_PATH",
            format!("Argmax could not stat {}. {error}", resolved.display()),
        )
    })?;
    if !metadata.is_dir() {
        return Err(ArgmaxError::service(
            "PROJECT_PATH",
            format!("{} is not a directory.", resolved.display()),
        ));
    }
    if tokio::fs::metadata(resolved.join(".git")).await.is_err() {
        return Err(ArgmaxError::service(
            "PROJECT_NOT_GIT",
            format!(
                "{} is not a git repository (.git missing).",
                resolved.display()
            ),
        ));
    }
    Ok(resolved)
}

pub(crate) async fn read_git_metadata(candidate_path: &Path) -> ArgmaxResult<GitMetadata> {
    let root = run_git_text(
        candidate_path,
        ["rev-parse", "--show-toplevel"],
        GIT_DEFAULT_TIMEOUT,
    )
    .await
    .map_err(project_git_error)?;
    let repo_path = PathBuf::from(root.trim());
    let current_branch = run_git_text(
        &repo_path,
        ["branch", "--show-current"],
        GIT_DEFAULT_TIMEOUT,
    )
    .await
    .map_err(project_git_error)?
    .trim()
    .to_string();
    let current_branch = if current_branch.is_empty() {
        "HEAD".to_string()
    } else {
        current_branch
    };
    let default_branch = discover_default_branch(&repo_path, &current_branch).await?;
    let remote_url = run_git_text(
        &repo_path,
        ["config", "--get", "remote.origin.url"],
        GIT_DEFAULT_TIMEOUT,
    )
    .await
    .ok();
    let remote = remote_url.as_deref().and_then(parse_github_remote);

    Ok(GitMetadata {
        repo_path,
        current_branch,
        default_branch,
        remote,
    })
}

pub(crate) async fn discover_default_branch(
    repo_path: &Path,
    current_branch: &str,
) -> ArgmaxResult<Option<String>> {
    if let Ok(origin_head) = run_git_text(
        repo_path,
        [
            "symbolic-ref",
            "--quiet",
            "--short",
            "refs/remotes/origin/HEAD",
        ],
        GIT_DEFAULT_TIMEOUT,
    )
    .await
    {
        let branch = origin_head
            .trim()
            .strip_prefix("origin/")
            .unwrap_or(origin_head.trim());
        if !branch.is_empty() {
            return Ok(Some(branch.to_string()));
        }
    }

    for branch in ["main", "master", "trunk"] {
        if run_git_text(
            repo_path,
            [
                "show-ref",
                "--verify",
                "--quiet",
                &format!("refs/heads/{branch}"),
            ],
            GIT_DEFAULT_TIMEOUT,
        )
        .await
        .is_ok()
        {
            return Ok(Some(branch.to_string()));
        }
    }

    Ok((current_branch != "HEAD").then(|| current_branch.to_string()))
}

pub(crate) async fn assert_valid_ref_name(repo_path: &Path, reference: &str) -> ArgmaxResult<()> {
    run_git_text(
        repo_path,
        ["check-ref-format", "--allow-onelevel", reference],
        GIT_DEFAULT_TIMEOUT,
    )
    .await
    .map(|_| ())
    .map_err(|_| {
        ArgmaxError::service(
            "GIT_REF_INVALID",
            format!("Invalid git ref name: {reference}"),
        )
    })
}

pub(crate) fn default_settings(project_id: &str) -> ArgmaxResult<ProjectSettings> {
    Ok(ProjectSettings {
        worktree_location: crate::util::data_dir::worktree_root()?
            .join(project_id)
            .to_string_lossy()
            .to_string(),
        setup_command: String::new(),
        check_commands: Vec::new(),
        merge_cleanup: Default::default(),
    })
}

pub(crate) fn project_git_error(error: ArgmaxError) -> ArgmaxError {
    ArgmaxError::service(
        "PROJECT_GIT",
        format!("Argmax requires a local git repository. {error}"),
    )
}
