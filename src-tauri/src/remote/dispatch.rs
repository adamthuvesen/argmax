// Channel dispatch for the remote bridge.
//
// A remote client has no Tauri invoke pipeline, so this module parses the
// channel's input struct itself and calls the same `&AppState` implementation
// the `#[tauri::command]` wrapper in `crate::ipc` calls. Inputs deserialize
// into the exact same structs, so validation, error codes, and locking order
// are identical on both paths.
//
// Every channel in `crate::ipc::REGISTERED_CHANNELS` must be either handled
// here or listed in `REMOTE_UNSUPPORTED_CHANNELS`; a test enforces that.

use serde::de::DeserializeOwned;
use serde::Serialize;
use serde_json::Value;

use crate::error::{ArgmaxError, ArgmaxResult, InvalidInputIssue};
use crate::ipc::inputs::*;
use crate::ipc::{
    approvals, checks, dashboard, git_ops, health, learnings, projects, providers, prs, review,
    session, skills, system, terminal, workspace_files, workspaces,
};
use crate::state::AppState;

/// Channels whose handlers need an `AppHandle` (native dialogs, the shell
/// opener, window theming, the on-disk attachment store keyed by app data dir)
/// and therefore cannot run for a browser client.
pub const REMOTE_UNSUPPORTED_CHANNELS: &[&str] = &[
    "projects:pick-folder",
    "attachments:save-image",
    "system:open-path",
    "system:diagnostics",
    "system:set-theme",
    "remote:get-status",
    "remote:set-config",
    "remote:test-notification",
    // The browser pane manipulates the desktop app's native child webview.
    "browser:open",
    "browser:navigate",
    "browser:back",
    "browser:forward",
    "browser:reload",
    "browser:set-bounds",
    "browser:close",
    "browser:fill-credentials",
];

