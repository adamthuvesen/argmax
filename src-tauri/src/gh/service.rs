// GhService — Stage 1 of the CI feedback loop. Shells out to `gh pr view`
// against a session's workspace and persists the result so the renderer can
// render PR status without re-running `gh` on every read.
//
// Mirrors `src/main/gh/ghService.ts`. The `GhRunner` shape matches
// `src-tauri/src/git/ops.rs::GhRunner` so both subsystems can share a
// fake binary in tests.

use std::{future::Future, pin::Pin, sync::Arc, time::Duration};

use crate::error::{ArgmaxError, ArgmaxResult};
use crate::persistence::database::Database;
use crate::persistence::gh::{list_gh_pr_for_session, upsert_gh_pr, GhPrRecord};
use crate::persistence::sessions::find_session_by_id;
use crate::persistence::time::now_iso;
use crate::persistence::workspaces::find_workspace_by_id;

/// Mirrors the TS default of 15s — `gh` is the bottleneck, not us.
const GH_TIMEOUT: Duration = Duration::from_secs(15);

/// `gh` is invoked via this closure so tests can stub the binary the same
/// way the TS code injects a fake `ghRunner`.
pub type GhRunner = Arc<
    dyn Fn(String, Vec<String>) -> Pin<Box<dyn Future<Output = ArgmaxResult<String>> + Send>>
        + Send
        + Sync,
>;

pub fn default_gh_runner() -> GhRunner {
    Arc::new(|cwd: String, args: Vec<String>| {
        Box::pin(async move {
            use tokio::process::Command;
            let output = tokio::time::timeout(
                GH_TIMEOUT,
                Command::new("gh").current_dir(cwd).args(&args).output(),
            )
            .await
            .map_err(|_| {
                ArgmaxError::service("GH_TIMEOUT", format!("gh timed out after {GH_TIMEOUT:?}"))
            })?
            .map_err(|error| {
                ArgmaxError::service("GH_SPAWN_FAILED", format!("failed to run gh: {error}"))
            })?;
            if !output.status.success() {
                let stderr = String::from_utf8_lossy(&output.stderr);
                return Err(ArgmaxError::service(
                    "GH_NON_ZERO_EXIT",
                    format!("gh failed: {}", stderr.trim()),
                ));
            }
            String::from_utf8(output.stdout).map_err(|error| {
                ArgmaxError::service(
                    "GH_STDOUT_NOT_UTF8",
                    format!("gh stdout was not valid UTF-8: {error}"),
                )
            })
        })
    })
}

/// `GhService` keeps the renderer's PR rows fresh. Cheap reads (`list_for_session`)
/// hit SQLite; `refresh` calls out to `gh` and upserts.
pub struct GhService {
    database: Arc<Database>,
    runner: GhRunner,
}

impl GhService {
    pub fn new(database: Arc<Database>) -> Arc<Self> {
        Arc::new(Self {
            database,
            runner: default_gh_runner(),
        })
    }

    pub fn with_runner(database: Arc<Database>, runner: GhRunner) -> Arc<Self> {
        Arc::new(Self { database, runner })
    }

    /// Returns the cached `gh_pr` rows for a session. Cheap — single
    /// read-only DB hit.
    pub fn list_for_session(&self, session_id: &str) -> ArgmaxResult<Vec<GhPrRecord>> {
        let conn = self.database.connection();
        list_gh_pr_for_session(&conn, session_id)
    }

