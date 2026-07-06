// Provider runtime primitives.
//
// This module owns the process/PTY layer for provider sessions:
//   - `ProviderRuntimeEvent` / `ProviderRuntimeEventType` — the wire-event
//     shape the launcher emits and the session service consumes.
//   - `ProviderRuntimeHandle` trait — per-session lifecycle surface
//     (send_input, resize, terminate, disposed/accepts_input).
//   - `ProviderProcessLauncher` trait — how the service spawns a session.
//   - `RealProviderProcessLauncher` — production implementation that
//     shells out to the discovered provider binary in structured-JSON
//     mode and pipes stdout/stderr through a blocking reader thread.
//   - `ProviderSessionHandle` — concrete handle returned by the real
//     launcher.
//
// Session lifecycle, follow-up queue, persistence side effects, and
// orphan recovery live in `session_service.rs` (this module is the
// process/IO substrate, that one is the state machine).

use std::{
    fs::File,
    future::Future,
    io::{Read, Write},
    pin::Pin,
    process::{Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Arc, Mutex,
    },
    thread,
    time::Duration,
};

#[cfg(unix)]
use std::os::fd::{AsFd, OwnedFd};

#[cfg(unix)]
use nix::{
    pty::{openpty, OpenptyResult},
    sys::termios::{tcgetattr, tcsetattr, LocalFlags, SetArg},
    unistd::dup,
};

use serde_json::json;

use super::{
    adapters::get_provider_definition, discovery::ProviderDiscovery,
    environment::build_provider_environment, flush_queue::DashboardDelta,
    normalizer::ProviderOutputStream, AgentMode, PermissionMode, ProviderId, ProviderLaunchInput,
    ProviderMode, ReasoningEffort,
};
use crate::{
    error::{ArgmaxError, ArgmaxResult},
    ipc::inputs::ComposerAttachmentInput,
    persistence::time::now_iso,
};

// ---------------------------------------------------------------------------
// Type aliases shared between the launcher and the session service.
// ---------------------------------------------------------------------------

pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;
pub type EventCallback = Arc<dyn Fn(ProviderRuntimeEvent) + Send + Sync>;
pub type DeltaPublisher = Arc<dyn Fn(DashboardDelta) + Send + Sync>;

// ---------------------------------------------------------------------------
// Runtime event surface.
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProviderRuntimeEvent {
    pub session_id: String,
    pub r#type: ProviderRuntimeEventType,
    pub stream: ProviderOutputStream,
    pub message: String,
    pub exit_code: Option<i32>,
    pub created_at: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProviderRuntimeEventType {
    Output,
    Exit,
    Error,
    /// Synthetic signal fired exactly once per session when the reader sees
    /// its first non-empty byte from the child. Lets the renderer hide the
    /// "Thinking" bubble the moment output starts flowing, even before a
    /// complete JSON line has been buffered — important for Codex, which
    /// only emits `message.completed` at end-of-turn.
    StreamStarted,
}

// ---------------------------------------------------------------------------
// Traits the session service depends on.
// ---------------------------------------------------------------------------

pub trait ProviderRuntimeHandle: Send + Sync {
    fn accepts_input(&self) -> bool;
    fn disposed(&self) -> bool;
    fn send_input(&self, input: &str);
    fn resize(&self, cols: u16, rows: u16);
    fn terminate<'a>(&'a self) -> BoxFuture<'a, ArgmaxResult<()>>;
}

pub trait ProviderProcessLauncher: Send + Sync {
    fn launch<'a>(
        &'a self,
        input: ProviderLaunchInput,
        on_event: EventCallback,
    ) -> BoxFuture<'a, ArgmaxResult<Arc<dyn ProviderRuntimeHandle>>>;
}

// ---------------------------------------------------------------------------
// Real launcher (production path).
// ---------------------------------------------------------------------------

#[derive(Clone)]
pub struct RealProviderProcessLauncher {
    discovery: ProviderDiscovery,
}

impl RealProviderProcessLauncher {
    pub fn new() -> Self {
        Self {
            discovery: ProviderDiscovery::new(),
        }
    }
}

impl Default for RealProviderProcessLauncher {
    fn default() -> Self {
        Self::new()
    }
}

