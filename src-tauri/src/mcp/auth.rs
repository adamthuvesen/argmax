// MCP auth service — owns the interactive PTY behind Settings → MCP servers
// → "Authenticate via Claude (/mcp)". Mirrors `src/main/mcp/mcpAuthService.ts`.
//
// Claude Code has no standalone `claude mcp auth <name>` subcommand — its
// OAuth flow lives inside the interactive `/mcp` slash command. So we spawn
// `claude` in a small modal PTY and feed `/mcp` once, after the CLI's prompt
// is on screen. Distinct from TerminalService because (a) there is no
// workspace, cwd is the user's home directory so Claude reads the global
// config, and (b) we own the post-spawn `/mcp` prime.
//
// Sessions are keyed by an `mcp:auth` session id (NOT a provider session) —
// each `start()` call creates a short-lived PTY backed by its own reader
// thread that emits chunks through an `OutputSink`. Exit fires a single
// exit callback and removes the session.

use std::{
    io::{Read, Write},
    sync::{Arc, Mutex},
    thread,
    time::Duration,
};

use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use specta::Type;
use uuid::Uuid;

use crate::error::{ArgmaxError, ArgmaxResult};
use crate::providers::discovery::ProviderDiscovery;
use crate::providers::environment::build_provider_environment;
use crate::providers::ProviderId;
use crate::util::process_control::signal_term_then_kill;

/// Callback the auth service uses to stream PTY output. Mirrors the
/// `OutputSink` shape in `checks/service.rs` so call sites can adapt
/// either subsystem.
pub type OutputSink = Arc<dyn Fn(McpAuthChunk) + Send + Sync>;

/// Fires once when the PTY exits. `exit_code` is the process exit code if
/// known; `signal` is the POSIX signal number if the child was terminated
/// by a signal (otherwise `None`).
pub type ExitSink = Arc<dyn Fn(McpAuthExitInfo) + Send + Sync>;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct McpAuthChunk {
    pub session_id: String,
    pub data: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct McpAuthExitInfo {
    pub session_id: String,
    pub exit_code: i32,
    pub signal: Option<i32>,
}

/// Input shape for `start()`. Cols/rows size the PTY so the CLI renders
/// correctly inside the renderer's modal.
#[derive(Debug, Clone, Copy)]
pub struct StartAuthInput {
    pub cols: u16,
    pub rows: u16,
}

#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct StartAuthOutput {
    pub session_id: String,
}

/// Resolves the Claude binary path. Defaults to the production
/// `ProviderDiscovery` lookup; tests inject a fixture.
pub type BinaryResolver =
    Arc<dyn Fn() -> futures_boxed::BoxFuture<'static, Option<String>> + Send + Sync>;

mod futures_boxed {
    use std::{future::Future, pin::Pin};
    pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;
}

struct AuthSession {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    child: Box<dyn portable_pty::Child + Send + Sync>,
    pid: Option<u32>,
}

/// `McpAuthService` — owns the per-session PTYs spawned for the Claude
/// `/mcp` flow. Use `start()` to spawn, `write()` / `resize()` to drive
/// the live session, and `terminate()` to escalate-kill the process.
pub struct McpAuthService {
    sessions: Mutex<std::collections::HashMap<String, AuthSession>>,
    resolve_binary: BinaryResolver,
}

impl McpAuthService {
    /// Production constructor — resolves the Claude binary via
    /// `ProviderDiscovery`.
    pub fn new() -> Arc<Self> {
        let resolver: BinaryResolver = Arc::new(|| {
            Box::pin(async {
                let discovery = ProviderDiscovery::new();
                let report = discovery.discover(ProviderId::Claude).await;
                report.binary_path
            })
        });
        Self::with_resolver(resolver)
    }

    /// Test/seam constructor — caller supplies the binary resolver.
    pub fn with_resolver(resolve_binary: BinaryResolver) -> Arc<Self> {
        Arc::new(Self {
            sessions: Mutex::new(std::collections::HashMap::new()),
            resolve_binary,
        })
    }

