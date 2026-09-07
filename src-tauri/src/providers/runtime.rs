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

use crate::{
    session_control::{SessionLaunchProcessConfig, SessionLaunchRegistry},
    util::sync::LockOrRecover,
};
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
    ReasoningEffort,
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
    session_launch_registry: Option<Arc<SessionLaunchRegistry>>,
    cursor_acp: Arc<super::cursor_acp::CursorAcpSessions>,
    approvals: Option<Arc<crate::approvals::service::ApprovalService>>,
    grok_acp: Arc<super::grok_acp::GrokAcpSessions>,
}

impl RealProviderProcessLauncher {
    pub fn new() -> Self {
        Self {
            discovery: ProviderDiscovery::new(),
            session_launch_registry: None,
            cursor_acp: Arc::new(super::cursor_acp::CursorAcpSessions::new()),
            approvals: None,
            grok_acp: Arc::new(super::grok_acp::GrokAcpSessions::new()),
        }
    }

    pub fn with_grok_acp(mut self, pool: Arc<super::grok_acp::GrokAcpSessions>) -> Self {
        self.grok_acp = pool;
        self
    }

    pub fn with_approvals(
        mut self,
        approvals: Arc<crate::approvals::service::ApprovalService>,
    ) -> Self {
        self.approvals = Some(approvals);
        self
    }

