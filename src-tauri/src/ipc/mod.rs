use std::sync::Arc;

use tauri_specta::{collect_commands, Builder as SpectaBuilder};

use crate::error::{ArgmaxError, ArgmaxResult};
use crate::persistence::Database;
use crate::state::AppState;

pub mod inputs;
pub mod validation;

pub mod approvals;
pub mod attachments;
pub mod browser;
pub mod checks;
pub mod dashboard;
pub mod git_ops;
pub mod health;
pub mod learnings;
pub mod projects;
pub mod providers;
pub mod prs;
pub mod remote;
pub mod review;
pub mod routines;
pub mod session;
pub mod skills;
pub mod sync;
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
    "workspaces:create-scratch",
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
    "providers:send-queued-message-now",
    "attachments:save-image",
    "terminal:spawn",
    "terminal:write",
    "terminal:resize",
    "terminal:terminate",
    "approvals:resolve",
    "approvals:pending",
    "session:events-since",
    "session:agent-events",
    "session:fork",
    "review:list-changed-files",
    "review:load-diff",
    "workspace:list-files",
    "workspace:read-file",
    "workspace:write-file",
    "workspace:stat-file",
    "workspace:grep-content",
    "checks:run",
    "skills:list",
    "system:open-path",
    "system:list-detected-ides",
    "system:diagnostics",
    "system:vacuum-database",
    "system:set-theme",
    "session:cost-summary",
    "learnings:list",
    "learnings:update",
    "learnings:delete",
    "session:search",
    "workspaces:set-pinned",
    "workspaces:set-priority-added",
    "workspaces:set-priority-dismissed",
    "workspaces:set-label",
    "workspaces:set-icon",
    "prs:list-for-session",
    "prs:refresh",
    "git:commit",
    "git:push",
    "git:create-branch",
    "git:view-or-create-pr",
    "remote:get-status",
    "remote:set-config",
    "remote:test-notification",
    "sync:get-status",
    "sync:set-config",
    "sync:run-now",
    "browser:open",
    "browser:navigate",
    "browser:back",
    "browser:forward",
    "browser:reload",
    "browser:stop",
    "browser:set-bounds",
    "browser:close",
    "browser:fill-credentials",
    "routines:list",
    "routines:upsert",
    "routines:delete",
    "routines:set-enabled",
    "routines:run-now",
];

/// Resolve the live `Database` Arc from `AppState`. Shared across IPC
/// handler modules so each ported command does not re-duplicate the
/// `state.db.get()` boilerplate.
/// Run a blocking database read off the macOS main thread.
///
/// Tauri resolves a sync `#[tauri::command]` body inline on the main thread, so
/// a 24 ms dashboard read is 24 ms the window cannot draw or handle input. The
/// `async` flag is not the fix — it is `tokio::spawn`, which parks a shared
/// worker that provider IO and the `dashboard:delta` emit loop also need.
/// `spawn_blocking` uses the pool sized for exactly this.
pub(crate) async fn read_off_main<T, F>(read: F) -> ArgmaxResult<T>
where
    F: FnOnce() -> ArgmaxResult<T> + Send + 'static,
    T: Send + 'static,
{
    tauri::async_runtime::spawn_blocking(read)
        .await
        .map_err(|error| ArgmaxError::service("DATABASE_READ_JOIN", error.to_string()))?
}

pub(crate) fn live_database(state: &AppState) -> ArgmaxResult<Arc<Database>> {
    state.db.get().cloned().ok_or_else(|| {
        // A recorded open failure is the whole story; without one, boot is
        // simply still in flight.
        match state.db_open_error.get() {
            Some(reason) => ArgmaxError::service("DATABASE_NOT_READY", reason),
            None => ArgmaxError::service(
                "DATABASE_NOT_READY",
                "database is not initialized (startup may still be in progress)",
            ),
        }
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
        workspaces::workspaces_create_scratch,
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
        providers::providers_send_queued_message_now,
        attachments::attachments_save_image,
        terminal::terminal_spawn,
        terminal::terminal_write,
        terminal::terminal_resize,
        terminal::terminal_terminate,
        approvals::approvals_resolve,
        approvals::approvals_pending,
        session::session_events_since,
        session::session_agent_events,
        session::session_fork,
        review::review_list_changed_files,
        review::review_load_diff,
        workspace_files::workspace_list_files,
        workspace_files::workspace_read_file,
        workspace_files::workspace_write_file,
        workspace_files::workspace_stat_file,
        workspace_files::workspace_grep_content,
        checks::checks_run,
        skills::skills_list,
        system::system_open_path,
        system::system_list_detected_ides,
        system::system_diagnostics,
        system::system_vacuum_database,
        system::system_set_theme,
        session::session_cost_summary,
        learnings::learnings_list,
        learnings::learnings_update,
        learnings::learnings_delete,
        session::session_search,
        workspaces::workspaces_set_pinned,
        workspaces::workspaces_set_priority_added,
        workspaces::workspaces_set_priority_dismissed,
        workspaces::workspaces_set_label,
        workspaces::workspaces_set_icon,
        prs::prs_list_for_session,
        prs::prs_refresh,
        git_ops::git_commit,
        git_ops::git_push,
        git_ops::git_create_branch,
        git_ops::git_view_or_create_pr,
        remote::remote_get_status,
        remote::remote_set_config,
        remote::remote_test_notification,
        sync::sync_get_status,
        sync::sync_set_config,
        sync::sync_run_now,
        browser::browser_open,
        browser::browser_navigate,
        browser::browser_back,
        browser::browser_forward,
        browser::browser_reload,
        browser::browser_stop,
        browser::browser_set_bounds,
        browser::browser_close,
        browser::browser_fill_credentials,
        routines::routines_list,
        routines::routines_upsert,
        routines::routines_delete,
        routines::routines_set_enabled,
        routines::routines_run_now
    ])
}