impl ProviderProcessLauncher for RealProviderProcessLauncher {
    fn launch<'a>(
        &'a self,
        input: ProviderLaunchInput,
        on_event: EventCallback,
    ) -> BoxFuture<'a, ArgmaxResult<Arc<dyn ProviderRuntimeHandle>>> {
        Box::pin(async move {
            if input.mode != ProviderMode::StructuredJson {
                return Err(ArgmaxError::service(
                    "PROVIDER_MODE_UNSUPPORTED",
                    "interactive provider PTY launch is not wired yet",
                ));
            }

            let definition = get_provider_definition(input.provider);
            let capability = self.discovery.discover(input.provider).await;
            let Some(binary_path) = capability.binary_path else {
                return Err(ArgmaxError::service(
                    "PROVIDER_NOT_INSTALLED",
                    capability
                        .setup_guidance
                        .unwrap_or_else(|| format!("{} is not installed", capability.display_name)),
                ));
            };

            let args = match input.resume_conversation_id.as_deref() {
                Some(resume_id) => (definition.structured_resume_args)(&input, resume_id),
                None => (definition.structured_args)(&input),
            };

            launch_structured_via_pty(
                binary_path.as_str(),
                definition.display_name,
                args,
                &input,
                on_event,
            )
        })
    }
}

