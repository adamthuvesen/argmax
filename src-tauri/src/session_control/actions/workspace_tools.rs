//! The workspace-addressed tools: checks, status, diff, and terminals.
//!
//! Each one takes an optional `session` and defaults to the caller's own. That
//! is what makes them worth having at all: for its own tree an agent already
//! has `git status` and a shell, so the gap these close is reading — and
//! running checks in — a *peer's* workspace, and starting a process that
//! outlives the turn.

use std::{sync::Arc, time::Instant};

use serde::Serialize;
use tauri::Emitter;

use super::super::{
    argmax_protocol_error,
    protocol::{
        ChangedFile, CheckOutcome, ChecksOutcome, ChecksRunAction, SessionControlError,
        SessionControlResponse, SessionControlResult, TerminalOutput, TerminalReadAction,
        TerminalSpawnAction, TerminalStarted, TerminalSummary, WorkspaceDiffAction,
        WorkspaceDiffOutcome, WorkspaceStatusAction, WorkspaceStatusOutcome,
    },
    protocol_error,
    registry::ParentLaunchSettings,
    CHECKS_RUN_DEFAULT_TIMEOUT_MS, CHECKS_RUN_MAX_TIMEOUT_MS, TERMINAL_READ_DEFAULT_CHARS,
    TERMINAL_READ_MAX_CHARS, WORKSPACE_DIFF_DEFAULT_CHARS, WORKSPACE_DIFF_FILE_LIMIT,
    WORKSPACE_DIFF_MAX_CHARS,
};
use super::{terminal_cols, terminal_rows};
use crate::{
    persistence::{
        database::Database,
        projects::{find_project_by_id, ProjectSummary},
        sessions::find_session_by_id,
        workspaces::{find_workspace_by_id, WorkspaceSummary},
    },
    review::git_review,
    terminal::service::{TerminalRecordSummary, TerminalService, TerminalSpawnInput},
    workspaces::WorkspaceTargetKind,
};

/// The workspace one of these actions is about: the named session's, or the
/// caller's when none was named.
pub(super) struct SessionWorkspace {
    pub session_id: String,
    pub workspace: WorkspaceSummary,
    pub project: ProjectSummary,
}

pub(super) fn resolve_session_workspace(
    database: &Database,
    caller_session_id: &str,
    session: Option<&str>,
) -> Result<SessionWorkspace, SessionControlError> {
    let session_id = session.unwrap_or(caller_session_id);
    let connection = database.read_connection();
    let session = find_session_by_id(&connection, session_id).map_err(argmax_protocol_error)?;
    let workspace =
        find_workspace_by_id(&connection, &session.workspace_id).map_err(argmax_protocol_error)?;
    let project = find_project_by_id(&connection, &workspace.project_id)
        .map_err(argmax_protocol_error)?
        .ok_or_else(|| {
            protocol_error(
                "PROJECT_NOT_FOUND",
                "That session's project is no longer registered.",
            )
        })?;
    Ok(SessionWorkspace {
        session_id: session.id,
        workspace,
        project,
    })
}

/// Services that live on the app rather than on the socket's own dependencies.
/// The MCP process has no `AppHandle`, so these reach the running window the
/// same way the goal and browser actions do.
fn service<T>(
    app: Option<&tauri::AppHandle>,
    pick: impl Fn(&crate::state::AppState) -> Option<Arc<T>>,
) -> Option<Arc<T>> {
    use tauri::Manager;
    let app = app?;
    let state = app.try_state::<crate::state::AppState>()?;
    pick(&state)
}

pub(super) async fn run_checks(
    action: ChecksRunAction,
    parent: ParentLaunchSettings,
    database: Arc<Database>,
    app: Option<&tauri::AppHandle>,
) -> Result<SessionControlResponse, SessionControlError> {
    let target =
        resolve_session_workspace(&database, &parent.session_id, action.session.as_deref())?;
    let timeout_ms = action.timeout_ms.unwrap_or(CHECKS_RUN_DEFAULT_TIMEOUT_MS);
    if !(1..=CHECKS_RUN_MAX_TIMEOUT_MS).contains(&timeout_ms) {
        return Err(protocol_error(
            "CHECK_TIMEOUT_INVALID",
            format!("timeout_ms must be between 1 and {CHECKS_RUN_MAX_TIMEOUT_MS} milliseconds."),
        ));
    }
    // One named command, or the project's configured list. An empty list is
    // worth its own message: the answer is to configure the project, not to
    // retry with different arguments. Resolved before the service is asked
    // for, so the answer to a misconfigured project does not depend on
    // whether a window happens to be up.
    let commands = match action.command {
        Some(command) => vec![command],
        None if target.project.settings.check_commands.is_empty() => {
            return Err(protocol_error(
                "CHECKS_NOT_CONFIGURED",
                format!(
                    "Project '{}' has no check commands configured. Name a command to run instead.",
                    target.project.name
                ),
            ));
        }
        None => target.project.settings.check_commands.clone(),
    };
    let checks = service(app, |state| state.checks.get().cloned()).ok_or_else(|| {
        protocol_error(
            "CHECKS_UNAVAILABLE",
            "This Argmax instance cannot run checks right now.",
        )
    })?;

    let mut outcomes = Vec::new();
    let mut passed = true;
    let deadline = Instant::now() + std::time::Duration::from_millis(timeout_ms);
    for command in commands {
        let remaining_ms = deadline
            .saturating_duration_since(Instant::now())
            .as_millis()
            .clamp(1, u64::MAX as u128) as u64;
        let run = checks
            .run_workspace_check(
                crate::checks::service::RunWorkspaceCheckInput {
                    workspace_id: target.workspace.id.clone(),
                    command: command.clone(),
                    timeout_ms: Some(remaining_ms),
                },
                None,
            )
            .await
            .map_err(argmax_protocol_error)?;
        let ok = run.status == "passed";
        passed &= ok;
        outcomes.push(CheckOutcome {
            command: run.command,
            status: run.status,
            exit_code: run.exit_code,
            summary: run.summary,
        });
        // Stop at the first failure of a configured sequence: the later
        // commands would report a tree the earlier one never fixed.
        if !ok {
            break;
        }
    }
    Ok(SessionControlResponse::new(SessionControlResult::Checked(
        ChecksOutcome {
            session_id: target.session_id,
            workspace_id: target.workspace.id,
            passed,
            checks: outcomes,
        },
    )))
}

