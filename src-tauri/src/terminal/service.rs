// TerminalService owns the user-facing PTYs that back the integrated
// terminal panel.
//
// Distinct from `ProviderSessionService`, which owns provider-launched
// PTYs tied to a session's lifecycle; user terminals are just shells
// scoped to a workspace cwd and live until the renderer closes them or
// the app quits.
// The child handle moves into a dedicated wait watcher thread, while
// terminate paths signal the captured PID only while the watcher still
// considers it live.

use crate::util::sync::LockOrRecover;
use std::{
    collections::HashMap,
    io::{Read, Write},
    path::Path,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    thread,
};

use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use specta::Type;
use uuid::Uuid;

use crate::{
    error::{ArgmaxError, ArgmaxResult},
    persistence::{database::Database, workspaces::find_workspace_by_id},
    util::process_control::{
        signal_target_term_and_kill_blocking, signal_target_term_then_kill, SignalTarget,
    },
};

/// Streams each PTY chunk to the renderer (the IPC layer turns these
/// into `terminal:data` push events).
pub type OutputSink = Arc<dyn Fn(TerminalChunk) + Send + Sync>;

/// Fires once when the PTY exits. The IPC layer turns this into a
/// `terminal:exit` push event.
pub type ExitSink = Arc<dyn Fn(TerminalExitInfo) + Send + Sync>;

#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TerminalChunk {
    pub terminal_id: String,
    pub data: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TerminalExitInfo {
    pub terminal_id: String,
    pub exit_code: i32,
    pub signal: Option<i32>,
}

#[derive(Debug, Clone)]
pub struct TerminalSpawnInput {
    pub workspace_id: String,
    pub cols: u16,
    pub rows: u16,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TerminalSpawnResult {
    pub terminal_id: String,
}

/// Test seam: produce a `CommandBuilder` for the PTY. Production picks
/// `$SHELL` (or `/bin/zsh` / `/bin/bash`) under a `xterm-256color`
/// truecolor env; tests inject `/bin/sh -c "<script>"` so the
/// assertions are stable.
pub type ShellFactory = Arc<dyn Fn(&str) -> CommandBuilder + Send + Sync>;

struct TerminalEntry {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    pid: Option<u32>,
    reaped: Arc<AtomicBool>,
}

pub struct TerminalService {
    database: Arc<Database>,
    on_data: OutputSink,
    on_exit: ExitSink,
    terminals: Mutex<HashMap<String, TerminalEntry>>,
    shell_factory: ShellFactory,
}

impl TerminalService {
    pub fn new(database: Arc<Database>, on_data: OutputSink, on_exit: ExitSink) -> Arc<Self> {
        Self::with_shell_factory(database, on_data, on_exit, default_shell_factory())
    }

    pub fn with_shell_factory(
        database: Arc<Database>,
        on_data: OutputSink,
        on_exit: ExitSink,
        shell_factory: ShellFactory,
    ) -> Arc<Self> {
        Arc::new(Self {
            database,
            on_data,
            on_exit,
            terminals: Mutex::new(HashMap::new()),
            shell_factory,
        })
    }