    /// Share the boot-warmed discovery cache (`AppState.provider_discovery`).
    /// A launcher with its own fresh cache re-probes each provider's version
    /// and auth status on its first launch — `cursor-agent status` alone runs
    /// ~800 ms — so the first session per provider paid a probe the app had
    /// already done at boot.
    pub fn with_discovery(
        discovery: ProviderDiscovery,
        session_launch_registry: Option<Arc<SessionLaunchRegistry>>,
        cursor_acp: Arc<super::cursor_acp::CursorAcpSessions>,
    ) -> Self {
        Self {
            discovery,
            session_launch_registry,
            cursor_acp,
            approvals: None,
            grok_acp: Arc::new(super::grok_acp::GrokAcpSessions::new()),
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
        mut input: ProviderLaunchInput,
        on_event: EventCallback,
    ) -> BoxFuture<'a, ArgmaxResult<Arc<dyn ProviderRuntimeHandle>>> {
        Box::pin(async move {
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

            let session_launch = self
                .session_launch_registry
                .as_ref()
                .map(|registry| registry.issue(&input));

            // Warm-process fast path: eligible Cursor launches run as ACP
            // prompts on a per-workspace `cursor-agent acp` process instead of
            // paying the ~5.5 s one-shot client boot per turn. The warm process
            // is shared per workspace, so the per-session credential rides in
            // the `mcpServers` entry of `session/new` / `session/load` rather
            // than in the process environment. A failed handshake is surfaced
            // instead of silently losing native approval handling.
            if super::cursor_acp::is_acp_eligible(&input) {
                // ACP receives the same launch instructions as the other
                // native transports. Handshake failures return to the caller.
                let mut acp_input = input.clone();
                if let Some(config) = session_launch.as_ref() {
                    acp_input.prompt = config.prepend_instruction(&input.prompt);
                }
                match self
                    .cursor_acp
                    .launch_turn_with_approvals(
                        binary_path.as_str(),
                        &acp_input,
                        session_launch.as_ref(),
                        self.approvals.clone(),
                        Arc::clone(&on_event),
                    )
                    .await
                {
                    Ok(handle) => return Ok(handle),
                    Err(error) => return Err(error),
                }
            }

            if let Some(config) = session_launch.as_ref() {
                input.prompt = config.prepend_instruction(&input.prompt);
            }

            // A fork is the one Grok launch ACP cannot serve: `session/load`
            // would continue the source conversation under a second session id,
            // so a fork falls through to the CLI's `--fork-session`.
            if super::grok_acp::is_acp_eligible(&input) {
                return self
                    .grok_acp
                    .launch_turn(
                        &binary_path,
                        &input,
                        session_launch.as_ref(),
                        self.approvals.clone(),
                        on_event,
                    )
                    .await;
            }

            if input.provider == ProviderId::Opencode {
                let approvals = self.approvals.clone().ok_or_else(|| {
                    ArgmaxError::service(
                        "APPROVAL_SERVICE_NOT_READY",
                        "Approval service is not initialized",
                    )
                })?;
                return super::opencode_server::launch_turn(
                    &binary_path,
                    &input,
                    session_launch.as_ref(),
                    approvals,
                    on_event,
                )
                .await;
            }

            if input.provider == ProviderId::Codex {
                let approvals = self.approvals.clone().ok_or_else(|| {
                    ArgmaxError::service(
                        "APPROVAL_SERVICE_NOT_READY",
                        "Approval service is not initialized",
                    )
                })?;
                return super::codex_app_server::launch_turn(
                    &binary_path,
                    &input,
                    session_launch.as_ref(),
                    approvals,
                    on_event,
                )
                .await;
            }

            if input.provider == ProviderId::Claude {
                let approvals = self.approvals.clone().ok_or_else(|| {
                    ArgmaxError::service(
                        "APPROVAL_SERVICE_NOT_READY",
                        "Approval service is not initialized",
                    )
                })?;
                return super::claude_control::launch_turn(
                    &binary_path,
                    &input,
                    session_launch.as_ref(),
                    approvals,
                    on_event,
                )
                .await;
            }

            let args = match input.resume_conversation_id.as_deref() {
                Some(resume_id) => {
                    (definition.structured_resume_args)(&input, resume_id, session_launch.as_ref())
                }
                None => (definition.structured_args)(&input, session_launch.as_ref()),
            };

            launch_structured_via_pty(
                binary_path.as_str(),
                definition.display_name,
                args,
                &input,
                on_event,
                session_launch.as_ref(),
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
    session_launch: Option<&SessionLaunchProcessConfig>,
) -> ArgmaxResult<Arc<dyn ProviderRuntimeHandle>> {
    // Connect the child's stdio to a PTY instead of pipes. With pipes,
    // `claude -p`, `codex exec --json`, and `cursor agent` all fall into
    // libc's full-block buffering for non-TTY stdout (4–8KB) and the
    // renderer sees nothing until the process exits or is signalled —
    // i.e., the "no chat until Stop" symptom. A PTY makes `isatty(stdout)`
    // true so each JSON line flushes as it is written.
    //
    // Only stdout and stderr go through the PTY. Stdin is an ordinary pipe:
    // a PTY runs its input through the line discipline, which caps one line
    // at TTYHOG (1024 bytes on macOS) and, past that, drops the line and
    // rings a BEL per discarded byte back onto the PTY's output side. A
    // pasted paragraph longer than that reached Codex as an empty prompt and
    // reached the renderer as a wall of bells. A pipe has no such limit, and
    // closing it is a real EOF rather than a canonical-mode Ctrl-D.
    //
    // ECHO is still disabled on the slave so nothing the child writes loops
    // back into the output stream and confuses the JSON normalizer.
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

    // Each Stdio takes ownership of an fd; dup the slave twice so stdout and
    // stderr each get their own.
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
    let stdout_fd = dup_slave()?;
    let stderr_fd = dup_slave()?;

    let mut environment_overrides = vec![
        ("NO_COLOR".to_string(), "1".to_string()),
        ("TERM".to_string(), "xterm-256color".to_string()),
    ];
    if input.provider == ProviderId::Claude {
        // Print mode otherwise kills active background agents after ten minutes,
        // even while they are making progress. The user can still stop the turn.
        environment_overrides.push((
            "CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS".to_string(),
            "0".to_string(),
        ));
    }
    if let Some(config) = session_launch {
        environment_overrides.extend(config.env_pairs());
    }
    // OpenCode, Grok, and Cursor's one-shot path have no per-launch MCP flag:
    // their server spec is inline environment or a config file in the
    // workspace, put back once the child exits.
    let (mcp_environment, mcp_scratch) = super::mcp_injection::launch_files(
        input.provider,
        &input.workspace_path,
        &input.session_id,
        session_launch,
    );
    environment_overrides.extend(mcp_environment);

    let mut child = Command::new(binary_path)
        .args(&args)
        .current_dir(&input.workspace_path)
        .env_clear()
        .envs(build_provider_environment(environment_overrides))
        .stdin(Stdio::piped())
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

    let master_file = File::from(master);

    // Write the prompt payload (Codex reads its prompt from stdin), then drop
    // the handle so the child sees EOF and starts work. Claude/Cursor pass
    // their prompt via argv and ignore stdin, so the immediate EOF is
    // harmless for them.
    if let Some(mut child_stdin) = child.stdin.take() {
        if let Some(payload) = (definition.structured_stdin)(input) {
            let mut write = child_stdin.write_all(payload.as_bytes());
            if write.is_ok() && !payload.ends_with('\n') {
                write = child_stdin.write_all(b"\n");
            }
            if let Err(error) = write.and_then(|()| child_stdin.flush()) {
                let _ = child.kill();
                let _ = child.wait();
                return Err(io_error(error));
            }
        }
    }

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
        mcp_scratch.restore();
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
    _session_launch: Option<&SessionLaunchProcessConfig>,
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
            let receiver = self.exit_rx.lock_or_recover("exit receiver").take();
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

// ---------------------------------------------------------------------------
// Wire ↔ enum coercions used by `recover_orphaned_sessions` and friends.
// These are tiny and lossy; the typed surface in `ipc::inputs` is the
// preferred entry point everywhere else.
// ---------------------------------------------------------------------------

pub(crate) fn parse_provider(value: &str) -> ArgmaxResult<ProviderId> {
    match value {
        "claude" => Ok(ProviderId::Claude),
        "codex" => Ok(ProviderId::Codex),
        "cursor" => Ok(ProviderId::Cursor),
        "opencode" => Ok(ProviderId::Opencode),
        "grok" => Ok(ProviderId::Grok),
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
        "provider-defaults" => Ok(PermissionMode::ProviderDefaults),
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
        "max" => Some(ReasoningEffort::Max),
        "ultra" => Some(ReasoningEffort::Ultra),
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
            PermissionMode::ProviderDefaults => "provider-defaults",
        }
    }
}

#[cfg(all(test, feature = "verification", unix))]
mod verification_tests {
    use super::*;
    use std::{path::PathBuf, process::Command as ProcessCommand, time::Instant};

    const CHILD_ENV: &str = "ARGMAX_VERIFICATION_RUNTIME_TEST_CHILD";

    /// Runs in a subprocess because verification configuration is process-wide.
    /// The child reaches the real discovery, adapters, PTY and reader path; the
    /// fixture itself rejects an incorrect resume argument.
    #[test]
    fn fixture_runs_through_real_provider_launcher_and_resume() {
        if std::env::var(CHILD_ENV).as_deref() == Ok("1") {
            run_fixture_launches();
            return;
        }

        let fixture = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../scripts/verification/provider-fixture.mjs");
        let profile = std::env::temp_dir().join(format!(
            "argmax-provider-verification-test-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&profile).expect("create isolated verification profile");
        let output = ProcessCommand::new(std::env::current_exe().expect("current test binary"))
            .args([
                "--exact",
                "providers::runtime::verification_tests::fixture_runs_through_real_provider_launcher_and_resume",
                "--nocapture",
            ])
            .env(CHILD_ENV, "1")
            .env(super::super::verification::MODE_ENV, "1")
            .env(super::super::verification::HOME_ENV, &profile)
            .env("ARGMAX_VERIFICATION_LOG", profile.join("invocations.jsonl"))
            .env("ARGMAX_VERIFICATION_CLAUDE_BINARY", fixture)
            .output()
            .expect("run isolated verification child");
        let _ = std::fs::remove_dir_all(&profile);
        assert!(
            output.status.success(),
            "verification child failed:\nstdout:\n{}\nstderr:\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
    }

    fn run_fixture_launches() {
        super::super::verification::validate_configuration()
            .expect("verification child configuration");
        let runtime = tokio::runtime::Runtime::new().expect("tokio runtime");
        runtime.block_on(async {
            let launcher = RealProviderProcessLauncher::new();
            let first =
                launch_and_collect(&launcher, "[argmax-verification:chat-resume:first]", None)
                    .await;
            assert!(first.contains("Verification first turn complete."));
            assert!(first.contains("verification-tool-read"));

            let resumed = launch_and_collect(
                &launcher,
                "[argmax-verification:chat-resume:second]",
                Some("argmax-verification-conversation"),
            )
            .await;
            assert!(resumed.contains("Verification resumed turn complete."));
            let log = std::fs::read_to_string(
                std::env::var("ARGMAX_VERIFICATION_LOG").expect("fixture invocation log"),
            )
            .expect("read fixture invocations");
            let launches: Vec<serde_json::Value> = log
                .lines()
                .map(|line| serde_json::from_str(line).expect("fixture invocation JSON"))
                .filter(|row: &serde_json::Value| {
                    row["args"].as_array().is_some_and(|args| {
                        args.iter()
                            .any(|arg| arg.as_str() == Some("--output-format"))
                    })
                })
                .collect();
            assert_eq!(launches.len(), 2, "initial launch and resume reach the CLI");
            for launch in launches {
                assert_eq!(launch["backgroundWaitCeiling"], "0");
            }
        });
    }

    async fn launch_and_collect(
        launcher: &RealProviderProcessLauncher,
        prompt: &str,
        resume_conversation_id: Option<&str>,
    ) -> String {
        let events = Arc::new(Mutex::new(Vec::<ProviderRuntimeEvent>::new()));
        let callback_events = Arc::clone(&events);
        let callback: EventCallback = Arc::new(move |event| {
            callback_events
                .lock()
                .expect("verification events poisoned")
                .push(event);
        });
        let input = ProviderLaunchInput {
            provider: ProviderId::Claude,
            session_id: uuid::Uuid::new_v4().to_string(),
            workspace_path: PathBuf::from(
                std::env::var(super::super::verification::HOME_ENV).expect("verification profile"),
            ),
            prompt: prompt.to_string(),
            model_label: "Sonnet 5".to_string(),
            model_id: "claude-sonnet-5".to_string(),
            reasoning_effort: None,
            fast_mode: false,
            resume_conversation_id: resume_conversation_id.map(str::to_string),
            resume_fork: false,
            permission_mode: PermissionMode::AutoApprove,
            agent_mode: AgentMode::Auto,
            cols: 120,
            rows: 32,
        };
        let handle = launcher
            .launch(input, callback)
            .await
            .expect("launch verification fixture through real runtime");
        let deadline = Instant::now() + Duration::from_secs(3);
        loop {
            let finished = events
                .lock()
                .expect("verification events poisoned")
                .iter()
                .any(|event| {
                    matches!(
                        event.r#type,
                        ProviderRuntimeEventType::Exit | ProviderRuntimeEventType::Error
                    )
                });
            if finished {
                break;
            }
            assert!(Instant::now() < deadline, "fixture did not exit in time");
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        drop(handle);
        let events = events.lock().expect("verification events poisoned");
        assert!(
            events
                .iter()
                .all(|event| event.r#type != ProviderRuntimeEventType::Error),
            "fixture emitted an error: {events:?}"
        );
        events
            .iter()
            .map(|event| event.message.as_str())
            .collect::<String>()
    }
}
