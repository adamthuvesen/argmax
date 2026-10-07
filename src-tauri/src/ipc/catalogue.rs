//! Command registration, remote availability, and dispatch share this catalogue.
//! Each remote arm calls the same typed application operation as its Tauri adapter.
use super::inputs::*;
use super::*;
use crate::remote::dispatch::{encode, parse};
use serde_json::Value;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RemoteAccess {
    Desktop,
    Read,
    Control,
}

pub struct CommandContract {
    pub channel: &'static str,
    pub method: &'static str,
    pub remote: RemoteAccess,
}

macro_rules! remote_access {
    (desktop) => {
        RemoteAccess::Desktop
    };
    (read) => {
        RemoteAccess::Read
    };
    (control) => {
        RemoteAccess::Control
    };
}

macro_rules! command_catalogue {
    ($( $channel:literal => $module:ident::$method:ident, $access:ident,
        |$state:ident, $input:ident, $agent:ident, $name:ident| $body:block; )*) => {
        pub const REGISTERED_CHANNELS: &[&str] = &[$($channel),*];
        pub const COMMAND_CONTRACTS: &[CommandContract] = &[$(CommandContract {
            channel: $channel, method: stringify!($method), remote: remote_access!($access),
        }),*];
        pub fn specta_builder() -> SpectaBuilder<tauri::Wry> {
            SpectaBuilder::new().commands(collect_commands![$($module::$method),*])
                .typ::<super::events::PushPayloads>()
        }
        pub fn dispatch<'a>(
            state: &'a AppState, channel: &'a str, input: Value,
            default_agent: crate::default_agent::DefaultAgent,
        ) -> crate::providers::runtime::BoxFuture<'a, ArgmaxResult<Value>> {
            // Box each operation separately. A combined async match retained every
            // workflow's debug frame and exceeded the worker stack budget.
            match channel {
                $($channel => Box::pin(async move {
                    #[allow(unused_variables)]
                    let ($state, $input, $agent, $name) = (state, input, default_agent, channel);
                    $body
                }),)*
                _ => Box::pin(async move { Err(ArgmaxError::service(
                    "UNKNOWN_CHANNEL", format!("unknown channel: {channel}"),
                )) }),
            }
        }
    }
}

