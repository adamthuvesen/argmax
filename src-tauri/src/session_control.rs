use std::{
    collections::HashMap,
    env,
    ffi::OsString,
    io::{self, BufRead, Read, Write},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};

use serde::{Deserialize, Serialize};
use tempfile::TempDir;
use tokio::sync::{broadcast, oneshot};
use uuid::Uuid;

use crate::{
    error::ArgmaxError,
    ipc::{
        inputs::{
            ProvidersLaunchInput, ProvidersSendInput, ProvidersTerminateInput, TerminalCols,
            TerminalRows, WorkspacesArchiveInput, WorkspacesCreateCurrentInput,
            WorkspacesCreateIsolatedInput,
        },
        validation::{
            BaseRef, NonEmptyString, ProjectId, Prompt, SessionId, TaskLabel, WorkspaceId,
        },
    },
    mcp::browser_bridge::{BrowserOutcome, BrowserRequest},
    persistence::{
        dashboard::DASHBOARD_ROW_LIMIT,
        database::Database,
        events::{
            latest_agent_message, latest_user_message_at, list_session_events_since,
            persist_timeline_event, PersistTimelineEventInput, TimelineEvent,
            SESSION_EVENT_PAGE_LIMIT,
        },
        projects::{list_projects, ProjectSummary},
        session_messages::{
            count_undelivered_messages, insert_session_message, take_undelivered_messages,
            NewSessionMessage, SessionMessage, MESSAGE_KIND,
        },
        sessions::{
            find_session_by_id, list_sessions_for_dashboard, record_session_launch,
            session_launch_lineage, sessions_launched_by,
        },
        workspaces::{find_workspace_by_id, list_workspaces, WorkspaceSummary},
    },
    providers::{
        session_service::{MessageOrigin, ProviderSessionService},
        ProviderLaunchInput,
    },
    workspaces::WorkspaceService,
};

const PROTOCOL_VERSION: u32 = 1;
const MAX_REQUEST_BYTES: usize = 256 * 1024;
const MAX_RESPONSE_BYTES: usize = 64 * 1024;
/// A screenshot's base64 PNG rides in the reply, so the browser action gets
/// its own ceiling. `mcp::browser_bridge` caps the image well below this.
const MAX_BROWSER_RESPONSE_BYTES: usize = 4 * 1024 * 1024;
const SERVER_IO_TIMEOUT: Duration = Duration::from_secs(5);
const CLIENT_IO_TIMEOUT: Duration = Duration::from_secs(75);
const ACCEPT_POLL_INTERVAL: Duration = Duration::from_millis(25);
const SESSION_LIST_LIMIT: usize = 40;
/// A session the user started is depth 0, so two levels of agent-launched
/// sessions exist below it and the third is refused.
const MAX_LAUNCH_DEPTH: i64 = 2;
const MAX_LAUNCHES_PER_SESSION: i64 = 10;
/// `session_read`'s byte budget: the default an agent gets when it names none,
/// and the ceiling it may ask for. The ceiling leaves headroom under
/// `MAX_RESPONSE_BYTES` for the envelope and for JSON escaping.
const SESSION_READ_DEFAULT_CHARS: usize = 16 * 1024;
const SESSION_READ_MAX_CHARS: usize = 40 * 1024;
/// The last assistant message `session_status` carries, so a status call stays
/// a status call rather than a transcript read.
const STATUS_ANSWER_CHARS: usize = 2 * 1024;
const INBOX_READ_LIMIT: usize = 50;
/// How many bytes of message body one inbox hand-over may carry. A row is
/// marked delivered only when it is actually in the reply, so this has to stay
/// under `MAX_RESPONSE_BYTES` with room for the envelope and JSON escaping;
/// what does not fit stays collectable for the next read.
const INBOX_READ_BYTE_BUDGET: usize = 48 * 1024;
const WAIT_DEFAULT_SECONDS: u64 = 120;
const WAIT_MAX_SECONDS: u64 = 600;
/// A safety re-read while a wait is blocked. The broadcast is what makes a
/// wake immediate; this only covers an edge written by something other than
/// the provider service (or a subscriber that fell behind a burst).
const WAIT_POLL_INTERVAL: Duration = Duration::from_secs(1);
/// How much longer than its own timeout a waiting client keeps the socket
/// open, so the answer to a wait that ran the full duration still arrives.
const WAIT_RESPONSE_SLACK: Duration = Duration::from_secs(30);
const INBOX_BROADCAST_CAPACITY: usize = 256;
/// Per-row caps inside a `session_read` page, so one enormous tool result
/// cannot spend the whole byte budget.
const READ_ENTRY_MAX_CHARS: usize = 2000;
const TOOL_ARGUMENT_MAX_CHARS: usize = 160;
const DEFAULT_TASK_LABEL: &str = "Local agent task";
const MAX_TASK_LABEL_CHARS: usize = 64;
const MAX_TASK_LABEL_BYTES: usize = 200;
const TASK_LABEL_ELLIPSIS: &str = "...";

pub const SESSION_LAUNCH_SOCKET_ENV: &str = "ARGMAX_SESSION_LAUNCH_SOCKET";
pub const SESSION_LAUNCH_TOKEN_ENV: &str = "ARGMAX_SESSION_LAUNCH_TOKEN";
pub const ARGMAX_BIN_ENV: &str = "ARGMAX_BIN";

#[derive(Debug, thiserror::Error)]
pub enum SessionLaunchError {
    #[error("Argmax session launching is not supported on this platform")]
    Unsupported,
    #[error("could not prepare Argmax session launching: {0}")]
    Setup(#[source] io::Error),
    #[error("Argmax session launch server has already started")]
    AlreadyStarted,
}

#[derive(Clone)]
pub struct SessionLaunchRegistry {
    inner: Arc<RegistryInner>,
}

struct RegistryInner {
    socket_path: PathBuf,
    argmax_bin: PathBuf,
    credentials: Mutex<CredentialState>,
    pending_moves: Mutex<HashMap<String, PendingMoveSignal>>,
    /// Recipients of rows just written to `session_messages`. A blocked
    /// `session_wait` subscribes to this rather than polling the table.
    inbox: broadcast::Sender<String>,
}

struct PendingMoveSignal {
    settled: Option<oneshot::Sender<()>>,
}

#[derive(Default)]
struct CredentialState {
    launches_by_token: HashMap<String, ParentLaunchSettings>,
    tokens_by_session: HashMap<String, String>,
}

#[derive(Clone)]
struct ParentLaunchSettings {
    session_id: String,
    provider: crate::providers::ProviderId,
    model_label: String,
    model_id: String,
    reasoning_effort: Option<crate::providers::ReasoningEffort>,
    fast_mode: bool,
    permission_mode: crate::providers::PermissionMode,
    agent_mode: crate::providers::AgentMode,
}

pub struct SessionLaunchProcessConfig {
    socket_path: PathBuf,
    token: String,
    argmax_bin: PathBuf,
}

impl std::fmt::Debug for SessionLaunchProcessConfig {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("SessionLaunchProcessConfig")
            .field("socket_path", &self.socket_path)
            .field("token", &"[redacted]")
            .field("argmax_bin", &self.argmax_bin)
            .finish()
    }
}

impl SessionLaunchProcessConfig {
    pub fn env_pairs(&self) -> [(String, String); 3] {
        [
            (
                SESSION_LAUNCH_SOCKET_ENV.to_string(),
                self.socket_path.to_string_lossy().into_owned(),
            ),
            (SESSION_LAUNCH_TOKEN_ENV.to_string(), self.token.clone()),
            (
                ARGMAX_BIN_ENV.to_string(),
                self.argmax_bin.to_string_lossy().into_owned(),
            ),
        ]
    }

    /// A config with fixed values, for arg-builder and injection tests in
    /// other modules (the fields are private to this one).
    #[cfg(test)]
    pub fn for_tests(socket_path: &str, token: &str, argmax_bin: &str) -> Self {
        Self {
            socket_path: PathBuf::from(socket_path),
            token: token.to_string(),
            argmax_bin: PathBuf::from(argmax_bin),
        }
    }

    pub fn socket_path(&self) -> &Path {
        &self.socket_path
    }

    pub fn token(&self) -> &str {
        &self.token
    }

    pub fn argmax_bin(&self) -> &Path {
        &self.argmax_bin
    }

    /// The launch instruction ahead of the user's prompt. Which one depends on
    /// whether this provider's launch could carry the MCP server itself.
    pub fn prepend_instruction(
        &self,
        provider: crate::providers::ProviderId,
        via_acp: bool,
        prompt: &str,
    ) -> String {
        format!(
            "{}\n\n{prompt}",
            crate::providers::mcp_injection::instruction(provider, via_acp)
        )
    }
}

impl SessionLaunchRegistry {
    pub fn issue(&self, input: &ProviderLaunchInput) -> SessionLaunchProcessConfig {
        let mut credentials = self
            .inner
            .credentials
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let token = credentials
            .tokens_by_session
            .get(&input.session_id)
            .cloned()
            .unwrap_or_else(random_bearer_token);
        credentials
            .tokens_by_session
            .insert(input.session_id.clone(), token.clone());
        credentials.launches_by_token.insert(
            token.clone(),
            ParentLaunchSettings {
                session_id: input.session_id.clone(),
                provider: input.provider,
                model_label: input.model_label.clone(),
                model_id: input.model_id.clone(),
                reasoning_effort: input.reasoning_effort,
                fast_mode: input.fast_mode,
                permission_mode: input.permission_mode,
                agent_mode: input.agent_mode,
            },
        );
        SessionLaunchProcessConfig {
            socket_path: self.inner.socket_path.clone(),
            token,
            argmax_bin: self.inner.argmax_bin.clone(),
        }
    }

    /// Drops the session's launch token. Only for a session that is gone for
    /// good: follow-up turns reuse the token issued for the first turn, so a
    /// plain process exit must not revoke it. Without this, a background process
    /// the agent left running keeps a working credential forever.
    pub fn revoke(&self, session_id: &str) {
        let mut credentials = self
            .inner
            .credentials
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some(token) = credentials.tokens_by_session.remove(session_id) {
            credentials.launches_by_token.remove(&token);
        }
    }

    fn resolve(&self, token: &str) -> Option<ParentLaunchSettings> {
        self.inner
            .credentials
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .launches_by_token
            .get(token)
            .cloned()
    }

    fn schedule_move(
        &self,
        session_id: &str,
        settled: oneshot::Sender<()>,
    ) -> Result<(), SessionControlError> {
        let mut pending = self
            .inner
            .pending_moves
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if pending.contains_key(session_id) {
            return Err(protocol_error(
                "MOVE_ALREADY_PENDING",
                "A move is already scheduled for this session.",
            ));
        }
        pending.insert(
            session_id.to_string(),
            PendingMoveSignal {
                settled: Some(settled),
            },
        );
        Ok(())
    }