#[cfg(unix)]
fn launch_structured_via_pty(
    binary_path: &str,
    display_name: &'static str,
    args: Vec<String>,
    input: &ProviderLaunchInput,
    on_event: EventCallback,
) -> ArgmaxResult<Arc<dyn ProviderRuntimeHandle>> {
    // Connect the child's stdio to a PTY instead of pipes. With pipes,
    // `claude -p`, `codex exec --json`, and `cursor agent` all fall into
    // libc's full-block buffering for non-TTY stdout (4–8KB) and the
    // renderer sees nothing until the process exits or is signalled —
    // i.e., the "no chat until Stop" symptom. A PTY makes `isatty(stdout)`
    // true so each JSON line flushes as it is written.
    //
    // ECHO is disabled on the slave so the prompt payload we hand to
    // Codex's stdin doesn't loop back into the output stream and confuse
    // the JSON normalizer.
    let definition = get_provider_definition(input.provider);

    let OpenptyResult { master, slave } = openpty(None, None).map_err(|error| {
        ArgmaxError::service(
            "PROVIDER_PTY_OPEN_FAILED",
            format!("could not open provider PTY: {error}"),
        )
    })?;

    {
        let mut termios = tcgetattr(slave.as_fd()).map_err(termios_error)?;
        termios.local_flags.remove(
            LocalFlags::ECHO
                | LocalFlags::ECHOE
                | LocalFlags::ECHOK
                | LocalFlags::ECHONL
                | LocalFlags::ECHOCTL,
        );
        tcsetattr(slave.as_fd(), SetArg::TCSANOW, &termios).map_err(termios_error)?;
    }

    // Each Stdio takes ownership of an fd; dup the slave three times so
    // stdin/stdout/stderr each get their own.
    // nix 0.31's `dup` borrows an `AsFd` and hands back a fresh `OwnedFd`
    // we exclusively own — no raw-fd round-trip or `unsafe` needed.
    let dup_slave = || -> ArgmaxResult<OwnedFd> {
        dup(slave.as_fd()).map_err(|error| {
            ArgmaxError::service(
                "PROVIDER_PTY_DUP_FAILED",
                format!("could not dup PTY slave: {error}"),
            )
        })
    };
    let stdin_fd = dup_slave()?;
    let stdout_fd = dup_slave()?;
    let stderr_fd = dup_slave()?;

    let mut child = Command::new(binary_path)
        .args(&args)
        .current_dir(&input.workspace_path)
        .env_clear()
        .envs(build_provider_environment([
            ("NO_COLOR".to_string(), "1".to_string()),
            ("TERM".to_string(), "xterm-256color".to_string()),
        ]))
        .stdin(Stdio::from(stdin_fd))
        .stdout(Stdio::from(stdout_fd))
        .stderr(Stdio::from(stderr_fd))
        .spawn()
        .map_err(|error| {
            ArgmaxError::service(
                "PROVIDER_SPAWN_FAILED",
                format!("could not launch {display_name}: {error}"),
            )
        })?;

    // The child's stdio now owns the slave fds; drop the parent's
    // reference so the master sees EOF when the child exits.
    drop(slave);

    let mut master_file = File::from(master);

    // Write the prompt payload (Codex reads its prompt from stdin) then send
    // Ctrl-D so the child sees EOF and starts work. Claude/Cursor pass their
    // prompt via argv and ignore stdin, so the EOF is harmless for them.
    if let Some(payload) = (definition.structured_stdin)(input) {
        if let Err(error) = master_file.write_all(payload.as_bytes()) {
            let _ = child.kill();
            let _ = child.wait();
            return Err(io_error(error));
        }
        if !payload.ends_with('\n') {
            let _ = master_file.write_all(b"\n");
        }
    }
    let _ = master_file.write_all(b"\x04");
    let _ = master_file.flush();

    let pid = child.id();
    let disposed = Arc::new(AtomicBool::new(false));
    let reaped = Arc::new(AtomicBool::new(false));
    let (exit_tx, exit_rx) = mpsc::channel();

    let reader_handle = spawn_reader(
        master_file,
        input.session_id.clone(),
        ProviderOutputStream::Stdout,
        Arc::clone(&disposed),
        Arc::clone(&on_event),
    );

    let wait_session_id = input.session_id.clone();
    let wait_provider = display_name.to_string();
    let wait_disposed = Arc::clone(&disposed);
    let wait_reaped = Arc::clone(&reaped);
    // The reader normally hits EOF the instant the child exits, but a PTY fd
    // leaked to a grandchild can keep its blocking read alive indefinitely.
    // Join it off-thread and bound the wait, so a stuck reader can't wedge the
    // session on "running" forever (the Exit event would never fire).
    let (reader_drained_tx, reader_drained_rx) = mpsc::channel::<()>();
    thread::spawn(move || {
        let _ = reader_handle.join();
        let _ = reader_drained_tx.send(());
    });
    let drain_session_id = input.session_id.clone();
    thread::spawn(move || {
        let status = child.wait();
        wait_reaped.store(true, Ordering::SeqCst);
        let _ = exit_tx.send(());
        if reader_drained_rx
            .recv_timeout(Duration::from_secs(5))
            .is_err()
        {
            tracing::warn!(
                session_id = %drain_session_id,
                "provider reader did not drain within 5s; emitting exit without it"
            );
        }
        let was_disposed = wait_disposed.swap(true, Ordering::SeqCst);
        if was_disposed {
            return;
        }
        let (event_type, exit_code, message) = match status {
            Ok(status) => {
                let code = status.code().unwrap_or(1);
                (
                    if code == 0 {
                        ProviderRuntimeEventType::Exit
                    } else {
                        ProviderRuntimeEventType::Error
                    },
                    Some(code),
                    format!("{wait_provider} structured probe exited with code {code}."),
                )
            }
            Err(error) => (
                ProviderRuntimeEventType::Error,
                Some(1),
                format!("{wait_provider} structured probe wait failed: {error}"),
            ),
        };
        on_event(ProviderRuntimeEvent {
            session_id: wait_session_id,
            r#type: event_type,
            stream: ProviderOutputStream::System,
            message,
            exit_code,
            created_at: now_iso(),
        });
    });

    let handle: Arc<dyn ProviderRuntimeHandle> = Arc::new(ProviderSessionHandle {
        session_id: input.session_id.clone(),
        provider: input.provider,
        accepts_input: false,
        pid,
        disposed,
        reaped,
        exit_rx: Mutex::new(Some(exit_rx)),
    });
    Ok(handle)
}

#[cfg(not(unix))]
fn launch_structured_via_pty(
    _binary_path: &std::path::Path,
    _display_name: &'static str,
    _args: Vec<String>,
    _input: &ProviderLaunchInput,
    _on_event: EventCallback,
) -> ArgmaxResult<Arc<dyn ProviderRuntimeHandle>> {
    Err(ArgmaxError::service(
        "PROVIDER_PTY_UNSUPPORTED",
        "structured-json provider launch requires a Unix PTY",
    ))
}

#[cfg(unix)]
fn termios_error(error: nix::Error) -> ArgmaxError {
    ArgmaxError::service(
        "PROVIDER_PTY_TERMIOS",
        format!("could not configure PTY termios: {error}"),
    )
}

// ---------------------------------------------------------------------------
// Concrete handle returned by the real launcher.
// ---------------------------------------------------------------------------