    /// Spawn `claude` inside a fresh PTY rooted at the user's home dir.
    /// Streams stdout chunks to `on_output` and fires `on_exit` once when
    /// the child exits.
    pub async fn start(
        self: &Arc<Self>,
        input: StartAuthInput,
        on_output: OutputSink,
        on_exit: ExitSink,
    ) -> ArgmaxResult<StartAuthOutput> {
        let binary_path = (self.resolve_binary)().await.ok_or_else(|| {
            ArgmaxError::service(
                "MCP_AUTH_BINARY_MISSING",
                "Claude Code is not installed on this machine. Install it from https://docs.claude.com/en/docs/claude-code/install and try again.",
            )
        })?;

        // Match the TS adapter: NO_COLOR-clearing env with truecolor terminal
        // markers. `buildProviderEnvironment` already extends PATH so the
        // node shebang Claude ships with can resolve `node`.
        let overrides = vec![
            ("TERM".to_string(), "xterm-256color".to_string()),
            (
                "COLORTERM".to_string(),
                std::env::var("COLORTERM").unwrap_or_else(|_| "truecolor".to_string()),
            ),
        ];
        let env = build_provider_environment(overrides);

        let home = std::env::var_os("HOME")
            .map(std::path::PathBuf::from)
            .unwrap_or_else(|| std::path::PathBuf::from("."));

        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(PtySize {
                rows: input.rows,
                cols: input.cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|error| {
                ArgmaxError::service(
                    "MCP_AUTH_PTY_OPEN_FAILED",
                    format!("could not open MCP auth PTY: {error}"),
                )
            })?;

        let mut cmd = CommandBuilder::new(&binary_path);
        cmd.cwd(&home);
        cmd.env_clear();
        for (key, value) in env {
            cmd.env(key, value);
        }

        let child = pair.slave.spawn_command(cmd).map_err(|error| {
            ArgmaxError::service(
                "MCP_AUTH_PTY_SPAWN_FAILED",
                format!("could not spawn claude for MCP auth: {error}"),
            )
        })?;
        // Drop the slave handle on the parent side; the child holds its own.
        drop(pair.slave);

        let pid = child.process_id();
        let reader = pair.master.try_clone_reader().map_err(|error| {
            ArgmaxError::service(
                "MCP_AUTH_PTY_READER_FAILED",
                format!("could not clone PTY reader: {error}"),
            )
        })?;
        let writer = pair.master.take_writer().map_err(|error| {
            ArgmaxError::service(
                "MCP_AUTH_PTY_WRITER_FAILED",
                format!("could not take PTY writer: {error}"),
            )
        })?;

        let session_id = Uuid::new_v4().to_string();

        {
            let mut sessions = self.sessions.lock().expect("mcp auth sessions poisoned");
            sessions.insert(
                session_id.clone(),
                AuthSession {
                    master: pair.master,
                    writer,
                    child,
                    pid,
                },
            );
        }

        // Spawn the read loop on a blocking-friendly OS thread. portable_pty
        // exposes a synchronous reader; tokio's spawn_blocking would work
        // but we want the thread to survive a runtime shutdown cleanly.
        spawn_reader_thread(
            session_id.clone(),
            reader,
            Arc::clone(&on_output),
            Arc::clone(self),
        );

        // Spawn a small watcher thread for the child's exit. Cleans up the
        // session entry and fires the exit sink exactly once.
        spawn_exit_watcher(session_id.clone(), Arc::clone(self), on_exit);

        // First chunk from Claude may be a banner / color setup written
        // BEFORE the prompt is ready for input. Wait ~200 ms then auto-type
        // `/mcp\r`. Matches the TS audit-2026-05-17 M17 behavior.
        let prime_session = session_id.clone();
        let prime_service = Arc::clone(self);
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(200)).await;
            prime_service.write_internal(&prime_session, b"/mcp\r");
        });

        Ok(StartAuthOutput { session_id })
    }

    /// Forward `data` to the session's PTY. Silently no-ops on unknown ids
    /// — matches the TS service which treats stale ids as a benign race.
    pub fn write(&self, session_id: &str, data: &[u8]) {
        self.write_internal(session_id, data);
    }

    fn write_internal(&self, session_id: &str, data: &[u8]) {
        let mut sessions = self.sessions.lock().expect("mcp auth sessions poisoned");
        if let Some(entry) = sessions.get_mut(session_id) {
            let _ = entry.writer.write_all(data);
            let _ = entry.writer.flush();
        }
    }

    /// Resize the PTY for the live session. No-op on unknown ids.
    pub fn resize(&self, session_id: &str, cols: u16, rows: u16) {
        let sessions = self.sessions.lock().expect("mcp auth sessions poisoned");
        if let Some(entry) = sessions.get(session_id) {
            let _ = entry.master.resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            });
        }
    }

    /// Terminate a live session: SIGTERM, wait up to GRACEFUL_TIMEOUT_MS,
    /// then SIGKILL. Returns immediately if the session id is unknown.
    pub async fn terminate(&self, session_id: &str) {
        let pid = {
            let sessions = self.sessions.lock().expect("mcp auth sessions poisoned");
            sessions.get(session_id).and_then(|entry| entry.pid)
        };
        let Some(pid) = pid else { return };
        signal_term_then_kill(pid).await;
    }

    /// Terminate every live session (used at app shutdown).
    pub async fn dispose_all(&self) {
        let pids: Vec<u32> = {
            let sessions = self.sessions.lock().expect("mcp auth sessions poisoned");
            sessions.values().filter_map(|entry| entry.pid).collect()
        };
        for pid in pids {
            signal_term_then_kill(pid).await;
        }
    }

    /// Test helper — how many sessions are currently registered.
    #[allow(dead_code)]
    pub fn live_count(&self) -> usize {
        self.sessions
            .lock()
            .expect("mcp auth sessions poisoned")
            .len()
    }

    fn remove_session(&self, session_id: &str) -> Option<AuthSession> {
        let mut sessions = self.sessions.lock().expect("mcp auth sessions poisoned");
        sessions.remove(session_id)
    }
}

