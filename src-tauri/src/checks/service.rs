// CheckService runs workspace check commands under a wall-clock cap with
// output capture, sensitive-env filtering, per-workspace cancellation, and
// process-group SIGTERM/SIGKILL escalation.

use std::{
    collections::{HashMap, VecDeque},
    process::Stdio,
    sync::{Arc, Mutex},
    time::Duration,
};

use regex::Regex;
use tokio::{
    io::{AsyncBufReadExt, BufReader},
    process::Command,
    sync::oneshot,
    time,
};
use uuid::Uuid;

use crate::approvals::dangerous_action_policy::{classify_command_risk, CommandRiskLevel};
use crate::error::{ArgmaxError, ArgmaxResult};
use crate::persistence::checks::{
    persist_check, update_check, CheckRun, PersistCheckInput, UpdateCheckInput,
};
use crate::persistence::database::Database;
use crate::persistence::time::now_iso;
use crate::persistence::workspaces::find_workspace_by_id;
use crate::util::process_control::terminate_process_group_with_escalation;

/// Hard wall-clock cap. Matches `CHECK_DEFAULT_TIMEOUT_MS` in the TS.
pub const DEFAULT_TIMEOUT_MS: u64 = 5 * 60 * 1000;

/// Cap on accumulated stdout+stderr text. summarize_output only persists
/// the last 8 lines anyway; the tail drops oldest chunks once exceeded.
const OUTPUT_TAIL_BYTES: usize = 64 * 1024;

#[derive(Debug, Clone)]
pub struct RunWorkspaceCheckInput {
    pub workspace_id: String,
    pub command: String,
    pub timeout_ms: Option<u64>,
}

/// Callback shape that lets a caller observe streaming check output.
/// Matches the TS `onOutput?: (chunk: string) => void`.
pub type OutputSink = Arc<dyn Fn(&str) + Send + Sync>;

#[derive(Default)]
struct CancelRegistry {
    workspaces: HashMap<String, Vec<CancelEntry>>,
}

struct CancelEntry {
    check_id: String,
    sender: oneshot::Sender<()>,
}

impl CancelRegistry {
    fn register(&mut self, workspace_id: &str, check_id: &str, sender: oneshot::Sender<()>) {
        self.workspaces
            .entry(workspace_id.to_string())
            .or_default()
            .push(CancelEntry {
                check_id: check_id.to_string(),
                sender,
            });
    }

    fn unregister(&mut self, workspace_id: &str, check_id: &str) {
        let mut remove_bucket = false;
        if let Some(bucket) = self.workspaces.get_mut(workspace_id) {
            bucket.retain(|entry| entry.check_id != check_id);
            remove_bucket = bucket.is_empty();
        }
        if remove_bucket {
            self.workspaces.remove(workspace_id);
        }
    }

    fn cancel_all(&mut self, workspace_id: &str) {
        if let Some(bucket) = self.workspaces.remove(workspace_id) {
            for entry in bucket {
                let _ = entry.sender.send(());
            }
        }
    }

    #[cfg(test)]
    fn pending_count(&self) -> usize {
        self.workspaces.values().map(Vec::len).sum()
    }
}

pub struct CheckService {
    database: Arc<Database>,
    cancel_registry: Mutex<CancelRegistry>,
}

impl CheckService {
    pub fn new(database: Arc<Database>) -> Arc<Self> {
        Arc::new(Self {
            database,
            cancel_registry: Mutex::new(CancelRegistry::default()),
        })
    }

    pub fn cancel_workspace_checks(&self, workspace_id: &str) {
        let mut registry = self
            .cancel_registry
            .lock()
            .expect("cancel registry poisoned");
        registry.cancel_all(workspace_id);
    }

    #[cfg(test)]
    fn pending_cancel_count(&self) -> usize {
        self.cancel_registry
            .lock()
            .expect("cancel registry poisoned")
            .pending_count()
    }