    /// Announce a new row in `session_messages`. Called by whoever wrote it —
    /// the socket's `session_message` handler and the completion notice — so a
    /// waiting recipient wakes on the insert rather than on the next poll.
    pub fn notify_inbox(&self, to_session_id: &str) {
        let _ = self.inner.inbox.send(to_session_id.to_string());
    }

    pub fn subscribe_inbox(&self) -> broadcast::Receiver<String> {
        self.inner.inbox.subscribe()
    }

    pub fn cancel_move(&self, session_id: &str) {
        self.inner
            .pending_moves
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .remove(session_id);
    }

    pub fn has_pending_move(&self, session_id: &str) -> bool {
        self.inner
            .pending_moves
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .contains_key(session_id)
    }

    pub fn settle_move(&self, session_id: &str) {
        let settled = self
            .inner
            .pending_moves
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .get_mut(session_id)
            .and_then(|pending| pending.settled.take());
        if let Some(settled) = settled {
            let _ = settled.send(());
        }
    }

    fn finish_move(&self, session_id: &str) {
        self.inner
            .pending_moves
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .remove(session_id);
    }
}

pub struct SessionLaunchServer {
    registry: Arc<SessionLaunchRegistry>,
    _temp_dir: TempDir,
    stop: Arc<AtomicBool>,
    thread: Option<std::thread::JoinHandle<()>>,
    #[cfg(unix)]
    listener: Option<std::os::unix::net::UnixListener>,
}

impl SessionLaunchServer {
    #[cfg(unix)]
    pub fn bind() -> Result<(Self, Arc<SessionLaunchRegistry>), SessionLaunchError> {
        use std::os::unix::fs::PermissionsExt;

        let temp_dir = tempfile::Builder::new()
            .prefix("ax-")
            .tempdir_in("/tmp")
            .map_err(SessionLaunchError::Setup)?;
        std::fs::set_permissions(temp_dir.path(), std::fs::Permissions::from_mode(0o700))
            .map_err(SessionLaunchError::Setup)?;
        let socket_path = temp_dir.path().join("s");
        let listener = std::os::unix::net::UnixListener::bind(&socket_path)
            .map_err(SessionLaunchError::Setup)?;
        std::fs::set_permissions(&socket_path, std::fs::Permissions::from_mode(0o600))
            .map_err(SessionLaunchError::Setup)?;
        listener
            .set_nonblocking(true)
            .map_err(SessionLaunchError::Setup)?;
        let argmax_bin = env::current_exe().map_err(SessionLaunchError::Setup)?;
        let registry = Arc::new(SessionLaunchRegistry {
            inner: Arc::new(RegistryInner {
                socket_path,
                argmax_bin,
                credentials: Mutex::new(CredentialState::default()),
                pending_moves: Mutex::new(HashMap::new()),
                inbox: broadcast::channel(INBOX_BROADCAST_CAPACITY).0,
            }),
        });
        Ok((
            Self {
                registry: Arc::clone(&registry),
                _temp_dir: temp_dir,
                stop: Arc::new(AtomicBool::new(false)),
                thread: None,
                listener: Some(listener),
            },
            registry,
        ))
    }

    #[cfg(not(unix))]
    pub fn bind() -> Result<(Self, Arc<SessionLaunchRegistry>), SessionLaunchError> {
        Err(SessionLaunchError::Unsupported)
    }

    /// `app` is what the browser actions need: `browser::automation` takes an
    /// `AppHandle` explicitly, and this socket is the one caller that does not
    /// arrive through Tauri's invoke pipeline. It is optional because the
    /// protocol tests run this server with no GUI behind it; without a handle
    /// the browser actions are refused and everything else works as before.
    #[cfg(unix)]
    pub fn start(
        mut self,
        app: Option<tauri::AppHandle>,
        database: Arc<Database>,
        workspaces: Arc<WorkspaceService>,
        providers: Arc<ProviderSessionService>,
    ) -> Result<Self, SessionLaunchError> {
        let listener = self
            .listener
            .take()
            .ok_or(SessionLaunchError::AlreadyStarted)?;
        let stop = Arc::clone(&self.stop);
        let registry = Arc::clone(&self.registry);
        self.thread = Some(std::thread::spawn(move || {
            while !stop.load(Ordering::Relaxed) {
                match listener.accept() {
                    Ok((stream, _)) => {
                        let app = app.clone();
                        let database = Arc::clone(&database);
                        let workspaces = Arc::clone(&workspaces);
                        let providers = Arc::clone(&providers);
                        let registry = Arc::clone(&registry);
                        std::thread::spawn(move || {
                            handle_connection(
                                stream, app, database, workspaces, providers, registry,
                            )
                        });
                    }
                    Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                        std::thread::sleep(ACCEPT_POLL_INTERVAL);
                    }
                    Err(error) => {
                        tracing::warn!(?error, "Argmax session launch socket stopped accepting");
                        break;
                    }
                }
            }
        }));
        Ok(self)
    }

    #[cfg(not(unix))]
    pub fn start(
        self,
        _app: Option<tauri::AppHandle>,
        _database: Arc<Database>,
        _workspaces: Arc<WorkspaceService>,
        _providers: Arc<ProviderSessionService>,
    ) -> Result<Self, SessionLaunchError> {
        Err(SessionLaunchError::Unsupported)
    }
}

impl Drop for SessionLaunchServer {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

/// One request on the session-control socket.
///
/// This is the whole wire protocol: the `argmax session …` CLI and the
/// `argmax mcp` tools both build a [`SessionControlAction`] and hand it to
/// [`send_session_control`], and the socket handler matches on the same enum.
/// Each action carries exactly the fields it uses, so a nonsense combination
/// (a project selector on a message, a prompt on a move) cannot be encoded.
#[derive(Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionControlRequest {
    pub version: u32,
    pub token: String,
    pub action: SessionControlAction,
}

#[derive(Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "kebab-case", deny_unknown_fields)]
pub enum SessionControlAction {
    Launch(LaunchAction),
    Move(MoveAction),
    List(ListAction),
    Message(MessageAction),
    /// Drive the in-app browser. The MCP process has no `AppHandle`, so the
    /// tools send the action here and the app runs it — see
    /// [`crate::mcp::browser_bridge`].
    Browser(BrowserRequest),
    Status(StatusAction),
    Read(ReadAction),
    Stop(StopAction),
    Inbox(InboxAction),
    Wait(WaitAction),
}

/// Start a new top-level session. Provider and model default to the calling
/// session's own, so an agent that names neither gets a peer of itself.
#[derive(Debug, Default, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LaunchAction {
    pub prompt: String,
    #[serde(default)]
    pub project: Option<String>,
    #[serde(default)]
    pub worktree: bool,
    #[serde(default)]
    pub provider: Option<crate::providers::ProviderId>,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub task_label: Option<String>,
}

#[derive(Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MoveAction {
    pub project: String,
    #[serde(default)]
    pub worktree: bool,
    #[serde(default)]
    pub keep_source: bool,
}

#[derive(Debug, Default, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ListAction {
    #[serde(default)]
    pub project: Option<String>,
    #[serde(default)]
    pub all: bool,
}

#[derive(Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MessageAction {
    pub session_id: String,
    pub message: String,
}

/// What one session looks like right now, without reading its transcript.
#[derive(Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StatusAction {
    pub session_id: String,
}

/// The normalized timeline since a cursor. `cursor` is the `nextCursor` a
/// previous read returned; omitting it starts from the beginning.
#[derive(Debug, Default, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReadAction {
    pub session_id: String,
    #[serde(default)]
    pub cursor: Option<i64>,
    #[serde(default)]
    pub max_chars: Option<u32>,
}

#[derive(Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StopAction {
    pub session_id: String,
}

/// No arguments: an inbox read is always the caller's own.
#[derive(Debug, Default, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InboxAction {}

/// Block until a watched session settles or a message arrives. With no
/// `sessions`, the watch list is every session this caller has launched.
#[derive(Debug, Default, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WaitAction {
    #[serde(default)]
    pub sessions: Option<Vec<String>>,
    #[serde(default)]
    pub timeout_s: Option<u64>,
}

