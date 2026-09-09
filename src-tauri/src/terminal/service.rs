// TerminalService owns the user-facing PTYs that back the integrated
// terminal panel.
//
// Distinct from `ProviderSessionService`, which owns provider-launched
// PTYs tied to a session's lifecycle; user terminals are just shells
// scoped to a workspace cwd and live until the renderer closes them or
// the app quits.
// The child handle moves into a dedicated wait watcher thread, while
// terminate paths signal every process group that still belongs to the PTY
// shell's dedicated session.

use crate::util::sync::LockOrRecover;
use std::{
    collections::HashMap,
    io::{Read, Write},
    path::Path,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex, Weak,
    },
    thread,
};

use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtyPair, PtySize};
use serde::Serialize;
use specta::Type;
use uuid::Uuid;

#[cfg(unix)]
use std::os::fd::{AsFd, BorrowedFd};

#[cfg(unix)]
use nix::poll::{poll, PollFd, PollFlags};

use crate::{
    error::{ArgmaxError, ArgmaxResult},
    persistence::{database::Database, workspaces::find_workspace_by_id},
    util::process_control::{
        cleanup_pty_session_after_leader_exit, signal_pty_session_term_and_kill_blocking,
        signal_pty_session_term_then_kill,
    },
    workspaces::lifecycle::WorkspaceLifecycle,
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

#[cfg(unix)]
struct PollingTerminalReader {
    reader: std::fs::File,
    reaped: Arc<AtomicBool>,
}

#[cfg(unix)]
impl Read for PollingTerminalReader {
    fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
        loop {
            let ready = {
                let mut descriptors = [PollFd::new(self.reader.as_fd(), PollFlags::POLLIN)];
                match poll(&mut descriptors, 100u16) {
                    Ok(ready) => ready,
                    Err(nix::errno::Errno::EINTR) => continue,
                    Err(error) => {
                        return Err(std::io::Error::from_raw_os_error(error as i32));
                    }
                }
            };
            if ready > 0 {
                return self.reader.read(buffer);
            }
            // A descendant can inherit the PTY slave after the direct shell
            // exits. Once wait() has reaped that shell and the kernel has no
            // bytes ready, treat the stream as drained instead of waiting for
            // an unrelated descendant to close its copy.
            if self.reaped.load(Ordering::Acquire) {
                return Ok(0);
            }
        }
    }
}

struct SpawnedPty {
    master: Box<dyn MasterPty + Send>,
    reader: Box<dyn Read + Send>,
    writer: Box<dyn Write + Send>,
    child: Box<dyn portable_pty::Child + Send + Sync>,
}

/// Builds every fallible parent-side PTY handle before starting the child.
/// Once spawn succeeds, no setup error can strand a live process without an
/// exit watcher.
fn prepare_and_spawn_pty(
    pair: PtyPair,
    cmd: CommandBuilder,
    reaped: Arc<AtomicBool>,
) -> ArgmaxResult<SpawnedPty> {
    #[cfg(unix)]
    let reader: Box<dyn Read + Send> = {
        let raw_fd = pair.master.as_raw_fd().ok_or_else(|| {
            ArgmaxError::service(
                "TERMINAL_PTY_READER_FAILED",
                "terminal PTY did not expose a readable descriptor",
            )
        })?;
        // Own the descriptor used for both poll and read. Retaining only
        // the master's raw integer would allow close-and-reuse races while
        // the reader drains during service shutdown.
        let borrowed = unsafe { BorrowedFd::borrow_raw(raw_fd) };
        let owned = nix::unistd::dup(borrowed).map_err(|error| {
            ArgmaxError::service(
                "TERMINAL_PTY_READER_FAILED",
                format!("could not clone PTY reader: {error}"),
            )
        })?;
        Box::new(PollingTerminalReader {
            reader: std::fs::File::from(owned),
            reaped,
        })
    };
    #[cfg(not(unix))]
    let reader = pair.master.try_clone_reader().map_err(|error| {
        ArgmaxError::service(
            "TERMINAL_PTY_READER_FAILED",
            format!("could not clone PTY reader: {error}"),
        )
    })?;
    #[cfg(not(unix))]
    drop(reaped);
    let writer = pair.master.take_writer().map_err(|error| {
        ArgmaxError::service(
            "TERMINAL_PTY_WRITER_FAILED",
            format!("could not take PTY writer: {error}"),
        )
    })?;
    let child = pair.slave.spawn_command(cmd).map_err(|error| {
        ArgmaxError::service(
            "TERMINAL_PTY_SPAWN_FAILED",
            format!("could not spawn terminal shell: {error}"),
        )
    })?;
    // Drop the slave handle on the parent side; the child holds its own.
    drop(pair.slave);

    Ok(SpawnedPty {
        master: pair.master,
        reader,
        writer,
        child,
    })
}