pub struct ProviderSessionHandle {
    pub session_id: String,
    pub provider: ProviderId,
    accepts_input: bool,
    pid: u32,
    disposed: Arc<AtomicBool>,
    /// Set by the wait thread once `child.wait()` returns; gates every
    /// downstream signal so we don't send SIGTERM/SIGKILL into a PID the
    /// kernel may have already recycled to an unrelated process.
    reaped: Arc<AtomicBool>,
    exit_rx: Mutex<Option<mpsc::Receiver<()>>>,
}

impl ProviderRuntimeHandle for ProviderSessionHandle {
    fn accepts_input(&self) -> bool {
        self.accepts_input
    }

    fn disposed(&self) -> bool {
        self.disposed.load(Ordering::SeqCst)
    }

    fn send_input(&self, _input: &str) {
        // Structured-json sessions are single-shot: the child reads its
        // prompt from argv (and a payload via stdin at launch for Codex),
        // then exits. Follow-up messages re-launch via `--resume` rather
        // than streaming over the existing pipe. Mirrors TS behavior.
    }

    fn resize(&self, _cols: u16, _rows: u16) {
        // No-op for structured-json mode (no TTY to resize). The
        // interactive-PTY launch mode (not yet wired) will own this.
    }

    fn terminate<'a>(&'a self) -> BoxFuture<'a, ArgmaxResult<()>> {
        Box::pin(async move {
            self.disposed.store(true, Ordering::SeqCst);
            if self.reaped.load(Ordering::SeqCst) {
                return Ok(());
            }
            signal_process(self.pid, SignalKind::Term);
            let receiver = self.exit_rx.lock().expect("exit receiver poisoned").take();
            if let Some(receiver) = receiver {
                let pid = self.pid;
                let reaped = Arc::clone(&self.reaped);
                tokio::task::spawn_blocking(move || {
                    if receiver.recv_timeout(Duration::from_millis(1500)).is_err()
                        && !reaped.load(Ordering::SeqCst)
                    {
                        signal_process(pid, SignalKind::Kill);
                    }
                })
                .await
                .map_err(|error| {
                    ArgmaxError::service("PROVIDER_TERMINATE_JOIN", error.to_string())
                })?;
            }
            Ok(())
        })
    }
}

impl Drop for ProviderSessionHandle {
    fn drop(&mut self) {
        if self.disposed.swap(true, Ordering::SeqCst) {
            return;
        }
        // Synchronous best-effort cleanup. The graceful timed escalation
        // lives on the async `terminate` path; Drop is the panic-and-leak
        // safety net when async terminate never runs. Skip when the wait
        // thread already reaped: signaling a recycled PID would hit an
        // unrelated process.
        if self.reaped.load(Ordering::SeqCst) {
            return;
        }
        signal_process(self.pid, SignalKind::Term);
        signal_process(self.pid, SignalKind::Kill);
    }
}

// ---------------------------------------------------------------------------
// IO + process helpers used by the launcher and the session service.
// ---------------------------------------------------------------------------

pub(super) fn spawn_reader<R: Read + Send + 'static>(
    reader: R,
    session_id: String,
    stream: ProviderOutputStream,
    disposed: Arc<AtomicBool>,
    on_event: EventCallback,
) -> thread::JoinHandle<()> {
    let trace_stream = stream.as_str();
    let trace_session = session_id.clone();
    tracing::trace!(
        session_id = %trace_session,
        stream = trace_stream,
        "provider reader thread starting"
    );
    thread::spawn(move || {
        // Fire StreamStarted exactly once per reader, on the first non-empty
        // read. The session service forwards this to the renderer so the
        // Thinking bubble can clear the instant bytes flow — important for
        // Codex, which doesn't emit message.delta and would otherwise leave
        // Thinking on screen for the full turn duration.
        let mut announced_start = false;
        let emit = |r#type, message| {
            on_event(ProviderRuntimeEvent {
                session_id: session_id.clone(),
                r#type,
                stream: stream.clone(),
                message,
                exit_code: None,
                created_at: now_iso(),
            })
        };
        crate::util::stream_reader::pump_utf8_stream(
            reader,
            |n| {
                tracing::trace!(
                    session_id = %session_id,
                    stream = stream.as_str(),
                    bytes = n,
                    "provider reader read"
                );
                if disposed.load(Ordering::SeqCst) {
                    tracing::trace!(session_id = %session_id, "reader exiting because disposed");
                    return false;
                }
                if !announced_start {
                    announced_start = true;
                    emit(ProviderRuntimeEventType::StreamStarted, String::new());
                }
                true
            },
            |chunk| emit(ProviderRuntimeEventType::Output, chunk),
            |error| {
                tracing::warn!(
                    session_id = %session_id,
                    stream = stream.as_str(),
                    error = %error,
                    "provider reader read error"
                );
            },
        );
    })
}

