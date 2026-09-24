use std::{
    collections::HashSet,
    path::PathBuf,
    sync::{Mutex, OnceLock},
};

use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::State;

use crate::{
    error::{ArgmaxError, ArgmaxResult},
    persistence::{
        events::persist_timeline_event,
        projects::require_project,
        sessions::{find_session_by_id, update_session_last_activity},
        time::now_iso,
        workspaces::find_workspace_by_id,
    },
    providers::{
        claude_cloud,
        cloud::{
            clone_verified_checkout, handoff_brief, handoff_note, validate_checkout,
            CheckoutSnapshot, CloudEnvironment,
        },
        codex_cloud, cursor_cloud,
    },
    state::AppState,
};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CloudPrepareInput {
    pub provider: CloudProvider,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project_id: Option<String>,
    /// What the user typed after `/cloud`. Only a chat source takes one: it
    /// becomes the brief's closing instruction after the chat's transcript.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub instruction: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CloudHandoffPreview {
    pub provider: CloudProvider,
    pub repository: String,
    pub branch: String,
    pub commit: String,
    pub brief: String,
    pub environments: Vec<CloudEnvironment>,
    pub environment_description: String,
    pub environment_id: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CloudLaunchInput {
    pub provider: CloudProvider,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project_id: Option<String>,
    pub repository: String,
    pub branch: String,
    pub commit: String,
    pub brief: String,
    pub environment_id: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "lowercase")]
pub enum CloudProvider {
    Claude,
    Codex,
    Cursor,
}

