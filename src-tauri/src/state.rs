// AppState: shared, cloneable container for the cross-subsystem services.
//
// Most fields are `OnceCell<Arc<…>>` because the services come online over
// the course of boot — see `recover_orphaned_sessions` (must run before
// `tauri::Builder::run`), the prune sweeper, the GH poller. Each owner
// installs its handle into the matching cell once initialized.
//
use once_cell::sync::OnceCell;
use std::sync::Arc;

use crate::checks::service::CheckService;
use crate::gh::poller::GhPoller;
use crate::mcp::auth::McpAuthService;
use crate::persistence::Database;
use crate::providers::discovery::ProviderDiscovery;
use crate::providers::session_service::ProviderSessionService;
use crate::terminal::service::TerminalService;
use crate::util::startup_timer::StartupTimer;
use crate::workspaces::WorkspaceService;

#[derive(Default)]
pub struct AppState {
    pub startup_timer: Arc<StartupTimer>,
    pub db: OnceCell<Arc<Database>>,
    pub providers: OnceCell<Arc<ProviderSessionService>>,
    pub provider_discovery: Arc<ProviderDiscovery>,
    pub terminals: OnceCell<Arc<TerminalService>>,
    pub mcp_auth: OnceCell<Arc<McpAuthService>>,
    pub checks: OnceCell<Arc<CheckService>>,
    pub workspaces: OnceCell<Arc<WorkspaceService>>,
    pub gh_poller: OnceCell<Arc<GhPoller>>,
}

impl AppState {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn with_startup_timer(startup_timer: Arc<StartupTimer>) -> Self {
        Self {
            startup_timer,
            ..Self::default()
        }
    }
}