    /// Runs `gh pr view --json …` against the session's workspace and upserts
    /// the result. On `gh` failure (no PR / auth / transport) returns the
    /// existing cached rows — historical rows are never deleted because the
    /// timeline still wants to render them.
    pub async fn refresh(&self, session_id: &str) -> ArgmaxResult<Vec<GhPrRecord>> {
        let workspace_path = {
            let conn = self.database.connection();
            let session = find_session_by_id(&conn, session_id)?;
            let workspace = find_workspace_by_id(&conn, &session.workspace_id)?;
            workspace.path
        };
        if workspace_path.is_empty() {
            return self.list_for_session(session_id);
        }

        let stdout = match (self.runner)(
            workspace_path,
            vec![
                "pr".into(),
                "view".into(),
                "--json".into(),
                "number,headRefOid,state,statusCheckRollup".into(),
            ],
        )
        .await
        {
            Ok(text) => text,
            Err(error) => {
                let category = gh_error_category(&error);
                if category == GhErrorCategory::Unknown {
                    tracing::info!(
                        session_id = %session_id,
                        error = %error,
                        "gh.refresh: gh failed with unknown error"
                    );
                } else if category != GhErrorCategory::NoPr {
                    tracing::warn!(
                        session_id = %session_id,
                        error = %error,
                        category = ?category,
                        "gh.refresh: gh failed"
                    );
                }
                return self.list_for_session(session_id);
            }
        };

        let parsed: Option<PrViewResponse> = serde_json::from_str(stdout.trim()).ok();
        let Some(parsed) = parsed else {
            return self.list_for_session(session_id);
        };
        let Some(pr_number) = parsed.number else {
            return self.list_for_session(session_id);
        };
        let Some(head_sha) = parsed.head_ref_oid.filter(|sha| !sha.is_empty()) else {
            return self.list_for_session(session_id);
        };

        let record = GhPrRecord {
            session_id: session_id.to_string(),
            pr_number,
            head_sha,
            last_seen_check_state: collapse_rollup(parsed.status_check_rollup.as_deref()).into(),
            updated_at: now_iso(),
            pr_state: normalize_pr_state(parsed.state.as_deref()),
            notified_at: None,
        };
        {
            let conn = self.database.connection();
            upsert_gh_pr(&conn, &record)?;
        }
        self.list_for_session(session_id)
    }
}

// ---------------------------------------------------------------------------
// gh JSON shapes — minimal subset we read.
// ---------------------------------------------------------------------------

#[derive(Debug, serde::Deserialize)]
struct PrViewResponse {
    #[serde(default)]
    number: Option<i64>,
    #[serde(default, rename = "headRefOid")]
    head_ref_oid: Option<String>,
    #[serde(default)]
    state: Option<String>,
    #[serde(default, rename = "statusCheckRollup")]
    status_check_rollup: Option<Vec<RollupEntry>>,
}

#[derive(Debug, serde::Deserialize)]
struct RollupEntry {
    #[serde(default)]
    state: Option<String>,
    #[serde(default)]
    status: Option<String>,
    #[serde(default)]
    conclusion: Option<String>,
}

// ---------------------------------------------------------------------------
// Error categorization — distinguishes "no PR" from "transport broke" so the
// log surface doesn't bury real failures under PR-less branches.
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum GhErrorCategory {
    Transient,
    Auth,
    RateLimit,
    NoPr,
    Unknown,
}

fn gh_error_category(error: &ArgmaxError) -> GhErrorCategory {
    let text = error.to_string().to_lowercase();
    if text.contains("no pull requests")
        || text.contains("not a git repository")
        || text.contains("no commits between")
    {
        return GhErrorCategory::NoPr;
    }
    if text.contains("authentication")
        || text.contains("unauthorized")
        || text.contains("not authenticated")
        || text.contains("token")
    {
        return GhErrorCategory::Auth;
    }
    if text.contains("rate limit") || text.contains("api rate") {
        return GhErrorCategory::RateLimit;
    }
    if text.contains("timeout") || text.contains("etimedout") || text.contains("network") {
        return GhErrorCategory::Transient;
    }
    GhErrorCategory::Unknown
}

// ---------------------------------------------------------------------------
// Status-check rollup collapse. Mirrors `collapseRollup` in ghService.ts.
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GhCheckState {
    Unknown,
    Pending,
    Success,
    Failure,
    Cancelled,
    Skipped,
}

impl From<GhCheckState> for String {
    fn from(value: GhCheckState) -> Self {
        match value {
            GhCheckState::Unknown => "unknown",
            GhCheckState::Pending => "pending",
            GhCheckState::Success => "success",
            GhCheckState::Failure => "failure",
            GhCheckState::Cancelled => "cancelled",
            GhCheckState::Skipped => "skipped",
        }
        .to_string()
    }
}

