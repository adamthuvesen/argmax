mod label;
mod launch;
mod messaging;
mod move_archive;
mod project_tools;
mod resume;
mod wait;
mod workspace_tools;

pub(crate) use launch::{launch_with_spec, AlongsideCheckout, LaunchSpec};
pub use resume::resume_after_turn_actions;

use std::path::Path;
use std::sync::Arc;

use self::{
    label::rename_session,
    launch::launch_session,
    messaging::{
        inbox_read, list_sessions_action, message_session, session_read, session_status,
        stop_session,
    },
    move_archive::{schedule_session_move, schedule_workspace_archive},
    project_tools::{
        add_learning, cancel_schedule, list_projects_action, list_schedules, resume_schedule,
        schedule_followup, search_learnings_action,
    },
    wait::wait_for_sessions,
    workspace_tools::{
        read_terminal, run_checks, spawn_terminal, workspace_diff, workspace_status,
    },
};
use super::{
    protocol::{
        GoalOutcome, GoalSetAction, SessionControlAction, SessionControlError,
        SessionControlRequest, SessionControlResponse, SessionControlResult,
    },
    protocol_error,
    registry::{ParentLaunchSettings, SessionLaunchRegistry},
    DEFAULT_TASK_LABEL, MAX_TASK_LABEL_BYTES, MAX_TASK_LABEL_CHARS, PROTOCOL_VERSION,
    TASK_LABEL_ELLIPSIS,
};
use crate::{
    ipc::inputs::{TerminalCols, TerminalRows},
    persistence::{
        database::Database, projects::ProjectSummary, session_messages::count_undelivered_messages,
    },
    providers::session_service::ProviderSessionService,
    workspaces::WorkspaceService,
};