pub(super) fn workspace_status(
    action: WorkspaceStatusAction,
    parent: ParentLaunchSettings,
    database: Arc<Database>,
) -> Result<SessionControlResponse, SessionControlError> {
    let target =
        resolve_session_workspace(&database, &parent.session_id, action.session.as_deref())?;
    let workspace = target.workspace;
    Ok(SessionControlResponse::new(
        SessionControlResult::WorkspaceStatus(WorkspaceStatusOutcome {
            session_id: target.session_id,
            workspace_id: workspace.id,
            project_id: target.project.id,
            project_name: target.project.name,
            task_label: workspace.task_label,
            path: workspace.path,
            branch: workspace.branch,
            base_ref: workspace.base_ref,
            shared_checkout: workspace.shared_workspace,
            state: workspace.state,
            dirty: workspace.dirty,
            changed_files: workspace.changed_files,
            // A shared checkout is the user's own working copy: archiving one
            // closes the chat and leaves the tree alone.
            archivable: !workspace.shared_workspace && workspace.kind == "git",
            pr_number: workspace.pr_number,
            pr_state: workspace.pr_state,
            pr_check_state: workspace.pr_check_state,
        }),
    ))
}

pub(super) async fn workspace_diff(
    action: WorkspaceDiffAction,
    parent: ParentLaunchSettings,
    database: Arc<Database>,
) -> Result<SessionControlResponse, SessionControlError> {
    let target =
        resolve_session_workspace(&database, &parent.session_id, action.session.as_deref())?;
    let budget = action
        .max_chars
        .map(|value| (value as usize).min(WORKSPACE_DIFF_MAX_CHARS))
        .unwrap_or(WORKSPACE_DIFF_DEFAULT_CHARS);
    let comparison = action.comparison.unwrap_or_default();
    let workspace_id = target.workspace.id.clone();
    let changed = git_review::list_changed_files(
        database.as_ref(),
        WorkspaceTargetKind::Workspace,
        &workspace_id,
        comparison,
    )
    .await
    .map_err(argmax_protocol_error)?;
    let requested_path = action.file_path.as_deref();
    let matches_path = |path: &str| {
        requested_path.is_none_or(|requested| {
            path == requested
                || path
                    .strip_prefix(requested)
                    .is_some_and(|rest| rest.starts_with('/'))
        })
    };
    let relevant_file_count = changed
        .iter()
        .filter(|file| matches_path(&file.path))
        .count();
    let files = changed
        .iter()
        .filter(|file| matches_path(&file.path))
        .take(WORKSPACE_DIFF_FILE_LIMIT)
        .map(|file| ChangedFile {
            path: file.path.clone(),
            status: file.status.clone(),
            additions: file.additions,
            deletions: file.deletions,
        })
        .collect::<Vec<_>>();
    let mut truncated = relevant_file_count > files.len();
    // Nothing changed: skip the diff read rather than paying for a git
    // invocation that can only answer with an empty string.
    if files.is_empty() && action.file_path.is_none() {
        return Ok(SessionControlResponse::new(
            SessionControlResult::WorkspaceDiff(WorkspaceDiffOutcome {
                session_id: target.session_id,
                workspace_id,
                comparison,
                files,
                diff: String::new(),
                truncated,
            }),
        ));
    }
    let diff = git_review::load_diff(
        database.as_ref(),
        WorkspaceTargetKind::Workspace,
        &workspace_id,
        action.file_path.as_deref(),
        comparison,
        None,
    )
    .await
    .map_err(argmax_protocol_error)?;
    let (diff, diff_truncated) = cap_chars(&diff.content, budget);
    truncated |= diff_truncated;
    Ok(SessionControlResponse::new(
        SessionControlResult::WorkspaceDiff(WorkspaceDiffOutcome {
            session_id: target.session_id,
            workspace_id,
            comparison,
            files,
            diff,
            truncated,
        }),
    ))
}