fn collapse_rollup(rollup: Option<&[RollupEntry]>) -> GhCheckState {
    let Some(entries) = rollup else {
        return GhCheckState::Unknown;
    };
    if entries.is_empty() {
        return GhCheckState::Unknown;
    }
    let mut has_pending = false;
    for entry in entries {
        let state = entry_state(entry);
        match state.as_str() {
            "failure" | "failed" | "timed_out" | "action_required" => return GhCheckState::Failure,
            "cancelled" | "cancel" => return GhCheckState::Cancelled,
            "pending" | "in_progress" | "queued" | "waiting" => has_pending = true,
            _ => {}
        }
    }
    if has_pending {
        return GhCheckState::Pending;
    }
    let all_skipped = entries.iter().all(|entry| {
        let state = entry_state(entry);
        state == "skipped" || state == "neutral"
    });
    if all_skipped {
        GhCheckState::Skipped
    } else {
        GhCheckState::Success
    }
}

fn entry_state(entry: &RollupEntry) -> String {
    entry
        .conclusion
        .clone()
        .or_else(|| entry.state.clone())
        .or_else(|| entry.status.clone())
        .unwrap_or_default()
        .to_lowercase()
}

fn normalize_pr_state(raw: Option<&str>) -> Option<String> {
    let raw = raw?;
    let upper = raw.to_uppercase();
    matches!(upper.as_str(), "OPEN" | "CLOSED" | "MERGED").then_some(upper)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::persistence::projects::{persist_project, PersistProjectInput, ProjectSettings};
    use crate::persistence::sessions::{persist_session, PersistSessionInput};
    use crate::persistence::workspaces::{persist_workspace, PersistWorkspaceInput};
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Mutex;
    use tempfile::TempDir;

    struct StubRunner {
        responses: Mutex<Vec<ArgmaxResult<String>>>,
        calls: AtomicUsize,
    }

    impl StubRunner {
        fn new(responses: Vec<ArgmaxResult<String>>) -> Arc<Self> {
            Arc::new(Self {
                responses: Mutex::new(responses),
                calls: AtomicUsize::new(0),
            })
        }

        fn runner(self: Arc<Self>) -> GhRunner {
            Arc::new(move |_cwd, _args| {
                let next = {
                    let mut responses = self.responses.lock().expect("stub responses poisoned");
                    self.calls.fetch_add(1, Ordering::SeqCst);
                    if responses.is_empty() {
                        None
                    } else {
                        Some(responses.remove(0))
                    }
                };
                Box::pin(async move {
                    next.unwrap_or_else(|| {
                        Err(ArgmaxError::service(
                            "GH_TEST_EXHAUSTED",
                            "stub runner ran out of responses",
                        ))
                    })
                })
            })
        }

        fn call_count(&self) -> usize {
            self.calls.load(Ordering::SeqCst)
        }
    }

    fn fixture(database: &Arc<Database>, repo_path: &str) -> (String, String) {
        let conn = database.connection();
        persist_project(
            &conn,
            &PersistProjectInput {
                id: "p1".to_string(),
                name: "fixture".to_string(),
                repo_path: repo_path.to_string(),
                default_branch: Some("main".to_string()),
                current_branch: "main".to_string(),
                settings: ProjectSettings {
                    default_provider: "claude".to_string(),
                    default_model_label: "Claude Haiku 4.5".to_string(),
                    worktree_location: format!("{repo_path}/.worktrees"),
                    setup_command: String::new(),
                    check_commands: Vec::new(),
                },
            },
        )
        .expect("project");
        persist_workspace(
            &conn,
            &PersistWorkspaceInput {
                id: "w1".to_string(),
                project_id: "p1".to_string(),
                task_label: "gh-test".to_string(),
                branch: "feature/x".to_string(),
                base_ref: "main".to_string(),
                path: repo_path.to_string(),
                state: "running".to_string(),
                shared_workspace: false,
                dirty: false,
                changed_files: 0,
            },
        )
        .expect("workspace");
        persist_session(
            &conn,
            &PersistSessionInput {
                id: "s1".to_string(),
                workspace_id: "w1".to_string(),
                provider: "claude".to_string(),
                model_label: "Claude Haiku 4.5".to_string(),
                model_id: "claude-haiku-4.5".to_string(),
                reasoning_effort: None,
                permission_mode: Some("auto-approve".to_string()),
                agent_mode: Some("auto".to_string()),
                prompt: "test".to_string(),
                state: "running".to_string(),
                attention: "normal".to_string(),
            },
        )
        .expect("session");
        ("s1".to_string(), "w1".to_string())
    }

    fn open_db() -> (TempDir, Arc<Database>) {
        let dir = TempDir::new().unwrap();
        let database = Arc::new(Database::open(dir.path().join("argmax.sqlite")).unwrap());
        (dir, database)
    }

    fn success_payload(pr_number: i64, head_sha: &str, rollup_state: &str) -> String {
        format!(
            r#"{{
                "number": {pr_number},
                "headRefOid": "{head_sha}",
                "state": "OPEN",
                "statusCheckRollup": [{{"conclusion": "{rollup_state}"}}]
            }}"#
        )
    }

    #[tokio::test]
    async fn list_for_session_roundtrip() {
        let (_dir, database) = open_db();
        let (session_id, _) = fixture(&database, "/tmp/argmax-gh-list");
        // Pre-seed an existing row so list_for_session has something to read.
        {
            let conn = database.connection();
            upsert_gh_pr(
                &conn,
                &GhPrRecord {
                    session_id: session_id.clone(),
                    pr_number: 42,
                    head_sha: "deadbeef".to_string(),
                    last_seen_check_state: "success".to_string(),
                    updated_at: now_iso(),
                    pr_state: Some("OPEN".to_string()),
                    notified_at: None,
                },
            )
            .expect("seed gh_pr");
        }
        let stub = StubRunner::new(Vec::new());
        let service = GhService::with_runner(Arc::clone(&database), Arc::clone(&stub).runner());
        let rows = service.list_for_session(&session_id).expect("list");
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].pr_number, 42);
        assert_eq!(rows[0].last_seen_check_state, "success");
        // Read-only — runner must not have been invoked.
        assert_eq!(stub.call_count(), 0);
    }

    #[tokio::test]
    async fn refresh_upserts_pr_row_from_gh_stdout() {
        let (_dir, database) = open_db();
        let (session_id, _) = fixture(&database, "/tmp/argmax-gh-refresh");
        let stub = StubRunner::new(vec![Ok(success_payload(7, "feedface", "success"))]);
        let service = GhService::with_runner(Arc::clone(&database), Arc::clone(&stub).runner());

        let rows = service.refresh(&session_id).await.expect("refresh");
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].pr_number, 7);
        assert_eq!(rows[0].head_sha, "feedface");
        assert_eq!(rows[0].last_seen_check_state, "success");
        assert_eq!(rows[0].pr_state.as_deref(), Some("OPEN"));
        assert_eq!(stub.call_count(), 1);

        // Subsequent gh call returns a failure rollup for a new head — same
        // pr_number, but state moves.
        let stub2 = StubRunner::new(vec![Ok(success_payload(7, "cafef00d", "failure"))]);
        let service2 = GhService::with_runner(Arc::clone(&database), Arc::clone(&stub2).runner());
        let rows = service2.refresh(&session_id).await.expect("refresh2");
        assert_eq!(rows.len(), 1, "still one row — upsert keyed on pr_number");
        assert_eq!(rows[0].head_sha, "cafef00d");
        assert_eq!(rows[0].last_seen_check_state, "failure");
    }

    #[tokio::test]
    async fn refresh_returns_cached_rows_when_gh_fails() {
        let (_dir, database) = open_db();
        let (session_id, _) = fixture(&database, "/tmp/argmax-gh-fail");
        // Seed an existing row so we can distinguish "kept the cache" from
        // "nuked the cache".
        {
            let conn = database.connection();
            upsert_gh_pr(
                &conn,
                &GhPrRecord {
                    session_id: session_id.clone(),
                    pr_number: 99,
                    head_sha: "abc123".to_string(),
                    last_seen_check_state: "pending".to_string(),
                    updated_at: now_iso(),
                    pr_state: Some("OPEN".to_string()),
                    notified_at: None,
                },
            )
            .expect("seed gh_pr");
        }

        let stub = StubRunner::new(vec![Err(ArgmaxError::service(
            "GH_NON_ZERO_EXIT",
            "no pull requests found for branch feature/x",
        ))]);
        let service = GhService::with_runner(Arc::clone(&database), Arc::clone(&stub).runner());

        let rows = service.refresh(&session_id).await.expect("returns cache");
        assert_eq!(rows.len(), 1, "row preserved on gh failure");
        assert_eq!(rows[0].pr_number, 99);
        assert_eq!(rows[0].last_seen_check_state, "pending");
        assert_eq!(stub.call_count(), 1);
    }

    #[tokio::test]
    async fn refresh_propagates_record_not_found_for_unknown_session() {
        let (_dir, database) = open_db();
        let stub = StubRunner::new(Vec::new());
        let service = GhService::with_runner(Arc::clone(&database), stub.runner());
        let err = service.refresh("missing").await.expect_err("session lookup fails");
        match err {
            ArgmaxError::RecordNotFound { kind, .. } => assert_eq!(kind, "session"),
            other => panic!("unexpected error: {other:?}"),
        }
    }

    #[test]
    fn collapse_rollup_failure_dominates() {
        let rollup = vec![
            RollupEntry {
                state: Some("PENDING".to_string()),
                status: None,
                conclusion: None,
            },
            RollupEntry {
                state: None,
                status: None,
                conclusion: Some("FAILURE".to_string()),
            },
        ];
        assert_eq!(collapse_rollup(Some(&rollup)), GhCheckState::Failure);
    }

    #[test]
    fn collapse_rollup_all_skipped_is_skipped() {
        let rollup = vec![
            RollupEntry {
                state: None,
                status: None,
                conclusion: Some("skipped".to_string()),
            },
            RollupEntry {
                state: None,
                status: None,
                conclusion: Some("neutral".to_string()),
            },
        ];
        assert_eq!(collapse_rollup(Some(&rollup)), GhCheckState::Skipped);
    }

    #[test]
    fn collapse_rollup_empty_is_unknown() {
        assert_eq!(collapse_rollup(None), GhCheckState::Unknown);
        assert_eq!(collapse_rollup(Some(&[])), GhCheckState::Unknown);
    }

    #[test]
    fn normalize_pr_state_passes_canonical_values() {
        assert_eq!(normalize_pr_state(Some("open")).as_deref(), Some("OPEN"));
        assert_eq!(normalize_pr_state(Some("MERGED")).as_deref(), Some("MERGED"));
        assert!(normalize_pr_state(Some("draft")).is_none());
        assert!(normalize_pr_state(None).is_none());
    }

    #[test]
    fn gh_error_category_buckets_known_messages() {
        let auth = ArgmaxError::service("GH_NON_ZERO_EXIT", "gh failed: not authenticated");
        assert_eq!(gh_error_category(&auth), GhErrorCategory::Auth);
        let rate = ArgmaxError::service("GH_NON_ZERO_EXIT", "gh failed: API rate limit exceeded");
        assert_eq!(gh_error_category(&rate), GhErrorCategory::RateLimit);
        let no_pr = ArgmaxError::service("GH_NON_ZERO_EXIT", "gh failed: no pull requests found");
        assert_eq!(gh_error_category(&no_pr), GhErrorCategory::NoPr);
        let unknown = ArgmaxError::service("GH_NON_ZERO_EXIT", "something completely different");
        assert_eq!(gh_error_category(&unknown), GhErrorCategory::Unknown);
    }
}