pub(super) async fn handle_session_control(
    request: SessionControlRequest,
    parent: ParentLaunchSettings,
    app: Option<tauri::AppHandle>,
    database: Arc<Database>,
    workspaces: Arc<WorkspaceService>,
    providers: Arc<ProviderSessionService>,
    registry: Arc<SessionLaunchRegistry>,
) -> Result<SessionControlResponse, SessionControlError> {
    if request.version != PROTOCOL_VERSION {
        return Err(protocol_error(
            "VERSION_UNSUPPORTED",
            format!(
                "Protocol version {} is not supported. Expected {PROTOCOL_VERSION}.",
                request.version
            ),
        ));
    }
    let caller_session_id = parent.session_id.clone();
    let counting_database = Arc::clone(&database);
    let mut response = match request.action {
        SessionControlAction::Launch(action) => {
            launch_session(action, parent, database, workspaces, providers).await
        }
        SessionControlAction::Move(action) => {
            schedule_session_move(action, parent, database, workspaces, providers, registry).await
        }
        SessionControlAction::Archive(action) => {
            schedule_workspace_archive(action, parent, database, workspaces, providers, registry)
                .await
        }
        SessionControlAction::List(action) => list_sessions_action(action, parent, database).await,
        SessionControlAction::Message(action) => {
            message_session(action, parent, database, providers, registry).await
        }
        SessionControlAction::Status(action) => session_status(action, database),
        SessionControlAction::Read(action) => session_read(action, database),
        SessionControlAction::Stop(action) => {
            stop_session(action, parent, database, providers).await
        }
        SessionControlAction::Inbox(_) => inbox_read(parent, database),
        SessionControlAction::Wait(action) => {
            wait_for_sessions(action, parent, database, providers, registry).await
        }
        SessionControlAction::GoalSet(action) => {
            set_goal(action, &parent, database, app.as_ref()).await
        }
        SessionControlAction::GoalClear => clear_goal(&parent, app.as_ref()).await,
        SessionControlAction::Rename(action) => {
            rename_session(action, parent, database, workspaces)
        }
        SessionControlAction::ChecksRun(action) => {
            run_checks(action, parent, database, app.as_ref()).await
        }
        SessionControlAction::WorkspaceStatus(action) => workspace_status(action, parent, database),
        SessionControlAction::WorkspaceDiff(action) => {
            workspace_diff(action, parent, database).await
        }
        SessionControlAction::LearningsAdd(action) => add_learning(action, parent, database),
        SessionControlAction::LearningsSearch(action) => {
            search_learnings_action(action, parent, database)
        }
        SessionControlAction::TerminalSpawn(action) => {
            // Spawning opens a PTY and forks a shell. Keep that work off the
            // async runtime for the same reason the renderer's terminal IPC
            // does.
            tauri::async_runtime::spawn_blocking(move || {
                spawn_terminal(action, parent, database, app.as_ref())
            })
            .await
            .map_err(|error| protocol_error("TERMINAL_SPAWN_JOIN", error.to_string()))?
        }
        SessionControlAction::TerminalRead(action) => {
            read_terminal(action, parent, database, app.as_ref())
        }
        SessionControlAction::Projects(_) => list_projects_action(database),
        SessionControlAction::ScheduleFollowup(action) => {
            schedule_followup(action, parent, database)
        }
        SessionControlAction::ScheduleList(action) => list_schedules(action, parent, database),
        SessionControlAction::ScheduleCancel(action) => cancel_schedule(action, parent, database),
        SessionControlAction::ScheduleResume(action) => resume_schedule(action, parent, database),
        SessionControlAction::Browser(request) => {
            let app = app.ok_or_else(|| {
                protocol_error(
                    "BROWSER_UNAVAILABLE",
                    "This Argmax instance has no window to browse in.",
                )
            })?;
            crate::mcp::browser_bridge::handle(&app, &parent.session_id, request)
                .await
                .map(|outcome| SessionControlResponse::new(SessionControlResult::Browsed(outcome)))
        }
    }?;
    // Counted after the action, so an inbox read or a wait reports what its own
    // hand-over left behind rather than what it just collected: a batch the
    // reply ceiling cut short says so instead of looking complete. A failed
    // count only costs the stamp — the action already happened, and answering
    // an error would have the agent retry a launch that really did launch.
    let unread = match count_undelivered_messages(
        &counting_database.read_connection(),
        &caller_session_id,
    ) {
        Ok(unread) => unread,
        Err(error) => {
            tracing::warn!(
                ?error,
                session_id = %caller_session_id,
                "could not count undelivered messages for the reply stamp"
            );
            0
        }
    };
    if unread > 0 {
        response.unread_inbox = Some(unread);
    }
    Ok(response)
}

pub(super) fn resolve_project(
    projects: &[ProjectSummary],
    selector: Option<&str>,
    parent_project_id: &str,
) -> Result<ProjectSummary, SessionControlError> {
    // The hidden scratch project is not a repository: routing a launch at it
    // would run `create_current` against the app-owned side-chats root.
    let projects: Vec<ProjectSummary> = projects
        .iter()
        .filter(|project| project.id != crate::workspaces::SCRATCH_PROJECT_ID)
        .cloned()
        .collect();
    let Some(selector) = selector else {
        return projects
            .iter()
            .find(|project| project.id == parent_project_id)
            .cloned()
            .ok_or_else(|| {
                protocol_error(
                    "PARENT_PROJECT_NOT_FOUND",
                    "The parent session's project is no longer registered.",
                )
            });
    };
    if selector.trim().is_empty() {
        return Err(protocol_error(
            "PROJECT_SELECTOR_EMPTY",
            "Project selector must not be empty.",
        ));
    }
    if let Some(project) = projects.iter().find(|project| project.id == selector) {
        return Ok(project.clone());
    }

    let selector_path = Path::new(selector);
    let selector_canonical = selector_path.canonicalize().ok();
    let mut path_matches = projects
        .iter()
        .filter(|project| {
            project.repo_path == selector
                || selector_canonical.as_ref().is_some_and(|canonical| {
                    Path::new(&project.repo_path)
                        .canonicalize()
                        .is_ok_and(|project_path| project_path == *canonical)
                })
        })
        .cloned()
        .collect::<Vec<_>>();
    if path_matches.len() == 1 {
        return Ok(path_matches.remove(0));
    }
    if path_matches.len() > 1 {
        return Err(protocol_error(
            "PROJECT_SELECTOR_AMBIGUOUS",
            format!("Project path '{selector}' matches more than one registered project."),
        ));
    }

    let mut name_matches = projects
        .iter()
        .filter(|project| project.name.eq_ignore_ascii_case(selector))
        .cloned()
        .collect::<Vec<_>>();
    if name_matches.len() == 1 {
        return Ok(name_matches.remove(0));
    }
    if name_matches.len() > 1 {
        return Err(protocol_error(
            "PROJECT_SELECTOR_AMBIGUOUS",
            format!("Project name '{selector}' is ambiguous. Use its id or absolute repo path."),
        ));
    }
    Err(protocol_error(
        "PROJECT_NOT_FOUND",
        format!("No registered project matches '{selector}'."),
    ))
}

