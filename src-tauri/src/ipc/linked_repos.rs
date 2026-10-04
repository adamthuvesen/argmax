//! Settings channels for linked repositories and branch-name templates.
//! Both are per-project (or app-wide) preferences that a launch reads from
//! Rust, so they cannot live in the renderer's `localStorage`.

use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::{AppHandle, State};

use super::{
    live_database, read_off_main,
    validation::{NonEmptyString, ProjectId},
};
use crate::{
    error::{ArgmaxError, ArgmaxResult},
    files::linked_roots,
    persistence::{
        app_settings,
        linked_repos::{self, LinkedRepo, LinkedRepoInput},
        projects::{self, ProjectSummary},
    },
    providers::one_shot,
    state::AppState,
};

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LinkedReposListInput {
    pub project_id: ProjectId,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LinkedReposAddInput {
    pub project_id: ProjectId,
    pub repo: LinkedRepoInput,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LinkedReposSetEnabledInput {
    pub project_id: ProjectId,
    pub id: NonEmptyString,
    pub enabled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LinkedReposRemoveInput {
    pub project_id: ProjectId,
    pub id: NonEmptyString,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LinkedReposSummarizeInput {
    pub project_id: ProjectId,
    pub id: NonEmptyString,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProjectsSetBranchTemplateInput {
    pub project_id: ProjectId,
    /// `null` removes the project's override.
    pub template: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SetBranchTemplateInput {
    /// `null` returns to Argmax's built-in template.
    pub template: Option<String>,
}

/// The app-wide template as saved, and the built-in one it falls back to, so
/// the form can show what "unset" means.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct BranchTemplateSettings {
    pub template: Option<String>,
    pub default_template: &'static str,
}

fn settings(template: Option<String>) -> BranchTemplateSettings {
    BranchTemplateSettings {
        template,
        default_template: crate::workspaces::branch_names::DEFAULT_BRANCH_TEMPLATE,
    }
}

#[tauri::command(rename = "linked-repos:list")]
#[specta::specta]
pub async fn linked_repos_list(
    state: State<'_, AppState>,
    input: LinkedReposListInput,
) -> ArgmaxResult<Vec<LinkedRepo>> {
    let database = live_database(&state)?;
    read_off_main(move || {
        linked_repos::list_linked_repos(&database.read_connection(), input.project_id.as_str())
    })
    .await
}

#[tauri::command(rename = "linked-repos:add")]
#[specta::specta]
pub async fn linked_repos_add(
    state: State<'_, AppState>,
    input: LinkedReposAddInput,
) -> ArgmaxResult<LinkedRepo> {
    let database = live_database(&state)?;
    // Canonicalizing the path touches the filesystem, so it runs off the main thread.
    read_off_main(move || {
        linked_repos::add_linked_repo(
            &database.connection(),
            input.project_id.as_str(),
            &input.repo,
        )
    })
    .await
}

#[tauri::command(rename = "linked-repos:pick-folder")]
#[specta::specta]
pub async fn linked_repos_pick_folder(
    app: AppHandle,
    state: State<'_, AppState>,
    input: LinkedReposListInput,
) -> ArgmaxResult<Option<LinkedRepo>> {
    let database = live_database(&state)?;
    let Some(path) = super::projects::pick_project_folder(app, "Connect Repository").await? else {
        return Ok(None);
    };
    read_off_main(move || {
        linked_repos::add_linked_repo(
            &database.connection(),
            input.project_id.as_str(),
            &LinkedRepoInput {
                name: None,
                path: path.to_string_lossy().into_owned(),
            },
        )
        .map(Some)
    })
    .await
}

#[tauri::command(rename = "linked-repos:summarize")]
#[specta::specta]
pub async fn linked_repos_summarize(
    state: State<'_, AppState>,
    input: LinkedReposSummarizeInput,
) -> ArgmaxResult<LinkedRepo> {
    let database = live_database(&state)?;
    let read_database = database.clone();
    let project_id = input.project_id.into_string();
    let id = input.id.into_string();
    let read_project = project_id.clone();
    let read_id = id.clone();
    let repo = read_off_main(move || {
        linked_repos::find_linked_repo_by_id(
            &read_database.read_connection(),
            &read_project,
            &read_id,
        )
    })
    .await?;
    let context = repository_summary_context(&repo).await?;
    let provider = state.provider_discovery.available_providers().await.into_iter().next()
        .ok_or_else(|| ArgmaxError::service(
            "LINKED_REPO_SUMMARY_UNAVAILABLE",
            "No available provider can generate the repository summary. Connect a provider and retry.",
        ))?;
    let summary =
        one_shot::summarize_repository(provider, one_shot::helper_model(provider), &context)
            .await
            .ok_or_else(|| {
                ArgmaxError::service(
                    "LINKED_REPO_SUMMARY_UNAVAILABLE",
                    "The provider could not generate a repository summary. Retry to try again.",
                )
            })?;
    read_off_main(move || {
        linked_repos::set_linked_repo_summary(&database.connection(), &project_id, &id, &summary)
    })
    .await
}

/// A small orientation sample keeps the helper cheap without sending the whole checkout.
async fn repository_summary_context(repo: &LinkedRepo) -> ArgmaxResult<String> {
    const CONTEXT_CHARS: usize = 24_000;
    const FILE_CHARS: usize = 4_000;
    const FILES: &[&str] = &[
        "README.md",
        "readme.md",
        "README",
        "AGENTS.md",
        "CLAUDE.md",
        "package.json",
        "Cargo.toml",
        "pyproject.toml",
        "go.mod",
        "Package.swift",
        "composer.json",
        "Gemfile",
    ];
    let listing_repo = repo.clone();
    let listing =
        read_off_main(move || linked_roots::list_directory(&listing_repo, "", 0, 500)).await?;
    let names: Vec<&str> = listing
        .entries
        .iter()
        .filter(|entry| {
            !entry.name.starts_with('.')
                && !matches!(entry.name.as_str(), "node_modules" | "target" | "dist")
        })
        .take(80)
        .map(|entry| entry.name.as_str())
        .collect();
    let mut context = format!(
        "Repository: {}\nTop-level entries: {}\n",
        repo.name,
        names.join(", ")
    );
    for file in FILES {
        if !listing
            .entries
            .iter()
            .any(|entry| entry.name == *file && matches!(entry.kind, "file" | "symlink"))
        {
            continue;
        }
        let remaining = CONTEXT_CHARS.saturating_sub(context.chars().count() + file.len() + 6);
        if remaining == 0 {
            break;
        }
        let read = linked_roots::read_text(repo, file, FILE_CHARS.min(remaining)).await?;
        context.push_str(&format!("\n--- {file}\n{}\n", read.content));
    }
    Ok(context)
}

#[tauri::command(rename = "linked-repos:set-enabled")]
#[specta::specta]
pub async fn linked_repos_set_enabled(
    state: State<'_, AppState>,
    input: LinkedReposSetEnabledInput,
) -> ArgmaxResult<LinkedRepo> {
    let database = live_database(&state)?;
    read_off_main(move || {
        linked_repos::set_linked_repo_enabled(
            &database.connection(),
            input.project_id.as_str(),
            input.id.as_str(),
            input.enabled,
        )
    })
    .await
}

#[tauri::command(rename = "linked-repos:remove")]
#[specta::specta]
pub async fn linked_repos_remove(
    state: State<'_, AppState>,
    input: LinkedReposRemoveInput,
) -> ArgmaxResult<()> {
    let database = live_database(&state)?;
    read_off_main(move || {
        linked_repos::delete_linked_repo(
            &database.connection(),
            input.project_id.as_str(),
            input.id.as_str(),
        )
    })
    .await
}

#[tauri::command(rename = "projects:set-branch-template")]
#[specta::specta]
pub async fn projects_set_branch_template(
    state: State<'_, AppState>,
    input: ProjectsSetBranchTemplateInput,
) -> ArgmaxResult<ProjectSummary> {
    let database = live_database(&state)?;
    read_off_main(move || {
        projects::set_project_branch_template(
            &database.connection(),
            input.project_id.as_str(),
            input.template.as_deref(),
        )
    })
    .await
}

#[tauri::command(rename = "settings:branch-template")]
#[specta::specta]
pub async fn settings_branch_template(
    state: State<'_, AppState>,
) -> ArgmaxResult<BranchTemplateSettings> {
    let database = live_database(&state)?;
    read_off_main(move || {
        Ok(settings(app_settings::branch_template(
            &database.read_connection(),
        )))
    })
    .await
}

#[tauri::command(rename = "settings:set-branch-template")]
#[specta::specta]
pub async fn settings_set_branch_template(
    state: State<'_, AppState>,
    input: SetBranchTemplateInput,
) -> ArgmaxResult<BranchTemplateSettings> {
    let database = live_database(&state)?;
    read_off_main(move || {
        let connection = database.connection();
        app_settings::set_branch_template(&connection, input.template.as_deref())?;
        Ok(settings(app_settings::branch_template(&connection)))
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    fn repo_at(root: &std::path::Path) -> LinkedRepo {
        LinkedRepo {
            id: "l1".into(),
            project_id: "p1".into(),
            name: "api".into(),
            root_path: root.canonicalize().unwrap().to_string_lossy().into_owned(),
            summary: None,
            enabled: true,
            created_at: String::new(),
            updated_at: String::new(),
        }
    }

    #[tokio::test]
    async fn summary_sample_is_bounded_and_excludes_secret_contents() {
        let root = TempDir::new().unwrap();
        fs::write(
            root.path().join("README.md"),
            "API contracts. ".repeat(1000),
        )
        .unwrap();
        fs::write(
            root.path().join("package.json"),
            r#"{"name":"api-contracts"}"#,
        )
        .unwrap();
        fs::write(root.path().join(".env"), "PRIVATE_TOKEN=secret-content").unwrap();
        fs::create_dir(root.path().join("src")).unwrap();
        let context = repository_summary_context(&repo_at(root.path()))
            .await
            .unwrap();
        assert!(context.contains("API contracts."));
        assert!(context.contains("api-contracts"));
        assert!(context.contains("src"));
        assert!(!context.contains("secret-content"));
        assert!(context.chars().count() <= 24_000);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn summary_sample_refuses_a_document_symlink_outside_the_linked_root() {
        let root = TempDir::new().unwrap();
        let outside = TempDir::new().unwrap();
        fs::write(
            outside.path().join("private.md"),
            "Outside the linked root.",
        )
        .unwrap();
        std::os::unix::fs::symlink(
            outside.path().join("private.md"),
            root.path().join("README.md"),
        )
        .unwrap();
        assert!(
            matches!(repository_summary_context(&repo_at(root.path())).await,
            Err(ArgmaxError::ServiceError { sub_code, .. }) if sub_code == "LINKED_REPO_PATH_ESCAPES")
        );
    }
}
