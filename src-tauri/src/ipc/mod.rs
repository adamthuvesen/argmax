use std::sync::Arc;

use tauri_specta::{collect_commands, Builder as SpectaBuilder};

use crate::error::{ArgmaxError, ArgmaxResult};
use crate::persistence::Database;
use crate::state::AppState;

pub mod inputs;
pub mod validation;

pub mod approvals;
pub mod attachments;
pub mod checkpoints;
pub mod checks;
pub mod dashboard;
pub mod git_ops;
pub mod health;
pub mod learnings;
pub mod mcp;
pub mod projects;
pub mod providers;
pub mod prs;
pub mod review;
pub mod session;
pub mod skills;
pub mod system;
pub mod terminal;
pub mod workspace_files;
pub mod workspaces;

pub const REGISTERED_CHANNELS: &[&str] = &[
    "health:ping",
    "projects:list",
    "projects:pick-folder",
    "dashboard:list",
    "projects:register",
    "projects:remove",
    "projects:update-settings",
    "projects:list-branches",
    "projects:refresh-branch",
    "projects:switch-branch",
    "workspaces:create-isolated",
    "workspaces:create-current",
    "workspaces:refresh-status",
    "workspaces:keep",
    "workspaces:archive",
    "workspaces:open-in-ide",
    "workspaces:autotitle",
    "workspace:status",
    "providers:discover",
    "providers:launch",
    "providers:send-input",
    "providers:resize",
    "providers:terminate",
    "providers:cancel-queued-message",
    "attachments:save-image",
    "terminal:spawn",
    "terminal:write",
    "terminal:resize",
    "terminal:terminate",
    "approvals:resolve",
    "approvals:pending",
    "session:events-since",
    "session:agent-events",
    "review:list-changed-files",
    "review:load-diff",
    "review:list-changed-files-for-project",
    "review:load-diff-for-project",
    "workspace:list-files",
    "workspace:read-file",
    "workspace:list-files-for-project",
    "workspace:read-file-for-project",
    "workspace:write-file",
    "workspace:stat-file",
    "workspace:write-file-for-project",
    "workspace:stat-file-for-project",
    "workspace:grep-content",
    "checks:run",
    "checkpoints:create",
    "dashboard:load",
    "skills:list",
    "system:open-path",
    "system:list-detected-ides",
    "system:diagnostics",
    "system:vacuum-database",
    "system:set-theme",
    "mcp:list",
    "mcp:auth:start",
    "mcp:auth:write",
    "mcp:auth:resize",
    "mcp:auth:terminate",
    "session:cost-summary",
    "learnings:list",
    "learnings:update",
    "learnings:delete",
    "session:search",
    "workspaces:set-pinned",
    "workspaces:set-label",
    "prs:list-for-session",
    "prs:refresh",
    "git:commit",
    "git:push",
    "git:create-branch",
    "git:view-or-create-pr",
];

/// Resolve the live `Database` Arc from `AppState`. Shared across IPC
/// handler modules so each ported command does not re-duplicate the
/// `state.db.get()` boilerplate.
pub(crate) fn live_database(state: &AppState) -> ArgmaxResult<Arc<Database>> {
    state.db.get().cloned().ok_or_else(|| {
        ArgmaxError::service(
            "DATABASE_NOT_READY",
            "database is not initialized (startup may still be in progress, or DB setup failed — see logs)",
        )
    })
}

pub fn specta_builder() -> SpectaBuilder<tauri::Wry> {
    SpectaBuilder::<tauri::Wry>::new().commands(collect_commands![
        health::health_ping,
        projects::projects_list,
        projects::projects_pick_folder,
        dashboard::dashboard_list,
        projects::projects_register,
        projects::projects_remove,
        projects::projects_update_settings,
        projects::projects_list_branches,
        projects::projects_refresh_branch,
        projects::projects_switch_branch,
        workspaces::workspaces_create_isolated,
        workspaces::workspaces_create_current,
        workspaces::workspaces_refresh_status,
        workspaces::workspaces_keep,
        workspaces::workspaces_archive,
        workspaces::workspaces_open_in_ide,
        workspaces::workspaces_autotitle,
        workspace_files::workspace_status,
        providers::providers_discover,
        providers::providers_launch,
        providers::providers_send_input,
        providers::providers_resize,
        providers::providers_terminate,
        providers::providers_cancel_queued_message,
        attachments::attachments_save_image,
        terminal::terminal_spawn,
        terminal::terminal_write,
        terminal::terminal_resize,
        terminal::terminal_terminate,
        approvals::approvals_resolve,
        approvals::approvals_pending,
        session::session_events_since,
        session::session_agent_events,
        review::review_list_changed_files,
        review::review_load_diff,
        review::review_list_changed_files_for_project,
        review::review_load_diff_for_project,
        workspace_files::workspace_list_files,
        workspace_files::workspace_read_file,
        workspace_files::workspace_list_files_for_project,
        workspace_files::workspace_read_file_for_project,
        workspace_files::workspace_write_file,
        workspace_files::workspace_stat_file,
        workspace_files::workspace_write_file_for_project,
        workspace_files::workspace_stat_file_for_project,
        workspace_files::workspace_grep_content,
        checks::checks_run,
        checkpoints::checkpoints_create,
        dashboard::dashboard_load,
        skills::skills_list,
        system::system_open_path,
        system::system_list_detected_ides,
        system::system_diagnostics,
        system::system_vacuum_database,
        system::system_set_theme,
        mcp::mcp_list,
        mcp::mcp_auth_start,
        mcp::mcp_auth_write,
        mcp::mcp_auth_resize,
        mcp::mcp_auth_terminate,
        session::session_cost_summary,
        learnings::learnings_list,
        learnings::learnings_update,
        learnings::learnings_delete,
        session::session_search,
        workspaces::workspaces_set_pinned,
        workspaces::workspaces_set_label,
        prs::prs_list_for_session,
        prs::prs_refresh,
        git_ops::git_commit,
        git_ops::git_push,
        git_ops::git_create_branch,
        git_ops::git_view_or_create_pr
    ])
}