pub(super) fn spawn_terminal(
    action: TerminalSpawnAction,
    parent: ParentLaunchSettings,
    database: Arc<Database>,
    app: Option<&tauri::AppHandle>,
) -> Result<SessionControlResponse, SessionControlError> {
    let target =
        resolve_session_workspace(&database, &parent.session_id, action.session.as_deref())?;
    let terminals = live_terminals(app)?;
    let command = action
        .command
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    let spawned = terminals
        .spawn(TerminalSpawnInput {
            workspace_id: target.workspace.id.clone(),
            cols: terminal_cols(120)?.get(),
            rows: terminal_rows(32)?.get(),
        })
        .map_err(argmax_protocol_error)?;
    if let Some(command) = command.as_deref() {
        terminals.record_command(&spawned.terminal_id, command);
    }
    // Announce the terminal before typing. The renderer subscribes globally
    // and buffers output until xterm adopts this id, so even a command that
    // exits immediately remains visible.
    if let Some(app) = app {
        if let Err(error) = app.emit(
            "terminal:agent-open",
            AgentTerminalOpen {
                terminal_id: &spawned.terminal_id,
                workspace_id: &target.workspace.id,
                command: command.as_deref(),
            },
        ) {
            tracing::warn!(?error, "could not show an agent terminal in the renderer");
        }
    }
    if let Some(command) = command.as_deref() {
        terminals
            .write(&spawned.terminal_id, format!("{command}\n").as_bytes())
            .map_err(argmax_protocol_error)?;
    }
    Ok(SessionControlResponse::new(
        SessionControlResult::TerminalStarted(TerminalStarted {
            terminal_id: spawned.terminal_id,
            session_id: target.session_id,
            workspace_id: target.workspace.id,
            path: target.workspace.path,
            command,
        }),
    ))
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AgentTerminalOpen<'a> {
    terminal_id: &'a str,
    workspace_id: &'a str,
    command: Option<&'a str>,
}

pub(super) fn read_terminal(
    action: TerminalReadAction,
    parent: ParentLaunchSettings,
    database: Arc<Database>,
    app: Option<&tauri::AppHandle>,
) -> Result<SessionControlResponse, SessionControlError> {
    let terminals = live_terminals(app)?;
    let budget = action
        .max_chars
        .map(|value| (value as usize).min(TERMINAL_READ_MAX_CHARS))
        .unwrap_or(TERMINAL_READ_DEFAULT_CHARS);
    // A named terminal answers for its own workspace, whichever session that
    // is: the id came from a spawn, and re-deriving the workspace from the
    // caller would refuse a terminal it legitimately holds.
    let (workspace_id, terminal, output, truncated) = match action.terminal_id {
        Some(terminal_id) => {
            let (summary, output, truncated) = terminals
                .read_terminal(&terminal_id, budget)
                .ok_or_else(|| {
                    protocol_error(
                        "TERMINAL_NOT_FOUND",
                        format!("No terminal {terminal_id} has run in this Argmax session."),
                    )
                })?;
            (
                summary.workspace_id.clone(),
                Some(summary),
                Some(output),
                truncated,
            )
        }
        None => {
            let target = resolve_session_workspace(
                &database,
                &parent.session_id,
                action.session.as_deref(),
            )?;
            (target.workspace.id, None, None, false)
        }
    };
    let terminals = terminals
        .workspace_terminals(&workspace_id)
        .into_iter()
        .map(terminal_summary)
        .collect::<Vec<_>>();
    Ok(SessionControlResponse::new(
        SessionControlResult::TerminalOutput(TerminalOutput {
            workspace_id,
            terminals,
            terminal_id: terminal.map(|summary| summary.terminal_id),
            output,
            truncated,
        }),
    ))
}

fn terminal_summary(record: TerminalRecordSummary) -> TerminalSummary {
    TerminalSummary {
        terminal_id: record.terminal_id,
        running: record.running,
        started_at: record.started_at,
        command: record.command,
        exit_code: record.exit_code,
    }
}

fn live_terminals(
    app: Option<&tauri::AppHandle>,
) -> Result<Arc<TerminalService>, SessionControlError> {
    service(app, |state| state.terminals.get().cloned()).ok_or_else(|| {
        protocol_error(
            "TERMINAL_UNAVAILABLE",
            "This Argmax instance has no terminal service running.",
        )
    })
}

/// The first `max_chars` characters of a diff. A diff reads from the top, so
/// this keeps the head — the opposite of a terminal, where the tail is what
/// just happened.
fn cap_chars(value: &str, max_chars: usize) -> (String, bool) {
    if value.chars().count() <= max_chars {
        return (value.to_string(), false);
    }
    (value.chars().take(max_chars).collect(), true)
}