command_catalogue! {
    "health:ping" => health::health_ping, read,
    |state, input, default_agent, channel| { encode(health::health_ping(parse(channel, input)?)) };

    "projects:list" => projects::projects_list, read,
    |state, input, default_agent, channel| {
            let _input: ProjectsListInput = parse(channel, input)?;
            encode(projects::projects_list_impl(state).await?)
        };

    "projects:pick-folder" => projects::projects_pick_folder, desktop,
    |state, input, default_agent, channel| { Err(ArgmaxError::service("REMOTE_UNSUPPORTED", format!("{channel} is only available in the desktop app"))) };

    "projects:check-prompt" => projects::projects_check_prompt, control,
    |state, input, default_agent, channel| {
            let input: ProjectsCheckPromptInput = parse(channel, input)?;
            encode(projects::projects_check_prompt_impl(state, input).await?)
        };

    "projects:resolve-check" => projects::projects_resolve_check, control,
    |state, input, default_agent, channel| {
            let input: ProjectsResolveCheckInput = parse(channel, input)?;
            encode(projects::projects_resolve_check_impl(state, input).await?)
        };

    "dashboard:list" => dashboard::dashboard_list, read,
    |state, input, default_agent, channel| {
            let _input: DashboardListInput = parse(channel, input)?;
            encode(dashboard::dashboard_list_impl(state).await?)
        };

    "projects:register" => projects::projects_register, control,
    |state, input, default_agent, channel| {
            let input: ProjectsRegisterInput = parse(channel, input)?;
            encode(
                projects::register_project_path(state, input.repo_path.into_string().into())
                    .await?,
            )
        };

    "projects:remove" => projects::projects_remove, control,
    |state, input, default_agent, channel| {
            let input: ProjectsRemoveInput = parse(channel, input)?;
            encode(projects::projects_remove_impl(state, input).await?)
        };

    "projects:update-settings" => projects::projects_update_settings, control,
    |state, input, default_agent, channel| {
            let input: ProjectsUpdateSettingsInput = parse(channel, input)?;
            encode(projects::projects_update_settings_impl(state, input)?)
        };

    "projects:list-branches" => projects::projects_list_branches, read,
    |state, input, default_agent, channel| {
            let input: ProjectsListBranchesInput = parse(channel, input)?;
            encode(projects::projects_list_branches_impl(state, input).await?)
        };

    "projects:refresh-branch" => projects::projects_refresh_branch, control,
    |state, input, default_agent, channel| {
            let input: ProjectsRefreshBranchInput = parse(channel, input)?;
            encode(projects::projects_refresh_branch_impl(state, input).await?)
        };

    "projects:switch-branch" => projects::projects_switch_branch, control,
    |state, input, default_agent, channel| {
            let input: ProjectsSwitchBranchInput = parse(channel, input)?;
            encode(projects::projects_switch_branch_impl(state, input).await?)
        };

    "projects:list-checkouts" => projects::projects_list_checkouts, read,
    |state, input, default_agent, channel| {
            let input: ProjectsListCheckoutsInput = parse(channel, input)?;
            encode(projects::projects_list_checkouts_impl(state, input).await?)
        };

    "workspaces:create-alongside" => workspaces::workspaces_create_alongside, control,
    |state, input, default_agent, channel| {
            let input: crate::workspaces::inputs::WorkspacesCreateInCheckoutInput = parse(channel, input)?;
            encode(workspaces::workspaces_create_alongside_impl(state, input).await?)
        };

    "workspaces:create-isolated" => workspaces::workspaces_create_isolated, control,
    |state, input, default_agent, channel| {
            let input: WorkspacesCreateIsolatedInput = parse(channel, input)?;
            encode(workspaces::workspaces_create_isolated_impl(state, input).await?)
        };

    "workspaces:create-current" => workspaces::workspaces_create_current, control,
    |state, input, default_agent, channel| {
            let input: WorkspacesCreateCurrentInput = parse(channel, input)?;
            encode(workspaces::workspaces_create_current_impl(state, input)?)
        };

    "workspaces:create-scratch" => workspaces::workspaces_create_scratch, control,
    |state, input, default_agent, channel| {
            let input: WorkspacesCreateScratchInput = parse(channel, input)?;
            encode(workspaces::workspaces_create_scratch_impl(state, input).await?)
        };

    "workspaces:refresh-status" => workspaces::workspaces_refresh_status, control,
    |state, input, default_agent, channel| {
            let input: WorkspacesRefreshStatusInput = parse(channel, input)?;
            encode(workspaces::workspaces_refresh_status_impl(state, input).await?)
        };

    "workspaces:keep" => workspaces::workspaces_keep, control,
    |state, input, default_agent, channel| {
            let input: WorkspacesKeepInput = parse(channel, input)?;
            encode(workspaces::workspaces_keep_impl(state, input)?)
        };

    "workspaces:archive" => workspaces::workspaces_archive, control,
    |state, input, default_agent, channel| {
            let input: WorkspacesArchiveInput = parse(channel, input)?;
            encode(workspaces::workspaces_archive_impl(state, input).await?)
        };

    "workspaces:open-in-ide" => workspaces::workspaces_open_in_ide, control,
    |state, input, default_agent, channel| {
            let input: WorkspacesOpenInIdeInput = parse(channel, input)?;
            encode(workspaces::workspaces_open_in_ide_impl(state, input).await?)
        };

    "workspaces:autotitle" => workspaces::workspaces_autotitle, control,
    |state, input, default_agent, channel| {
            let input: WorkspacesAutotitleInput = parse(channel, input)?;
            encode(workspaces::workspaces_autotitle_impl(state, input).await?)
        };

    "workspace:status" => workspace_files::workspace_status, read,
    |state, input, default_agent, channel| {
            let input: WorkspaceStatusInput = parse(channel, input)?;
            encode(workspace_files::workspace_status_impl(state, input).await?)
        };

    "providers:discover" => providers::providers_discover, read,
    |state, input, default_agent, channel| {
            let input: ProvidersDiscoverInput = parse(channel, input)?;
            encode(providers::providers_discover_impl(state, input).await?)
        };

    "providers:launch" => providers::providers_launch, control,
    |state, input, default_agent, channel| {
            let input: ProvidersLaunchInput = parse(channel, input)?;
            encode(providers::providers_launch_impl(state, input, &default_agent).await?)
        };

    "providers:send-input" => providers::providers_send_input, control,
    |state, input, default_agent, channel| {
            let input: ProvidersSendInput = parse(channel, input)?;
            encode(providers::providers_send_input_impl(state, input).await?)
        };

    "providers:steer-input" => providers::providers_steer_input, control,
    |state, input, default_agent, channel| {
            let input: ProvidersSendInput = parse(channel, input)?;
            encode(providers::providers_steer_input_impl(state, input).await?)
        };

    "providers:resize" => providers::providers_resize, control,
    |state, input, default_agent, channel| {
            let input: ProvidersResizeInput = parse(channel, input)?;
            encode(providers::providers_resize_impl(state, input)?)
        };

    "providers:terminate" => providers::providers_terminate, control,
    |state, input, default_agent, channel| {
            let input: ProvidersTerminateInput = parse(channel, input)?;
            encode(providers::providers_terminate_impl(state, input).await?)
        };

    "providers:cancel-queued-message" => providers::providers_cancel_queued_message, control,
    |state, input, default_agent, channel| {
            let input: ProvidersCancelQueuedMessageInput = parse(channel, input)?;
            encode(providers::providers_cancel_queued_message_impl(
                state, input,
            )?)
        };

    "providers:send-queued-message-now" => providers::providers_send_queued_message_now, control,
    |state, input, default_agent, channel| {
            let input: ProvidersSendQueuedMessageNowInput = parse(channel, input)?;
            encode(providers::providers_send_queued_message_now_impl(state, input).await?)
        };

    "cloud:prepare" => cloud::cloud_prepare, read,
    |state, input, default_agent, channel| {
            let input: cloud::CloudPrepareInput = parse(channel, input)?;
            encode(cloud::cloud_prepare_impl(state, input).await?)
        };

    "cloud:launch" => cloud::cloud_launch, control,
    |state, input, default_agent, channel| {
            let input: cloud::CloudLaunchInput = parse(channel, input)?;
            encode(cloud::cloud_launch_impl(state, input).await?)
        };

    "attachments:save-image" => attachments::attachments_save_image, control,
    |state, input, default_agent, channel| {
            let input: AttachmentsSaveImageInput = parse(channel, input)?;
            let store = state.attachments.get().ok_or_else(|| {
                ArgmaxError::service(
                    "ATTACHMENT_STORE_NOT_READY",
                    "attachment storage is not initialized",
                )
            })?;
            encode(attachments::save_image(store, input)?)
        };

    "terminal:spawn" => terminal::terminal_spawn, control,
    |state, input, default_agent, channel| {
            let input: TerminalSpawnInput = parse(channel, input)?;
            encode(terminal::terminal_spawn_impl(state, input)?)
        };

    "terminal:write" => terminal::terminal_write, control,
    |state, input, default_agent, channel| {
            let input: TerminalWriteInput = parse(channel, input)?;
            encode(terminal::terminal_write_impl(state, input)?)
        };

    "terminal:resize" => terminal::terminal_resize, control,
    |state, input, default_agent, channel| {
            let input: TerminalResizeInput = parse(channel, input)?;
            encode(terminal::terminal_resize_impl(state, input)?)
        };

    "terminal:terminate" => terminal::terminal_terminate, control,
    |state, input, default_agent, channel| {
            let input: TerminalTerminateInput = parse(channel, input)?;
            encode(terminal::terminal_terminate_impl(state, input).await?)
        };

    "approvals:resolve" => approvals::approvals_resolve, control,
    |state, input, default_agent, channel| {
            let input: ApprovalsResolveInput = parse(channel, input)?;
            encode(approvals::approvals_resolve_impl(state, input)?)
        };

    "approvals:pending" => approvals::approvals_pending, read,
    |state, input, default_agent, channel| {
            let _input: ApprovalsPendingInput = parse(channel, input)?;
            encode(approvals::approvals_pending_impl(state)?)
        };

    "questions:resolve" => questions::questions_resolve, control,
    |state, input, default_agent, channel| {
            let input: QuestionsResolveInput = parse(channel, input)?;
            encode(questions::questions_resolve_impl(state, input).await?)
        };

    "session:events-since" => session::session_events_since, read,
    |state, input, default_agent, channel| {
            let input: SessionEventsSinceInput = parse(channel, input)?;
            let row_paged = input.change_cursor.is_none();
            let mut page = session::session_events_since_remote_impl(
                state,
                input,
                crate::remote::transcript_trim::REMOTE_PAGE_BUDGET_BYTES - 128,
            )
            .await?;
            crate::remote::transcript_trim::trim_for_remote(&mut page);
            if row_paged || page.reset_required {
                crate::remote::transcript_trim::fit_to_budget(
                    &mut page,
                    crate::remote::transcript_trim::REMOTE_PAGE_BUDGET_BYTES,
                );
            }
            encode(page)
        };

    "session:agent-events" => session::session_agent_events, read,
    |state, input, default_agent, channel| {
            let input: SessionAgentEventsInput = parse(channel, input)?;
            let mut page = session::session_agent_events_impl(state, input).await?;
            crate::remote::transcript_trim::trim_payloads_for_remote(&mut page);
            encode(page)
        };

    "session:fork" => session::session_fork, control,
    |state, input, default_agent, channel| {
            let input: SessionForkInput = parse(channel, input)?;
            encode(session::session_fork_impl_async(state, input).await?)
        };

    "session:fork-lineage" => session::session_fork_lineage, read,
    |state, input, default_agent, channel| {
            let input: SessionForkLineageInput = parse(channel, input)?;
            encode(session::session_fork_lineage_impl(state, input).await?)
        };

    "session:fork-merge-preview" => session::session_fork_merge_preview, read,
    |state, input, default_agent, channel| {
            let input: SessionForkMergePreviewInput = parse(channel, input)?;
            encode(session::session_fork_merge_preview_impl(state, input).await?)
        };

    "session:fork-merge" => session::session_fork_merge, control,
    |state, input, default_agent, channel| {
            let input: SessionForkMergeInput = parse(channel, input)?;
            encode(session::session_fork_merge_impl(state, input).await?)
        };

    "session:multitask" => session::session_multitask, control,
    |state, input, default_agent, channel| {
            let input: SessionMultitaskInput = parse(channel, input)?;
            encode(session::session_multitask_impl(state, input).await?)
        };

    "session:clear" => session::session_clear, control,
    |state, input, default_agent, channel| {
            let input: SessionClearInput = parse(channel, input)?;
            encode(session::session_clear_impl(state, input).await?)
        };

    "session:suggest-follow-up" => session::session_suggest_follow_up, control,
    |state, input, default_agent, channel| {
            let input: SessionSuggestFollowUpInput = parse(channel, input)?;
            encode(session::session_suggest_follow_up_impl(state, input).await?)
        };

    "settings:agent-tools" => settings::settings_agent_tools, desktop,
    |state, input, default_agent, channel| { Err(ArgmaxError::service("REMOTE_UNSUPPORTED", format!("{channel} is only available in the desktop app"))) };

    "settings:set-browser-tools" => settings::settings_set_browser_tools, desktop,
    |state, input, default_agent, channel| { Err(ArgmaxError::service("REMOTE_UNSUPPORTED", format!("{channel} is only available in the desktop app"))) };

    "settings:routing" => settings::settings_routing, read,
    |state, input, default_agent, channel| {
            let _: SettingsRoutingInput = parse(channel, input)?;
            encode(settings::settings_routing_impl(state).await?)
        };

    "settings:set-project-check" => settings::settings_set_project_check, desktop,
    |state, input, default_agent, channel| { Err(ArgmaxError::service("REMOTE_UNSUPPORTED", format!("{channel} is only available in the desktop app"))) };

    "settings:set-routing-key" => settings::settings_set_routing_key, desktop,
    |state, input, default_agent, channel| { Err(ArgmaxError::service("REMOTE_UNSUPPORTED", format!("{channel} is only available in the desktop app"))) };

    "settings:clear-routing-key" => settings::settings_clear_routing_key, desktop,
    |state, input, default_agent, channel| { Err(ArgmaxError::service("REMOTE_UNSUPPORTED", format!("{channel} is only available in the desktop app"))) };

    "settings:preview-chat-cleanup" => settings::settings_preview_chat_cleanup, desktop,
    |state, input, default_agent, channel| { Err(ArgmaxError::service("REMOTE_UNSUPPORTED", format!("{channel} is only available in the desktop app"))) };

    "settings:delete-old-chats" => settings::settings_delete_old_chats, desktop,
    |state, input, default_agent, channel| { Err(ArgmaxError::service("REMOTE_UNSUPPORTED", format!("{channel} is only available in the desktop app"))) };

    "window-snapshot:status" => window_snapshot::window_snapshot_status, desktop,
    |state, input, default_agent, channel| { Err(ArgmaxError::service("REMOTE_UNSUPPORTED", format!("{channel} is only available in the desktop app"))) };

    "window-snapshot:configure" => window_snapshot::window_snapshot_configure, desktop,
    |state, input, default_agent, channel| { Err(ArgmaxError::service("REMOTE_UNSUPPORTED", format!("{channel} is only available in the desktop app"))) };

    "window-snapshot:request-permission" => window_snapshot::window_snapshot_request_permission, desktop,
    |state, input, default_agent, channel| { Err(ArgmaxError::service("REMOTE_UNSUPPORTED", format!("{channel} is only available in the desktop app"))) };

    "review:list-changed-files" => review::review_list_changed_files, read,
    |state, input, default_agent, channel| {
            let input: ReviewListChangedFilesInput = parse(channel, input)?;
            encode(review::review_list_changed_files_impl(state, input).await?)
        };

    "review:load-diff" => review::review_load_diff, read,
    |state, input, default_agent, channel| {
            let input: ReviewLoadDiffInput = parse(channel, input)?;
            encode(review::review_load_diff_impl(state, input).await?)
        };

    "review:stage-file" => review::review_stage_file, control,
    |state, input, default_agent, channel| {
            let input: review::ReviewIndexFileInput = parse(channel, input)?;
            encode(
                review::review_update_file_index_impl(state, input, channel == "review:stage-file")
                    .await?,
            )
        };

    "review:unstage-file" => review::review_unstage_file, control,
    |state, input, default_agent, channel| {
            let input: review::ReviewIndexFileInput = parse(channel, input)?;
            encode(
                review::review_update_file_index_impl(state, input, channel == "review:stage-file")
                    .await?,
            )
        };

    "review:stage-hunk" => review::review_stage_hunk, control,
    |state, input, default_agent, channel| {
            let input: review::ReviewIndexHunkInput = parse(channel, input)?;
            encode(
                review::review_update_hunk_index_impl(state, input, channel == "review:stage-hunk")
                    .await?,
            )
        };

    "review:unstage-hunk" => review::review_unstage_hunk, control,
    |state, input, default_agent, channel| {
            let input: review::ReviewIndexHunkInput = parse(channel, input)?;
            encode(
                review::review_update_hunk_index_impl(state, input, channel == "review:stage-hunk")
                    .await?,
            )
        };

    "review:commit-staged" => review::review_commit_staged, control,
    |state, input, default_agent, channel| {
            encode(review::review_commit_staged_impl(state, parse(channel, input)?).await?)
        };

    "review:revert-file" => review::review_revert_file, control,
    |state, input, default_agent, channel| {
            encode(review::review_revert_file_impl(state, parse(channel, input)?).await?)
        };

    "review:revert-hunk" => review::review_revert_hunk, control,
    |state, input, default_agent, channel| {
            encode(review::review_revert_hunk_impl(state, parse(channel, input)?).await?)
        };

    "goal:set" => goals::goal_set, control,
    |state, input, default_agent, channel| { encode(
            goals::live_goals(state)?
                .set(parse(channel, input)?)
                .await?,
        ) };

    "goal:get" => goals::goal_get, read,
    |state, input, default_agent, channel| {
            let input: crate::goals::service::GoalSessionInput = parse(channel, input)?;
            let service = goals::live_goals(state)?;
            encode(
                crate::ipc::read_off_main(move || service.get_for_session(&input.session_id))
                    .await?,
            )
        };

    "goal:list" => goals::goal_list, read,
    |state, input, default_agent, channel| {
            let input: crate::goals::service::GoalListInput = parse(channel, input)?;
            let service = goals::live_goals(state)?;
            encode(
                crate::ipc::read_off_main(move || service.list(input.workspace_id.as_deref()))
                    .await?,
            )
        };

    "goal:clear" => goals::goal_clear, control,
    |state, input, default_agent, channel| {
            let input: crate::goals::service::GoalSessionInput = parse(channel, input)?;
            encode(goals::live_goals(state)?.clear(&input.session_id).await?)
        };

    "arc:create" => arcs::arc_create, control,
    |state, input, default_agent, channel| {
            let input = parse(channel, input)?;
            encode(arcs::arc_create_impl(state, input).await?)
        };

    "arc:list" => arcs::arc_list, read,
    |state, input, default_agent, channel| {
            let input = parse(channel, input)?;
            encode(arcs::arc_list_impl(state, input).await?)
        };

    "arc:get" => arcs::arc_get, read,
    |state, input, default_agent, channel| {
            let input = parse(channel, input)?;
            encode(arcs::arc_get_impl(state, input).await?)
        };

    "arc:update" => arcs::arc_update, control,
    |state, input, default_agent, channel| {
            let input = parse(channel, input)?;
            encode(arcs::arc_update_impl(state, input).await?)
        };

    "arc:set-state" => arcs::arc_set_state, control,
    |state, input, default_agent, channel| {
            let input = parse(channel, input)?;
            encode(arcs::arc_set_state_impl(state, input).await?)
        };

    "arc:launch-coordinator" => arcs::arc_launch_coordinator, control,
    |state, input, default_agent, channel| {
            let input = parse(channel, input)?;
            encode(arcs::arc_launch_coordinator_impl(state, input).await?)
        };

    "arc:timeline" => arcs::arc_timeline, read,
    |state, input, default_agent, channel| {
            let input = parse(channel, input)?;
            encode(arcs::arc_timeline_impl(state, input).await?)
        };

    "arc:draft-from-session" => arcs::arc_draft_from_session, control,
    |state, input, default_agent, channel| {
            let input = parse(channel, input)?;
            encode(arcs::arc_draft_from_session_impl(state, input).await?)
        };

    "arc:promote" => arcs::arc_promote, control,
    |state, input, default_agent, channel| {
            let input = parse(channel, input)?;
            encode(arcs::arc_promote_impl(state, input).await?)
        };

    "checkpoints:list" => checkpoints::checkpoints_list, read,
    |state, input, default_agent, channel| {
            encode(checkpoints::checkpoints_list_impl(state, parse(channel, input)?).await?)
        };

    "checkpoints:preview-rewind" => checkpoints::checkpoints_preview_rewind, read,
    |state, input, default_agent, channel| { encode(
            checkpoints::checkpoints_preview_rewind_impl(state, parse(channel, input)?).await?,
        ) };

    "checkpoints:rewind-files" => checkpoints::checkpoints_rewind_files, control,
    |state, input, default_agent, channel| {
            encode(checkpoints::checkpoints_rewind_files_impl(state, parse(channel, input)?).await?)
        };

    "workspace:list-files" => workspace_files::workspace_list_files, read,
    |state, input, default_agent, channel| {
            let input: WorkspaceListFilesInput = parse(channel, input)?;
            encode(workspace_files::workspace_list_files_impl(state, input).await?)
        };

    "workspace:read-file" => workspace_files::workspace_read_file, read,
    |state, input, default_agent, channel| {
            let input: WorkspaceReadFileInput = parse(channel, input)?;
            encode(workspace_files::workspace_read_file_impl(state, input).await?)
        };

    "visualization:import" => visualizations::visualization_import, control,
    |state, input, default_agent, channel| { encode(visualizations::visualization_import_impl(state, parse(channel,input)?).await?) };
    "visualization:read" => visualizations::visualization_read, read,
    |state, input, default_agent, channel| { encode(visualizations::visualization_read_impl(state, parse(channel,input)?).await?) };
    "visualization:export" => visualizations::visualization_export, read,
    |state, input, default_agent, channel| { encode(visualizations::visualization_export_impl(state, parse(channel,input)?).await?) };
    "visualization:set-state" => visualizations::visualization_set_state, control,
    |state, input, default_agent, channel| { encode(visualizations::visualization_set_state_impl(state, parse(channel,input)?).await?) };
    "visualization:set-controls" => visualizations::visualization_set_controls, control,
    |state, input, default_agent, channel| { encode(visualizations::visualization_set_controls_impl(state, parse(channel,input)?).await?) };
    "visualization:publish" => visualizations::visualization_publish, control,
    |state, input, default_agent, channel| { encode(visualizations::visualization_publish_impl(state, parse(channel,input)?).await?) };
    "visualization:preview" => visualizations::visualization_preview, desktop,
    |state, input, default_agent, channel| { Err(ArgmaxError::service("REMOTE_UNSUPPORTED", format!("{channel} is only available in the desktop app"))) };

    "workspace:write-file" => workspace_files::workspace_write_file, control,
    |state, input, default_agent, channel| {
            let input: WorkspaceWriteFileInput = parse(channel, input)?;
            encode(workspace_files::workspace_write_file_impl(state, input).await?)
        };

    "workspace:stat-file" => workspace_files::workspace_stat_file, read,
    |state, input, default_agent, channel| {
            let input: WorkspaceStatFileInput = parse(channel, input)?;
            encode(workspace_files::workspace_stat_file_impl(state, input).await?)
        };

    "workspace:read-external-file" => workspace_files::workspace_read_external_file, read,
    |state, input, default_agent, channel| {
            let input: WorkspaceExternalFileInput = parse(channel, input)?;
            encode(workspace_files::workspace_read_external_file_impl(state, input).await?)
        };

    "workspace:stat-external-file" => workspace_files::workspace_stat_external_file, read,
    |state, input, default_agent, channel| {
            let input: WorkspaceExternalFileInput = parse(channel, input)?;
            encode(workspace_files::workspace_stat_external_file_impl(state, input).await?)
        };

    "workspace:grep-content" => workspace_files::workspace_grep_content, read,
    |state, input, default_agent, channel| {
            let input: WorkspaceGrepContentInput = parse(channel, input)?;
            encode(workspace_files::workspace_grep_content_impl(state, input).await?)
        };

    "checks:run" => checks::checks_run, control,
    |state, input, default_agent, channel| {
            let input: ChecksRunInput = parse(channel, input)?;
            encode(checks::checks_run_impl(state, input).await?)
        };

    "skills:list" => skills::skills_list, read,
    |state, input, default_agent, channel| {
            let input: SkillsListInput = parse(channel, input)?;
            encode(skills::skills_list_impl(state, input)?)
        };

    "linked-repos:list" => linked_repos::linked_repos_list, desktop,
    |state, input, default_agent, channel| { Err(ArgmaxError::service("REMOTE_UNSUPPORTED", format!("{channel} is only available in the desktop app"))) };

    "linked-repos:add" => linked_repos::linked_repos_add, desktop,
    |state, input, default_agent, channel| { Err(ArgmaxError::service("REMOTE_UNSUPPORTED", format!("{channel} is only available in the desktop app"))) };

    "linked-repos:pick-folder" => linked_repos::linked_repos_pick_folder, desktop,
    |state, input, default_agent, channel| { Err(ArgmaxError::service("REMOTE_UNSUPPORTED", format!("{channel} is only available in the desktop app"))) };

    "linked-repos:summarize" => linked_repos::linked_repos_summarize, desktop,
    |state, input, default_agent, channel| { Err(ArgmaxError::service("REMOTE_UNSUPPORTED", format!("{channel} is only available in the desktop app"))) };

    "linked-repos:set-enabled" => linked_repos::linked_repos_set_enabled, desktop,
    |state, input, default_agent, channel| { Err(ArgmaxError::service("REMOTE_UNSUPPORTED", format!("{channel} is only available in the desktop app"))) };

    "linked-repos:remove" => linked_repos::linked_repos_remove, desktop,
    |state, input, default_agent, channel| { Err(ArgmaxError::service("REMOTE_UNSUPPORTED", format!("{channel} is only available in the desktop app"))) };

    "projects:set-branch-template" => linked_repos::projects_set_branch_template, desktop,
    |state, input, default_agent, channel| { Err(ArgmaxError::service("REMOTE_UNSUPPORTED", format!("{channel} is only available in the desktop app"))) };

    "settings:branch-template" => linked_repos::settings_branch_template, desktop,
    |state, input, default_agent, channel| { Err(ArgmaxError::service("REMOTE_UNSUPPORTED", format!("{channel} is only available in the desktop app"))) };

    "settings:set-branch-template" => linked_repos::settings_set_branch_template, desktop,
    |state, input, default_agent, channel| { Err(ArgmaxError::service("REMOTE_UNSUPPORTED", format!("{channel} is only available in the desktop app"))) };

    "workspaces:set-snoozed-until" => workspaces::workspaces_set_snoozed_until, control,
    |state, input, default_agent, channel| {
            let input: WorkspacesSetSnoozedUntilInput = parse(channel, input)?;
            encode(workspaces::workspaces_set_snoozed_until_impl(state, input)?)
        };

    "sources:list" => sources::sources_list, read,
    |state, input, default_agent, channel| {
            let input = parse(channel, input)?;
            encode(sources::sources_list_impl(state, input).await?)
        };

    "sources:add" => sources::sources_add, control,
    |state, input, default_agent, channel| {
            let input = parse(channel, input)?;
            encode(sources::sources_add_impl(state, input).await?)
        };

    "sources:update" => sources::sources_update, control,
    |state, input, default_agent, channel| {
            let input = parse(channel, input)?;
            encode(sources::sources_update_impl(state, input).await?)
        };

    "sources:delete" => sources::sources_delete, control,
    |state, input, default_agent, channel| {
            let input = parse(channel, input)?;
            encode(sources::sources_delete_impl(state, input).await?)
        };

    "connections:list" => connections::connections_list, control,
    |state, input, default_agent, channel| {
            let input: ConnectionsListInput = parse(channel, input)?;
            encode(connections::connections_list_impl(state, input).await?)
        };

    "system:open-path" => system::system_open_path, desktop,
    |state, input, default_agent, channel| { Err(ArgmaxError::service("REMOTE_UNSUPPORTED", format!("{channel} is only available in the desktop app"))) };

    "system:open-file-in" => system::system_open_file_in, desktop,
    |state, input, default_agent, channel| { Err(ArgmaxError::service("REMOTE_UNSUPPORTED", format!("{channel} is only available in the desktop app"))) };

    "system:list-detected-ides" => system::system_list_detected_ides, read,
    |state, input, default_agent, channel| {
            encode(system::system_list_detected_ides(parse(channel, input)?).await)
        };

    "system:diagnostics" => system::system_diagnostics, desktop,
    |state, input, default_agent, channel| { Err(ArgmaxError::service("REMOTE_UNSUPPORTED", format!("{channel} is only available in the desktop app"))) };

    "system:debug-snapshot" => system::system_debug_snapshot, read,
    |state, input, default_agent, channel| { encode(system::system_debug_snapshot(parse(channel, input)?)) };

    "system:performance-start" => system::system_performance_start, read,
    |state, input, default_agent, channel| {
            let _input: SystemPerformanceStartInput = parse(channel, input)?;
            encode(system::system_performance_start_impl(state)?)
        };

    "system:performance-stop" => system::system_performance_stop, read,
    |state, input, default_agent, channel| {
            let _input: SystemPerformanceStopInput = parse(channel, input)?;
            encode(system::system_performance_stop_impl(state))
        };

    "system:performance-status" => system::system_performance_status, read,
    |state, input, default_agent, channel| {
            let _input: SystemPerformanceStatusInput = parse(channel, input)?;
            encode(system::system_performance_status_impl(state))
        };

    "system:performance-capture" => system::system_performance_capture, read,
    |state, input, default_agent, channel| {
            let _input: SystemPerformanceCaptureInput = parse(channel, input)?;
            encode(system::system_performance_capture_impl(state))
        };

    "system:renderer-stall" => system::system_renderer_stall, desktop,
    |state, input, default_agent, channel| { Err(ArgmaxError::service("REMOTE_UNSUPPORTED", format!("{channel} is only available in the desktop app"))) };

    "system:vacuum-database" => system::system_vacuum_database, control,
    |state, input, default_agent, channel| {
            let _input: SystemVacuumDatabaseInput = parse(channel, input)?;
            encode(system::system_vacuum_database_impl(state).await?)
        };

    "system:set-theme" => system::system_set_theme, desktop,
    |state, input, default_agent, channel| { Err(ArgmaxError::service("REMOTE_UNSUPPORTED", format!("{channel} is only available in the desktop app"))) };

    "system:set-default-agent" => system::system_set_default_agent, desktop,
    |state, input, default_agent, channel| { Err(ArgmaxError::service("REMOTE_UNSUPPORTED", format!("{channel} is only available in the desktop app"))) };

    "system:set-notifications-enabled" => system::system_set_notifications_enabled, desktop,
    |state, input, default_agent, channel| { Err(ArgmaxError::service("REMOTE_UNSUPPORTED", format!("{channel} is only available in the desktop app"))) };

    "system:set-keep-awake" => system::system_set_keep_awake, desktop,
    |state, input, default_agent, channel| { Err(ArgmaxError::service("REMOTE_UNSUPPORTED", format!("{channel} is only available in the desktop app"))) };

    "system:test-notification" => system::system_test_notification, desktop,
    |state, input, default_agent, channel| { Err(ArgmaxError::service("REMOTE_UNSUPPORTED", format!("{channel} is only available in the desktop app"))) };

    "window:open-session" => windows::window_open_session, desktop,
    |state, input, default_agent, channel| { Err(ArgmaxError::service("REMOTE_UNSUPPORTED", format!("{channel} is only available in the desktop app"))) };

    "window:set-session" => windows::window_set_session, desktop,
    |state, input, default_agent, channel| { Err(ArgmaxError::service("REMOTE_UNSUPPORTED", format!("{channel} is only available in the desktop app"))) };

    "session:cost-summary" => session::session_cost_summary, read,
    |state, input, default_agent, channel| {
            let input: SessionCostSummaryInput = parse(channel, input)?;
            encode(session::session_cost_summary_impl(state, input).await?)
        };

    "learnings:list" => learnings::learnings_list, read,
    |state, input, default_agent, channel| {
            let input: LearningsListInput = parse(channel, input)?;
            encode(learnings::learnings_list_impl(state, input).await?)
        };

    "learnings:update" => learnings::learnings_update, control,
    |state, input, default_agent, channel| {
            let input: LearningsUpdateInput = parse(channel, input)?;
            encode(learnings::learnings_update_impl(state, input)?)
        };

    "learnings:delete" => learnings::learnings_delete, control,
    |state, input, default_agent, channel| {
            let input: LearningsDeleteInput = parse(channel, input)?;
            encode(learnings::learnings_delete_impl(state, input)?)
        };

    "session:search" => session::session_search, read,
    |state, input, default_agent, channel| {
            let input: SessionSearchInput = parse(channel, input)?;
            encode(session::session_search_impl(state, input).await?)
        };

    "workspaces:set-pinned" => workspaces::workspaces_set_pinned, control,
    |state, input, default_agent, channel| {
            let input: WorkspacesSetPinnedInput = parse(channel, input)?;
            encode(workspaces::workspaces_set_pinned_impl(state, input)?)
        };

    "workspaces:mark-viewed" => workspaces::workspaces_mark_viewed, control,
    |state, input, default_agent, channel| {
            let input: WorkspacesMarkViewedInput = parse(channel, input)?;
            encode(workspaces::workspaces_mark_viewed_impl(state, input).await?)
        };

    "workspaces:set-priority-added" => workspaces::workspaces_set_priority_added, control,
    |state, input, default_agent, channel| {
            let input: WorkspacesSetPriorityAddedInput = parse(channel, input)?;
            encode(workspaces::workspaces_set_priority_added_impl(
                state, input,
            )?)
        };

    "workspaces:set-priority-dismissed" => workspaces::workspaces_set_priority_dismissed, control,
    |state, input, default_agent, channel| {
            let input: WorkspacesSetPriorityDismissedInput = parse(channel, input)?;
            encode(workspaces::workspaces_set_priority_dismissed_impl(
                state, input,
            )?)
        };

    "workspaces:set-label" => workspaces::workspaces_set_label, control,
    |state, input, default_agent, channel| {
            let input: WorkspacesSetLabelInput = parse(channel, input)?;
            encode(workspaces::workspaces_set_label_impl(state, input)?)
        };

    "workspaces:set-icon" => workspaces::workspaces_set_icon, control,
    |state, input, default_agent, channel| {
            let input: WorkspacesSetIconInput = parse(channel, input)?;
            encode(workspaces::workspaces_set_icon_impl(state, input)?)
        };

    "prs:list-for-session" => prs::prs_list_for_session, read,
    |state, input, default_agent, channel| {
            let input: PrsListForSessionInput = parse(channel, input)?;
            encode(prs::prs_list_for_session_impl(state, input)?)
        };

    "prs:refresh" => prs::prs_refresh, control,
    |state, input, default_agent, channel| {
            let input: PrsRefreshInput = parse(channel, input)?;
            encode(prs::prs_refresh_impl(state, input).await?)
        };

    "prs:set-primary" => prs::prs_set_primary, control,
    |state, input, default_agent, channel| {
            let input: PrsSetPrimaryInput = parse(channel, input)?;
            encode(prs::prs_set_primary_impl(state, input).await?)
        };

    "prs:dismiss" => prs::prs_dismiss, control,
    |state, input, default_agent, channel| {
            let input: PrsDismissInput = parse(channel, input)?;
            encode(prs::prs_dismiss_impl(state, input).await?)
        };

    "prs:cleanup" => prs::prs_cleanup, control,
    |state, input, default_agent, channel| {
            let input: PrsCleanupInput = parse(channel, input)?;
            encode(prs::prs_cleanup_impl(state, input).await?)
        };

    "git:commit" => git_ops::git_commit, control,
    |state, input, default_agent, channel| {
            let input: GitCommitInput = parse(channel, input)?;
            encode(git_ops::git_commit_impl(state, input).await?)
        };

    "git:push" => git_ops::git_push, control,
    |state, input, default_agent, channel| {
            let input: GitPushInput = parse(channel, input)?;
            encode(git_ops::git_push_impl(state, input).await?)
        };

    "git:create-branch" => git_ops::git_create_branch, control,
    |state, input, default_agent, channel| {
            let input: GitCreateBranchInput = parse(channel, input)?;
            encode(git_ops::git_create_branch_impl(state, input).await?)
        };

    "git:view-or-create-pr" => git_ops::git_view_or_create_pr, control,
    |state, input, default_agent, channel| {
            let input: GitViewOrCreatePrInput = parse(channel, input)?;
            encode(git_ops::git_view_or_create_pr_impl(state, input).await?)
        };

    "remote:get-status" => remote::remote_get_status, desktop,
    |state, input, default_agent, channel| { Err(ArgmaxError::service("REMOTE_UNSUPPORTED", format!("{channel} is only available in the desktop app"))) };

    "remote:set-config" => remote::remote_set_config, desktop,
    |state, input, default_agent, channel| { Err(ArgmaxError::service("REMOTE_UNSUPPORTED", format!("{channel} is only available in the desktop app"))) };

    "remote:test-notification" => remote::remote_test_notification, desktop,
    |state, input, default_agent, channel| { Err(ArgmaxError::service("REMOTE_UNSUPPORTED", format!("{channel} is only available in the desktop app"))) };

    "remote:set-apns-config" => remote::remote_set_apns_config, desktop,
    |state, input, default_agent, channel| { Err(ArgmaxError::service("REMOTE_UNSUPPORTED", format!("{channel} is only available in the desktop app"))) };

    "remote:register-push-device" => remote::remote_register_push_device, control,
    |state, input, default_agent, channel| {
            let input: RemoteRegisterPushDeviceInput = parse(channel, input)?;
            encode(remote::remote_register_push_device_impl(state, input)?)
        };

    "remote:unregister-push-device" => remote::remote_unregister_push_device, control,
    |state, input, default_agent, channel| {
            let input: RemoteUnregisterPushDeviceInput = parse(channel, input)?;
            encode(remote::remote_unregister_push_device_impl(state, input)?)
        };

    "remote:push-test" => remote::remote_push_test, control,
    |state, input, default_agent, channel| {
            let _input: RemotePushTestInput = parse(channel, input)?;
            encode(remote::remote_push_test_impl(state).await?)
        };

    "remote:push-capability" => remote::remote_push_capability, read,
    |state, input, default_agent, channel| {
            let _input: RemotePushCapabilityInput = parse(channel, input)?;
            encode(remote::remote_push_capability_impl(state)?)
        };

    "sync:get-status" => sync::sync_get_status, desktop,
    |state, input, default_agent, channel| { Err(ArgmaxError::service("REMOTE_UNSUPPORTED", format!("{channel} is only available in the desktop app"))) };

    "sync:set-config" => sync::sync_set_config, desktop,
    |state, input, default_agent, channel| { Err(ArgmaxError::service("REMOTE_UNSUPPORTED", format!("{channel} is only available in the desktop app"))) };

    "sync:run-now" => sync::sync_run_now, desktop,
    |state, input, default_agent, channel| { Err(ArgmaxError::service("REMOTE_UNSUPPORTED", format!("{channel} is only available in the desktop app"))) };

    "browser:open" => browser::browser_open, desktop,
    |state, input, default_agent, channel| { Err(ArgmaxError::service("REMOTE_UNSUPPORTED", format!("{channel} is only available in the desktop app"))) };

    "browser:content-blocking" => browser::browser_content_blocking, desktop,
    |state, input, default_agent, channel| { Err(ArgmaxError::service("REMOTE_UNSUPPORTED", format!("{channel} is only available in the desktop app"))) };

    "browser:set-site-blocking" => browser::browser_set_site_blocking, desktop,
    |state, input, default_agent, channel| { Err(ArgmaxError::service("REMOTE_UNSUPPORTED", format!("{channel} is only available in the desktop app"))) };

    "browser:navigate" => browser::browser_navigate, desktop,
    |state, input, default_agent, channel| { Err(ArgmaxError::service("REMOTE_UNSUPPORTED", format!("{channel} is only available in the desktop app"))) };

    "browser:back" => browser::browser_back, desktop,
    |state, input, default_agent, channel| { Err(ArgmaxError::service("REMOTE_UNSUPPORTED", format!("{channel} is only available in the desktop app"))) };

    "browser:forward" => browser::browser_forward, desktop,
    |state, input, default_agent, channel| { Err(ArgmaxError::service("REMOTE_UNSUPPORTED", format!("{channel} is only available in the desktop app"))) };

    "browser:reload" => browser::browser_reload, desktop,
    |state, input, default_agent, channel| { Err(ArgmaxError::service("REMOTE_UNSUPPORTED", format!("{channel} is only available in the desktop app"))) };

    "browser:stop" => browser::browser_stop, desktop,
    |state, input, default_agent, channel| { Err(ArgmaxError::service("REMOTE_UNSUPPORTED", format!("{channel} is only available in the desktop app"))) };

    "browser:set-bounds" => browser::browser_set_bounds, desktop,
    |state, input, default_agent, channel| { Err(ArgmaxError::service("REMOTE_UNSUPPORTED", format!("{channel} is only available in the desktop app"))) };

    "browser:focus" => browser::browser_focus, desktop,
    |state, input, default_agent, channel| { Err(ArgmaxError::service("REMOTE_UNSUPPORTED", format!("{channel} is only available in the desktop app"))) };

    "browser:set-theme" => browser::browser_set_theme, desktop,
    |state, input, default_agent, channel| { Err(ArgmaxError::service("REMOTE_UNSUPPORTED", format!("{channel} is only available in the desktop app"))) };

    "browser:close" => browser::browser_close, desktop,
    |state, input, default_agent, channel| { Err(ArgmaxError::service("REMOTE_UNSUPPORTED", format!("{channel} is only available in the desktop app"))) };

    "browser:fill-credentials" => browser::browser_fill_credentials, desktop,
    |state, input, default_agent, channel| { Err(ArgmaxError::service("REMOTE_UNSUPPORTED", format!("{channel} is only available in the desktop app"))) };

    "browser:screenshot" => browser::browser_screenshot, desktop,
    |state, input, default_agent, channel| { Err(ArgmaxError::service("REMOTE_UNSUPPORTED", format!("{channel} is only available in the desktop app"))) };

    "browser:evaluate" => browser::browser_evaluate, desktop,
    |state, input, default_agent, channel| { Err(ArgmaxError::service("REMOTE_UNSUPPORTED", format!("{channel} is only available in the desktop app"))) };

    "browser:list-tabs" => browser::browser_list_tabs, desktop,
    |state, input, default_agent, channel| { Err(ArgmaxError::service("REMOTE_UNSUPPORTED", format!("{channel} is only available in the desktop app"))) };

    "browser:open-for-session" => browser::browser_open_for_session, desktop,
    |state, input, default_agent, channel| { Err(ArgmaxError::service("REMOTE_UNSUPPORTED", format!("{channel} is only available in the desktop app"))) };

    "browser:snapshot" => browser::browser_snapshot, desktop,
    |state, input, default_agent, channel| { Err(ArgmaxError::service("REMOTE_UNSUPPORTED", format!("{channel} is only available in the desktop app"))) };

    "browser:find" => browser::browser_find, desktop,
    |state, input, default_agent, channel| { Err(ArgmaxError::service("REMOTE_UNSUPPORTED", format!("{channel} is only available in the desktop app"))) };

    "browser:get-text" => browser::browser_get_text, desktop,
    |state, input, default_agent, channel| { Err(ArgmaxError::service("REMOTE_UNSUPPORTED", format!("{channel} is only available in the desktop app"))) };

    "browser:extract" => browser::browser_extract, desktop,
    |state, input, default_agent, channel| { Err(ArgmaxError::service("REMOTE_UNSUPPORTED", format!("{channel} is only available in the desktop app"))) };

    "browser:act" => browser::browser_act, desktop,
    |state, input, default_agent, channel| { Err(ArgmaxError::service("REMOTE_UNSUPPORTED", format!("{channel} is only available in the desktop app"))) };

    "browser:chrome-profiles" => browser_import::browser_chrome_profiles, desktop,
    |state, input, default_agent, channel| { Err(ArgmaxError::service("REMOTE_UNSUPPORTED", format!("{channel} is only available in the desktop app"))) };

    "browser:import-chrome-history" => browser_import::browser_import_chrome_history, desktop,
    |state, input, default_agent, channel| { Err(ArgmaxError::service("REMOTE_UNSUPPORTED", format!("{channel} is only available in the desktop app"))) };

    "routines:list" => routines::routines_list, desktop,
    |state, input, default_agent, channel| { Err(ArgmaxError::service("REMOTE_UNSUPPORTED", format!("{channel} is only available in the desktop app"))) };

    "routines:upsert" => routines::routines_upsert, desktop,
    |state, input, default_agent, channel| { Err(ArgmaxError::service("REMOTE_UNSUPPORTED", format!("{channel} is only available in the desktop app"))) };

    "routines:delete" => routines::routines_delete, desktop,
    |state, input, default_agent, channel| { Err(ArgmaxError::service("REMOTE_UNSUPPORTED", format!("{channel} is only available in the desktop app"))) };

    "routines:set-enabled" => routines::routines_set_enabled, desktop,
    |state, input, default_agent, channel| { Err(ArgmaxError::service("REMOTE_UNSUPPORTED", format!("{channel} is only available in the desktop app"))) };

    "routines:run-now" => routines::routines_run_now, desktop,
    |state, input, default_agent, channel| { Err(ArgmaxError::service("REMOTE_UNSUPPORTED", format!("{channel} is only available in the desktop app"))) };

    "routines:reset-session" => routines::routines_reset_session, desktop,
    |state, input, default_agent, channel| { Err(ArgmaxError::service("REMOTE_UNSUPPORTED", format!("{channel} is only available in the desktop app"))) };

    "usage:summary" => usage::usage_summary, read,
    |state, input, default_agent, channel| {
            let input: UsageSummaryInput = parse(channel, input)?;
            encode(usage::usage_summary_impl(state, input).await?)
        };

    "usage:remaining" => usage::usage_remaining, read,
    |state, input, default_agent, channel| {
            let _: UsageRemainingInput = parse(channel, input)?;
            encode(usage::usage_remaining_impl().await?)
        };

    "usage:router-cost" => usage::usage_router_cost, read,
    |state, input, default_agent, channel| {
            let input: UsageRouterCostInput = parse(channel, input)?;
            encode(usage::usage_router_cost_impl(state, input).await?)
        };

    "activity:summary" => activity::activity_summary, read,
    |state, input, default_agent, channel| {
            let input: ActivitySummaryInput = parse(channel, input)?;
            encode(activity::activity_summary_impl(state, input).await?)
        };
}