pub(super) fn composer_payload(
    agent_mode: AgentMode,
    attachments: Option<&[ComposerAttachmentInput]>,
) -> serde_json::Value {
    let mut payload = json!({
        "source": "composer",
        "agentMode": agent_mode.as_str(),
    });
    if let Some(attachments) = attachments.filter(|attachments| !attachments.is_empty()) {
        payload["attachments"] = serde_json::to_value(attachments).unwrap_or_else(|_| json!([]));
    }
    payload
}

pub(super) fn attention_for_state(state: &str) -> &'static str {
    match state {
        "blocked" | "waiting" => "blocked",
        "failed" => "failed",
        "complete" => "review-ready",
        _ => "normal",
    }
}

// ---------------------------------------------------------------------------
// Wire ↔ enum coercions used by `recover_orphaned_sessions` and friends.
// These are tiny and lossy; the typed surface in `ipc::inputs` is the
// preferred entry point everywhere else.
// ---------------------------------------------------------------------------

pub(super) fn parse_provider(value: &str) -> ArgmaxResult<ProviderId> {
    match value {
        "claude" => Ok(ProviderId::Claude),
        "codex" => Ok(ProviderId::Codex),
        "cursor" => Ok(ProviderId::Cursor),
        _ => Err(ArgmaxError::service(
            "PROVIDER_UNKNOWN",
            format!("unknown provider {value}"),
        )),
    }
}

pub(super) fn parse_permission_mode(value: &str) -> ArgmaxResult<PermissionMode> {
    match value {
        "auto-approve" => Ok(PermissionMode::AutoApprove),
        "ask-each-time" => Ok(PermissionMode::AskEachTime),
        _ => Err(ArgmaxError::service(
            "PERMISSION_MODE_UNKNOWN",
            format!("unknown permission mode {value}"),
        )),
    }
}

pub(super) fn parse_agent_mode(value: &str) -> Option<AgentMode> {
    match value {
        "auto" => Some(AgentMode::Auto),
        "plan" => Some(AgentMode::Plan),
        _ => None,
    }
}

pub(super) fn parse_reasoning_effort(value: &str) -> Option<ReasoningEffort> {
    match value {
        "low" => Some(ReasoningEffort::Low),
        "medium" => Some(ReasoningEffort::Medium),
        "high" => Some(ReasoningEffort::High),
        "xhigh" => Some(ReasoningEffort::Xhigh),
        _ => None,
    }
}

// ---------------------------------------------------------------------------
// Signal helpers.
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy)]
pub(super) enum SignalKind {
    Term,
    Kill,
}

#[cfg(unix)]
pub(super) fn signal_process(pid: u32, signal: SignalKind) {
    use nix::{
        sys::signal::{kill, Signal},
        unistd::Pid,
    };
    let signal = match signal {
        SignalKind::Term => Signal::SIGTERM,
        SignalKind::Kill => Signal::SIGKILL,
    };
    // A negative `Pid::from_raw` value targets a process group (or, with
    // -1, every process the caller can signal). Reject pids that would
    // wrap into the i32 negative range so we never broadcast by accident.
    let Ok(raw) = i32::try_from(pid) else { return };
    if raw <= 0 {
        return;
    }
    let _ = kill(Pid::from_raw(raw), signal);
}

#[cfg(not(unix))]
pub(super) fn signal_process(_pid: u32, _signal: SignalKind) {}

// ---------------------------------------------------------------------------
// Error converters used throughout the session service.
// ---------------------------------------------------------------------------

pub(super) fn io_error(error: std::io::Error) -> ArgmaxError {
    ArgmaxError::service("IO", error.to_string())
}

pub(super) fn sqlite_error(error: rusqlite::Error) -> ArgmaxError {
    ArgmaxError::service("SQLITE", error.to_string())
}

// ---------------------------------------------------------------------------
// Small impl extension on a shared enum.
// ---------------------------------------------------------------------------

impl PermissionMode {
    pub(super) fn as_wire(self) -> &'static str {
        match self {
            PermissionMode::AutoApprove => "auto-approve",
            PermissionMode::AskEachTime => "ask-each-time",
        }
    }
}