fn spawn_reader_thread(
    session_id: String,
    mut reader: Box<dyn Read + Send>,
    on_output: OutputSink,
    service: Arc<McpAuthService>,
) {
    thread::spawn(move || {
        let mut buffer = [0u8; 8192];
        loop {
            match reader.read(&mut buffer) {
                Ok(0) => break,
                Ok(n) => {
                    // Drop the reader if the session has been removed by
                    // the exit watcher — avoids racing the sink callback
                    // against a renderer that's already moved on.
                    let still_live = service
                        .sessions
                        .lock()
                        .expect("mcp auth sessions poisoned")
                        .contains_key(&session_id);
                    if !still_live {
                        break;
                    }
                    let data = String::from_utf8_lossy(&buffer[..n]).into_owned();
                    on_output(McpAuthChunk {
                        session_id: session_id.clone(),
                        data,
                    });
                }
                Err(_) => break,
            }
        }
    });
}

fn spawn_exit_watcher(session_id: String, service: Arc<McpAuthService>, on_exit: ExitSink) {
    thread::spawn(move || {
        // Take the child out of the session entry so we can `wait()` on it
        // without holding the sessions lock for the duration. The PTY
        // master/writer stay registered until the watcher removes the
        // whole entry below.
        let mut child_opt = {
            let mut sessions = service.sessions.lock().expect("mcp auth sessions poisoned");
            sessions
                .get_mut(&session_id)
                .map(|entry| std::mem::replace(&mut entry.child, dummy_child()))
        };
        let exit_code = match child_opt.as_mut() {
            Some(child) => child
                .wait()
                .map(|status| status.exit_code() as i32)
                .unwrap_or(-1),
            None => -1,
        };
        // portable_pty's ExitStatus doesn't expose POSIX signal numbers
        // cross-platform; we emit `None` to match the TS shape when the
        // value is unavailable.
        let signal: Option<i32> = None;
        let _ = service.remove_session(&session_id);
        on_exit(McpAuthExitInfo {
            session_id,
            exit_code,
            signal,
        });
    });
}

/// A no-op `Child` we swap into the session entry while the watcher waits
/// on the real child. `Child::wait` is consuming-ish (`&mut self`) and we
/// don't want to hold the sessions mutex across the wait.
fn dummy_child() -> Box<dyn portable_pty::Child + Send + Sync> {
    Box::new(DummyChild)
}

#[derive(Debug)]
struct DummyChild;

impl portable_pty::Child for DummyChild {
    fn try_wait(&mut self) -> std::io::Result<Option<portable_pty::ExitStatus>> {
        Ok(Some(portable_pty::ExitStatus::with_exit_code(0)))
    }

    fn wait(&mut self) -> std::io::Result<portable_pty::ExitStatus> {
        Ok(portable_pty::ExitStatus::with_exit_code(0))
    }

    fn process_id(&self) -> Option<u32> {
        None
    }
}

impl portable_pty::ChildKiller for DummyChild {
    fn kill(&mut self) -> std::io::Result<()> {
        Ok(())
    }