/// Test seam: produce a `CommandBuilder` for the PTY. Production picks
/// `$SHELL` (or `/bin/zsh` / `/bin/bash`) under a `xterm-256color`
/// truecolor env; tests inject `/bin/sh -c "<script>"` so the
/// assertions are stable.
pub type ShellFactory = Arc<dyn Fn(&str) -> CommandBuilder + Send + Sync>;

struct TerminalEntry {
    workspace_id: String,
    master: Box<dyn MasterPty + Send>,
    // Behind its own mutex so a blocking PTY write never holds the shared
    // `terminals` map lock (which every other terminal op contends on).
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
    pid: Option<u32>,
    reaped: Arc<AtomicBool>,
}

struct TerminalProcessScope {
    session_id: u32,
    fallback_process_groups: Vec<u32>,
}

pub struct TerminalService {
    database: Arc<Database>,
    on_data: OutputSink,
    on_exit: ExitSink,
    terminals: Mutex<HashMap<String, TerminalEntry>>,
    shell_factory: ShellFactory,
    lifecycle: Arc<WorkspaceLifecycle>,
}

impl TerminalService {
    pub fn new(database: Arc<Database>, on_data: OutputSink, on_exit: ExitSink) -> Arc<Self> {
        Self::with_shell_factory_and_lifecycle(
            database,
            on_data,
            on_exit,
            default_shell_factory(),
            WorkspaceLifecycle::new(),
        )
    }

    pub fn with_lifecycle(
        database: Arc<Database>,
        on_data: OutputSink,
        on_exit: ExitSink,
        lifecycle: Arc<WorkspaceLifecycle>,
    ) -> Arc<Self> {
        Self::with_shell_factory_and_lifecycle(
            database,
            on_data,
            on_exit,
            default_shell_factory(),
            lifecycle,
        )
    }

    pub fn with_shell_factory(
        database: Arc<Database>,
        on_data: OutputSink,
        on_exit: ExitSink,
        shell_factory: ShellFactory,
    ) -> Arc<Self> {
        Self::with_shell_factory_and_lifecycle(
            database,
            on_data,
            on_exit,
            shell_factory,
            WorkspaceLifecycle::new(),
        )
    }