/// The response to one request. `result` is flattened, so a launch reads
/// `{"version":1,"launched":{…}}`, a list `{"version":1,"listed":{…}}`, and a
/// failure `{"version":1,"error":{…}}`.
#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionControlResponse {
    pub version: u32,
    #[serde(flatten)]
    pub result: SessionControlResult,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum SessionControlResult {
    Launched(LaunchedSession),
    Scheduled(ScheduledMove),
    Listed(SessionList),
    Messaged(MessageDelivery),
    Browsed(BrowserOutcome),
    Status(SessionStatus),
    Read(SessionRead),
    Stopped(SessionStopped),
    Inbox(InboxDelivery),
    Waited(WaitOutcome),
    Error(SessionControlError),
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LaunchedSession {
    pub session_id: String,
    pub workspace_id: String,
    pub project_id: String,
    pub project_name: String,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ScheduledMove {
    pub scheduled: bool,
    pub source_session_id: String,
    pub project_id: String,
    pub project_name: String,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionList {
    pub sessions: Vec<SessionListEntry>,
    pub truncated: bool,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MessageDelivery {
    pub session_id: String,
    /// True when the target was mid-turn and the message waits for turn end.
    pub queued: bool,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionListEntry {
    pub session_id: String,
    pub project_id: String,
    pub project_name: String,
    pub task_label: String,
    pub provider: String,
    pub state: String,
    pub last_activity_at: String,
    /// The session that launched this one, when an agent did.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub launched_by_session_id: Option<String>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionStatus {
    pub session_id: String,
    pub task_label: String,
    pub provider: String,
    pub model_id: String,
    pub state: String,
    /// Seconds since the current turn's prompt landed. `None` once the session
    /// has settled — there is no turn running to age.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub turn_age_seconds: Option<i64>,
    pub last_activity_at: String,
    /// The session's most recent visible answer, capped.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_assistant_text: Option<String>,
    /// Messages addressed to this session that no one has collected yet.
    pub unread_inbox: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub launched_by_session_id: Option<String>,
    pub launch_depth: i64,
}

/// One normalized timeline row. `kind` is what the chat shows it as, not the
/// provider's own event name.
#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReadEntry {
    pub at: String,
    pub kind: String,
    pub text: String,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionRead {
    pub session_id: String,
    pub entries: Vec<ReadEntry>,
    /// Feed this back as `cursor` to read only what arrives after these rows.
    pub next_cursor: i64,
    /// True when the byte cap cut the page short; read again from
    /// `next_cursor` for the rest.
    pub truncated: bool,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionStopped {
    pub session_id: String,
    pub state: String,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InboxMessage {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub from_session_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub from_label: Option<String>,
    pub kind: String,
    pub body: String,
    pub created_at: String,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InboxDelivery {
    pub messages: Vec<InboxMessage>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WaitedSession {
    pub session_id: String,
    pub task_label: String,
    pub state: String,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WaitOutcome {
    /// True when nothing happened before the timeout. Both lists are empty.
    pub timed_out: bool,
    /// Watched sessions that have settled.
    pub sessions: Vec<WaitedSession>,
    /// Messages that arrived for the caller, already marked delivered.
    pub messages: Vec<InboxMessage>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionControlError {
    pub code: String,
    pub message: String,
}

impl SessionControlResponse {
    fn new(result: SessionControlResult) -> Self {
        Self {
            version: PROTOCOL_VERSION,
            result,
        }
    }

    fn failure(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self::new(SessionControlResult::Error(SessionControlError {
            code: code.into(),
            message: message.into(),
        }))
    }
}

#[cfg(unix)]
fn handle_connection(
    mut stream: std::os::unix::net::UnixStream,
    app: Option<tauri::AppHandle>,
    database: Arc<Database>,
    workspaces: Arc<WorkspaceService>,
    providers: Arc<ProviderSessionService>,
    registry: Arc<SessionLaunchRegistry>,
) {
    if let Err(error) = stream.set_nonblocking(false) {
        let response = SessionControlResponse::failure(
            "STREAM_SETUP_FAILED",
            format!("Could not prepare session launch connection: {error}"),
        );
        let _ = write_json_line(&mut stream, &response);
        return;
    }
    let _ = stream.set_read_timeout(Some(SERVER_IO_TIMEOUT));
    let _ = stream.set_write_timeout(Some(SERVER_IO_TIMEOUT));
    let request = match read_json_line::<SessionControlRequest>(&mut stream, MAX_REQUEST_BYTES) {
        Ok(request) => request,
        Err(error) => {
            let response = SessionControlResponse::failure(error.code, error.message);
            let _ = write_json_line(&mut stream, &response);
            return;
        }
    };
    let Some(parent) = registry.resolve(&request.token) else {
        let response = SessionControlResponse::failure(
            "AUTH_FAILED",
            "Session launch credential is missing or invalid.",
        );
        let _ = write_json_line(&mut stream, &response);
        return;
    };
    tauri::async_runtime::spawn(async move {
        let response = handle_session_control(
            request, parent, app, database, workspaces, providers, registry,
        )
        .await
        .unwrap_or_else(|error| SessionControlResponse::failure(error.code, error.message));
        let _ = write_json_line(&mut stream, &response);
    });
}

struct ProtocolFailure {
    code: &'static str,
    message: String,
}

fn read_json_line<T: for<'de> Deserialize<'de>>(
    reader: &mut impl Read,
    max_bytes: usize,
) -> Result<T, ProtocolFailure> {
    let mut reader = io::BufReader::new(reader);
    let mut bytes = Vec::new();
    reader
        .by_ref()
        .take((max_bytes + 1) as u64)
        .read_until(b'\n', &mut bytes)
        .map_err(|error| ProtocolFailure {
            code: "REQUEST_READ_FAILED",
            message: format!("Could not read request: {error}"),
        })?;
    if bytes.len() > max_bytes {
        return Err(ProtocolFailure {
            code: "REQUEST_TOO_LARGE",
            message: format!("Request exceeds the {max_bytes}-byte limit."),
        });
    }
    if !bytes.ends_with(b"\n") {
        return Err(ProtocolFailure {
            code: "REQUEST_NOT_TERMINATED",
            message: "Request must end with a newline.".to_string(),
        });
    }
    bytes.pop();
    if bytes.last() == Some(&b'\r') {
        bytes.pop();
    }
    serde_json::from_slice(&bytes).map_err(|error| ProtocolFailure {
        code: "REQUEST_INVALID",
        message: format!("Request is not valid protocol JSON: {error}"),
    })
}

fn write_json_line(writer: &mut impl Write, response: &SessionControlResponse) -> io::Result<()> {
    serde_json::to_writer(&mut *writer, response)?;
    writer.write_all(b"\n")?;
    writer.flush()
}

/// Everything needed to launch a top-level session. The session-launch
/// socket derives it from a parent session's settings; the scheduled-task
/// scheduler derives it from a stored routine row.
pub(crate) struct LaunchSpec {
    pub project: Option<String>,
    pub prompt: String,
    pub worktree: bool,
    pub provider: crate::providers::ProviderId,
    pub model_label: String,
    pub model_id: String,
    pub reasoning_effort: Option<crate::providers::ReasoningEffort>,
    pub fast_mode: bool,
    pub permission_mode: crate::providers::PermissionMode,
    pub agent_mode: crate::providers::AgentMode,
    /// Sidebar label for the new workspace. Falls back to the prompt's first
    /// line, which is what every launch used before agents could name one.
    pub task_label: Option<String>,
}

pub(crate) struct LaunchOutcome {
    pub session_id: String,
    pub workspace_id: String,
    pub project_id: String,
    pub project_name: String,
}

/// Resolve the project, create the workspace, and launch the provider —
/// the shared tail of every programmatic session launch.
pub(crate) async fn launch_with_spec(
    spec: LaunchSpec,
    database: Arc<Database>,
    workspaces: Arc<WorkspaceService>,
    providers: Arc<ProviderSessionService>,
    fallback_project_id: &str,
) -> Result<LaunchOutcome, SessionControlError> {
    let prompt = Prompt::try_from(spec.prompt).map_err(invalid_input_error)?;
    let label = spec
        .task_label
        .as_deref()
        .map(task_label)
        .unwrap_or_else(|| task_label(prompt.as_str()));
    let task_label = TaskLabel::try_from(label).map_err(invalid_input_error)?;
    let projects = {
        let connection = database.connection();
        list_projects(&connection).map_err(argmax_protocol_error)?
    };
    let project = resolve_project(&projects, spec.project.as_deref(), fallback_project_id)?;
    let project_id = ProjectId::try_from(project.id.clone()).map_err(invalid_input_error)?;
    let model_label = NonEmptyString::try_from(spec.model_label).map_err(invalid_input_error)?;
    let model_id = NonEmptyString::try_from(spec.model_id).map_err(invalid_input_error)?;
    let cols = terminal_cols(120)?;
    let rows = terminal_rows(32)?;

    let workspace = if spec.worktree {
        let base_ref =
            BaseRef::try_from(project.current_branch.clone()).map_err(invalid_input_error)?;
        workspaces
            .create_isolated(WorkspacesCreateIsolatedInput {
                project_id,
                task_label,
                base_ref: Some(base_ref),
            })
            .await
    } else {
        workspaces.create_current(WorkspacesCreateCurrentInput {
            project_id,
            task_label,
        })
    }
    .map_err(argmax_protocol_error)?;

    let workspace_id = WorkspaceId::try_from(workspace.id.clone()).map_err(invalid_input_error)?;
    let launch_result = providers
        .launch(ProvidersLaunchInput {
            workspace_id,
            provider: spec.provider,
            prompt,
            model_label,
            model_id,
            reasoning_effort: spec.reasoning_effort,
            fast_mode: spec.fast_mode,
            agent_mode: Some(spec.agent_mode),
            permission_mode: Some(spec.permission_mode),
            cols,
            rows,
            attachments: None,
        })
        .await;
    let session = match launch_result {
        Ok(session) => session,
        Err(error) => {
            let _ = workspaces
                .archive(WorkspacesArchiveInput {
                    workspace_id: WorkspaceId::try_from(workspace.id.clone())
                        .map_err(invalid_input_error)?,
                    force: Some(false),
                })
                .await;
            return Err(argmax_protocol_error(error));
        }
    };
    Ok(LaunchOutcome {
        session_id: session.id,
        workspace_id: workspace.id,
        project_id: project.id,
        project_name: project.name,
    })
}

async fn launch_session(
    action: LaunchAction,
    parent: ParentLaunchSettings,
    database: Arc<Database>,
    workspaces: Arc<WorkspaceService>,
    providers: Arc<ProviderSessionService>,
) -> Result<SessionControlResponse, SessionControlError> {
    let (parent_project_id, lineage) = {
        let connection = database.connection();
        let parent_session =
            find_session_by_id(&connection, &parent.session_id).map_err(argmax_protocol_error)?;
        let project_id = find_workspace_by_id(&connection, &parent_session.workspace_id)
            .map_err(argmax_protocol_error)?
            .project_id;
        let lineage = session_launch_lineage(&connection, &parent.session_id)
            .map_err(argmax_protocol_error)?;
        (project_id, lineage)
    };
    let depth = lineage.depth + 1;
    if depth > MAX_LAUNCH_DEPTH {
        return Err(protocol_error(
            "LAUNCH_DEPTH_EXCEEDED",
            format!(
                "Launched sessions may go {MAX_LAUNCH_DEPTH} levels deep and this session is already at {}. Do the work here, or message a session nearer the top to launch it.",
                lineage.depth
            ),
        ));
    }
    if lineage.launched >= MAX_LAUNCHES_PER_SESSION {
        return Err(protocol_error(
            "LAUNCH_LIMIT_REACHED",
            format!(
                "This session has already launched {MAX_LAUNCHES_PER_SESSION} sessions, which is the per-session cap. Message one of them instead."
            ),
        ));
    }
    let provider = action.provider.unwrap_or(parent.provider);
    // A model id names a model the CLI accepts; Rust has no label catalog
    // (labels live in `src/shared/providerModels.ts`), so an explicit id is
    // its own sidebar label — the same fallback session sync uses.
    let (model_label, model_id, reasoning_effort) =
        match (action.model, provider == parent.provider) {
            (Some(model), _) => (model.clone(), model, provider_effort(provider, &parent)),
            (None, true) => (
                parent.model_label.clone(),
                parent.model_id.clone(),
                parent.reasoning_effort,
            ),
            (None, false) => {
                let defaults = crate::provider_defaults(provider.as_str());
                (
                    defaults.model_label.to_string(),
                    defaults.model_id.to_string(),
                    parse_reasoning_effort(defaults.reasoning_effort),
                )
            }
        };
    let outcome = launch_with_spec(
        LaunchSpec {
            project: action.project,
            prompt: action.prompt,
            worktree: action.worktree,
            provider,
            model_label,
            model_id,
            reasoning_effort,
            fast_mode: parent.fast_mode,
            permission_mode: parent.permission_mode,
            agent_mode: parent.agent_mode,
            task_label: action.task_label,
        },
        Arc::clone(&database),
        workspaces,
        providers,
        &parent_project_id,
    )
    .await?;
    {
        let connection = database.connection();
        record_session_launch(&connection, &outcome.session_id, &parent.session_id, depth)
            .map_err(argmax_protocol_error)?;
    }
    Ok(SessionControlResponse::new(SessionControlResult::Launched(
        LaunchedSession {
            session_id: outcome.session_id,
            workspace_id: outcome.workspace_id,
            project_id: outcome.project_id,
            project_name: outcome.project_name,
        },
    )))
}

/// The effort to carry onto an explicitly named model: the caller's own when
/// it stays on its provider, that provider's default otherwise.
fn provider_effort(
    provider: crate::providers::ProviderId,
    parent: &ParentLaunchSettings,
) -> Option<crate::providers::ReasoningEffort> {
    if provider == parent.provider {
        return parent.reasoning_effort;
    }
    parse_reasoning_effort(crate::provider_defaults(provider.as_str()).reasoning_effort)
}

fn parse_reasoning_effort(value: Option<&str>) -> Option<crate::providers::ReasoningEffort> {
    serde_json::from_value(serde_json::json!(value?)).ok()
}

async fn handle_session_control(
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
    match request.action {
        SessionControlAction::Launch(action) => {
            launch_session(action, parent, database, workspaces, providers).await
        }
        SessionControlAction::Move(action) => {
            schedule_session_move(action, parent, database, workspaces, providers, registry).await
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
    }
}

async fn list_sessions_action(
    action: ListAction,
    parent: ParentLaunchSettings,
    database: Arc<Database>,
) -> Result<SessionControlResponse, SessionControlError> {
    if action.all && action.project.is_some() {
        return Err(protocol_error(
            "ARGUMENT_INVALID",
            "A session list is scoped either by project or across all of them, not both.",
        ));
    }
    let connection = database.connection();
    let all_projects = list_projects(&connection).map_err(argmax_protocol_error)?;
    let parent_project_id = {
        let parent_session =
            find_session_by_id(&connection, &parent.session_id).map_err(argmax_protocol_error)?;
        find_workspace_by_id(&connection, &parent_session.workspace_id)
            .map_err(argmax_protocol_error)?
            .project_id
    };
    let scoped_projects = if action.all {
        all_projects
            .into_iter()
            .filter(|project| project.id != crate::workspaces::SCRATCH_PROJECT_ID)
            .collect::<Vec<_>>()
    } else {
        vec![resolve_project(
            &all_projects,
            action.project.as_deref(),
            &parent_project_id,
        )?]
    };
    let project_names: HashMap<String, String> = scoped_projects
        .iter()
        .map(|project| (project.id.clone(), project.name.clone()))
        .collect();

    let workspaces =
        list_workspaces(&connection, None, DASHBOARD_ROW_LIMIT).map_err(argmax_protocol_error)?;
    let workspaces_by_id: HashMap<String, &WorkspaceSummary> = workspaces
        .iter()
        .map(|workspace| (workspace.id.clone(), workspace))
        .collect();
    let workspace_ids: Vec<String> = workspaces
        .iter()
        .filter(|workspace| {
            project_names.contains_key(&workspace.project_id)
                && !matches!(workspace.state.as_str(), "archiving" | "archived")
        })
        .map(|workspace| workspace.id.clone())
        .collect();

    let sessions =
        list_sessions_for_dashboard(&connection, Some(&workspace_ids), DASHBOARD_ROW_LIMIT)
            .map_err(argmax_protocol_error)?;
    let mut entries: Vec<SessionListEntry> = sessions
        .into_iter()
        .filter(|session| session.id != parent.session_id)
        .filter_map(|session| {
            let workspace = workspaces_by_id.get(&session.workspace_id)?;
            let project_name = project_names.get(&workspace.project_id)?.clone();
            Some(SessionListEntry {
                session_id: session.id,
                project_id: workspace.project_id.clone(),
                project_name,
                task_label: workspace.task_label.clone(),
                provider: session.provider,
                state: session.state,
                last_activity_at: session.last_activity_at,
                launched_by_session_id: session.launched_by_session_id,
            })
        })
        .collect();
    entries.sort_by(|left, right| right.last_activity_at.cmp(&left.last_activity_at));
    let truncated = entries.len() > SESSION_LIST_LIMIT;
    entries.truncate(SESSION_LIST_LIMIT);
    Ok(SessionControlResponse::new(SessionControlResult::Listed(
        SessionList {
            sessions: entries,
            truncated,
        },
    )))
}

async fn message_session(
    action: MessageAction,
    parent: ParentLaunchSettings,
    database: Arc<Database>,
    providers: Arc<ProviderSessionService>,
    registry: Arc<SessionLaunchRegistry>,
) -> Result<SessionControlResponse, SessionControlError> {
    if action.session_id == parent.session_id {
        return Err(protocol_error(
            "MESSAGE_SELF",
            "A session cannot message itself; name another session's id.",
        ));
    }
    let target = SessionId::try_from(action.session_id.clone()).map_err(invalid_input_error)?;
    let message = Prompt::try_from(action.message.clone()).map_err(invalid_input_error)?;
    // The row goes in before the turn does. It is what `inbox_read` and
    // `session_wait` see, so a recipient that is mid-turn — or one that is
    // deliberately polling instead of taking turns — still collects the
    // message even though the delivery below only queues it.
    let (message_id, label) = {
        let connection = database.connection();
        find_session_by_id(&connection, &action.session_id).map_err(argmax_protocol_error)?;
        let id = Uuid::new_v4().to_string();
        insert_session_message(
            &connection,
            &NewSessionMessage {
                id: id.clone(),
                from_session_id: Some(parent.session_id.clone()),
                to_session_id: action.session_id.clone(),
                body: action.message,
                kind: MESSAGE_KIND.to_string(),
            },
        )
        .map_err(argmax_protocol_error)?;
        (id, session_task_label(&connection, &parent.session_id))
    };
    registry.notify_inbox(&action.session_id);
    let result = providers
        .send_input_with_origin(
            ProvidersSendInput {
                session_id: target,
                input: message,
                provider: None,
                model_label: None,
                model_id: None,
                reasoning_effort: None,
                fast_mode: false,
                agent_mode: None,
                attachments: None,
            },
            Some(MessageOrigin {
                session_id: parent.session_id.clone(),
                label,
                kind: MESSAGE_KIND.to_string(),
            }),
        )
        .await
        .map_err(argmax_protocol_error)?;
    // A message that reached the recipient as a turn has been delivered; one
    // that is still queued has not, and stays collectable from the inbox.
    if !result.queued {
        let connection = database.connection();
        if let Err(error) =
            crate::persistence::session_messages::mark_message_delivered(&connection, &message_id)
        {
            tracing::warn!(?error, "failed to mark a session message delivered");
        }
    }
    Ok(SessionControlResponse::new(SessionControlResult::Messaged(
        MessageDelivery {
            session_id: action.session_id,
            queued: result.queued,
        },
    )))
}

/// A session's sidebar label, falling back to its id when the workspace is
/// gone. Used wherever a message names who sent it.
fn session_task_label(connection: &rusqlite::Connection, session_id: &str) -> String {
    find_session_by_id(connection, session_id)
        .and_then(|session| find_workspace_by_id(connection, &session.workspace_id))
        .map(|workspace| workspace.task_label)
        .unwrap_or_else(|_| session_id.to_string())
}

fn session_status(
    action: StatusAction,
    database: Arc<Database>,
) -> Result<SessionControlResponse, SessionControlError> {
    let connection = database.read_connection();
    let session =
        find_session_by_id(&connection, &action.session_id).map_err(argmax_protocol_error)?;
    let workspace =
        find_workspace_by_id(&connection, &session.workspace_id).map_err(argmax_protocol_error)?;
    let turn_age_seconds = (!is_settled(&session.state))
        .then(|| {
            latest_user_message_at(&connection, &action.session_id)
                .ok()
                .flatten()
                .or_else(|| Some(session.started_at.clone()))
                .and_then(|at| seconds_since(&at))
        })
        .flatten();
    let last_assistant_text = latest_agent_message(&connection, &action.session_id)
        .map_err(argmax_protocol_error)?
        .map(|text| cap_chars(&text, STATUS_ANSWER_CHARS));
    let unread_inbox = count_undelivered_messages(&connection, &action.session_id)
        .map_err(argmax_protocol_error)?;
    let lineage =
        session_launch_lineage(&connection, &action.session_id).map_err(argmax_protocol_error)?;
    Ok(SessionControlResponse::new(SessionControlResult::Status(
        SessionStatus {
            session_id: session.id,
            task_label: workspace.task_label,
            provider: session.provider,
            model_id: session.model_id,
            state: session.state,
            turn_age_seconds,
            last_activity_at: session.last_activity_at,
            last_assistant_text,
            unread_inbox,
            launched_by_session_id: session.launched_by_session_id,
            launch_depth: lineage.depth,
        },
    )))
}

fn session_read(
    action: ReadAction,
    database: Arc<Database>,
) -> Result<SessionControlResponse, SessionControlError> {
    let budget = action
        .max_chars
        .map(|value| (value as usize).min(SESSION_READ_MAX_CHARS))
        .unwrap_or(SESSION_READ_DEFAULT_CHARS);
    let connection = database.read_connection();
    find_session_by_id(&connection, &action.session_id).map_err(argmax_protocol_error)?;
    // The same read the chat pane takes. `events` is already the normalized
    // timeline — every provider's output is translated into these rows on the
    // way in — so this summarizes rows rather than re-parsing provider JSON.
    // A read with no cursor starts at the beginning of the transcript. The
    // cursorless read this shares with the chat pane returns the *newest* page,
    // which is right for a surface that scrolls up and wrong for an agent that
    // pages forward from `nextCursor`, so name row 0 rather than leaving it out.
    let cursor = action.cursor.unwrap_or(0);
    let page = list_session_events_since(&connection, &action.session_id, Some(cursor), None)
        .map_err(argmax_protocol_error)?;
    drop(connection);

    let mut entries = Vec::new();
    let mut spent = 0usize;
    // A full page of rows means the row limit, not the byte budget, is what
    // ended this page: there is more to read from `nextCursor`.
    let mut truncated = page.events.len() == SESSION_EVENT_PAGE_LIMIT;
    let mut next_cursor = page.event_cursor;
    for event in page.events {
        let cursor = event.row_cursor.unwrap_or(next_cursor);
        let Some(entry) = read_entry(&event) else {
            continue;
        };
        if spent + entry.text.len() > budget && !entries.is_empty() {
            truncated = true;
            next_cursor = cursor - 1;
            break;
        }
        spent += entry.text.len();
        next_cursor = cursor;
        entries.push(entry);
    }
    Ok(SessionControlResponse::new(SessionControlResult::Read(
        SessionRead {
            session_id: action.session_id,
            entries,
            next_cursor,
            truncated,
        },
    )))
}

async fn stop_session(
    action: StopAction,
    parent: ParentLaunchSettings,
    database: Arc<Database>,
    providers: Arc<ProviderSessionService>,
) -> Result<SessionControlResponse, SessionControlError> {
    if action.session_id == parent.session_id {
        return Err(protocol_error(
            "STOP_SELF",
            "A session cannot stop its own turn; finish the turn instead.",
        ));
    }
    let session_id = SessionId::try_from(action.session_id.clone()).map_err(invalid_input_error)?;
    providers
        .terminate(ProvidersTerminateInput { session_id })
        .await
        .map_err(argmax_protocol_error)?;
    // The state that actually landed, not the one a stop usually produces: a
    // session whose turn had already ended stays `complete`, and telling the
    // agent it was cancelled would be a lie it then reports to the user.
    let state = {
        let connection = database.read_connection();
        find_session_by_id(&connection, &action.session_id)
            .map_err(argmax_protocol_error)?
            .state
    };
    Ok(SessionControlResponse::new(SessionControlResult::Stopped(
        SessionStopped {
            session_id: action.session_id,
            state,
        },
    )))
}

fn inbox_read(
    parent: ParentLaunchSettings,
    database: Arc<Database>,
) -> Result<SessionControlResponse, SessionControlError> {
    let mut connection = database.connection();
    let messages = take_undelivered_messages(
        &mut connection,
        &parent.session_id,
        INBOX_READ_LIMIT,
        INBOX_READ_BYTE_BUDGET,
    )
    .map_err(argmax_protocol_error)?;
    let messages = to_inbox_messages(&connection, messages);
    Ok(SessionControlResponse::new(SessionControlResult::Inbox(
        InboxDelivery { messages },
    )))
}

fn to_inbox_messages(
    connection: &rusqlite::Connection,
    messages: Vec<SessionMessage>,
) -> Vec<InboxMessage> {
    messages
        .into_iter()
        .map(|message| InboxMessage {
            from_label: message
                .from_session_id
                .as_deref()
                .map(|id| session_task_label(connection, id)),
            from_session_id: message.from_session_id,
            kind: message.kind,
            body: message.body,
            created_at: message.created_at,
        })
        .collect()
}

fn is_settled(state: &str) -> bool {
    !matches!(state, "running" | "waiting" | "blocked")
}

fn seconds_since(at: &str) -> Option<i64> {
    let then = chrono::DateTime::parse_from_rfc3339(at).ok()?;
    Some((chrono::Utc::now() - then.with_timezone(&chrono::Utc)).num_seconds())
}

fn cap_chars(text: &str, max_chars: usize) -> String {
    if text.chars().count() <= max_chars {
        return text.to_string();
    }
    let mut out: String = text.chars().take(max_chars).collect();
    out.push_str("...");
    out
}

/// One timeline row as a line an agent can read. Rows the chat itself hides —
/// streaming deltas, subagent traces, lifecycle bookkeeping — return `None`.
fn read_entry(event: &TimelineEvent) -> Option<ReadEntry> {
    if event.payload.get("parent_tool_use_id").is_some()
        || event.payload.get("traceImported").is_some()
    {
        return None;
    }
    let (kind, text) = match event.r#type.as_str() {
        "user.message" => {
            let from = event
                .payload
                .pointer("/origin/label")
                .and_then(|value| value.as_str());
            let text = match from {
                Some(label) => format!("[from {label}] {}", event.message),
                None => event.message.clone(),
            };
            ("user", text)
        }
        "message.completed" if !event.message.trim().is_empty() => {
            ("assistant", event.message.clone())
        }
        "command.started" => (
            "tool",
            format!("{} {}", event.message, tool_arguments(event)),
        ),
        "command.completed" => (
            "tool-result",
            format!("{} -> {}", tool_name(event), tool_outcome(event)),
        ),
        "error" if !event.message.trim().is_empty() => ("error", event.message.clone()),
        "session.completed" => ("state", "session finished".to_string()),
        "session.cancelled" => ("state", "session cancelled".to_string()),
        _ => return None,
    };
    Some(ReadEntry {
        at: event.created_at.clone(),
        kind: kind.to_string(),
        text: cap_chars(text.trim(), READ_ENTRY_MAX_CHARS),
    })
}

fn tool_name(event: &TimelineEvent) -> String {
    event
        .payload
        .get("toolName")
        .and_then(|value| value.as_str())
        .unwrap_or(if event.message.trim().is_empty() {
            "tool"
        } else {
            event.message.trim()
        })
        .to_string()
}

/// The one argument worth a line: whichever of the common input keys the
/// provider filled in, otherwise the compact JSON of the whole input.
fn tool_arguments(event: &TimelineEvent) -> String {
    let Some(input) = event.payload.get("input") else {
        return String::new();
    };
    for key in [
        "command",
        "file_path",
        "target_file",
        "path",
        "pattern",
        "query",
        "url",
        "prompt",
    ] {
        if let Some(value) = input.get(key).and_then(|value| value.as_str()) {
            return cap_chars(value.trim(), TOOL_ARGUMENT_MAX_CHARS);
        }
    }
    cap_chars(&input.to_string(), TOOL_ARGUMENT_MAX_CHARS)
}

fn tool_outcome(event: &TimelineEvent) -> String {
    let failed = matches!(
        event
            .payload
            .get("is_error")
            .or(event.payload.get("isError")),
        Some(serde_json::Value::Bool(true))
    );
    if !failed {
        return "ok".to_string();
    }
    let detail = event.message.lines().next().unwrap_or_default().trim();
    if detail.is_empty() {
        "error".to_string()
    } else {
        format!("error: {}", cap_chars(detail, TOOL_ARGUMENT_MAX_CHARS))
    }
}

/// Block until something the caller cares about happens.
///
/// The two wake-ups are a watched session settling and a message arriving for
/// the caller. Both are in-process broadcasts, subscribed to *before* the
/// first database read, so an edge that lands between subscribing and reading
/// is queued rather than lost. Nothing here holds a database connection across
/// an await: every look at the rows opens and drops its own.
async fn wait_for_sessions(
    action: WaitAction,
    parent: ParentLaunchSettings,
    database: Arc<Database>,
    providers: Arc<ProviderSessionService>,
    registry: Arc<SessionLaunchRegistry>,
) -> Result<SessionControlResponse, SessionControlError> {
    let timeout = Duration::from_secs(
        action
            .timeout_s
            .unwrap_or(WAIT_DEFAULT_SECONDS)
            .clamp(1, WAIT_MAX_SECONDS),
    );
    let mut states = providers.subscribe_session_states();
    let mut inbox = registry.subscribe_inbox();

    let watched = {
        let connection = database.read_connection();
        match action.sessions {
            Some(ids) => {
                if ids.is_empty() {
                    return Err(protocol_error(
                        "WAIT_NO_SESSIONS",
                        "The sessions list is empty. Name session ids, or omit it to wait on the sessions you launched.",
                    ));
                }
                for id in &ids {
                    find_session_by_id(&connection, id).map_err(argmax_protocol_error)?;
                }
                ids
            }
            None => {
                let launched = sessions_launched_by(&connection, &parent.session_id)
                    .map_err(argmax_protocol_error)?;
                if launched.is_empty() {
                    return Err(protocol_error(
                        "WAIT_NOTHING_TO_WATCH",
                        "This session has not launched any sessions, so there is nothing to wait for. Name sessions explicitly to watch other ones.",
                    ));
                }
                launched
            }
        }
    };

    let deadline = tokio::time::Instant::now() + timeout;
    loop {
        if let Some(outcome) = collect_wait_outcome(&database, &parent.session_id, &watched)? {
            return Ok(SessionControlResponse::new(SessionControlResult::Waited(
                outcome,
            )));
        }
        let woken = tokio::select! {
            _ = tokio::time::sleep_until(deadline) => false,
            // A lagged subscriber has missed edges; the re-read at the top of
            // the loop is what recovers them, so any result wakes us.
            _ = states.recv() => true,
            _ = inbox.recv() => true,
            // The safety re-read. State written outside the provider service
            // (or a burst that overran a subscriber) still surfaces here.
            _ = tokio::time::sleep(WAIT_POLL_INTERVAL) => true,
        };
        if !woken {
            return Ok(SessionControlResponse::new(SessionControlResult::Waited(
                WaitOutcome {
                    timed_out: true,
                    sessions: Vec::new(),
                    messages: Vec::new(),
                },
            )));
        }
    }
}

/// What the wait would report right now, or `None` while nothing has happened.
fn collect_wait_outcome(
    database: &Database,
    caller_session_id: &str,
    watched: &[String],
) -> Result<Option<WaitOutcome>, SessionControlError> {
    let settled = {
        let connection = database.read_connection();
        let mut settled = Vec::new();
        for session_id in watched {
            let Ok(session) = find_session_by_id(&connection, session_id) else {
                continue;
            };
            if !is_settled(&session.state) {
                continue;
            }
            settled.push(WaitedSession {
                task_label: session_task_label(&connection, session_id),
                session_id: session.id,
                state: session.state,
            });
        }
        settled
    };
    let has_message = {
        let connection = database.read_connection();
        count_undelivered_messages(&connection, caller_session_id).map_err(argmax_protocol_error)?
            > 0
    };
    if settled.is_empty() && !has_message {
        return Ok(None);
    }
    // Taking the messages needs the writer, so it happens only once the wait
    // is actually returning.
    let messages = {
        let mut connection = database.connection();
        let taken = take_undelivered_messages(
            &mut connection,
            caller_session_id,
            INBOX_READ_LIMIT,
            INBOX_READ_BYTE_BUDGET,
        )
        .map_err(argmax_protocol_error)?;
        to_inbox_messages(&connection, taken)
    };
    Ok(Some(WaitOutcome {
        timed_out: false,
        sessions: settled,
        messages,
    }))
}

async fn schedule_session_move(
    action: MoveAction,
    parent: ParentLaunchSettings,
    database: Arc<Database>,
    workspaces: Arc<WorkspaceService>,
    providers: Arc<ProviderSessionService>,
    registry: Arc<SessionLaunchRegistry>,
) -> Result<SessionControlResponse, SessionControlError> {
    let selector = action.project.as_str();
    let (source_session, source_workspace, destination) = {
        let connection = database.connection();
        let source_session =
            find_session_by_id(&connection, &parent.session_id).map_err(argmax_protocol_error)?;
        let source_workspace = find_workspace_by_id(&connection, &source_session.workspace_id)
            .map_err(argmax_protocol_error)?;
        let projects = list_projects(&connection).map_err(argmax_protocol_error)?;
        let destination = resolve_project(&projects, Some(selector), &source_workspace.project_id)?;
        (source_session, source_workspace, destination)
    };
    if destination.id == source_workspace.project_id {
        return Err(protocol_error(
            "MOVE_SAME_PROJECT",
            "The destination must be a different project.",
        ));
    }

    let (settled_tx, settled_rx) = oneshot::channel();
    registry.schedule_move(&parent.session_id, settled_tx)?;
    if let Err(error) = providers.ensure_move_schedulable(&parent.session_id) {
        registry.cancel_move(&parent.session_id);
        return Err(argmax_protocol_error(error));
    }
    let requested_event = {
        let connection = database.connection();
        persist_timeline_event(
            &connection,
            &PersistTimelineEventInput {
                id: Uuid::new_v4().to_string(),
                session_id: parent.session_id.clone(),
                r#type: "session.move-requested".to_string(),
                message: format!("Move to {} scheduled.", destination.name),
                payload: serde_json::json!({
                    "destinationProjectId": destination.id,
                    "destinationProjectName": destination.name,
                    "worktree": action.worktree,
                    "keepSource": action.keep_source,
                }),
                created_at: None,
            },
        )
    };
    let requested_event = match requested_event {
        Ok(event) => event,
        Err(error) => {
            registry.cancel_move(&parent.session_id);
            return Err(argmax_protocol_error(error));
        }
    };
    workspaces.publish_session_with_events(source_session, vec![requested_event]);

    let source_session_id = parent.session_id.clone();
    let destination_project_id = destination.id.clone();
    let destination_project_name = destination.name.clone();
    let scheduled_destination_project_id = destination_project_id.clone();
    let move_registry = Arc::clone(&registry);
    tauri::async_runtime::spawn(async move {
        if settled_rx.await.is_err() {
            move_registry.finish_move(&source_session_id);
            return;
        }
        let result = workspaces
            .move_session_to_project(
                &source_session_id,
                &scheduled_destination_project_id,
                action.worktree,
                action.keep_source,
            )
            .await;
        if let Err(error) = result {
            tracing::warn!(
                ?error,
                session_id = %source_session_id,
                "scheduled session move failed"
            );
            if let Err(record_error) =
                workspaces.record_session_move_failure(&source_session_id, &error)
            {
                tracing::error!(
                    ?record_error,
                    session_id = %source_session_id,
                    "failed to record session move failure"
                );
            }
        }
        move_registry.finish_move(&source_session_id);
    });

    Ok(SessionControlResponse::new(
        SessionControlResult::Scheduled(ScheduledMove {
            scheduled: true,
            source_session_id: parent.session_id,
            project_id: destination_project_id,
            project_name: destination_project_name,
        }),
    ))
}

fn resolve_project(
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

fn task_label(prompt: &str) -> String {
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

fn terminal_cols(value: u16) -> Result<TerminalCols, SessionControlError> {
    serde_json::from_value(serde_json::json!(value)).map_err(|error| {
        protocol_error(
            "INTERNAL_INPUT_INVALID",
            format!("Could not prepare terminal columns: {error}"),
        )
    })
}

fn terminal_rows(value: u16) -> Result<TerminalRows, SessionControlError> {
    serde_json::from_value(serde_json::json!(value)).map_err(|error| {
        protocol_error(
            "INTERNAL_INPUT_INVALID",
            format!("Could not prepare terminal rows: {error}"),
        )
    })
}

fn invalid_input_error(error: crate::error::InvalidInputIssue) -> SessionControlError {
    protocol_error(error.code, error.message)
}

pub(crate) fn argmax_protocol_error(error: ArgmaxError) -> SessionControlError {
    match error {
        ArgmaxError::InvalidInput { issues } => issues.into_iter().next().map_or_else(
            || protocol_error("INVALID_INPUT", "Input is invalid."),
            invalid_input_error,
        ),
        ArgmaxError::RecordNotFound { kind, id } => {
            protocol_error("RECORD_NOT_FOUND", format!("{kind} '{id}' was not found."))
        }
        ArgmaxError::MigrationDrift { detail } => protocol_error("MIGRATION_DRIFT", detail),
        ArgmaxError::ServiceError { sub_code, message } => SessionControlError {
            code: sub_code,
            message,
        },
    }
}

fn protocol_error(code: impl Into<String>, message: impl Into<String>) -> SessionControlError {
    SessionControlError {
        code: code.into(),
        message: message.into(),
    }
}

fn random_bearer_token() -> String {
    format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple())
}

#[derive(Debug, PartialEq)]
pub enum CliPrompt {
    Value(String),
    Stdin,
}

#[derive(Debug, PartialEq)]
pub enum SessionControlCliInput {
    Launch {
        project: Option<String>,
        prompt: CliPrompt,
        worktree: bool,
    },
    Move {
        project: String,
        worktree: bool,
        keep_source: bool,
    },
    List {
        project: Option<String>,
        all: bool,
    },
    Message {
        session_id: String,
        prompt: CliPrompt,
    },
}

impl SessionControlCliInput {
    /// Resolve `--prompt-stdin` and hand back the wire action. Parsing never
    /// reads stdin, so the argv shape and the protocol stay separate types.
    fn into_action(self) -> Result<SessionControlAction, SessionControlError> {
        Ok(match self {
            SessionControlCliInput::Launch {
                project,
                prompt,
                worktree,
            } => SessionControlAction::Launch(LaunchAction {
                prompt: prompt.read()?,
                project,
                worktree,
                ..LaunchAction::default()
            }),
            SessionControlCliInput::Move {
                project,
                worktree,
                keep_source,
            } => SessionControlAction::Move(MoveAction {
                project,
                worktree,
                keep_source,
            }),
            SessionControlCliInput::List { project, all } => {
                SessionControlAction::List(ListAction { project, all })
            }
            SessionControlCliInput::Message { session_id, prompt } => {
                SessionControlAction::Message(MessageAction {
                    session_id,
                    message: prompt.read()?,
                })
            }
        })
    }
}

impl CliPrompt {
    fn read(self) -> Result<String, SessionControlError> {
        match self {
            CliPrompt::Value(value) => Ok(value),
            CliPrompt::Stdin => read_bounded_stdin(),
        }
    }
}

pub fn try_run_session_control_cli<I, S>(args: I) -> Option<i32>
where
    I: IntoIterator<Item = S>,
    S: Into<OsString>,
{
    let args = args.into_iter().map(Into::into).collect::<Vec<_>>();
    if args.get(1).and_then(|value| value.to_str()) != Some("session") {
        return None;
    }
    let input = match parse_session_control_cli(&args) {
        Ok(input) => input,
        Err(message) => {
            eprintln!("argmax: {message}");
            return Some(2);
        }
    };
    Some(run_session_control_cli(input))
}

fn parse_session_control_cli(args: &[OsString]) -> Result<SessionControlCliInput, String> {
    match args.get(2).and_then(|value| value.to_str()) {
        Some("launch") => parse_session_launch_cli(args),
        Some("move") => parse_session_move_cli(args),
        Some("list") => parse_session_list_cli(args),
        Some("message") => parse_session_message_cli(args),
        _ => Err(session_control_usage()),
    }
}

fn parse_session_launch_cli(args: &[OsString]) -> Result<SessionControlCliInput, String> {
    let mut project = None;
    let mut prompt = None;
    let mut worktree = false;
    let mut index = 3;
    while index < args.len() {
        let flag = args[index]
            .to_str()
            .ok_or_else(|| "arguments must be valid UTF-8".to_string())?;
        match flag {
            "--project" => {
                if project.is_some() {
                    return Err("--project may be provided only once".to_string());
                }
                index += 1;
                let value = args
                    .get(index)
                    .and_then(|value| value.to_str())
                    .ok_or_else(|| "--project requires a value".to_string())?;
                if value.is_empty() {
                    return Err("--project must not be empty".to_string());
                }
                project = Some(value.to_string());
            }
            "--worktree" => {
                if worktree {
                    return Err("--worktree may be provided only once".to_string());
                }
                worktree = true;
            }
            "--prompt" => {
                if prompt.is_some() {
                    return Err("provide exactly one of --prompt or --prompt-stdin".to_string());
                }
                index += 1;
                let value = args
                    .get(index)
                    .and_then(|value| value.to_str())
                    .ok_or_else(|| "--prompt requires a UTF-8 value".to_string())?;
                prompt = Some(CliPrompt::Value(value.to_string()));
            }
            "--prompt-stdin" => {
                if prompt.is_some() {
                    return Err("provide exactly one of --prompt or --prompt-stdin".to_string());
                }
                prompt = Some(CliPrompt::Stdin);
            }
            _ => return Err(format!("unknown session launch argument '{flag}'")),
        }
        index += 1;
    }
    let prompt = prompt.ok_or_else(session_launch_usage)?;
    Ok(SessionControlCliInput::Launch {
        project,
        prompt,
        worktree,
    })
}

fn parse_session_move_cli(args: &[OsString]) -> Result<SessionControlCliInput, String> {
    let mut project = None;
    let mut worktree = false;
    let mut keep_source = false;
    let mut index = 3;
    while index < args.len() {
        let flag = args[index]
            .to_str()
            .ok_or_else(|| "arguments must be valid UTF-8".to_string())?;
        match flag {
            "--project" => {
                if project.is_some() {
                    return Err("--project may be provided only once".to_string());
                }
                index += 1;
                let value = args
                    .get(index)
                    .and_then(|value| value.to_str())
                    .ok_or_else(|| "--project requires a value".to_string())?;
                if value.is_empty() {
                    return Err("--project must not be empty".to_string());
                }
                project = Some(value.to_string());
            }
            "--worktree" => {
                if worktree {
                    return Err("--worktree may be provided only once".to_string());
                }
                worktree = true;
            }
            "--keep-source" => {
                if keep_source {
                    return Err("--keep-source may be provided only once".to_string());
                }
                keep_source = true;
            }
            _ => return Err(format!("unknown session move argument '{flag}'")),
        }
        index += 1;
    }
    Ok(SessionControlCliInput::Move {
        project: project.ok_or_else(session_move_usage)?,
        worktree,
        keep_source,
    })
}

fn parse_session_list_cli(args: &[OsString]) -> Result<SessionControlCliInput, String> {
    let mut project = None;
    let mut all = false;
    let mut index = 3;
    while index < args.len() {
        let flag = args[index]
            .to_str()
            .ok_or_else(|| "arguments must be valid UTF-8".to_string())?;
        match flag {
            "--project" => {
                if project.is_some() {
                    return Err("--project may be provided only once".to_string());
                }
                index += 1;
                let value = args
                    .get(index)
                    .and_then(|value| value.to_str())
                    .ok_or_else(|| "--project requires a value".to_string())?;
                if value.is_empty() {
                    return Err("--project must not be empty".to_string());
                }
                project = Some(value.to_string());
            }
            "--all" => {
                if all {
                    return Err("--all may be provided only once".to_string());
                }
                all = true;
            }
            _ => return Err(format!("unknown session list argument '{flag}'")),
        }
        index += 1;
    }
    if all && project.is_some() {
        return Err("--all cannot be combined with --project".to_string());
    }
    Ok(SessionControlCliInput::List { project, all })
}

fn parse_session_message_cli(args: &[OsString]) -> Result<SessionControlCliInput, String> {
    let mut session_id = None;
    let mut prompt = None;
    let mut index = 3;
    while index < args.len() {
        let flag = args[index]
            .to_str()
            .ok_or_else(|| "arguments must be valid UTF-8".to_string())?;
        match flag {
            "--session" => {
                if session_id.is_some() {
                    return Err("--session may be provided only once".to_string());
                }
                index += 1;
                let value = args
                    .get(index)
                    .and_then(|value| value.to_str())
                    .ok_or_else(|| "--session requires a value".to_string())?;
                if value.is_empty() {
                    return Err("--session must not be empty".to_string());
                }
                session_id = Some(value.to_string());
            }
            "--prompt" => {
                if prompt.is_some() {
                    return Err("provide exactly one of --prompt or --prompt-stdin".to_string());
                }
                index += 1;
                let value = args
                    .get(index)
                    .and_then(|value| value.to_str())
                    .ok_or_else(|| "--prompt requires a UTF-8 value".to_string())?;
                prompt = Some(CliPrompt::Value(value.to_string()));
            }
            "--prompt-stdin" => {
                if prompt.is_some() {
                    return Err("provide exactly one of --prompt or --prompt-stdin".to_string());
                }
                prompt = Some(CliPrompt::Stdin);
            }
            _ => return Err(format!("unknown session message argument '{flag}'")),
        }
        index += 1;
    }
    Ok(SessionControlCliInput::Message {
        session_id: session_id.ok_or_else(session_message_usage)?,
        prompt: prompt.ok_or_else(session_message_usage)?,
    })
}

fn session_launch_usage() -> String {
    "usage: argmax session launch [--project VALUE] [--worktree] (--prompt VALUE | --prompt-stdin)"
        .to_string()
}

fn session_move_usage() -> String {
    "usage: argmax session move --project VALUE [--worktree] [--keep-source]".to_string()
}

fn session_message_usage() -> String {
    "usage: argmax session message --session VALUE (--prompt VALUE | --prompt-stdin)".to_string()
}

fn session_control_usage() -> String {
    "usage: argmax session <launch|move|list|message> [arguments]".to_string()
}

fn run_session_control_cli(input: SessionControlCliInput) -> i32 {
    #[cfg(not(unix))]
    {
        let _ = input;
        eprintln!("argmax: session launching is not supported on this platform");
        return 1;
    }
    #[cfg(unix)]
    {
        match input.into_action().and_then(send_session_control) {
            Ok(response) => {
                println!(
                    "{}",
                    serde_json::to_string(&response)
                        .unwrap_or_else(|_| "{\"ok\":true}".to_string())
                );
                0
            }
            Err(error) => {
                eprintln!("argmax: {}: {}", error.code, error.message);
                1
            }
        }
    }
}

/// One round trip on the session-control socket. Every caller — the CLI, the
/// MCP tools — goes through here, so the framing, the timeouts, and the size
/// caps have one implementation.
#[cfg(unix)]
pub fn send_session_control(
    action: SessionControlAction,
) -> Result<SessionControlResponse, SessionControlError> {
    use std::net::Shutdown;
    use std::os::unix::net::UnixStream;

    let socket = env::var_os(SESSION_LAUNCH_SOCKET_ENV).ok_or_else(|| {
        protocol_error(
            "ENV_MISSING",
            format!("{SESSION_LAUNCH_SOCKET_ENV} is not set. Run this command inside Argmax."),
        )
    })?;
    let token = env::var(SESSION_LAUNCH_TOKEN_ENV).map_err(|_| {
        protocol_error(
            "ENV_MISSING",
            format!("{SESSION_LAUNCH_TOKEN_ENV} is not set. Run this command inside Argmax."),
        )
    })?;
    let request = SessionControlRequest {
        version: PROTOCOL_VERSION,
        token,
        action,
    };
    let mut encoded = serde_json::to_vec(&request).map_err(|error| {
        protocol_error(
            "REQUEST_ENCODE_FAILED",
            format!("Could not encode request: {error}"),
        )
    })?;
    encoded.push(b'\n');
    if encoded.len() > MAX_REQUEST_BYTES {
        return Err(protocol_error(
            "REQUEST_TOO_LARGE",
            format!("Request exceeds the {MAX_REQUEST_BYTES}-byte limit."),
        ));
    }
    let mut stream = UnixStream::connect(PathBuf::from(socket)).map_err(|error| {
        protocol_error(
            "CONNECT_FAILED",
            format!("Could not connect to Argmax: {error}"),
        )
    })?;
    stream
        .set_read_timeout(Some(client_read_timeout(&request.action)))
        .map_err(|error| protocol_error("TIMEOUT_SETUP_FAILED", error.to_string()))?;
    stream
        .set_write_timeout(Some(CLIENT_IO_TIMEOUT))
        .map_err(|error| protocol_error("TIMEOUT_SETUP_FAILED", error.to_string()))?;
    stream.write_all(&encoded).map_err(|error| {
        protocol_error(
            "REQUEST_WRITE_FAILED",
            format!("Could not send request: {error}"),
        )
    })?;
    stream
        .shutdown(Shutdown::Write)
        .map_err(|error| protocol_error("REQUEST_WRITE_FAILED", error.to_string()))?;
    let response_cap = match request.action {
        SessionControlAction::Browser(_) => MAX_BROWSER_RESPONSE_BYTES,
        _ => MAX_RESPONSE_BYTES,
    };
    let response = read_json_line::<SessionControlResponse>(&mut stream, response_cap)
        .map_err(|error| protocol_error(error.code, error.message))?;
    if response.version != PROTOCOL_VERSION {
        return Err(protocol_error(
            "VERSION_UNSUPPORTED",
            format!("Argmax returned protocol version {}.", response.version),
        ));
    }
    let matches_action = match (&request.action, &response.result) {
        (_, SessionControlResult::Error(_)) => true,
        (SessionControlAction::Launch(_), SessionControlResult::Launched(_)) => true,
        (SessionControlAction::Move(_), SessionControlResult::Scheduled(_)) => true,
        (SessionControlAction::List(_), SessionControlResult::Listed(_)) => true,
        (SessionControlAction::Message(_), SessionControlResult::Messaged(_)) => true,
        (SessionControlAction::Browser(_), SessionControlResult::Browsed(_)) => true,
        (SessionControlAction::Status(_), SessionControlResult::Status(_)) => true,
        (SessionControlAction::Read(_), SessionControlResult::Read(_)) => true,
        (SessionControlAction::Stop(_), SessionControlResult::Stopped(_)) => true,
        (SessionControlAction::Inbox(_), SessionControlResult::Inbox(_)) => true,
        (SessionControlAction::Wait(_), SessionControlResult::Waited(_)) => true,
        _ => false,
    };
    if !matches_action {
        return Err(protocol_error(
            "RESPONSE_INVALID",
            "Argmax answered with a result that does not match the request.",
        ));
    }
    match response.result {
        SessionControlResult::Error(error) => Err(error),
        result => Ok(SessionControlResponse::new(result)),
    }
}

/// How long the client waits for an answer. Every action but `wait` settles
/// within the ordinary timeout; a wait is a deliberate block, so the socket
/// stays open for its own timeout plus enough slack to carry the reply.
fn client_read_timeout(action: &SessionControlAction) -> Duration {
    match action {
        SessionControlAction::Wait(action) => {
            Duration::from_secs(
                action
                    .timeout_s
                    .unwrap_or(WAIT_DEFAULT_SECONDS)
                    .clamp(1, WAIT_MAX_SECONDS),
            ) + WAIT_RESPONSE_SLACK
        }
        _ => CLIENT_IO_TIMEOUT,
    }
}

fn read_bounded_stdin() -> Result<String, SessionControlError> {
    let mut bytes = Vec::new();
    io::stdin()
        .take((MAX_REQUEST_BYTES + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|error| {
            protocol_error(
                "STDIN_READ_FAILED",
                format!("Could not read prompt from stdin: {error}"),
            )
        })?;
    if bytes.len() > MAX_REQUEST_BYTES {
        return Err(protocol_error(
            "REQUEST_TOO_LARGE",
            format!("Prompt exceeds the {MAX_REQUEST_BYTES}-byte request limit."),
        ));
    }
    String::from_utf8(bytes)
        .map_err(|_| protocol_error("PROMPT_INVALID", "Prompt stdin must be valid UTF-8."))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        persistence::projects::{ProjectCounts, ProjectSettings},
        providers::{AgentMode, PermissionMode, ProviderId, ReasoningEffort},
    };
    #[cfg(unix)]
    use std::os::unix::fs::PermissionsExt;

    fn launch_input(session_id: &str) -> ProviderLaunchInput {
        ProviderLaunchInput {
            provider: ProviderId::Codex,
            session_id: session_id.to_string(),
            workspace_path: PathBuf::from("/tmp/repo"),
            prompt: "parent prompt".to_string(),
            model_label: "GPT-5.6 Sol".to_string(),
            model_id: "gpt-5.6-sol".to_string(),
            reasoning_effort: Some(ReasoningEffort::High),
            fast_mode: true,
            resume_conversation_id: None,
            resume_fork: false,
            permission_mode: PermissionMode::AutoApprove,
            agent_mode: AgentMode::Auto,
            cols: 120,
            rows: 32,
        }
    }

    fn project(id: &str, name: &str, repo_path: &str) -> ProjectSummary {
        ProjectSummary {
            id: id.to_string(),
            name: name.to_string(),
            repo_path: repo_path.to_string(),
            current_branch: "main".to_string(),
            default_branch: Some("main".to_string()),
            settings: ProjectSettings {
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
    fn cli_parser_accepts_prompt_value_and_stdin_forms() {
        let args = [
            "argmax",
            "session",
            "launch",
            "--project",
            "Argmax",
            "--worktree",
            "--prompt",
            "Review this",
        ]
        .map(OsString::from);
        assert_eq!(
            parse_session_launch_cli(&args).unwrap(),
            SessionControlCliInput::Launch {
                project: Some("Argmax".to_string()),
                prompt: CliPrompt::Value("Review this".to_string()),
                worktree: true,
            }
        );

        let stdin_args = ["argmax", "session", "launch", "--prompt-stdin"].map(OsString::from);
        assert_eq!(
            parse_session_launch_cli(&stdin_args).unwrap(),
            SessionControlCliInput::Launch {
                project: None,
                prompt: CliPrompt::Stdin,
                worktree: false,
            }
        );
    }

    #[test]
    fn cli_parser_accepts_move_flags_and_requires_project() {
        let args = [
            "argmax",
            "session",
            "move",
            "--project",
            "Other",
            "--worktree",
            "--keep-source",
        ]
        .map(OsString::from);
        assert_eq!(
            parse_session_control_cli(&args).unwrap(),
            SessionControlCliInput::Move {
                project: "Other".to_string(),
                worktree: true,
                keep_source: true,
            }
        );

        for args in [
            vec!["argmax", "session", "move"],
            vec![
                "argmax",
                "session",
                "move",
                "--project",
                "Other",
                "--prompt",
                "no",
            ],
        ] {
            let args = args.into_iter().map(OsString::from).collect::<Vec<_>>();
            assert!(parse_session_control_cli(&args).is_err());
        }
    }

    #[test]
    fn cli_parser_rejects_missing_duplicate_and_unknown_arguments() {
        for args in [
            vec!["argmax", "session", "launch"],
            vec![
                "argmax",
                "session",
                "launch",
                "--prompt",
                "one",
                "--prompt-stdin",
            ],
            vec!["argmax", "session", "launch", "--wat"],
        ] {
            let args = args.into_iter().map(OsString::from).collect::<Vec<_>>();
            assert!(parse_session_launch_cli(&args).is_err());
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

    #[test]
    fn request_rejects_unknown_fields_and_requires_newline() {
        let with_unknown =
            b"{\"version\":1,\"token\":\"x\",\"action\":{\"list\":{\"all\":true}},\"extra\":true}\n";
        assert_eq!(
            read_json_line::<SessionControlRequest>(
                &mut with_unknown.as_slice(),
                MAX_REQUEST_BYTES
            )
            .unwrap_err()
            .code,
            "REQUEST_INVALID"
        );
        // A field that belongs to another action is rejected with it.
        let wrong_action =
            b"{\"version\":1,\"token\":\"x\",\"action\":{\"list\":{\"keepSource\":true}}}\n";
        assert_eq!(
            read_json_line::<SessionControlRequest>(
                &mut wrong_action.as_slice(),
                MAX_REQUEST_BYTES
            )
            .unwrap_err()
            .code,
            "REQUEST_INVALID"
        );
        let no_newline = br#"{"version":1,"token":"x","action":{"list":{"all":false}}}"#;
        assert_eq!(
            read_json_line::<SessionControlRequest>(&mut no_newline.as_slice(), MAX_REQUEST_BYTES)
                .unwrap_err()
                .code,
            "REQUEST_NOT_TERMINATED"
        );
    }

    #[test]
    fn the_wire_round_trips_every_action_and_result() {
        let request = SessionControlRequest {
            version: PROTOCOL_VERSION,
            token: "t".to_string(),
            action: SessionControlAction::Launch(LaunchAction {
                prompt: "Do it".to_string(),
                project: Some("Argmax".to_string()),
                worktree: true,
                provider: Some(ProviderId::Claude),
                model: Some("claude-opus-5".to_string()),
                task_label: Some("Side quest".to_string()),
            }),
        };
        let encoded = serde_json::to_value(&request).expect("encode");
        assert_eq!(encoded["action"]["launch"]["provider"], "claude");
        assert_eq!(
            serde_json::from_value::<SessionControlRequest>(encoded).expect("decode"),
            request
        );

        for action in [
            SessionControlAction::Move(MoveAction {
                project: "Other".to_string(),
                worktree: false,
                keep_source: true,
            }),
            SessionControlAction::List(ListAction::default()),
            SessionControlAction::Message(MessageAction {
                session_id: "s1".to_string(),
                message: "ping".to_string(),
            }),
        ] {
            let encoded = serde_json::to_string(&action).expect("encode");
            assert_eq!(
                serde_json::from_str::<SessionControlAction>(&encoded).expect("decode"),
                action
            );
        }

        // The result is flattened, so an agent reads `{"version":1,"messaged":…}`.
        let response =
            SessionControlResponse::new(SessionControlResult::Messaged(MessageDelivery {
                session_id: "s1".to_string(),
                queued: true,
            }));
        let encoded = serde_json::to_value(&response).expect("encode");
        assert_eq!(encoded["messaged"]["queued"], true);
        assert_eq!(encoded["version"], PROTOCOL_VERSION);
    }

    #[test]
    fn the_cli_resolves_its_prompt_into_one_wire_action() {
        let action = SessionControlCliInput::Launch {
            project: Some("Argmax".to_string()),
            prompt: CliPrompt::Value("Ship it".to_string()),
            worktree: true,
        }
        .into_action()
        .expect("action");
        assert_eq!(
            action,
            SessionControlAction::Launch(LaunchAction {
                prompt: "Ship it".to_string(),
                project: Some("Argmax".to_string()),
                worktree: true,
                provider: None,
                model: None,
                task_label: None,
            })
        );

        let message = SessionControlCliInput::Message {
            session_id: "abc".to_string(),
            prompt: CliPrompt::Value("Ping".to_string()),
        }
        .into_action()
        .expect("action");
        assert_eq!(
            message,
            SessionControlAction::Message(MessageAction {
                session_id: "abc".to_string(),
                message: "Ping".to_string(),
            })
        );
    }

    #[cfg(unix)]
    #[test]
    fn credentials_are_stable_per_session_and_redacted_from_debug() {
        let (server, registry) = SessionLaunchServer::bind().unwrap();
        let first = registry.issue(&launch_input("session-1"));
        let second = registry.issue(&launch_input("session-1"));
        let other = registry.issue(&launch_input("session-2"));
        assert_eq!(
            first.env_pairs()[1].1,
            second.env_pairs()[1].1,
            "one session should reuse one bounded registry entry"
        );
        assert_ne!(first.env_pairs()[1].1, other.env_pairs()[1].1);
        assert!(!format!("{first:?}").contains(&first.env_pairs()[1].1));
        assert_eq!(
            std::fs::metadata(server._temp_dir.path())
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o700
        );
        assert_eq!(
            std::fs::metadata(&registry.inner.socket_path)
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
    }

    #[cfg(unix)]
    #[test]
    fn revoked_session_token_stops_resolving() {
        let (_server, registry) = SessionLaunchServer::bind().unwrap();
        let issued = registry.issue(&launch_input("session-1"));
        let token = issued.env_pairs()[1].1.clone();
        assert!(registry.resolve(&token).is_some());

        registry.revoke("session-1");
        assert!(registry.resolve(&token).is_none());

        // A later session gets a fresh token rather than the revoked one.
        let reissued = registry.issue(&launch_input("session-1"));
        assert_ne!(reissued.env_pairs()[1].1, token);
    }

    #[cfg(unix)]
    #[test]
    fn pending_move_stays_guarded_until_execution_finishes() {
        let (_server, registry) = SessionLaunchServer::bind().unwrap();
        let (settled_tx, mut settled_rx) = oneshot::channel();
        registry.schedule_move("session-1", settled_tx).unwrap();
        assert!(registry.has_pending_move("session-1"));
        assert!(settled_rx.try_recv().is_err());

        registry.settle_move("session-1");
        assert_eq!(settled_rx.try_recv(), Ok(()));
        assert!(registry.has_pending_move("session-1"));

        registry.finish_move("session-1");
        assert!(!registry.has_pending_move("session-1"));
    }

    #[test]
    fn process_config_adds_env_and_hidden_instruction() {
        let config = SessionLaunchProcessConfig {
            socket_path: PathBuf::from("/tmp/a/s"),
            token: "secret".to_string(),
            argmax_bin: PathBuf::from("/Applications/Argmax.app/argmax"),
        };
        let env = config.env_pairs();
        assert_eq!(env[0].0, SESSION_LAUNCH_SOCKET_ENV);
        assert_eq!(
            env[1],
            (SESSION_LAUNCH_TOKEN_ENV.to_string(), "secret".to_string())
        );
        assert_eq!(env[2].0, ARGMAX_BIN_ENV);
        // A provider that loads the MCP server is told one line; one that
        // cannot gets the shell commands spelled out.
        let with_tools = config.prepend_instruction(ProviderId::Claude, false, "Do the work");
        assert!(with_tools.starts_with("Argmax tools are available as the `argmax` MCP server"));
        assert!(with_tools.ends_with("\n\nDo the work"));
        let cursor_pty = config.prepend_instruction(ProviderId::Cursor, false, "Do the work");
        assert!(cursor_pty.contains("session launch --project"));
        assert_eq!(
            config.prepend_instruction(ProviderId::Cursor, true, "Do the work"),
            with_tools
        );
        assert!(config.prepend_instruction(ProviderId::Grok, false, "Do the work") == cursor_pty);
    }

    #[test]
    fn cli_parser_accepts_list_flags_and_rejects_all_with_project() {
        let args = ["argmax", "session", "list", "--project", "Argmax"].map(OsString::from);
        assert_eq!(
            parse_session_control_cli(&args).unwrap(),
            SessionControlCliInput::List {
                project: Some("Argmax".to_string()),
                all: false,
            }
        );

        let all_args = ["argmax", "session", "list", "--all"].map(OsString::from);
        assert_eq!(
            parse_session_control_cli(&all_args).unwrap(),
            SessionControlCliInput::List {
                project: None,
                all: true,
            }
        );

        let bare_args = ["argmax", "session", "list"].map(OsString::from);
        assert_eq!(
            parse_session_control_cli(&bare_args).unwrap(),
            SessionControlCliInput::List {
                project: None,
                all: false,
            }
        );

        let conflicting =
            ["argmax", "session", "list", "--all", "--project", "Argmax"].map(OsString::from);
        assert!(parse_session_control_cli(&conflicting).is_err());
    }

    #[test]
    fn cli_parser_accepts_message_flags_and_requires_session_and_prompt() {
        let args = [
            "argmax",
            "session",
            "message",
            "--session",
            "abc123",
            "--prompt",
            "Ping",
        ]
        .map(OsString::from);
        assert_eq!(
            parse_session_control_cli(&args).unwrap(),
            SessionControlCliInput::Message {
                session_id: "abc123".to_string(),
                prompt: CliPrompt::Value("Ping".to_string()),
            }
        );

        for args in [
            vec!["argmax", "session", "message", "--prompt", "Ping"],
            vec!["argmax", "session", "message", "--session", "abc123"],
            vec![
                "argmax",
                "session",
                "message",
                "--session",
                "abc123",
                "--prompt",
                "one",
                "--prompt-stdin",
            ],
        ] {
            let args = args.into_iter().map(OsString::from).collect::<Vec<_>>();
            assert!(parse_session_control_cli(&args).is_err());
        }
    }
}