    /// Spawn a PTY rooted at the workspace cwd. Returns a stable id the
    /// renderer uses for `write` / `resize` / `terminate`.
    pub fn spawn(self: &Arc<Self>, input: TerminalSpawnInput) -> ArgmaxResult<TerminalSpawnResult> {
        let workspace = {
            let conn = self.database.connection();
            find_workspace_by_id(&conn, &input.workspace_id)?
        };
        if workspace.path.is_empty() {
            return Err(ArgmaxError::service(
                "TERMINAL_WORKSPACE_NO_PATH",
                "Workspace has no path on disk yet.",
            ));
        }

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
                    "TERMINAL_PTY_OPEN_FAILED",
                    format!("could not open terminal PTY: {error}"),
                )
            })?;

        let mut cmd = (self.shell_factory)(&workspace.path);
        cmd.cwd(&workspace.path);
        let child = pair.slave.spawn_command(cmd).map_err(|error| {
            ArgmaxError::service(
                "TERMINAL_PTY_SPAWN_FAILED",
                format!("could not spawn terminal shell: {error}"),
            )
        })?;
        // Drop the slave handle on the parent side; the child holds its own.
        drop(pair.slave);

        let pid = child.process_id();
        let reader = pair.master.try_clone_reader().map_err(|error| {
            ArgmaxError::service(
                "TERMINAL_PTY_READER_FAILED",
                format!("could not clone PTY reader: {error}"),
            )
        })?;
        let writer = pair.master.take_writer().map_err(|error| {
            ArgmaxError::service(
                "TERMINAL_PTY_WRITER_FAILED",
                format!("could not take PTY writer: {error}"),
            )
        })?;

        let terminal_id = Uuid::new_v4().to_string();
        let reaped = Arc::new(AtomicBool::new(false));
        {
            let mut terminals = self.terminals.lock_or_recover("terminals");
            terminals.insert(
                terminal_id.clone(),
                TerminalEntry {
                    master: pair.master,
                    writer,
                    pid,
                    reaped: Arc::clone(&reaped),
                },
            );
        }

        spawn_reader_thread(
            terminal_id.clone(),
            reader,
            Arc::clone(&self.on_data),
            Arc::clone(self),
        );
        spawn_exit_watcher(
            terminal_id.clone(),
            child,
            Arc::clone(self),
            Arc::clone(&self.on_exit),
            reaped,
        );

        Ok(TerminalSpawnResult { terminal_id })
    }

    /// Forward `data` to the PTY. Silently no-ops on unknown ids; stale ids
    /// are a benign renderer/runtime race.
    pub fn write(&self, terminal_id: &str, data: &[u8]) {
        let mut terminals = self.terminals.lock_or_recover("terminals");
        if let Some(entry) = terminals.get_mut(terminal_id) {
            let _ = entry.writer.write_all(data);
            let _ = entry.writer.flush();
        }
    }

    /// Resize the PTY for the live terminal. No-op on unknown ids.
    pub fn resize(&self, terminal_id: &str, cols: u16, rows: u16) {
        let terminals = self.terminals.lock_or_recover("terminals");
        if let Some(entry) = terminals.get(terminal_id) {
            let _ = entry.master.resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            });
        }
    }

    /// Terminate a live terminal: SIGTERM, wait up to 1500 ms, then
    /// SIGKILL. Returns immediately if the id is unknown.
    pub async fn terminate(&self, terminal_id: &str) {
        let target = {
            let terminals = self.terminals.lock_or_recover("terminals");
            terminals
                .get(terminal_id)
                .and_then(|entry| entry.pid.map(|pid| (pid, Arc::clone(&entry.reaped))))
        };
        let Some((pid, reaped)) = target else { return };
        signal_target_term_then_kill(SignalTarget::Process(pid), Some(&reaped)).await;
    }

    /// Terminate every live terminal (used at app shutdown).
    pub async fn dispose_all(&self) {
        let targets: Vec<(u32, Arc<AtomicBool>)> = {
            let terminals = self.terminals.lock_or_recover("terminals");
            terminals
                .values()
                .filter_map(|entry| entry.pid.map(|pid| (pid, Arc::clone(&entry.reaped))))
                .collect()
        };
        for (pid, reaped) in targets {
            signal_target_term_then_kill(SignalTarget::Process(pid), Some(&reaped)).await;
        }
    }

    #[allow(dead_code)]
    pub fn live_count(&self) -> usize {
        self.terminals.lock_or_recover("terminals").len()
    }

    fn remove_terminal(&self, terminal_id: &str) -> Option<TerminalEntry> {
        let mut terminals = self.terminals.lock_or_recover("terminals");
        terminals.remove(terminal_id)
    }
}

impl Drop for TerminalService {
    fn drop(&mut self) {
        // Sync best-effort cleanup. Drop cannot await `tokio::time::sleep`
        // so we use the blocking signal helper (SIGTERM + immediate
        // SIGKILL, no grace window) and let the exit watcher tear down.
        // Mirrors `ProviderSessionHandle::Drop`.
        let targets: Vec<(u32, Arc<AtomicBool>)> = {
            let terminals = self.terminals.lock_or_recover("terminals");
            terminals
                .values()
                .filter_map(|entry| entry.pid.map(|pid| (pid, Arc::clone(&entry.reaped))))
                .collect()
        };
        for (pid, reaped) in targets {
            signal_target_term_and_kill_blocking(SignalTarget::Process(pid), Some(&reaped));
        }
    }
}