    pub async fn run_workspace_check(
        self: &Arc<Self>,
        input: RunWorkspaceCheckInput,
        on_output: Option<OutputSink>,
    ) -> ArgmaxResult<CheckRun> {
        // Reject obviously-destructive shell shapes BEFORE persisting or
        // spawning. `sh -c` interprets the full command string, so
        // without this gate a check like `rm -rf $HOME` runs
        // unconditionally. `medium` risk (npm install, git push) is
        // legitimate in CI scripts. (audit-2026-05-17 C1/C2)
        let risk = classify_command_risk(&input.command);
        if matches!(risk.risk_level, CommandRiskLevel::High) {
            return Err(ArgmaxError::service(
                "CHECK_COMMAND_REFUSED",
                format!("Check command refused: {}", risk.reason),
            ));
        }

        let workspace = {
            let conn = self.database.connection();
            find_workspace_by_id(&conn, &input.workspace_id)?
        };
        let check = {
            let conn = self.database.connection();
            persist_check(
                &conn,
                &PersistCheckInput {
                    id: Uuid::new_v4().to_string(),
                    workspace_id: workspace.id.clone(),
                    command: input.command.clone(),
                    status: "running".to_string(),
                    started_at: None,
                },
            )?
        };

        let timeout = Duration::from_millis(input.timeout_ms.unwrap_or(DEFAULT_TIMEOUT_MS));

        let (cancel_tx, cancel_rx) = oneshot::channel::<()>();
        {
            let mut registry = self
                .cancel_registry
                .lock()
                .expect("cancel registry poisoned");
            registry.register(&workspace.id, &check.id, cancel_tx);
        }

        let mut command = Command::new("/bin/sh");
        command
            .arg("-c")
            .arg(&input.command)
            .current_dir(&workspace.path)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .stdin(Stdio::null())
            .env_clear();
        for (key, value) in filtered_env() {
            command.env(key, value);
        }
        // detach so we can SIGTERM/SIGKILL the entire process group;
        // tokio doesn't expose process-group control directly so we use
        // the std Command extension below.
        #[cfg(unix)]
        {
            command.process_group(0);
        }
        command.kill_on_drop(true);

        let mut child = command.spawn().map_err(|error| {
            ArgmaxError::service(
                "CHECK_SPAWN_FAILED",
                format!("failed to spawn check: {error}"),
            )
        })?;
        let stdout = child.stdout.take();
        let stderr = child.stderr.take();
        let output = Arc::new(Mutex::new(OutputTail::default()));

        let stdout_task = stdout.map(|stream| {
            tokio::spawn(read_stream(
                BufReader::new(stream),
                output.clone(),
                on_output.clone(),
            ))
        });
        let stderr_task = stderr.map(|stream| {
            tokio::spawn(read_stream(
                BufReader::new(stream),
                output.clone(),
                on_output.clone(),
            ))
        });

        let mut timed_out = false;
        let mut aborted = false;
        let exit_code: i32;

        tokio::select! {
            wait = child.wait() => {
                exit_code = wait
                    .ok()
                    .and_then(|status| status.code())
                    .unwrap_or(1);
            }
            _ = time::sleep(timeout) => {
                timed_out = true;
                let _ = terminate_process_group_with_escalation(&mut child).await;
                exit_code = child.wait().await.ok().and_then(|status| status.code()).unwrap_or(1);
            }
            _ = cancel_rx => {
                aborted = true;
                let _ = terminate_process_group_with_escalation(&mut child).await;
                exit_code = child.wait().await.ok().and_then(|status| status.code()).unwrap_or(1);
            }
        }

        {
            let mut registry = self
                .cancel_registry
                .lock()
                .expect("cancel registry poisoned");
            registry.unregister(&workspace.id, &check.id);
        }

        if let Some(task) = stdout_task {
            let _ = task.await;
        }
        if let Some(task) = stderr_task {
            let _ = task.await;
        }

        let (status, summary_prefix) = if timed_out {
            ("cancelled", "[timed-out] ")
        } else if aborted {
            ("cancelled", "[cancelled] ")
        } else if exit_code == 0 {
            ("passed", "")
        } else {
            ("failed", "")
        };

        let tail = output.lock().expect("output mutex poisoned").take();
        let summary = format!("{summary_prefix}{}", summarize_output(&tail));

        let conn = self.database.connection();
        update_check(
            &conn,
            &check.id,
            &UpdateCheckInput {
                status: status.to_string(),
                exit_code: Some(exit_code as i64),
                summary: Some(summary),
                completed_at: Some(now_iso()),
            },
        )
    }
}

#[derive(Default)]
struct OutputTail {
    chunks: VecDeque<String>,
    bytes: usize,
}

impl OutputTail {
    fn push(&mut self, chunk: String) {
        self.bytes += chunk.len();
        self.chunks.push_back(chunk);
        while self.bytes > OUTPUT_TAIL_BYTES && self.chunks.len() > 1 {
            let dropped = self.chunks.pop_front().expect("tail chunk exists");
            self.bytes -= dropped.len();
        }
        if self.bytes > OUTPUT_TAIL_BYTES && self.chunks.len() == 1 {
            let only = self.chunks.pop_front().expect("tail chunk exists");
            let start = only.len().saturating_sub(OUTPUT_TAIL_BYTES);
            // Slice on a char boundary so we never split a multibyte
            // sequence. Walk forward until we land on one.
            let mut byte_idx = start;
            while !only.is_char_boundary(byte_idx) && byte_idx < only.len() {
                byte_idx += 1;
            }
            let tail = only[byte_idx..].to_string();
            self.bytes = tail.len();
            self.chunks.push_back(tail);
        }
    }

