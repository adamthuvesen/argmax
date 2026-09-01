// AppState: shared, cloneable container for the cross-subsystem services.
//
// Most fields are `OnceCell<Arc<…>>` because the services come online over
// the course of boot — see `recover_orphaned_sessions` (must run before
// `tauri::Builder::run`), the prune sweeper, the GH poller. Each owner
// installs its handle into the matching cell once initialized.
//
use once_cell::sync::OnceCell;
use std::sync::Arc;
use tokio::sync::broadcast;

use crate::approvals::service::ApprovalService;
use crate::checks::service::CheckService;
use crate::gh::poller::GhPoller;
use crate::notifications::{NotificationService, TauriNotificationSink};
use crate::persistence::Database;
use crate::providers::cursor_acp::CursorAcpSessions;
use crate::providers::discovery::ProviderDiscovery;
use crate::providers::session_service::ProviderSessionService;
use crate::remote::{RemoteEvent, REMOTE_EVENT_CAPACITY};
use crate::session_control::SessionLaunchServer;
use crate::skills::registry::SkillRegistry;
use crate::terminal::service::TerminalService;
use crate::util::startup_timer::StartupTimer;
use crate::workspaces::WorkspaceService;

pub type LiveNotificationService = NotificationService<TauriNotificationSink<tauri::Wry>>;
pub type LiveDockBadgeService = DockBadgeService<TauriDockBadgeSink<tauri::Wry>>;

pub struct AppState {
    pub startup_timer: Arc<StartupTimer>,
    pub db: OnceCell<Arc<Database>>,
    /// Why the database never opened, when it never opened. A migration abort
    /// (checksum drift, a failed statement) leaves `db` empty and every handler
    /// failing identically, so the reason is kept here and handed to the
    /// renderer — otherwise the only actionable text is buried in the logs.
    pub db_open_error: OnceCell<String>,
    pub approvals: OnceCell<Arc<ApprovalService>>,
    pub providers: OnceCell<Arc<ProviderSessionService>>,
    pub session_launch_server: OnceCell<SessionLaunchServer>,
    pub provider_discovery: Arc<ProviderDiscovery>,
    /// Warm `cursor-agent acp` process pool; the `RunEvent::Exit` callback
    /// kills it because boot orphan recovery cannot match acp argv.
    pub cursor_acp: OnceCell<Arc<CursorAcpSessions>>,
    pub terminals: OnceCell<Arc<TerminalService>>,
    pub checks: OnceCell<Arc<CheckService>>,
    pub workspaces: OnceCell<Arc<WorkspaceService>>,
    pub gh_poller: OnceCell<Arc<GhPoller>>,
    pub notifications: OnceCell<Arc<LiveNotificationService>>,
    /// Phone push via ntfy; installed by `remote::apply` when the config names
    /// a topic, and swapped in place when the topic changes in Settings.
    pub ntfy: std::sync::RwLock<Option<Arc<crate::remote::ntfy::NtfyPublisher>>>,
    /// Running remote-bridge server task, if any. `remote::apply` aborts and
    /// replaces it when the bridge is toggled or re-configured in Settings.
    pub remote_server: std::sync::Mutex<Option<tauri::async_runtime::JoinHandle<()>>>,
    /// Fan-out of the push events (`dashboard:delta`, `terminal:data`,
    /// `terminal:exit`) the desktop webview receives, mirrored to whatever
    /// remote-bridge clients are connected. Always present, usually with no
    /// receivers — see `crate::remote::publish`.
    pub remote_events: broadcast::Sender<RemoteEvent>,
    /// Outcome of the most recent session-sync sweep, for the Settings pane.
    pub sync_report: std::sync::Mutex<Option<crate::sync::SyncReport>>,
    /// One session-sync sweep at a time. `sync:set-config`, `sync:run-now` and
    /// the 60s loop are otherwise free to interleave, and the sweep's read of
    /// the already-imported ids and its write of the new row sit in separate
    /// connections — so two sweeps import the same transcript twice, and the
    /// second `synced_sessions` insert trips the provider/external unique
    /// index and aborts the sweep with the duplicate session already persisted.
    pub sync_sweep: Arc<std::sync::Mutex<()>>,
    /// Skill discovery, held here so its per-provider cache survives across
    /// calls: a fresh registry per `skills:list` re-walks every skill tree.
    pub skills: Arc<SkillRegistry>,
}

// Hand-written because `broadcast::Sender` has no `Default`; every other field
// keeps the derived behavior.
impl Default for AppState {
    fn default() -> Self {
        Self {
            startup_timer: Arc::default(),
            db: OnceCell::new(),
            db_open_error: OnceCell::new(),
            approvals: OnceCell::new(),
            providers: OnceCell::new(),
            session_launch_server: OnceCell::new(),
            provider_discovery: Arc::default(),
            cursor_acp: OnceCell::new(),
            terminals: OnceCell::new(),
            checks: OnceCell::new(),
            workspaces: OnceCell::new(),
            gh_poller: OnceCell::new(),
            notifications: OnceCell::new(),
            ntfy: std::sync::RwLock::new(None),
            remote_server: std::sync::Mutex::new(None),
            remote_events: broadcast::channel(REMOTE_EVENT_CAPACITY).0,
            sync_report: std::sync::Mutex::new(None),
            sync_sweep: Arc::new(std::sync::Mutex::new(())),
            skills: Arc::new(SkillRegistry::from_env()),
        }
    }
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