    fn clone_killer(&self) -> Box<dyn portable_pty::ChildKiller + Send + Sync> {
        Box::new(DummyChild)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex as StdMutex;
    use tokio::time::{sleep, timeout, Duration};

    fn fake_binary_resolver(path: &str) -> BinaryResolver {
        let p = path.to_string();
        Arc::new(move || {
            let p = p.clone();
            Box::pin(async move { Some(p) })
        })
    }

    #[tokio::test]
    async fn start_spawns_pty_and_emits_output_then_exit() {
        // /bin/sh -c "echo hi; sleep 5" prints a line, then sleeps until
        // killed. We assert (a) the sink sees the "hi" line, and (b)
        // terminate kills the process and the exit watcher fires.
        let svc = McpAuthService::with_resolver(fake_binary_resolver("/bin/sh"));

        let chunks: Arc<StdMutex<Vec<String>>> = Arc::new(StdMutex::new(Vec::new()));
        let chunks_for_sink = Arc::clone(&chunks);
        let on_output: OutputSink = Arc::new(move |chunk| {
            chunks_for_sink
                .lock()
                .expect("chunks lock")
                .push(chunk.data);
        });

        let (exit_tx, exit_rx) = tokio::sync::oneshot::channel::<McpAuthExitInfo>();
        let exit_tx = StdMutex::new(Some(exit_tx));
        let on_exit: ExitSink = Arc::new(move |info| {
            if let Some(tx) = exit_tx.lock().expect("exit tx").take() {
                let _ = tx.send(info);
            }
        });

        // Pre-seed the PTY with a single-shot command via env. We can't
        // pass args through the McpAuthService API; instead, use the
        // resolver to point at a wrapper script that does the work.
        // For simplicity we point at /bin/sh and immediately write the
        // command via the PTY writer after start().
        let out = svc
            .start(StartAuthInput { cols: 80, rows: 24 }, on_output, on_exit)
            .await
            .expect("start");
        assert_eq!(svc.live_count(), 1);

        // /bin/sh in PTY mode shows a prompt and waits for stdin. Send a
        // command that prints "hi" then exits.
        svc.write(&out.session_id, b"echo hi; exit 0\n");

        // Wait for exit (the watcher fires once the shell exits).
        let exit = timeout(Duration::from_secs(5), exit_rx)
            .await
            .expect("did not exit in time")
            .expect("exit channel");
        assert_eq!(exit.exit_code, 0, "expected clean exit");

        // The sink should have captured the "hi" output. The PTY also
        // echoes the input line itself, so look for "hi" substring.
        let captured = chunks.lock().expect("chunks").concat();
        assert!(captured.contains("hi"), "captured: {captured:?}");

        // Session entry removed by the watcher.
        // Give the watcher a tick to clean up after firing the callback.
        sleep(Duration::from_millis(50)).await;
        assert_eq!(svc.live_count(), 0);
    }

    #[tokio::test]
    async fn missing_binary_returns_service_error() {
        let svc = McpAuthService::with_resolver(Arc::new(|| Box::pin(async { None })));
        let on_output: OutputSink = Arc::new(|_| {});
        let on_exit: ExitSink = Arc::new(|_| {});

        let err = svc
            .start(StartAuthInput { cols: 80, rows: 24 }, on_output, on_exit)
            .await
            .expect_err("expected MCP_AUTH_BINARY_MISSING");
        let json = serde_json::to_value(&err).expect("serialize");
        assert_eq!(json["code"], "SERVICE_ERROR");
        assert_eq!(json["sub_code"], "MCP_AUTH_BINARY_MISSING");
        assert_eq!(svc.live_count(), 0);
    }

    #[tokio::test]
    async fn terminate_kills_long_running_pty() {
        // sleep 60 will only exit when we signal it. Confirm the exit
        // watcher fires within the SIGTERM→SIGKILL escalation window.
        let svc = McpAuthService::with_resolver(fake_binary_resolver("/bin/sh"));

        let on_output: OutputSink = Arc::new(|_| {});
        let (exit_tx, exit_rx) = tokio::sync::oneshot::channel::<McpAuthExitInfo>();
        let exit_tx = StdMutex::new(Some(exit_tx));
        let on_exit: ExitSink = Arc::new(move |info| {
            if let Some(tx) = exit_tx.lock().expect("exit tx").take() {
                let _ = tx.send(info);
            }
        });

        let out = svc
            .start(StartAuthInput { cols: 80, rows: 24 }, on_output, on_exit)
            .await
            .expect("start");
        svc.write(&out.session_id, b"sleep 60\n");
        // Give the shell a moment to actually start `sleep`.
        sleep(Duration::from_millis(200)).await;

        svc.terminate(&out.session_id).await;

        let _exit = timeout(Duration::from_secs(5), exit_rx)
            .await
            .expect("watcher did not fire after terminate")
            .expect("exit channel");
        sleep(Duration::from_millis(50)).await;
        assert_eq!(svc.live_count(), 0);
    }

    #[tokio::test]
    async fn unknown_session_id_is_noop() {
        let svc = McpAuthService::with_resolver(fake_binary_resolver("/bin/true"));
        // None of these should panic.
        svc.write("ghost", b"hi");
        svc.resize("ghost", 100, 30);
        svc.terminate("ghost").await;
    }
}
