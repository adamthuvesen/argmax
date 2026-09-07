use std::{
    collections::HashMap,
    env,
    io::{self, BufRead, Read, Write},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
};

use serde::Deserialize;
use tempfile::TempDir;
use tokio::sync::broadcast;

use super::{
    actions::handle_session_control,
    protocol::{SessionControlRequest, SessionControlResponse},
    registry::{CredentialState, RegistryInner, SessionLaunchRegistry},
    ACCEPT_POLL_INTERVAL, ACCEPT_RETRY_INTERVAL, INBOX_BROADCAST_CAPACITY, MAX_REQUEST_BYTES,
    SERVER_IO_TIMEOUT,
};
use crate::{
    persistence::database::Database, providers::session_service::ProviderSessionService,
    workspaces::WorkspaceService,
};

#[derive(Debug, thiserror::Error)]
pub enum SessionLaunchError {
    #[error("Argmax session launching is not supported on this platform")]
    Unsupported,
    #[error("could not prepare Argmax session launching: {0}")]
    Setup(#[source] io::Error),
    #[error("Argmax session launch server has already started")]
    AlreadyStarted,
}

pub struct SessionLaunchServer {
    registry: Arc<SessionLaunchRegistry>,
    pub(super) _temp_dir: TempDir,
    stop: Arc<AtomicBool>,
    thread: Option<std::thread::JoinHandle<()>>,
    #[cfg(unix)]
    listener: Option<std::os::unix::net::UnixListener>,
}

impl SessionLaunchServer {
    /// `database` is where the registry keeps the disposals an agent has
    /// scheduled for the end of its turn, so a promise made in one run is
    /// still there in the next.
    #[cfg(unix)]
    pub fn bind(
        database: Arc<Database>,
    ) -> Result<(Self, Arc<SessionLaunchRegistry>), SessionLaunchError> {
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
                database,
                pending_after_turn: Mutex::new(HashMap::new()),
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
    pub fn bind(
        _database: Arc<Database>,
    ) -> Result<(Self, Arc<SessionLaunchRegistry>), SessionLaunchError> {
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
                    // Keep accepting. This listener is the only way any session
                    // reaches its tools, so leaving the loop on a failure that
                    // says nothing about the listener would fail every later
                    // `session_*` and `browser_*` call with CONNECT_FAILED
                    // until the app restarts.
                    Err(error) if is_transient_accept_error(&error) => {
                        tracing::warn!(
                            ?error,
                            "Argmax session launch socket could not accept a connection"
                        );
                        std::thread::sleep(ACCEPT_RETRY_INTERVAL);
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

/// Accept failures the listener outlives: a peer that hung up between connect
/// and accept, an interrupted syscall, and the two out-of-descriptor errors,
/// which clear as soon as other work closes its files.
#[cfg(unix)]
fn is_transient_accept_error(error: &io::Error) -> bool {
    if matches!(
        error.kind(),
        io::ErrorKind::ConnectionAborted | io::ErrorKind::Interrupted
    ) {
        return true;
    }
    // EMFILE and ENFILE have no `io::ErrorKind` of their own; the numbers are
    // the same on macOS and Linux.
    const ENFILE: i32 = 23;
    const EMFILE: i32 = 24;
    matches!(error.raw_os_error(), Some(ENFILE) | Some(EMFILE))
}

impl Drop for SessionLaunchServer {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
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
    let request = match read_json_line::<SessionControlRequest>(
        &mut stream,
        MAX_REQUEST_BYTES,
        Frame::Request,
    ) {
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

pub(super) struct ProtocolFailure {
    pub(super) code: String,
    pub(super) message: String,
}

/// Which side of the round trip a frame is. Both ends share
/// [`read_json_line`], and an agent told `REQUEST_TOO_LARGE` when it was the
/// reply that overflowed would go looking at its own call for the fault.
#[derive(Clone, Copy)]
pub(super) enum Frame {
    Request,
    Response,
}

impl Frame {
    fn noun(self) -> &'static str {
        match self {
            Frame::Request => "Request",
            Frame::Response => "Response",
        }
    }

    fn code(self, suffix: &str) -> String {
        match self {
            Frame::Request => format!("REQUEST_{suffix}"),
            Frame::Response => format!("RESPONSE_{suffix}"),
        }
    }
}

pub(super) fn read_json_line<T: for<'de> Deserialize<'de>>(
    reader: &mut impl Read,
    max_bytes: usize,
    frame: Frame,
) -> Result<T, ProtocolFailure> {
    let mut reader = io::BufReader::new(reader);
    let mut bytes = Vec::new();
    reader
        .by_ref()
        .take((max_bytes + 1) as u64)
        .read_until(b'\n', &mut bytes)
        .map_err(|error| ProtocolFailure {
            code: frame.code("READ_FAILED"),
            message: format!("{} could not be read: {error}", frame.noun()),
        })?;
    if bytes.len() > max_bytes {
        return Err(ProtocolFailure {
            code: frame.code("TOO_LARGE"),
            message: format!("{} exceeds the {max_bytes}-byte limit.", frame.noun()),
        });
    }
    if !bytes.ends_with(b"\n") {
        return Err(ProtocolFailure {
            code: frame.code("NOT_TERMINATED"),
            message: format!("{} must end with a newline.", frame.noun()),
        });
    }
    bytes.pop();
    if bytes.last() == Some(&b'\r') {
        bytes.pop();
    }
    serde_json::from_slice(&bytes).map_err(|error| ProtocolFailure {
        code: frame.code("INVALID"),
        message: format!("{} is not valid protocol JSON: {error}", frame.noun()),
    })
}

fn write_json_line(writer: &mut impl Write, response: &SessionControlResponse) -> io::Result<()> {
    serde_json::to_writer(&mut *writer, response)?;
    writer.write_all(b"\n")?;
    writer.flush()
}