    fn take(&mut self) -> String {
        let combined = std::mem::take(&mut self.chunks)
            .into_iter()
            .collect::<String>();
        self.bytes = 0;
        combined
    }
}

async fn read_stream<R>(
    mut reader: BufReader<R>,
    tail: Arc<Mutex<OutputTail>>,
    sink: Option<OutputSink>,
) where
    R: tokio::io::AsyncRead + Unpin,
{
    let mut buffer = String::new();
    loop {
        buffer.clear();
        match reader.read_line(&mut buffer).await {
            Ok(0) => return,
            Ok(_) => {
                if let Some(sink) = sink.as_ref() {
                    sink(&buffer);
                }
                let mut guard = tail.lock().expect("output mutex poisoned");
                guard.push(buffer.clone());
            }
            Err(error) => {
                // A read error is not EOF: log it so a broken pipe / unreadable
                // stream isn't mistaken for clean check completion.
                tracing::warn!(?error, "check output stream read error; stopping capture");
                return;
            }
        }
    }
}

fn summarize_output(output: &str) -> String {
    let trimmed = output.trim();
    if trimmed.is_empty() {
        return "No output.".to_string();
    }
    let lines: Vec<&str> = trimmed
        .split(['\n', '\r'])
        .filter(|line| !line.is_empty())
        .collect();
    let start = lines.len().saturating_sub(8);
    lines[start..].join("\n")
}