pub(crate) fn task_label(prompt: &str) -> String {
    let first_line = prompt.lines().next().unwrap_or_default().trim();
    if first_line.is_empty() {
        return DEFAULT_TASK_LABEL.to_string();
    }
    if first_line.chars().count() <= MAX_TASK_LABEL_CHARS
        && first_line.len() <= MAX_TASK_LABEL_BYTES
    {
        return first_line.to_string();
    }
    let max_prefix_chars = MAX_TASK_LABEL_CHARS - TASK_LABEL_ELLIPSIS.chars().count();
    let max_prefix_bytes = MAX_TASK_LABEL_BYTES - TASK_LABEL_ELLIPSIS.len();
    let mut prefix = String::new();
    for character in first_line.chars().take(max_prefix_chars) {
        if prefix.len() + character.len_utf8() > max_prefix_bytes {
            break;
        }
        prefix.push(character);
    }
    format!("{prefix}{TASK_LABEL_ELLIPSIS}")
}

pub(super) fn terminal_cols(value: u16) -> Result<TerminalCols, SessionControlError> {
    serde_json::from_value(serde_json::json!(value)).map_err(|error| {
        protocol_error(
            "INTERNAL_INPUT_INVALID",
            format!("Could not prepare terminal columns: {error}"),
        )
    })
}

pub(super) fn terminal_rows(value: u16) -> Result<TerminalRows, SessionControlError> {
    serde_json::from_value(serde_json::json!(value)).map_err(|error| {
        protocol_error(
            "INTERNAL_INPUT_INVALID",
            format!("Could not prepare terminal rows: {error}"),
        )
    })
}

/// The goal service lives on the app, not on the socket's own dependencies —
/// the MCP process has no `AppHandle`, so these follow the browser tools and
/// reach it through the running window.
fn goal_service(
    app: Option<&tauri::AppHandle>,
) -> Result<Arc<crate::goals::service::GoalService>, SessionControlError> {
    use tauri::Manager;
    app.and_then(|app| app.try_state::<crate::state::AppState>())
        .and_then(|state| state.goals.get().cloned())
        .ok_or_else(|| {
            protocol_error(
                "GOAL_UNAVAILABLE",
                "This Argmax instance cannot set goals right now.",
            )
        })
}

async fn set_goal(
    action: GoalSetAction,
    parent: &ParentLaunchSettings,
    database: Arc<Database>,
    app: Option<&tauri::AppHandle>,
) -> Result<SessionControlResponse, SessionControlError> {
    let goals = goal_service(app)?;
    // The caller's own workspace: a goal belongs to the chat that set it, so
    // the tool never takes a workspace argument to get wrong.
    let workspace_id = crate::persistence::sessions::find_session_by_id(
        &database.read_connection(),
        &parent.session_id,
    )
    .map_err(|error| protocol_error("GOAL_SET_FAILED", error.to_string()))?
    .workspace_id;
    let goal = goals
        .set(crate::goals::service::GoalSetInput {
            workspace_id,
            session_id: parent.session_id.clone(),
            condition: action.condition,
            max_turns: action.max_turns,
        })
        .await
        .map_err(|error| protocol_error("GOAL_SET_FAILED", error.to_string()))?;
    Ok(SessionControlResponse::new(SessionControlResult::Goal(
        GoalOutcome {
            active: true,
            goal_id: Some(goal.id),
            condition: Some(goal.condition),
            max_turns: Some(goal.max_turns),
        },
    )))
}

