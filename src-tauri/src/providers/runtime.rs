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

use serde_json::json;

use super::{
    adapters::{get_provider_definition, PLAN_MODE_PROMPT_PREFIX},
    discovery::ProviderDiscovery,
    environment::build_provider_environment,
    flush_queue::DashboardDelta,
    normalizer::ProviderOutputStream,
    AgentMode, PermissionMode, ProviderId, ProviderLaunchInput, ProviderMode, ReasoningEffort,
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
            let mut child = Command::new(&binary_path)
                .args(args)
                .current_dir(&input.workspace_path)
                .env_clear()
                .envs(build_provider_environment([(
                    "NO_COLOR".to_string(),
                    "1".to_string(),
                )]))
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .spawn()
                .map_err(|error| {
                    ArgmaxError::service(
                        "PROVIDER_SPAWN_FAILED",
                        format!("could not launch {}: {error}", definition.display_name),
                    )
                })?;

            if let Some(stdin) = (definition.structured_stdin)(&input) {
                if let Some(mut child_stdin) = child.stdin.take() {
                    child_stdin.write_all(stdin.as_bytes()).map_err(io_error)?;
                }
            }
            drop(child.stdin.take());

            let pid = child.id();
            let disposed = Arc::new(AtomicBool::new(false));
            let (exit_tx, exit_rx) = mpsc::channel();

            if let Some(stdout) = child.stdout.take() {
                spawn_reader(
                    stdout,
                    input.session_id.clone(),
                    ProviderOutputStream::Stdout,
                    Arc::clone(&disposed),
                    Arc::clone(&on_event),
                );
            }
            if let Some(stderr) = child.stderr.take() {
                spawn_reader(
                    stderr,
                    input.session_id.clone(),
                    ProviderOutputStream::Stderr,
                    Arc::clone(&disposed),
                    Arc::clone(&on_event),
                );
            }

            let wait_session_id = input.session_id.clone();
            let wait_provider = definition.display_name.to_string();
            let wait_disposed = Arc::clone(&disposed);
            thread::spawn(move || {
                let status = child.wait();
                let _ = exit_tx.send(());
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
                session_id: input.session_id,
                provider: input.provider,
                accepts_input: false,
                pid,
                disposed,
                exit_rx: Mutex::new(Some(exit_rx)),
            });
            Ok(handle)
        })
    }
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
    exit_rx: Mutex<Option<mpsc::Receiver<()>>>,
}

impl ProviderRuntimeHandle for ProviderSessionHandle {
    fn accepts_input(&self) -> bool {
        self.accepts_input
    }

    fn disposed(&self) -> bool {
        self.disposed.load(Ordering::SeqCst)
    }

    fn send_input(&self, _input: &str) {}

    fn resize(&self, _cols: u16, _rows: u16) {}

    fn terminate<'a>(&'a self) -> BoxFuture<'a, ArgmaxResult<()>> {
        Box::pin(async move {
            self.disposed.store(true, Ordering::SeqCst);
            signal_process(self.pid, SignalKind::Term);
            let receiver = self.exit_rx.lock().expect("exit receiver poisoned").take();
            if let Some(receiver) = receiver {
                let pid = self.pid;
                tokio::task::spawn_blocking(move || {
                    if receiver.recv_timeout(Duration::from_millis(1500)).is_err() {
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
        // safety net (see openspec port task 5.15).
        signal_process(self.pid, SignalKind::Term);
        signal_process(self.pid, SignalKind::Kill);
    }
}

// ---------------------------------------------------------------------------
// IO + process helpers used by the launcher and the session service.
// ---------------------------------------------------------------------------

pub(super) fn spawn_reader<R: Read + Send + 'static>(
    mut reader: R,
    session_id: String,
    stream: ProviderOutputStream,
    disposed: Arc<AtomicBool>,
    on_event: EventCallback,
) {
    thread::spawn(move || {
        let mut buffer = [0u8; 8192];
        loop {
            match reader.read(&mut buffer) {
                Ok(0) => break,
                Ok(n) => {
                    if disposed.load(Ordering::SeqCst) {
                        break;
                    }
                    on_event(ProviderRuntimeEvent {
                        session_id: session_id.clone(),
                        r#type: ProviderRuntimeEventType::Output,
                        stream: stream.clone(),
                        message: String::from_utf8_lossy(&buffer[..n]).into_owned(),
                        exit_code: None,
                        created_at: now_iso(),
                    });
                }
                Err(_) => break,
            }
        }
    });
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

pub(super) fn prompt_for_agent_mode(prompt: &str, agent_mode: AgentMode) -> String {
    if agent_mode == AgentMode::Plan {
        format!("{}\n\n{prompt}", PLAN_MODE_PROMPT_PREFIX)
    } else {
        prompt.to_string()
    }
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
    let _ = kill(Pid::from_raw(pid as i32), signal);
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