fn spawn_reader_thread(
    terminal_id: String,
    reader: Box<dyn Read + Send>,
    on_data: OutputSink,
    service: Arc<TerminalService>,
) {
    thread::spawn(move || {
        let chunk_terminal_id = terminal_id.clone();
        let error_terminal_id = terminal_id.clone();
        crate::util::stream_reader::pump_utf8_stream(
            reader,
            |_n| {
                // If the exit watcher has already removed the entry, stop
                // streaming — the renderer has moved on.
                service
                    .terminals
                    .lock_or_recover("terminals")
                    .contains_key(&terminal_id)
            },
            |data| {
                on_data(TerminalChunk {
                    terminal_id: chunk_terminal_id.clone(),
                    data,
                });
            },
            |error| {
                tracing::warn!(
                    terminal_id = %error_terminal_id,
                    error = %error,
                    "terminal reader read error; stopping stream"
                );
            },
        );
    });
}

fn spawn_exit_watcher(
    terminal_id: String,
    mut child: Box<dyn portable_pty::Child + Send + Sync>,
    service: Arc<TerminalService>,
    on_exit: ExitSink,
    reaped: Arc<AtomicBool>,
) {
    thread::spawn(move || {
        // Block waiting for the child. The child handle is owned exclusively
        // here — no shared mutex, so the wait can't deadlock against a
        // concurrent `terminate` / `write` / `resize`.
        let exit_code = child
            .wait()
            .map(|status| status.exit_code() as i32)
            .unwrap_or(-1);
        reaped.store(true, Ordering::Release);
        // portable_pty's ExitStatus doesn't expose POSIX signal numbers
        // cross-platform; emit `None` when unavailable to match the TS shape.
        let signal: Option<i32> = None;
        let _ = service.remove_terminal(&terminal_id);
        on_exit(TerminalExitInfo {
            terminal_id,
            exit_code,
            signal,
        });
    });
}

fn pick_shell() -> String {
    if let Ok(shell) = std::env::var("SHELL") {
        if is_usable_shell(&shell) {
            return shell;
        }
        tracing::warn!(shell = %shell, "ignoring unusable SHELL for terminal spawn");
    }
    if std::path::Path::new("/bin/zsh").exists() {
        "/bin/zsh".to_string()
    } else {
        "/bin/bash".to_string()
    }
}

fn is_usable_shell(shell: &str) -> bool {
    if shell.is_empty() {
        return false;
    }
    let path = Path::new(shell);
    !path.is_absolute() || path.exists()
}