    pub fn with_shell_factory_and_lifecycle(
        database: Arc<Database>,
        on_data: OutputSink,
        on_exit: ExitSink,
        shell_factory: ShellFactory,
        lifecycle: Arc<WorkspaceLifecycle>,
    ) -> Arc<Self> {
        Arc::new(Self {
            database,
            on_data,
            on_exit,
            terminals: Mutex::new(HashMap::new()),
            shell_factory,
            lifecycle,
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
        if matches!(
            workspace.state.as_str(),
            "archiving" | "archive-failed" | "archived"
        ) {
            return Err(ArgmaxError::service(
                "WORKSPACE_ARCHIVING",
                "Workspace archive is in progress; no new terminal can be started.",
            ));
        }
        let admission = self.lifecycle.admit(&workspace.id)?;

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
        let reaped = Arc::new(AtomicBool::new(false));
        let SpawnedPty {
            master,
            reader,
            writer,
            child,
        } = prepare_and_spawn_pty(pair, cmd, Arc::clone(&reaped))?;
        let pid = child.process_id();

        let terminal_id = Uuid::new_v4().to_string();
        {
            let mut terminals = self.terminals.lock_or_recover("terminals");
            terminals.insert(
                terminal_id.clone(),
                TerminalEntry {
                    workspace_id: workspace.id.clone(),
                    master,
                    writer: Arc::new(Mutex::new(writer)),
                    pid,
                    reaped: Arc::clone(&reaped),
                },
            );
        }
        drop(admission);

        let reader_thread =
            spawn_reader_thread(terminal_id.clone(), reader, Arc::clone(&self.on_data));
        spawn_exit_watcher(
            terminal_id.clone(),
            child,
            pid,
            Arc::downgrade(self),
            Arc::clone(&self.on_exit),
            reaped,
            reader_thread,
        );

        Ok(TerminalSpawnResult { terminal_id })
    }

    /// Forward `data` to the PTY. A failed write or flush is an error — a
    /// keystroke swallowed by a live PTY is a bug worth seeing. An unknown id
    /// stays a no-op: `spawn_reader_thread` removes the entry before it emits
    /// `terminal:exit`, so every keystroke between a shell exiting and the
    /// renderer disposing its input handler would otherwise raise one.
    pub fn write(&self, terminal_id: &str, data: &[u8]) -> ArgmaxResult<()> {
        // Take a handle to the writer and drop the map lock before writing:
        // the PTY master write blocks once the child stops draining its tty
        // input queue, and holding `terminals` across that stalls every other
        // terminal's output, resize, and terminate.
        let writer = {
            let terminals = self.terminals.lock_or_recover("terminals");
            terminals
                .get(terminal_id)
                .map(|entry| Arc::clone(&entry.writer))
        };
        let Some(writer) = writer else { return Ok(()) };
        let mut writer = writer.lock_or_recover("terminal writer");
        writer
            .write_all(data)
            .and_then(|()| writer.flush())
            .map_err(|error| ArgmaxError::service("TERMINAL_WRITE_FAILED", error.to_string()))
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
        let scope = {
            let terminals = self.terminals.lock_or_recover("terminals");
            terminals.get(terminal_id).and_then(terminal_process_scope)
        };
        let Some(scope) = scope else { return };
        if let Err(error) =
            signal_pty_session_term_then_kill(scope.session_id, scope.fallback_process_groups).await
        {
            tracing::warn!(terminal_id, %error, "terminal session enumeration failed during termination");
        }
    }

    pub async fn terminate_workspace(
        self: &Arc<Self>,
        workspace_id: &str,
        bound: std::time::Duration,
    ) -> bool {
        let terminal_ids: Vec<String> = {
            let terminals = self.terminals.lock_or_recover("terminals");
            terminals
                .iter()
                .filter(|(_, entry)| entry.workspace_id == workspace_id)
                .map(|(id, _)| id.clone())
                .collect()
        };
        // Start every escalation immediately. Waiting for each terminal in
        // sequence would multiply the 1.5s grace period by the number of open
        // tabs before the archive bound even started ticking.
        let termination_tasks = terminal_ids
            .into_iter()
            .map(|terminal_id| {
                let service = Arc::clone(self);
                tokio::spawn(async move {
                    service.terminate(&terminal_id).await;
                })
            })
            .collect::<Vec<_>>();
        tokio::time::timeout(bound, async {
            for task in termination_tasks {
                let _ = task.await;
            }
            loop {
                let live = self
                    .terminals
                    .lock_or_recover("terminals")
                    .values()
                    .any(|entry| entry.workspace_id == workspace_id);
                if !live {
                    return;
                }
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
        })
        .await
        .is_ok()
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
        let scopes: Vec<TerminalProcessScope> = {
            let terminals = self.terminals.lock_or_recover("terminals");
            terminals
                .values()
                .filter_map(terminal_process_scope)
                .collect()
        };
        for scope in scopes {
            if let Err(error) = signal_pty_session_term_and_kill_blocking(
                scope.session_id,
                &scope.fallback_process_groups,
            ) {
                tracing::warn!(session_id = scope.session_id, %error, "terminal session enumeration failed during drop");
            }
        }
    }
}

fn terminal_process_scope(entry: &TerminalEntry) -> Option<TerminalProcessScope> {
    if entry.reaped.load(Ordering::Acquire) {
        return None;
    }
    let shell_process_group = entry.pid?;
    let mut groups = vec![shell_process_group];
    #[cfg(unix)]
    if let Some(foreground_process_group) = entry
        .master
        .process_group_leader()
        .and_then(|pid| u32::try_from(pid).ok())
        .filter(|&pid| pid != shell_process_group)
    {
        groups.push(foreground_process_group);
    }
    Some(TerminalProcessScope {
        session_id: shell_process_group,
        fallback_process_groups: groups,
    })
}

fn spawn_reader_thread(
    terminal_id: String,
    reader: Box<dyn Read + Send>,
    on_data: OutputSink,
) -> thread::JoinHandle<()> {
    thread::spawn(move || {
        let error_terminal_id = terminal_id.clone();
        crate::util::stream_reader::pump_utf8_stream(
            reader,
            |_n| true,
            |data| {
                on_data(TerminalChunk {
                    terminal_id: terminal_id.clone(),
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
    })
}

fn spawn_exit_watcher(
    terminal_id: String,
    mut child: Box<dyn portable_pty::Child + Send + Sync>,
    session_id: Option<u32>,
    service: Weak<TerminalService>,
    on_exit: ExitSink,
    reaped: Arc<AtomicBool>,
    reader_thread: thread::JoinHandle<()>,
) {
    thread::spawn(move || {
        // Block waiting for the child. The child handle is owned exclusively
        // here — no shared mutex, so the wait can't deadlock against a
        // concurrent `terminate` / `write` / `resize`.
        let exit_code = child
            .wait()
            .map(|status| status.exit_code() as i32)
            .unwrap_or(-1);
        // Mark the process reaped as soon as wait returns. Termination paths
        // use this flag to guard signals against PID reuse, so it must not wait
        // behind a slow renderer output callback.
        reaped.store(true, Ordering::Release);
        if let Some(session_id) = session_id {
            if let Err(error) = cleanup_pty_session_after_leader_exit(session_id) {
                tracing::warn!(
                    terminal_id = %terminal_id,
                    %error,
                    "terminal session enumeration failed after shell exit"
                );
            }
        }
        // The child can report its exit before the PTY reader consumes the
        // final bytes already buffered in the kernel. Wait for EOF and for all
        // data callbacks to return before publishing `terminal:exit`, so exit
        // cannot overtake the tail of stdout in the shared delivery queue.
        if reader_thread.join().is_err() {
            tracing::warn!(terminal_id = %terminal_id, "terminal reader thread panicked");
        }
        // portable_pty's ExitStatus doesn't expose POSIX signal numbers
        // cross-platform; emit `None` when unavailable to match the TS shape.
        let signal: Option<i32> = None;
        if let Some(service) = service.upgrade() {
            let _ = service.remove_terminal(&terminal_id);
        }
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
    #[cfg(unix)]
    use nix::unistd::{getpgid, getsid, Pid};
    use std::sync::Mutex as StdMutex;
    use std::time::{Duration, Instant};
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
                        archive_on_merge: false,
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
                    kind: "git".to_string(),
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

    #[cfg(unix)]
    fn interactive_bash_factory() -> ShellFactory {
        Arc::new(|_cwd: &str| {
            let mut cmd = CommandBuilder::new("/bin/bash");
            cmd.arg("--noprofile");
            cmd.arg("--norc");
            cmd.arg("-i");
            cmd.env("TERM", "xterm-256color");
            if let Ok(path) = std::env::var("PATH") {
                cmd.env("PATH", path);
            }
            cmd
        })
    }

    #[cfg(unix)]
    fn process_gone(pid: u32) -> bool {
        let output = std::process::Command::new("ps")
            .args(["-o", "state=", "-p", &pid.to_string()])
            .output()
            .unwrap();
        let state = String::from_utf8_lossy(&output.stdout);
        state.trim().is_empty() || state.trim().starts_with('Z')
    }

    #[cfg(unix)]
    fn marker_pid(output: &str, marker: &str) -> u32 {
        output
            .replace('\r', "")
            .lines()
            .find_map(|line| line.strip_prefix(marker))
            .and_then(|pid| pid.trim().parse().ok())
            .unwrap_or_else(|| panic!("missing {marker} pid in {output:?}"))
    }

    #[cfg(unix)]
    struct ProcessGroupGuard(u32);

    #[cfg(unix)]
    impl Drop for ProcessGroupGuard {
        fn drop(&mut self) {
            crate::util::process_control::signal_target_term_and_kill_blocking(
                crate::util::process_control::SignalTarget::ProcessGroup(self.0),
                None,
            );
        }
    }

    #[cfg(unix)]
    struct ProcessGuard(u32);

    #[cfg(unix)]
    impl Drop for ProcessGuard {
        fn drop(&mut self) {
            crate::util::process_control::signal_target_term_and_kill_blocking(
                crate::util::process_control::SignalTarget::Process(self.0),
                None,
            );
        }
    }

    #[test]
    fn parent_pty_setup_failure_does_not_spawn_child() {
        let directory = TempDir::new().unwrap();
        let marker = directory.path().join("spawned");
        let pair = native_pty_system().openpty(PtySize::default()).unwrap();
        // portable-pty rejects a second writer. This gives us a real,
        // deterministic parent-side setup error before spawn_command.
        let _first_writer = pair.master.take_writer().unwrap();
        let mut cmd = CommandBuilder::new("/bin/sh");
        cmd.arg("-c");
        cmd.arg(format!("touch '{}'", marker.display()));
        let result = prepare_and_spawn_pty(pair, cmd, Arc::new(AtomicBool::new(false)));

        assert!(result.is_err(), "second PTY writer should fail setup");
        std::thread::sleep(Duration::from_millis(100));
        assert!(!marker.exists(), "setup failure must happen before spawn");
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

        // Receiving exit guarantees the reader drained and every output sink
        // call returned; no timing allowance belongs in this assertion.
        let combined = chunks.lock().unwrap().join("");
        assert!(
            combined.contains("argmax-terminal-hi"),
            "expected hi in stdout, got: {combined:?}"
        );
        assert_eq!(svc.live_count(), 0, "terminal removed on exit");
    }

    #[tokio::test]
    async fn reaped_guard_precedes_a_blocked_final_output_callback() {
        let (database, workspace_id, _db, _cwd) = setup();
        let chunks: Arc<StdMutex<Vec<String>>> = Arc::new(StdMutex::new(Vec::new()));
        let chunks_for_sink = Arc::clone(&chunks);
        let (started_tx, started_rx) = std::sync::mpsc::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        let release_rx = StdMutex::new(Some(release_rx));
        let on_data: OutputSink = Arc::new(move |chunk| {
            chunks_for_sink.lock().unwrap().push(chunk.data);
            let _ = started_tx.send(());
            if let Some(release_rx) = release_rx.lock().unwrap().take() {
                let _ = release_rx.recv();
            }
        });
        let (exit_tx, mut exit_rx) = oneshot::channel::<TerminalExitInfo>();
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
            script_factory("printf final-output; exit 0"),
        );
        let result = svc
            .spawn(TerminalSpawnInput {
                workspace_id,
                cols: 80,
                rows: 24,
            })
            .unwrap();
        let reaped = {
            let terminals = svc.terminals.lock().unwrap();
            Arc::clone(&terminals.get(&result.terminal_id).unwrap().reaped)
        };

        started_rx
            .recv_timeout(Duration::from_secs(2))
            .expect("final output callback started");
        timeout(Duration::from_secs(2), async {
            while !reaped.load(Ordering::Acquire) {
                sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .expect("child wait did not set the reaped guard");
        assert!(
            matches!(exit_rx.try_recv(), Err(oneshot::error::TryRecvError::Empty)),
            "exit must wait until the final output callback returns"
        );

        release_tx.send(()).unwrap();
        let info = timeout(Duration::from_secs(2), exit_rx)
            .await
            .expect("exit did not follow final output")
            .expect("exit channel closed");
        assert_eq!(info.terminal_id, result.terminal_id);
        assert!(chunks.lock().unwrap().join("").contains("final-output"));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn exit_does_not_wait_for_a_descendant_holding_the_pty_slave() {
        let (database, workspace_id, _db, _cwd) = setup();
        let chunks: Arc<StdMutex<Vec<String>>> = Arc::new(StdMutex::new(Vec::new()));
        let chunks_for_sink = Arc::clone(&chunks);
        let on_data: OutputSink = Arc::new(move |chunk| {
            chunks_for_sink.lock().unwrap().push(chunk.data);
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
            // The background process keeps the shell's session and PTY slave.
            // Natural shell exit must clean it up without waiting for its
            // intended lifetime.
            script_factory(
                "(sleep 60; printf descendant-output) & \
                 printf 'ARGMAX_DESCENDANT_PID:%s\\n' \"$!\"; \
                 printf final-output; exit 0",
            ),
        );
        let result = svc
            .spawn(TerminalSpawnInput {
                workspace_id,
                cols: 80,
                rows: 24,
            })
            .unwrap();

        let info = timeout(Duration::from_millis(750), exit_rx)
            .await
            .expect("exit waited for a descendant's PTY handle")
            .expect("exit channel closed");
        assert_eq!(info.terminal_id, result.terminal_id);
        let output = chunks.lock().unwrap().join("");
        assert!(output.contains("final-output"));
        let descendant_pid = marker_pid(&output, "ARGMAX_DESCENDANT_PID:");
        assert!(
            process_gone(descendant_pid),
            "natural shell exit left its background job alive"
        );
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
        // These must not panic / error: the entry is already gone by the time
        // the renderer stops sending keystrokes.
        svc.write("ghost", b"hello")
            .expect("write to a dead id is a no-op");
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

    #[cfg(unix)]
    #[tokio::test]
    async fn terminate_kills_term_ignoring_foreground_job_group() {
        let (database, workspace_id, _db, cwd) = setup();
        let pid_path = cwd.path().join("foreground.pid");
        let pending_pid_path = cwd.path().join("foreground.pid.pending");
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
            interactive_bash_factory(),
        );
        let result = svc
            .spawn(TerminalSpawnInput {
                workspace_id,
                cols: 80,
                rows: 24,
            })
            .unwrap();
        let command = format!(
            "sh -c 'trap \"\" HUP TERM; echo $$ > \"{}\"; mv \"{}\" \"{}\"; exec sleep 60'\n",
            pending_pid_path.display(),
            pending_pid_path.display(),
            pid_path.display(),
        );
        svc.write(&result.terminal_id, command.as_bytes())
            .expect("start foreground fixture");

        let handshake_deadline = Instant::now() + Duration::from_secs(5);
        while !pid_path.is_file() {
            assert!(
                Instant::now() < handshake_deadline,
                "foreground fixture did not write its pid"
            );
            sleep(Duration::from_millis(25)).await;
        }
        let foreground_pid: u32 = std::fs::read_to_string(&pid_path)
            .unwrap()
            .trim()
            .parse()
            .unwrap();
        let process_guard = ProcessGuard(foreground_pid);

        let group_deadline = Instant::now() + Duration::from_secs(2);
        let (shell_pid, foreground_process_group) = loop {
            let groups = {
                let terminals = svc.terminals.lock().unwrap();
                let entry = terminals.get(&result.terminal_id).unwrap();
                entry.pid.zip(
                    entry
                        .master
                        .process_group_leader()
                        .and_then(|pid| u32::try_from(pid).ok()),
                )
            };
            if let Some((shell_pid, foreground_process_group)) =
                groups.filter(|(shell_pid, foreground)| shell_pid != foreground)
            {
                break (shell_pid, foreground_process_group);
            }
            assert!(
                Instant::now() < group_deadline,
                "interactive shell did not assign a foreground job group"
            );
            sleep(Duration::from_millis(25)).await;
        };
        let guard = ProcessGroupGuard(foreground_process_group);
        assert_eq!(
            getpgid(Some(Pid::from_raw(shell_pid as i32)))
                .unwrap()
                .as_raw() as u32,
            shell_pid,
            "portable-pty shell should lead its own session group"
        );
        assert_eq!(
            getpgid(Some(Pid::from_raw(foreground_pid as i32)))
                .unwrap()
                .as_raw() as u32,
            foreground_process_group,
            "fixture must run in the tty foreground group"
        );

        svc.terminate(&result.terminal_id).await;
        timeout(Duration::from_secs(5), exit_rx)
            .await
            .expect("terminal shell did not exit")
            .expect("exit channel closed");
        let gone_deadline = Instant::now() + Duration::from_secs(3);
        while !process_gone(foreground_pid) {
            assert!(
                Instant::now() < gone_deadline,
                "TERM/HUP-ignoring foreground job survived terminal termination"
            );
            sleep(Duration::from_millis(25)).await;
        }
        std::mem::forget(guard);
        std::mem::forget(process_guard);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn terminate_cleans_background_groups_but_preserves_detached_sessions() {
        let (database, workspace_id, _db, cwd) = setup();
        let background_pid_path = cwd.path().join("background.pid");
        let pending_background_pid_path = cwd.path().join("background.pid.pending");
        let detached_pid_path = cwd.path().join("detached.pid");
        let pending_detached_pid_path = cwd.path().join("detached.pid.pending");
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
            interactive_bash_factory(),
        );
        let result = svc
            .spawn(TerminalSpawnInput {
                workspace_id,
                cols: 80,
                rows: 24,
            })
            .unwrap();
        let commands = format!(
            "sh -c 'trap \"\" HUP TERM; echo $$ > \"{}\"; mv \"{}\" \"{}\"; exec sleep 60' &\n\
             /usr/bin/python3 -c 'import os,time; pid=os.fork(); pid and os._exit(0); os.setsid(); f=open(\"{}\", \"w\"); f.write(str(os.getpid())); f.close(); os.replace(\"{}\", \"{}\"); time.sleep(60)'\n",
            pending_background_pid_path.display(),
            pending_background_pid_path.display(),
            background_pid_path.display(),
            pending_detached_pid_path.display(),
            pending_detached_pid_path.display(),
            detached_pid_path.display(),
        );
        svc.write(&result.terminal_id, commands.as_bytes())
            .expect("start background and detached fixtures");

        // Shared macOS runners often take >5s to exec python3 + setsid on a
        // freshly spawned PTY while 900 other tests are still winding down.
        let handshake_deadline = Instant::now() + Duration::from_secs(15);
        while !background_pid_path.is_file() || !detached_pid_path.is_file() {
            assert!(
                Instant::now() < handshake_deadline,
                "session fixture did not write both pids"
            );
            sleep(Duration::from_millis(25)).await;
        }
        let background_pid: u32 = std::fs::read_to_string(&background_pid_path)
            .unwrap()
            .trim()
            .parse()
            .unwrap();
        let detached_pid: u32 = std::fs::read_to_string(&detached_pid_path)
            .unwrap()
            .trim()
            .parse()
            .unwrap();
        let background_process_guard = ProcessGuard(background_pid);
        let _detached_process_guard = ProcessGuard(detached_pid);
        let shell_pid = svc
            .terminals
            .lock()
            .unwrap()
            .get(&result.terminal_id)
            .unwrap()
            .pid
            .unwrap();
        let background_process_group = getpgid(Some(Pid::from_raw(background_pid as i32)))
            .unwrap()
            .as_raw() as u32;
        let detached_process_group = getpgid(Some(Pid::from_raw(detached_pid as i32)))
            .unwrap()
            .as_raw() as u32;
        let background_guard = ProcessGroupGuard(background_process_group);
        let _detached_guard = ProcessGroupGuard(detached_process_group);
        assert_ne!(
            background_process_group, shell_pid,
            "interactive background job must use a separate process group"
        );
        assert_eq!(
            getsid(Some(Pid::from_raw(background_pid as i32)))
                .unwrap()
                .as_raw() as u32,
            shell_pid,
            "background job must remain in the terminal shell's session"
        );
        assert_eq!(
            getsid(Some(Pid::from_raw(detached_pid as i32)))
                .unwrap()
                .as_raw() as u32,
            detached_pid,
            "fixture must create a genuinely detached session"
        );

        svc.terminate(&result.terminal_id).await;
        timeout(Duration::from_secs(5), exit_rx)
            .await
            .expect("terminal shell did not exit")
            .expect("exit channel closed");
        let gone_deadline = Instant::now() + Duration::from_secs(3);
        while !process_gone(background_pid) {
            assert!(
                Instant::now() < gone_deadline,
                "TERM/HUP-ignoring background job survived terminal termination"
            );
            sleep(Duration::from_millis(25)).await;
        }
        assert!(
            !process_gone(detached_pid),
            "terminal cleanup must not signal a process that created a new session"
        );
        std::mem::forget(background_guard);
        std::mem::forget(background_process_guard);
    }

    #[tokio::test]
    async fn dropping_service_terminates_a_live_terminal() {
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
            script_factory("sleep 60"),
        );
        let result = svc
            .spawn(TerminalSpawnInput {
                workspace_id,
                cols: 80,
                rows: 24,
            })
            .unwrap();
        let service = Arc::downgrade(&svc);

        sleep(Duration::from_millis(100)).await;
        drop(svc);

        assert!(
            service.upgrade().is_none(),
            "the exit watcher retained the terminal service"
        );
        let info = timeout(Duration::from_secs(5), exit_rx)
            .await
            .expect("service drop did not terminate the terminal")
            .expect("exit channel closed before sending");
        assert_eq!(info.terminal_id, result.terminal_id);
        assert_ne!(info.exit_code, 0);
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
        svc.write(&result.terminal_id, b"hello\n")
            .expect("write hello");
        sleep(Duration::from_millis(150)).await;
        svc.write(&result.terminal_id, b"bye\n").expect("write bye");
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