/// Mirrors `SENSITIVE_ENV_PATTERNS` in the TS source. Default-deny by
/// pattern, not allowlist — check commands legitimately need access to
/// PYTHONPATH, GOPATH, npm_config_*, etc.
fn filtered_env() -> Vec<(String, String)> {
    let patterns: Vec<Regex> = vec![
        Regex::new(r"(?i)(^|_)(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIALS?|APIKEY)$").unwrap(),
        Regex::new(r"(?i)^AWS_").unwrap(),
        Regex::new(r"(?i)^AZURE_").unwrap(),
        Regex::new(r"(?i)^GOOGLE_").unwrap(),
        Regex::new(r"(?i)^GCP_").unwrap(),
        Regex::new(r"(?i)^OPENAI_").unwrap(),
        Regex::new(r"(?i)^ANTHROPIC_").unwrap(),
        Regex::new(r"(?i)^DATABASE_URL$").unwrap(),
    ];
    std::env::vars()
        .filter(|(key, _)| !patterns.iter().any(|p| p.is_match(key)))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::persistence::projects::{persist_project, PersistProjectInput, ProjectSettings};
    use crate::persistence::workspaces::{persist_workspace, PersistWorkspaceInput};
    use tempfile::TempDir;

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
                        default_model_label: "Claude Haiku 4.5".to_string(),
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
                    task_label: "checks-test".to_string(),
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

    #[tokio::test]
    async fn passing_command_records_passed() {
        let (database, workspace_id, _db, _cwd) = setup();
        let svc = CheckService::new(database);
        let result = svc
            .run_workspace_check(
                RunWorkspaceCheckInput {
                    workspace_id,
                    command: "echo ok".to_string(),
                    timeout_ms: Some(5_000),
                },
                None,
            )
            .await
            .unwrap();
        assert_eq!(result.status, "passed");
        assert_eq!(result.exit_code, Some(0));
        assert!(result.completed_at.is_some());
        assert_eq!(svc.pending_cancel_count(), 0);
    }

    #[tokio::test]
    async fn failing_command_records_failed_with_exit_code() {
        let (database, workspace_id, _db, _cwd) = setup();
        let svc = CheckService::new(database);
        let result = svc
            .run_workspace_check(
                RunWorkspaceCheckInput {
                    workspace_id,
                    command: "exit 7".to_string(),
                    timeout_ms: Some(5_000),
                },
                None,
            )
            .await
            .unwrap();
        assert_eq!(result.status, "failed");
        assert_eq!(result.exit_code, Some(7));
    }

    #[tokio::test]
    async fn high_risk_command_refused_without_persisting() {
        let (database, workspace_id, _db, _cwd) = setup();
        let svc = CheckService::new(database.clone());
        let err = svc
            .run_workspace_check(
                RunWorkspaceCheckInput {
                    workspace_id,
                    command: "rm -rf /".to_string(),
                    timeout_ms: Some(5_000),
                },
                None,
            )
            .await
            .expect_err("expected refusal");
        assert!(err.to_string().contains("Check command refused"));
    }

    #[tokio::test]
    async fn timeout_records_cancelled_with_timeout_prefix() {
        let (database, workspace_id, _db, _cwd) = setup();
        let svc = CheckService::new(database);
        let result = svc
            .run_workspace_check(
                RunWorkspaceCheckInput {
                    workspace_id,
                    command: "sleep 10".to_string(),
                    timeout_ms: Some(200),
                },
                None,
            )
            .await
            .unwrap();
        assert_eq!(result.status, "cancelled");
        assert!(result
            .summary
            .as_deref()
            .unwrap_or("")
            .starts_with("[timed-out] "));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn timeout_kills_check_process_group_descendants() {
        let (database, workspace_id, _db, cwd) = setup();
        let pid_path = cwd.path().join("child.pid");
        let command = format!(
            "sh -c 'trap \"\" TERM; echo $$ > \"{}\"; sleep 60' & wait",
            pid_path.display()
        );
        let svc = CheckService::new(database);
        let result = svc
            .run_workspace_check(
                RunWorkspaceCheckInput {
                    workspace_id,
                    command,
                    timeout_ms: Some(250),
                },
                None,
            )
            .await
            .unwrap();
        assert_eq!(result.status, "cancelled");

        let pid = std::fs::read_to_string(&pid_path)
            .expect("child pid written")
            .trim()
            .to_string();
        for _ in 0..20 {
            if !pid_is_alive(&pid) {
                return;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        panic!("check descendant process {pid} survived timeout cancellation");
    }

    #[tokio::test]
    async fn cancel_workspace_checks_aborts_in_flight_run() {
        let (database, workspace_id, _db, _cwd) = setup();
        let svc = CheckService::new(database);
        let svc_for_cancel = svc.clone();
        let workspace_clone = workspace_id.clone();
        let canceller = tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(100)).await;
            svc_for_cancel.cancel_workspace_checks(&workspace_clone);
        });
        let result = svc
            .run_workspace_check(
                RunWorkspaceCheckInput {
                    workspace_id,
                    command: "sleep 10".to_string(),
                    timeout_ms: Some(10_000),
                },
                None,
            )
            .await
            .unwrap();
        let _ = canceller.await;
        assert_eq!(result.status, "cancelled");
        assert!(result
            .summary
            .as_deref()
            .unwrap_or("")
            .starts_with("[cancelled] "));
        assert_eq!(svc.pending_cancel_count(), 0);
    }

    #[test]
    fn summarize_output_returns_no_output_on_empty() {
        assert_eq!(summarize_output(""), "No output.");
        assert_eq!(summarize_output("   "), "No output.");
    }

    #[test]
    fn summarize_output_keeps_last_eight_lines() {
        let body = (1..=12)
            .map(|i| format!("line {i}"))
            .collect::<Vec<_>>()
            .join("\n");
        let summary = summarize_output(&body);
        let lines: Vec<&str> = summary.split('\n').collect();
        assert_eq!(lines.len(), 8);
        assert_eq!(lines.first().unwrap(), &"line 5");
        assert_eq!(lines.last().unwrap(), &"line 12");
    }

    #[test]
    fn output_tail_keeps_recent_chunks_under_byte_cap() {
        let mut tail = OutputTail::default();
        tail.push("old".repeat(40_000));
        tail.push("new".repeat(24_000));

        let output = tail.take();

        assert!(!output.contains("oldoldold"));
        assert!(output.contains("newnewnew"));
        assert!(output.len() <= OUTPUT_TAIL_BYTES);
    }

    #[test]
    fn filtered_env_drops_sensitive_keys() {
        std::env::set_var("ARGMAX_TEST_SECRET", "shh");
        std::env::set_var("ARGMAX_TEST_API_KEY", "x");
        std::env::set_var("PATH_PASSTHROUGH", "/usr/bin");
        let env = filtered_env();
        let keys: Vec<&str> = env.iter().map(|(k, _)| k.as_str()).collect();
        assert!(!keys.contains(&"ARGMAX_TEST_SECRET"));
        assert!(!keys.contains(&"ARGMAX_TEST_API_KEY"));
        assert!(keys.contains(&"PATH_PASSTHROUGH"));
        std::env::remove_var("ARGMAX_TEST_SECRET");
        std::env::remove_var("ARGMAX_TEST_API_KEY");
        std::env::remove_var("PATH_PASSTHROUGH");
    }

    #[cfg(unix)]
    fn pid_is_alive(pid: &str) -> bool {
        let Ok(raw_pid) = pid.parse::<i32>() else {
            return false;
        };
        nix::sys::signal::kill(nix::unistd::Pid::from_raw(raw_pid), None).is_ok()
    }
}