pub async fn dispatch(state: &AppState, channel: &str, input: Value) -> ArgmaxResult<Value> {
    if REMOTE_UNSUPPORTED_CHANNELS.contains(&channel) {
        return Err(ArgmaxError::service(
            "REMOTE_UNSUPPORTED",
            format!("{channel} is only available in the desktop app"),
        ));
    }

    match channel {
        "health:ping" => encode(health::health_ping(parse(channel, input)?)),

        "projects:list" => {
            let _input: ProjectsListInput = parse(channel, input)?;
            encode(projects::projects_list_impl(state)?)
        }
        "projects:register" => {
            let input: ProjectsRegisterInput = parse(channel, input)?;
            encode(
                projects::register_project_path(state, input.repo_path.into_string().into())
                    .await?,
            )
        }
        "projects:remove" => {
            let input: ProjectsRemoveInput = parse(channel, input)?;
            encode(projects::projects_remove_impl(state, input).await?)
        }
        "projects:update-settings" => {
            let input: ProjectsUpdateSettingsInput = parse(channel, input)?;
            encode(projects::projects_update_settings_impl(state, input)?)
        }
        "projects:list-branches" => {
            let input: ProjectsListBranchesInput = parse(channel, input)?;
            encode(projects::projects_list_branches_impl(state, input).await?)
        }
        "projects:refresh-branch" => {
            let input: ProjectsRefreshBranchInput = parse(channel, input)?;
            encode(projects::projects_refresh_branch_impl(state, input).await?)
        }
        "projects:switch-branch" => {
            let input: ProjectsSwitchBranchInput = parse(channel, input)?;
            encode(projects::projects_switch_branch_impl(state, input).await?)
        }

        "dashboard:list" => {
            let _input: DashboardListInput = parse(channel, input)?;
            encode(dashboard::dashboard_list_impl(state)?)
        }
        "workspace:status" => {
            let input: WorkspaceStatusInput = parse(channel, input)?;
            encode(workspace_files::workspace_status_impl(state, input)?)
        }

        "workspaces:create-isolated" => {
            let input: WorkspacesCreateIsolatedInput = parse(channel, input)?;
            encode(workspaces::workspaces_create_isolated_impl(state, input).await?)
        }
        "workspaces:create-current" => {
            let input: WorkspacesCreateCurrentInput = parse(channel, input)?;
            encode(workspaces::workspaces_create_current_impl(state, input)?)
        }
        "workspaces:create-scratch" => {
            let input: WorkspacesCreateScratchInput = parse(channel, input)?;
            encode(workspaces::workspaces_create_scratch_impl(state, input).await?)
        }
        "workspaces:refresh-status" => {
            let input: WorkspacesRefreshStatusInput = parse(channel, input)?;
            encode(workspaces::workspaces_refresh_status_impl(state, input).await?)
        }
        "workspaces:keep" => {
            let input: WorkspacesKeepInput = parse(channel, input)?;
            encode(workspaces::workspaces_keep_impl(state, input)?)
        }
        "workspaces:archive" => {
            let input: WorkspacesArchiveInput = parse(channel, input)?;
            encode(workspaces::workspaces_archive_impl(state, input).await?)
        }
        "workspaces:open-in-ide" => {
            let input: WorkspacesOpenInIdeInput = parse(channel, input)?;
            encode(workspaces::workspaces_open_in_ide_impl(state, input)?)
        }
        "workspaces:autotitle" => {
            let input: WorkspacesAutotitleInput = parse(channel, input)?;
            encode(workspaces::workspaces_autotitle_impl(state, input).await?)
        }
        "workspaces:set-pinned" => {
            let input: WorkspacesSetPinnedInput = parse(channel, input)?;
            encode(workspaces::workspaces_set_pinned_impl(state, input)?)
        }
        "workspaces:set-priority-added" => {
            let input: WorkspacesSetPriorityAddedInput = parse(channel, input)?;
            encode(workspaces::workspaces_set_priority_added_impl(
                state, input,
            )?)
        }
        "workspaces:set-priority-dismissed" => {
            let input: WorkspacesSetPriorityDismissedInput = parse(channel, input)?;
            encode(workspaces::workspaces_set_priority_dismissed_impl(
                state, input,
            )?)
        }
        "workspaces:set-label" => {
            let input: WorkspacesSetLabelInput = parse(channel, input)?;
            encode(workspaces::workspaces_set_label_impl(state, input)?)
        }
        "workspaces:set-icon" => {
            let input: WorkspacesSetIconInput = parse(channel, input)?;
            encode(workspaces::workspaces_set_icon_impl(state, input)?)
        }

        "providers:discover" => {
            let input: ProvidersDiscoverInput = parse(channel, input)?;
            encode(providers::providers_discover_impl(state, input).await?)
        }
        "providers:launch" => {
            let input: ProvidersLaunchInput = parse(channel, input)?;
            encode(providers::providers_launch_impl(state, input).await?)
        }
        "providers:send-input" => {
            let input: ProvidersSendInput = parse(channel, input)?;
            encode(providers::providers_send_input_impl(state, input).await?)
        }
        "providers:resize" => {
            let input: ProvidersResizeInput = parse(channel, input)?;
            encode(providers::providers_resize_impl(state, input)?)
        }
        "providers:terminate" => {
            let input: ProvidersTerminateInput = parse(channel, input)?;
            encode(providers::providers_terminate_impl(state, input).await?)
        }
        "providers:cancel-queued-message" => {
            let input: ProvidersCancelQueuedMessageInput = parse(channel, input)?;
            encode(providers::providers_cancel_queued_message_impl(
                state, input,
            )?)
        }
        "providers:send-queued-message-now" => {
            let input: ProvidersSendQueuedMessageNowInput = parse(channel, input)?;
            encode(providers::providers_send_queued_message_now_impl(state, input).await?)
        }

        "terminal:spawn" => {
            let input: TerminalSpawnInput = parse(channel, input)?;
            encode(terminal::terminal_spawn_impl(state, input)?)
        }
        "terminal:write" => {
            let input: TerminalWriteInput = parse(channel, input)?;
            encode(terminal::terminal_write_impl(state, input)?)
        }
        "terminal:resize" => {
            let input: TerminalResizeInput = parse(channel, input)?;
            encode(terminal::terminal_resize_impl(state, input)?)
        }
        "terminal:terminate" => {
            let input: TerminalTerminateInput = parse(channel, input)?;
            encode(terminal::terminal_terminate_impl(state, input).await?)
        }

        "approvals:resolve" => {
            let input: ApprovalsResolveInput = parse(channel, input)?;
            encode(approvals::approvals_resolve_impl(state, input)?)
        }
        "approvals:pending" => {
            let _input: ApprovalsPendingInput = parse(channel, input)?;
            encode(approvals::approvals_pending_impl(state)?)
        }

        "session:events-since" => {
            let input: SessionEventsSinceInput = parse(channel, input)?;
            encode(session::session_events_since_impl(state, input)?)
        }
        "session:agent-events" => {
            let input: SessionAgentEventsInput = parse(channel, input)?;
            encode(session::session_agent_events_impl(state, input).await?)
        }
        "session:cost-summary" => {
            let input: SessionCostSummaryInput = parse(channel, input)?;
            encode(session::session_cost_summary_impl(state, input)?)
        }
        "session:search" => {
            let input: SessionSearchInput = parse(channel, input)?;
            encode(session::session_search_impl(state, input)?)
        }

        "review:list-changed-files" => {
            let input: ReviewListChangedFilesInput = parse(channel, input)?;
            encode(review::review_list_changed_files_impl(state, input).await?)
        }
        "review:load-diff" => {
            let input: ReviewLoadDiffInput = parse(channel, input)?;
            encode(review::review_load_diff_impl(state, input).await?)
        }

        "workspace:list-files" => {
            let input: WorkspaceListFilesInput = parse(channel, input)?;
            encode(workspace_files::workspace_list_files_impl(state, input).await?)
        }
        "workspace:read-file" => {
            let input: WorkspaceReadFileInput = parse(channel, input)?;
            encode(workspace_files::workspace_read_file_impl(state, input).await?)
        }
        "workspace:write-file" => {
            let input: WorkspaceWriteFileInput = parse(channel, input)?;
            encode(workspace_files::workspace_write_file_impl(state, input).await?)
        }
        "workspace:stat-file" => {
            let input: WorkspaceStatFileInput = parse(channel, input)?;
            encode(workspace_files::workspace_stat_file_impl(state, input).await?)
        }
        "workspace:grep-content" => {
            let input: WorkspaceGrepContentInput = parse(channel, input)?;
            encode(workspace_files::workspace_grep_content_impl(state, input).await?)
        }

        "checks:run" => {
            let input: ChecksRunInput = parse(channel, input)?;
            encode(checks::checks_run_impl(state, input).await?)
        }
        "skills:list" => {
            let input: SkillsListInput = parse(channel, input)?;
            encode(skills::skills_list_impl(state, input)?)
        }

        "system:list-detected-ides" => {
            encode(system::system_list_detected_ides(parse(channel, input)?).await)
        }
        "system:vacuum-database" => {
            let _input: SystemVacuumDatabaseInput = parse(channel, input)?;
            encode(system::system_vacuum_database_impl(state).await?)
        }

        "learnings:list" => {
            let input: LearningsListInput = parse(channel, input)?;
            encode(learnings::learnings_list_impl(state, input)?)
        }
        "learnings:update" => {
            let input: LearningsUpdateInput = parse(channel, input)?;
            encode(learnings::learnings_update_impl(state, input)?)
        }
        "learnings:delete" => {
            let input: LearningsDeleteInput = parse(channel, input)?;
            encode(learnings::learnings_delete_impl(state, input)?)
        }

        "prs:list-for-session" => {
            let input: PrsListForSessionInput = parse(channel, input)?;
            encode(prs::prs_list_for_session_impl(state, input)?)
        }
        "prs:refresh" => {
            let input: PrsRefreshInput = parse(channel, input)?;
            encode(prs::prs_refresh_impl(state, input).await?)
        }

        "git:commit" => {
            let input: GitCommitInput = parse(channel, input)?;
            encode(git_ops::git_commit_impl(state, input).await?)
        }
        "git:push" => {
            let input: GitPushInput = parse(channel, input)?;
            encode(git_ops::git_push_impl(state, input).await?)
        }
        "git:create-branch" => {
            let input: GitCreateBranchInput = parse(channel, input)?;
            encode(git_ops::git_create_branch_impl(state, input).await?)
        }
        "git:view-or-create-pr" => {
            let input: GitViewOrCreatePrInput = parse(channel, input)?;
            encode(git_ops::git_view_or_create_pr_impl(state, input).await?)
        }

        _ => Err(ArgmaxError::service(
            "UNKNOWN_CHANNEL",
            format!("unknown channel: {channel}"),
        )),
    }
}

