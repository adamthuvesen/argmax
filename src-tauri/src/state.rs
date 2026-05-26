// AppState: shared, cloneable container for the cross-subsystem services.
//
// Most fields are `OnceCell<Arc<…>>` because the services come online over
// the course of boot — see `recover_orphaned_sessions` (must run before
// `tauri::Builder::run`), the prune sweeper, the GH poller. Each owner
// installs its handle into the matching cell once initialized.
//
// The concrete service types are unit-struct placeholders until their
// owning subsystems land later in the port. Replacing them with real
// types is a single-line change here and a `use` swap at the use site.

use once_cell::sync::OnceCell;
use std::sync::Arc;

// ---------------------------------------------------------------------------
// Placeholder service types. Each is replaced by the real implementation
// as its subsystem lands (see openspec/changes/port-to-rust-tauri/tasks.md
// sections 3, 5, 6, 8, 9, 10).
// ---------------------------------------------------------------------------

pub struct Database;
pub struct ProviderSessionService;
pub struct TerminalService;
pub struct McpAuthService;
pub struct WorkspaceService;
pub struct GhPoller;
pub struct TournamentService;
pub struct UpdateService;

#[derive(Default)]
pub struct AppState {
    pub db: OnceCell<Arc<Database>>,
    pub providers: OnceCell<Arc<ProviderSessionService>>,
    pub terminals: OnceCell<Arc<TerminalService>>,
    pub mcp_auth: OnceCell<Arc<McpAuthService>>,
    pub workspaces: OnceCell<Arc<WorkspaceService>>,
    pub gh_poller: OnceCell<Arc<GhPoller>>,
    pub tournaments: OnceCell<Arc<TournamentService>>,
    pub update_service: OnceCell<Arc<UpdateService>>,
}

impl AppState {
    pub fn new() -> Self {
        Self::default()
    }
}