async fn clear_goal(
    parent: &ParentLaunchSettings,
    app: Option<&tauri::AppHandle>,
) -> Result<SessionControlResponse, SessionControlError> {
    let goals = goal_service(app)?;
    let cleared = goals
        .clear(&parent.session_id)
        .await
        .map_err(|error| protocol_error("GOAL_CLEAR_FAILED", error.to_string()))?;
    Ok(SessionControlResponse::new(SessionControlResult::Goal(
        GoalOutcome {
            active: false,
            goal_id: cleared.as_ref().map(|goal| goal.id.clone()),
            condition: cleared.map(|goal| goal.condition),
            max_turns: None,
        },
    )))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ipc::validation::TaskLabel;
    use crate::persistence::projects::{ProjectCounts, ProjectSettings};

    fn project(id: &str, name: &str, repo_path: &str) -> ProjectSummary {
        ProjectSummary {
            id: id.to_string(),
            name: name.to_string(),
            repo_path: repo_path.to_string(),
            current_branch: "main".to_string(),
            default_branch: Some("main".to_string()),
            settings: ProjectSettings {
                archive_on_merge: false,
                worktree_location: "/tmp/worktrees".to_string(),
                setup_command: String::new(),
                check_commands: Vec::new(),
            },
            counts: ProjectCounts {
                active: 0,
                blocked: 0,
                failed: 0,
                review_ready: 0,
            },
            latest_activity_at: None,
        }
    }

    #[test]
    fn title_uses_trimmed_first_line_and_unicode_character_cap() {
        assert_eq!(task_label("  Ship it  \nignore me"), "Ship it");
        assert_eq!(task_label("\nsecond line"), DEFAULT_TASK_LABEL);
        let long = "å".repeat(65);
        assert_eq!(task_label(&long), format!("{}...", "å".repeat(61)));
        assert_eq!(task_label(&long).chars().count(), 64);
        let multibyte = "😀".repeat(51);
        let label = task_label(&multibyte);
        assert_eq!(label, format!("{}...", "😀".repeat(49)));
        assert!(label.len() <= MAX_TASK_LABEL_BYTES);
        assert!(TaskLabel::try_from(label).is_ok());
    }

    #[test]
    fn resolver_uses_parent_id_then_exact_id_path_and_case_insensitive_name() {
        let projects = vec![
            project("one", "Argmax", "/tmp/argmax"),
            project("two", "Other", "/tmp/other"),
        ];
        assert_eq!(resolve_project(&projects, None, "two").unwrap().id, "two");
        assert_eq!(
            resolve_project(&projects, Some("one"), "two").unwrap().id,
            "one"
        );
        assert_eq!(
            resolve_project(&projects, Some("/tmp/other"), "one")
                .unwrap()
                .id,
            "two"
        );
        assert_eq!(
            resolve_project(&projects, Some("argmax"), "two")
                .unwrap()
                .id,
            "one"
        );
    }

    #[test]
    fn resolver_rejects_ambiguous_and_unknown_names() {
        let projects = vec![
            project("one", "Same", "/tmp/one"),
            project("two", "same", "/tmp/two"),
        ];
        assert_eq!(
            resolve_project(&projects, Some("SAME"), "one")
                .unwrap_err()
                .code,
            "PROJECT_SELECTOR_AMBIGUOUS"
        );
        assert_eq!(
            resolve_project(&projects, Some("missing"), "one")
                .unwrap_err()
                .code,
            "PROJECT_NOT_FOUND"
        );
    }
}