fn parse<T: DeserializeOwned>(channel: &str, input: Value) -> ArgmaxResult<T> {
    serde_json::from_value(input).map_err(|error| {
        ArgmaxError::invalid(InvalidInputIssue::at(
            vec!["input".to_string()],
            "REMOTE_INPUT_INVALID",
            format!("{channel}: {error}"),
        ))
    })
}

fn encode<T: Serialize>(value: T) -> ArgmaxResult<Value> {
    serde_json::to_value(value)
        .map_err(|error| ArgmaxError::service("REMOTE_ENCODE_FAILED", error.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ipc::REGISTERED_CHANNELS;
    use crate::persistence::Database;
    use std::sync::Arc;

    #[tokio::test]
    async fn every_registered_channel_is_implemented_or_declared_unsupported() {
        let state = AppState::new();
        let mut unknown = Vec::new();

        for channel in REGISTERED_CHANNELS {
            if REMOTE_UNSUPPORTED_CHANNELS.contains(channel) {
                continue;
            }
            // `Value::Null` fails every input parse, so a handled channel
            // reports invalid input long before it touches a service.
            let error = dispatch(&state, channel, Value::Null)
                .await
                .expect_err("garbage input never succeeds");
            if is_service_error(&error, "UNKNOWN_CHANNEL") {
                unknown.push(*channel);
            }
        }

        assert!(
            unknown.is_empty(),
            "channels missing from the remote dispatcher: {}",
            unknown.join(", ")
        );
    }

    #[test]
    fn unsupported_channels_are_registered_channels() {
        for channel in REMOTE_UNSUPPORTED_CHANNELS {
            assert!(
                REGISTERED_CHANNELS.contains(channel),
                "{channel} is not a registered IPC channel"
            );
        }
    }

    #[tokio::test]
    async fn dispatch_reads_the_live_database_and_rejects_native_channels() {
        let state = AppState::new();
        assert!(state
            .db
            .set(Arc::new(Database::open_in_memory().expect("open database")))
            .is_ok());

        let ping = dispatch(&state, "health:ping", serde_json::json!({}))
            .await
            .expect("health ping");
        assert_eq!(ping["ok"], true);

        let dashboard = dispatch(&state, "dashboard:list", serde_json::json!({}))
            .await
            .expect("dashboard list");
        assert!(dashboard["projects"]
            .as_array()
            .expect("projects array")
            .is_empty());

        let unsupported = dispatch(
            &state,
            "system:set-theme",
            serde_json::json!({"mode": "dark"}),
        )
        .await
        .expect_err("native channel rejected");
        assert!(is_service_error(&unsupported, "REMOTE_UNSUPPORTED"));

        let unknown = dispatch(&state, "nope:nope", Value::Null)
            .await
            .expect_err("unknown channel rejected");
        assert!(is_service_error(&unknown, "UNKNOWN_CHANNEL"));
    }

    #[tokio::test]
    async fn malformed_input_is_reported_as_invalid_not_a_panic() {
        let state = AppState::new();

        let error = dispatch(&state, "session:search", serde_json::json!({"query": 7}))
            .await
            .expect_err("bad query type rejected");

        assert!(matches!(error, ArgmaxError::InvalidInput { .. }));
    }

    fn is_service_error(error: &ArgmaxError, expected: &str) -> bool {
        matches!(error, ArgmaxError::ServiceError { sub_code, .. } if sub_code == expected)
    }
}