fn default_shell_factory() -> ShellFactory {
    Arc::new(|_cwd: &str| {
        let mut cmd = CommandBuilder::new(pick_shell());
        cmd.env("TERM", "xterm-256color");
        cmd.env("TERM_PROGRAM", "Argmax");
        cmd.env("TERM_PROGRAM_VERSION", env!("CARGO_PKG_VERSION"));
        cmd.env(
            "COLORTERM",
            std::env::var("COLORTERM").unwrap_or_else(|_| "truecolor".to_string()),
        );
        if let Ok(path) = std::env::var("PATH") {
            cmd.env("PATH", path);
        }
        if let Ok(home) = std::env::var("HOME") {
            cmd.env("HOME", home);
        }
        cmd
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::persistence::projects::{persist_project, PersistProjectInput, ProjectSettings};
    use crate::persistence::workspaces::{persist_workspace, PersistWorkspaceInput};
    use std::sync::Mutex as StdMutex;
    use std::time::Duration;
    use tempfile::TempDir;
    use tokio::sync::oneshot;
    use tokio::time::{sleep, timeout};

    fn setup() -> (Arc<Database>, String, TempDir, TempDir) {
        let db_dir = TempDir::new().unwrap();
        let cwd_dir = TempDir::new().unwrap();
        let database = Arc::new(Database::open(db_dir.path().join("argmax.sqlite")).unwrap());
        {
            let conn = database.connection();
            persist_project(
                &conn,
                &PersistProjectInput {
                    id: "p1".to_string(),
                    name: "fixture".to_string(),
                    repo_path: cwd_dir.path().to_string_lossy().into_owned(),
                    default_branch: Some("main".to_string()),
                    current_branch: "main".to_string(),
                    settings: ProjectSettings {
                        default_provider: "claude".to_string(),
                        default_model_label: "Haiku 4.5".to_string(),
                        worktree_location: cwd_dir
                            .path()
                            .join(".worktrees")
                            .to_string_lossy()
                            .into_owned(),
                        setup_command: String::new(),
                        check_commands: Vec::new(),
                    },
                },
            )
            .unwrap();
            persist_workspace(
                &conn,
                &PersistWorkspaceInput {
                    id: "w1".to_string(),
                    project_id: "p1".to_string(),
                    task_label: "terminal-test".to_string(),
                    branch: "main".to_string(),
                    base_ref: "main".to_string(),
                    path: cwd_dir.path().to_string_lossy().into_owned(),
                    state: "created".to_string(),
                    shared_workspace: true,
                    dirty: false,
                    changed_files: 0,
                },
            )
            .unwrap();
        }
        (database, "w1".to_string(), db_dir, cwd_dir)
    }

    fn script_factory(script: &'static str) -> ShellFactory {
        Arc::new(move |_cwd: &str| {
            let mut cmd = CommandBuilder::new("/bin/sh");
            cmd.arg("-c");
            cmd.arg(script);
            cmd.env("TERM", "xterm-256color");
            cmd.env("COLORTERM", "truecolor");
            if let Ok(path) = std::env::var("PATH") {
                cmd.env("PATH", path);
            }
            cmd.env("TERM_PROGRAM", "Argmax");
            cmd
        })
    }

    #[test]
    fn usable_shell_rejects_missing_absolute_path() {
        assert!(!is_usable_shell(""));
        assert!(!is_usable_shell("/definitely/not/argmax-shell"));
        assert!(is_usable_shell("/bin/sh"));
        assert!(is_usable_shell("zsh"));
    }

    #[tokio::test]
    async fn spawn_emits_output_and_fires_exit_naturally() {
        let (database, workspace_id, _db, _cwd) = setup();
        let chunks: Arc<StdMutex<Vec<String>>> = Arc::new(StdMutex::new(Vec::new()));
        let chunks_for_sink = Arc::clone(&chunks);
        let on_data: OutputSink = Arc::new(move |chunk| {
            chunks_for_sink
                .lock()
                .expect("chunks poisoned")
                .push(chunk.data);
        });
        let (exit_tx, exit_rx) = oneshot::channel::<TerminalExitInfo>();
        let exit_tx = StdMutex::new(Some(exit_tx));
        let on_exit: ExitSink = Arc::new(move |info| {
            if let Some(tx) = exit_tx.lock().unwrap().take() {
                let _ = tx.send(info);
            }
        });

        let svc = TerminalService::with_shell_factory(
            database,
            on_data,
            on_exit,
            script_factory("echo argmax-terminal-hi; exit 0"),
        );
        let result = svc
            .spawn(TerminalSpawnInput {
                workspace_id,
                cols: 80,
                rows: 24,
            })
            .unwrap();
        assert!(!result.terminal_id.is_empty());

        let info = timeout(Duration::from_secs(5), exit_rx)
            .await
            .expect("exit watcher did not fire")
            .expect("exit channel closed before sending");
        assert_eq!(info.terminal_id, result.terminal_id);
        assert_eq!(info.exit_code, 0);

        // Give the reader thread one last tick to drain.
        sleep(Duration::from_millis(50)).await;
        let combined = chunks.lock().unwrap().join("");
        assert!(
            combined.contains("argmax-terminal-hi"),
            "expected hi in stdout, got: {combined:?}"
        );
        assert_eq!(svc.live_count(), 0, "terminal removed on exit");
    }

    #[tokio::test]
    async fn terminate_after_natural_exit_is_noop() {
        let (database, workspace_id, _db, _cwd) = setup();
        let on_data: OutputSink = Arc::new(|_| {});
        let (exit_tx, exit_rx) = oneshot::channel::<TerminalExitInfo>();
        let exit_tx = StdMutex::new(Some(exit_tx));
        let on_exit: ExitSink = Arc::new(move |info| {
            if let Some(tx) = exit_tx.lock().unwrap().take() {
                let _ = tx.send(info);
            }
        });
        let svc = TerminalService::with_shell_factory(
            database,
            on_data,
            on_exit,
            script_factory("exit 0"),
        );
        let result = svc
            .spawn(TerminalSpawnInput {
                workspace_id,
                cols: 80,
                rows: 24,
            })
            .unwrap();
        let _ = timeout(Duration::from_secs(5), exit_rx)
            .await
            .expect("exit watcher did not fire")
            .expect("exit channel closed before sending");
        sleep(Duration::from_millis(50)).await;

        svc.terminate(&result.terminal_id).await;
        assert_eq!(svc.live_count(), 0);
    }

    #[tokio::test]
    async fn unknown_id_is_a_noop_for_write_resize_terminate() {
        let (database, _workspace_id, _db, _cwd) = setup();
        let on_data: OutputSink = Arc::new(|_| {});
        let on_exit: ExitSink = Arc::new(|_| {});
        let svc = TerminalService::with_shell_factory(
            database,
            on_data,
            on_exit,
            script_factory("sleep 1; exit 0"),
        );
        // These must not panic / error.
        svc.write("ghost", b"hello");
        svc.resize("ghost", 100, 50);
        svc.terminate("ghost").await;
        assert_eq!(svc.live_count(), 0);
    }

    #[tokio::test]
    async fn terminate_kills_long_running_pty() {
        let (database, workspace_id, _db, _cwd) = setup();
        let on_data: OutputSink = Arc::new(|_| {});
        let (exit_tx, exit_rx) = oneshot::channel::<TerminalExitInfo>();
        let exit_tx = StdMutex::new(Some(exit_tx));
        let on_exit: ExitSink = Arc::new(move |info| {
            if let Some(tx) = exit_tx.lock().unwrap().take() {
                let _ = tx.send(info);
            }
        });
        let svc = TerminalService::with_shell_factory(
            database,
            on_data,
            on_exit,
            // Sleep long enough that the natural-exit path can't race
            // ahead of terminate.
            script_factory("sleep 60"),
        );
        let result = svc
            .spawn(TerminalSpawnInput {
                workspace_id,
                cols: 80,
                rows: 24,
            })
            .unwrap();
        // Give the child a moment to actually start sleeping.
        sleep(Duration::from_millis(100)).await;
        svc.terminate(&result.terminal_id).await;

        let info = timeout(Duration::from_secs(5), exit_rx)
            .await
            .expect("exit watcher did not fire after terminate")
            .unwrap();
        assert_eq!(info.terminal_id, result.terminal_id);
        // After SIGTERM/SIGKILL the exit code on macOS is the signal value
        // (15 for SIGTERM, 9 for SIGKILL) shifted, or the raw value
        // depending on portable_pty's mapping. We just want a non-zero
        // sentinel — the test's contract is "the child died".
        assert!(
            info.exit_code != 0,
            "expected non-zero exit code after kill"
        );
    }

    #[tokio::test]
    async fn write_forwards_bytes_to_the_child() {
        let (database, workspace_id, _db, _cwd) = setup();
        let chunks: Arc<StdMutex<Vec<String>>> = Arc::new(StdMutex::new(Vec::new()));
        let chunks_for_sink = Arc::clone(&chunks);
        let on_data: OutputSink = Arc::new(move |chunk| {
            chunks_for_sink
                .lock()
                .expect("chunks poisoned")
                .push(chunk.data);
        });
        let (exit_tx, exit_rx) = oneshot::channel::<TerminalExitInfo>();
        let exit_tx = StdMutex::new(Some(exit_tx));
        let on_exit: ExitSink = Arc::new(move |info| {
            if let Some(tx) = exit_tx.lock().unwrap().take() {
                let _ = tx.send(info);
            }
        });
        // A tiny shell loop that echoes whatever we feed it and exits on
        // a magic token. `read` returns 1 on EOF so we use a sentinel
        // line to break cleanly.
        let svc = TerminalService::with_shell_factory(
            database,
            on_data,
            on_exit,
            script_factory(
                "while IFS= read -r line; do \
                    echo \"got:$line\"; \
                    if [ \"$line\" = \"bye\" ]; then exit 0; fi; \
                 done",
            ),
        );
        let result = svc
            .spawn(TerminalSpawnInput {
                workspace_id,
                cols: 80,
                rows: 24,
            })
            .unwrap();
        // Give the PTY a moment to wire up the read loop.
        sleep(Duration::from_millis(150)).await;
        svc.write(&result.terminal_id, b"hello\n");
        sleep(Duration::from_millis(150)).await;
        svc.write(&result.terminal_id, b"bye\n");
        let _info = timeout(Duration::from_secs(5), exit_rx)
            .await
            .expect("exit did not fire");
        sleep(Duration::from_millis(50)).await;
        let combined = chunks.lock().unwrap().join("");
        assert!(
            combined.contains("got:hello"),
            "expected echo of hello, got: {combined:?}"
        );
        assert!(
            combined.contains("got:bye"),
            "expected echo of bye, got: {combined:?}"
        );
    }
}