impl CloudProvider {
    fn display_name(self) -> &'static str {
        match self {
            Self::Claude => "Claude",
            Self::Codex => "Codex",
            Self::Cursor => "Cursor",
        }
    }

    fn key(self) -> &'static str {
        match self {
            Self::Claude => "claude",
            Self::Codex => "codex",
            Self::Cursor => "cursor",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CloudHandoffResult {
    pub url: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub warning: Option<String>,
}

#[derive(Debug)]
struct CloudCheckout {
    path: PathBuf,
    brief: String,
}

#[derive(Debug, Clone, PartialEq)]
enum CloudSource {
    Session(String),
    Project(String),
}

impl CloudSource {
    fn from_ids(session_id: Option<&str>, project_id: Option<&str>) -> ArgmaxResult<Self> {
        match (session_id, project_id) {
            (Some(session_id), None) if !session_id.trim().is_empty() => {
                Ok(Self::Session(session_id.to_string()))
            }
            (None, Some(project_id)) if !project_id.trim().is_empty() => {
                Ok(Self::Project(project_id.to_string()))
            }
            (Some(_), Some(_)) => Err(ArgmaxError::service(
                "CLOUD_SOURCE_CONFLICT",
                "Choose either a chat or a project for the cloud task, not both.",
            )),
            _ => Err(ArgmaxError::service(
                "CLOUD_SOURCE_REQUIRED",
                "Choose a chat or project for the cloud task.",
            )),
        }
    }

    fn launch_key(&self) -> String {
        match self {
            Self::Session(session_id) => format!("session:{session_id}"),
            Self::Project(project_id) => format!("project:{project_id}"),
        }
    }

    fn session_id(&self) -> Option<&str> {
        match self {
            Self::Session(session_id) => Some(session_id),
            Self::Project(_) => None,
        }
    }
}

static CLOUD_LAUNCHES: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();

struct CloudLaunchGuard(String);

impl CloudLaunchGuard {
    fn acquire(source_key: &str) -> ArgmaxResult<Self> {
        let mut launches = CLOUD_LAUNCHES
            .get_or_init(|| Mutex::new(HashSet::new()))
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if !launches.insert(source_key.to_string()) {
            return Err(ArgmaxError::service(
                "CLOUD_LAUNCH_IN_PROGRESS",
                "This task is already being sent. Wait for it to finish.",
            ));
        }
        Ok(Self(source_key.to_string()))
    }
}

impl Drop for CloudLaunchGuard {
    fn drop(&mut self) {
        CLOUD_LAUNCHES
            .get_or_init(|| Mutex::new(HashSet::new()))
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .remove(&self.0);
    }
}

#[tauri::command(rename = "cloud:prepare")]
#[specta::specta]
pub async fn cloud_prepare(
    state: State<'_, AppState>,
    input: CloudPrepareInput,
) -> ArgmaxResult<CloudHandoffPreview> {
    cloud_prepare_impl(&state, input).await
}

pub(crate) async fn cloud_prepare_impl(
    state: &AppState,
    input: CloudPrepareInput,
) -> ArgmaxResult<CloudHandoffPreview> {
    let provider = input.provider;
    let source = CloudSource::from_ids(input.session_id.as_deref(), input.project_id.as_deref())?;
    if input.instruction.is_some() && source.session_id().is_none() {
        return Err(ArgmaxError::service(
            "CLOUD_INSTRUCTION_NEEDS_CHAT",
            "Only a chat's cloud task takes a separate instruction. A project's task is its brief.",
        ));
    }
    let checkout = cloud_checkout(state, source, input.instruction).await?;
    let snapshot = validate_checkout(checkout.path).await?;
    let environments = prepare_provider(state, provider, &snapshot.repository).await?;
    let (environment_id, environment_description) = selected_environment(&environments);

    Ok(CloudHandoffPreview {
        provider,
        repository: snapshot.repository,
        branch: snapshot.branch,
        commit: snapshot.commit,
        brief: checkout.brief,
        environments,
        environment_description,
        environment_id,
    })
}

#[tauri::command(rename = "cloud:launch")]
#[specta::specta]
pub async fn cloud_launch(
    state: State<'_, AppState>,
    input: CloudLaunchInput,
) -> ArgmaxResult<CloudHandoffResult> {
    cloud_launch_impl(&state, input).await
}

pub(crate) async fn cloud_launch_impl(
    state: &AppState,
    input: CloudLaunchInput,
) -> ArgmaxResult<CloudHandoffResult> {
    let provider = input.provider;
    let source = CloudSource::from_ids(input.session_id.as_deref(), input.project_id.as_deref())?;
    let brief = input.brief.trim();
    if brief.is_empty() {
        return Err(ArgmaxError::service(
            "CLOUD_BRIEF_REQUIRED",
            "Enter a task brief before launching the cloud task.",
        ));
    }
    let _launch_guard = CloudLaunchGuard::acquire(&source.launch_key())?;

    let checkout = cloud_checkout(state, source.clone(), None).await?;
    let snapshot = validate_checkout(checkout.path).await?;
    ensure_preview_is_current(&snapshot, &input)?;
    if !environment_is_current(state, provider, &snapshot.repository, &input.environment_id).await?
    {
        return Err(ArgmaxError::service(
            "CLOUD_ENVIRONMENT_CHANGED",
            format!("The selected {} Cloud environment changed after this task was prepared. Review it and try again.", provider.display_name()),
        ));
    }
    let url = launch_provider(state, provider, &snapshot, &input.environment_id, brief).await?;

    let warning = if let Some(session_id) = source.session_id() {
        persist_handoff_note(state, session_id, provider, &url)
            .await
            .err()
            .map(|error| {
                tracing::warn!(
                    %session_id,
                    %url,
                    ?error,
                    provider = provider.key(),
                    "Cloud task launched, but its session note could not be persisted"
                );
                "The task started, but its link could not be saved in this chat. Open or copy it before you close.".to_string()
            })
    } else {
        None
    };
    Ok(CloudHandoffResult { url, warning })
}

async fn environment_is_current(
    state: &AppState,
    provider: CloudProvider,
    repository: &str,
    environment_id: &str,
) -> ArgmaxResult<bool> {
    match provider {
        CloudProvider::Claude => {
            // Binary first: without Claude Code installed, "run /remote-env"
            // is advice the user cannot follow.
            let _ = claude_cloud::claude_binary_path(&state.provider_discovery).await?;
            let selected = tauri::async_runtime::spawn_blocking(claude_cloud::selected_environment)
                .await
                .map_err(|error| {
                    ArgmaxError::service("CLOUD_ENVIRONMENT_JOIN_FAILED", error.to_string())
                })??;
            Ok(selected.0 == environment_id)
        }
        CloudProvider::Codex => {
            let _ = codex_cloud::binary_path(&state.provider_discovery).await?;
            let environments = codex_cloud::environments(repository).await?;
            Ok(codex_cloud::environment_is_current(
                &environments,
                environment_id,
            ))
        }
        // Cursor has one provider-managed environment. The create request is
        // the authoritative auth and repository-access check; repeating its
        // rate-limited repository inventory here would make an immediate send
        // fail after a successful prepare.
        CloudProvider::Cursor => Ok(environment_id == "cursor-cloud"),
    }
}

async fn prepare_provider(
    state: &AppState,
    provider: CloudProvider,
    repository: &str,
) -> ArgmaxResult<Vec<CloudEnvironment>> {
    match provider {
        CloudProvider::Claude => {
            // Binary first: without Claude Code installed, "run /remote-env"
            // is advice the user cannot follow.
            let _ = claude_cloud::claude_binary_path(&state.provider_discovery).await?;
            let selected = tauri::async_runtime::spawn_blocking(claude_cloud::selected_environment)
                .await
                .map_err(|error| {
                    ArgmaxError::service("CLOUD_ENVIRONMENT_JOIN_FAILED", error.to_string())
                })??;
            Ok(vec![CloudEnvironment {
                id: selected.0,
                name: selected.1,
            }])
        }
        CloudProvider::Codex => {
            let _ = codex_cloud::binary_path(&state.provider_discovery).await?;
            codex_cloud::environments(repository).await
        }
        CloudProvider::Cursor => cursor_cloud::environments(repository).await,
    }
}

fn selected_environment(environments: &[CloudEnvironment]) -> (String, String) {
    match environments {
        [environment] => (environment.id.clone(), environment.name.clone()),
        [] => (String::new(), "No cloud environment available".to_string()),
        _ => (String::new(), "Choose an environment".to_string()),
    }
}

async fn launch_provider(
    state: &AppState,
    provider: CloudProvider,
    snapshot: &CheckoutSnapshot,
    environment_id: &str,
    brief: &str,
) -> ArgmaxResult<String> {
    match provider {
        CloudProvider::Claude => {
            let binary_path = claude_cloud::claude_binary_path(&state.provider_discovery).await?;
            let checkout = clone_verified_checkout(snapshot).await?;
            claude_cloud::launch(
                &binary_path,
                &checkout.path().join("repository"),
                environment_id,
                brief,
            )
            .await
        }
        CloudProvider::Codex => {
            let binary_path = codex_cloud::binary_path(&state.provider_discovery).await?;
            let checkout = clone_verified_checkout(snapshot).await?;
            codex_cloud::launch(
                &binary_path,
                &checkout.path().join("repository"),
                &snapshot.branch,
                environment_id,
                brief,
            )
            .await
        }
        CloudProvider::Cursor => cursor_cloud::launch(snapshot, brief).await,
    }
}

async fn cloud_checkout(
    state: &AppState,
    source: CloudSource,
    instruction: Option<String>,
) -> ArgmaxResult<CloudCheckout> {
    let database = super::live_database(state)?;
    super::read_off_main(move || {
        let connection = database.read_connection();
        checkout_from_connection(&connection, &source, instruction.as_deref())
    })
    .await
}

fn checkout_from_connection(
    connection: &rusqlite::Connection,
    source: &CloudSource,
    instruction: Option<&str>,
) -> ArgmaxResult<CloudCheckout> {
    match source {
        CloudSource::Session(session_id) => {
            let session = find_session_by_id(connection, session_id)?;
            let workspace = find_workspace_by_id(connection, &session.workspace_id)?;
            if workspace.kind != "git" {
                return Err(ArgmaxError::service(
                    "CLOUD_GIT_CHECKOUT_REQUIRED",
                    "Cloud tasks need a chat in a git repository.",
                ));
            }
            let brief = handoff_brief(connection, session_id, instruction)?;
            Ok(CloudCheckout {
                path: PathBuf::from(workspace.path),
                brief,
            })
        }
        CloudSource::Project(project_id) => {
            let project = require_project(connection, project_id)?;
            Ok(CloudCheckout {
                path: PathBuf::from(project.repo_path),
                brief: String::new(),
            })
        }
    }
}

fn ensure_preview_is_current(
    snapshot: &CheckoutSnapshot,
    input: &CloudLaunchInput,
) -> ArgmaxResult<()> {
    if snapshot.repository != input.repository
        || snapshot.branch != input.branch
        || snapshot.commit != input.commit
    {
        return Err(ArgmaxError::service(
            "CLOUD_HANDOFF_CHANGED",
            "The repository, branch, or commit changed after this task was prepared. Review it and try again.",
        ));
    }
    Ok(())
}

async fn persist_handoff_note(
    state: &AppState,
    session_id: &str,
    provider: CloudProvider,
    url: &str,
) -> ArgmaxResult<()> {
    let database = super::live_database(state)?;
    let session_id = session_id.to_string();
    let url = url.to_string();
    let published = tauri::async_runtime::spawn_blocking(move || {
        let timestamp = now_iso();
        let connection = database.connection();
        let mut note = handoff_note(provider.display_name(), provider.key(), &url);
        note.session_id = session_id.clone();
        note.created_at = Some(timestamp.clone());
        let event = persist_timeline_event(&connection, &note)?;
        let session = update_session_last_activity(&connection, &session_id, &timestamp)?;
        Ok::<_, ArgmaxError>((session, event))
    })
    .await
    .map_err(|error| ArgmaxError::service("CLOUD_NOTE_JOIN_FAILED", error.to_string()))??;
    if let Some(workspaces) = state.workspaces.get() {
        workspaces.publish_session_with_events(published.0, vec![published.1]);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn snapshot() -> CheckoutSnapshot {
        CheckoutSnapshot {
            path: PathBuf::from("/tmp/repository"),
            repository: "example/private-sandbox".to_string(),
            origin_url: "git@github.com:example/private-sandbox.git".to_string(),
            branch: "main".to_string(),
            commit: "0123456789abcdef0123456789abcdef01234567".to_string(),
        }
    }

    fn input() -> CloudLaunchInput {
        let snapshot = snapshot();
        CloudLaunchInput {
            provider: CloudProvider::Claude,
            session_id: Some("session-1".to_string()),
            project_id: None,
            repository: snapshot.repository,
            branch: snapshot.branch,
            commit: snapshot.commit,
            brief: "Inspect the repository.".to_string(),
            environment_id: "env_default".to_string(),
        }
    }

    #[test]
    fn launch_rejects_a_stale_preview() {
        let mut input = input();
        input.commit = "ffffffffffffffffffffffffffffffffffffffff".to_string();
        assert!(matches!(
            ensure_preview_is_current(&snapshot(), &input),
            Err(ArgmaxError::ServiceError { sub_code, .. }) if sub_code == "CLOUD_HANDOFF_CHANGED"
        ));
    }

    #[test]
    fn source_requires_exactly_one_id() {
        let existing_session_input: CloudPrepareInput = serde_json::from_value(
            serde_json::json!({ "provider": "claude", "sessionId": "session-1" }),
        )
        .expect("deserialize existing session input");
        assert_eq!(existing_session_input.project_id, None);
        assert!(matches!(
            CloudSource::from_ids(None, None),
            Err(ArgmaxError::ServiceError { sub_code, .. }) if sub_code == "CLOUD_SOURCE_REQUIRED"
        ));
        assert!(matches!(
            CloudSource::from_ids(Some("session-1"), Some("project-1")),
            Err(ArgmaxError::ServiceError { sub_code, .. }) if sub_code == "CLOUD_SOURCE_CONFLICT"
        ));
        assert_eq!(
            CloudSource::from_ids(Some("session-1"), None).unwrap(),
            CloudSource::Session("session-1".to_string())
        );
        assert_eq!(
            CloudSource::from_ids(None, Some("project-1")).unwrap(),
            CloudSource::Project("project-1".to_string())
        );
    }

    #[test]
    fn project_source_resolves_only_the_registered_repo_path() {
        use crate::persistence::{
            database::Database,
            projects::{persist_project, PersistProjectInput, ProjectSettings},
        };

        let database = Database::open_in_memory().expect("database");
        let connection = database.connection();
        persist_project(
            &connection,
            &PersistProjectInput {
                id: "project-1".to_string(),
                name: "Private sandbox".to_string(),
                repo_path: "/tmp/private-sandbox".to_string(),
                current_branch: "main".to_string(),
                default_branch: Some("main".to_string()),
                settings: ProjectSettings {
                    worktree_location: "/tmp/worktrees".to_string(),
                    setup_command: String::new(),
                    check_commands: Vec::new(),
                    archive_on_merge: false,
                },
            },
        )
        .expect("persist project");

        let checkout = checkout_from_connection(
            &connection,
            &CloudSource::Project("project-1".to_string()),
            None,
        )
        .expect("resolve project checkout");
        assert_eq!(checkout.path, PathBuf::from("/tmp/private-sandbox"));
        assert!(checkout.brief.is_empty());
        assert!(checkout_from_connection(
            &connection,
            &CloudSource::Project("missing-project".to_string()),
            None
        )
        .is_err());
    }

    #[test]
    fn chat_brief_closes_on_the_users_instruction_instead_of_the_default() {
        use crate::persistence::{
            database::Database,
            events::{persist_timeline_event, PersistTimelineEventInput},
        };

        let database = Database::open_in_memory().expect("database");
        let connection = database.connection();
        for statement in [
            "INSERT INTO projects (id, name, repo_path, current_branch, worktree_location, created_at, updated_at) VALUES ('p1', 'p1', '/tmp/p1', 'main', '~/.argmax', '2026-05-24T10:00:00.000Z', '2026-05-24T10:00:00.000Z')",
            "INSERT INTO workspaces (id, project_id, task_label, branch, base_ref, path, state, last_activity_at, created_at, updated_at) VALUES ('w1', 'p1', 'task', 'branch', 'main', '/tmp/w1', 'running', '2026-05-24T10:00:00.000Z', '2026-05-24T10:00:00.000Z', '2026-05-24T10:00:00.000Z')",
            "INSERT INTO sessions (id, workspace_id, provider, model_label, model_id, reasoning_effort, permission_mode, agent_mode, prompt, state, attention, started_at, last_activity_at) VALUES ('s1', 'w1', 'claude', 'Sonnet', 'claude-sonnet-5', NULL, 'auto-approve', 'auto', 'prompt', 'complete', 'none', '2026-05-24T10:00:00.000Z', '2026-05-24T10:00:00.000Z')",
        ] {
            connection.execute(statement, []).expect("seed chat");
        }
        persist_timeline_event(
            &connection,
            &PersistTimelineEventInput {
                id: "event-1".to_string(),
                session_id: "s1".to_string(),
                r#type: "user.message".to_string(),
                message: "Why does the sidebar flicker?".to_string(),
                payload: serde_json::json!({}),
                created_at: Some("2026-05-24T10:00:01.000Z".to_string()),
            },
        )
        .expect("insert message");
        let session = CloudSource::Session("s1".to_string());

        let brief = checkout_from_connection(&connection, &session, Some("  Fix the flicker.  "))
            .expect("brief with instruction")
            .brief;
        assert!(
            brief.contains("User: Why does the sidebar flicker?"),
            "{brief}"
        );
        assert!(
            brief.ends_with("New user message:\nFix the flicker."),
            "{brief}"
        );
        assert!(!brief.contains("Continue this task"), "{brief}");

        let default_brief = checkout_from_connection(&connection, &session, Some("   "))
            .expect("brief without instruction")
            .brief;
        assert!(
            default_brief.contains("New user message:\nContinue this task"),
            "{default_brief}"
        );
    }
}
