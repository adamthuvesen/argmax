// GhPoller periodically calls
// `GhService::refresh` against every session with an open PR, watches for
// `check_state` / `head_sha` transitions, and publishes a `DashboardDelta`
// so the renderer can re-render PR status without polling itself.

use crate::util::sync::LockOrRecover;
use std::{
    collections::{HashMap, HashSet, VecDeque},
    sync::{Arc, Mutex},
    time::Duration,
};

use tauri::async_runtime::JoinHandle;

use crate::error::ArgmaxResult;
use crate::persistence::dashboard::list_running_session_ids;
use crate::persistence::database::Database;
use crate::persistence::gh::{list_open_gh_pr_session_ids, GhPrRecord};
use crate::providers::flush_queue::DashboardDelta;

use super::service::GhService;

/// Default polling interval (mirrors `GH_POLL_INTERVAL_MS = 60_000`).
pub const DEFAULT_POLL_INTERVAL: Duration = Duration::from_secs(60);

/// Bound on concurrent `gh pr view` calls per tick. Without it, a single
/// slow `gh` (15s default timeout) holds the re-entrancy guard for 15s × N
/// sessions — far past the 60s tick.
const TICK_CONCURRENCY: usize = 4;

/// Capacity of the in-memory transition ledger. 500 keys covers thousands
/// of PR/commit pairs before the oldest entry rotates out.
const TRANSITION_LEDGER_CAPACITY: usize = 500;

/// Sink for dashboard deltas the poller emits when PR state changes.
pub type DeltaPublisher = Arc<dyn Fn(DashboardDelta) + Send + Sync>;

/// Optional hook fired after a PR's check state transitions to `failure`
/// for a head_sha we haven't surfaced before. The TS version uses this to
/// launch a follow-up session; the Rust port leaves the implementation to
/// the caller.
pub type CheckFailureHook = Arc<dyn Fn(CheckFailureContext) + Send + Sync>;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CheckFailureContext {
    pub session_id: String,
    pub workspace_id: String,
    pub pr_number: i64,
    pub head_sha: String,
}

/// Dependencies for `GhPoller`. Everything except `database` and `service`
/// is optional so tests can wire one piece at a time.
pub struct GhPollerConfig {
    pub database: Arc<Database>,
    pub service: Arc<GhService>,
    pub interval: Duration,
    pub publish_delta: Option<DeltaPublisher>,
    pub on_check_failure: Option<CheckFailureHook>,
}

impl GhPollerConfig {
    pub fn new(database: Arc<Database>, service: Arc<GhService>) -> Self {
        Self {
            database,
            service,
            interval: DEFAULT_POLL_INTERVAL,
            publish_delta: None,
            on_check_failure: None,
        }
    }

    pub fn with_interval(mut self, interval: Duration) -> Self {
        self.interval = interval;
        self
    }

    pub fn with_delta_publisher(mut self, publisher: DeltaPublisher) -> Self {
        self.publish_delta = Some(publisher);
        self
    }

    pub fn with_check_failure_hook(mut self, hook: CheckFailureHook) -> Self {
        self.on_check_failure = Some(hook);
        self
    }
}

/// Owned per-session state the poller carries across ticks.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
struct PrState {
    head_sha: String,
    check_state: String,
}

struct PollerInner {
    database: Arc<Database>,
    service: Arc<GhService>,
    publish_delta: Option<DeltaPublisher>,
    on_check_failure: Option<CheckFailureHook>,
    /// Last-seen `(head_sha, check_state)` per `(session_id, pr_number)` so a
    /// repeated tick on the same state is a no-op.
    last_state: Mutex<HashMap<(String, i64), PrState>>,
    /// Insertion-ordered ledger of failure events we've already fired, keyed
    /// `session:pr:head_sha`. Bounded so a long-running app doesn't grow it.
    failure_ledger: Mutex<VecDeque<String>>,
}

impl PollerInner {
    fn ledger_has(&self, key: &str) -> bool {
        let ledger = self.failure_ledger.lock_or_recover("ledger");
        ledger.iter().any(|entry| entry == key)
    }

    fn ledger_add(&self, key: String) {
        let mut ledger = self.failure_ledger.lock_or_recover("ledger");
        if ledger.iter().any(|entry| entry == &key) {
            return;
        }
        ledger.push_back(key);
        while ledger.len() > TRANSITION_LEDGER_CAPACITY {
            ledger.pop_front();
        }
    }
}

/// Background poller. `start` spawns the tick loop into a `JoinSet`; `Drop`
/// aborts it, mirroring `Database`'s prune sweeper.
pub struct GhPoller {
    inner: Arc<PollerInner>,
    interval: Duration,
    tasks: Mutex<Vec<JoinHandle<()>>>,
}

impl GhPoller {
    pub fn new(config: GhPollerConfig) -> Arc<Self> {
        Arc::new(Self {
            inner: Arc::new(PollerInner {
                database: config.database,
                service: config.service,
                publish_delta: config.publish_delta,
                on_check_failure: config.on_check_failure,
                last_state: Mutex::new(HashMap::new()),
                failure_ledger: Mutex::new(VecDeque::new()),
            }),
            interval: config.interval,
            tasks: Mutex::new(Vec::new()),
        })
    }

    /// Spawns the polling loop. Safe to call multiple times — extra calls
    /// are no-ops once a task is running.
    pub fn start(self: &Arc<Self>) {
        let mut tasks = self.tasks.lock_or_recover("poller tasks");
        if !tasks.is_empty() {
            return;
        }
        let interval = self.interval;
        let inner = Arc::clone(&self.inner);
        let handle = tauri::async_runtime::spawn(async move {
            let mut ticker = tokio::time::interval(interval);
            // Skip the immediate tick the first interval fires — match TS
            // setInterval semantics where the first tick is one interval out.
            ticker.tick().await;
            loop {
                ticker.tick().await;
                if let Err(error) = tick_once(Arc::clone(&inner)).await {
                    tracing::warn!(error = %error, "gh.poller: tick failed");
                }
            }
        });
        tasks.push(handle);
    }

    /// Runs one polling cycle synchronously. Exposed for tests so we don't
    /// need to wait on `tokio::time` to fire.
    pub async fn tick_for_test(&self) -> ArgmaxResult<()> {
        tick_once(Arc::clone(&self.inner)).await
    }

    pub fn dispose(&self) {
        let mut tasks = self.tasks.lock_or_recover("poller tasks");
        for task in tasks.drain(..) {
            task.abort();
        }
    }
}

impl Drop for GhPoller {
    fn drop(&mut self) {
        self.dispose();
    }
}

async fn tick_once(inner: Arc<PollerInner>) -> ArgmaxResult<()> {
    let session_ids = pollable_session_ids(&inner.database)?;
    if session_ids.is_empty() {
        return Ok(());
    }

    // Bounded-concurrency fanout — one stuck `gh` no longer holds the
    // remaining sessions hostage.
    let mut transitions: Vec<Transition> = Vec::new();
    for chunk in session_ids.chunks(TICK_CONCURRENCY) {
        let mut join_set = tokio::task::JoinSet::new();
        for session_id in chunk.iter().cloned() {
            let inner = Arc::clone(&inner);
            join_set.spawn(async move {
                let result = inner.service.refresh(&session_id).await;
                (session_id, result)
            });
        }
        let mut results: Vec<(String, ArgmaxResult<Vec<GhPrRecord>>)> = Vec::new();
        while let Some(join_result) = join_set.join_next().await {
            match join_result {
                Ok(pair) => results.push(pair),
                Err(error) => tracing::warn!(error = %error, "gh.poller: refresh task panicked"),
            }
        }
        for (session_id, refresh_result) in results {
            let rows = match refresh_result {
                Ok(rows) => rows,
                Err(error) => {
                    tracing::debug!(
                        session_id = %session_id,
                        error = %error,
                        "gh.poller: refresh failed; skipping",
                    );
                    continue;
                }
            };
            // Latest PR is at the tail (sorted ASC by pr_number).
            let Some(latest) = rows.last() else { continue };
            if let Some(transition) = detect_transition(&inner, &session_id, latest) {
                transitions.push(transition);
            }
        }
    }

    if transitions.is_empty() {
        return Ok(());
    }

    // Publish one delta per tick — re-renders pull the fresh PR rows from
    // SQLite via the existing dashboard readers.
    if let Some(publisher) = inner.publish_delta.as_ref() {
        (publisher)(DashboardDelta::default());
    }

    for transition in transitions {
        if transition.is_failure {
            if let Some(hook) = inner.on_check_failure.as_ref() {
                (hook)(transition.context.clone());
            }
        }
    }

    Ok(())
}

/// Union of `running` sessions + sessions with an OPEN gh_pr row, dedup'd.
fn pollable_session_ids(database: &Arc<Database>) -> ArgmaxResult<Vec<String>> {
    let conn = database.connection();
    let mut ids: HashSet<String> = list_running_session_ids(&conn)?.into_iter().collect();
    for id in list_open_gh_pr_session_ids(&conn)? {
        ids.insert(id);
    }
    Ok(ids.into_iter().collect())
}

#[derive(Debug, Clone)]
struct Transition {
    is_failure: bool,
    context: CheckFailureContext,
}

fn detect_transition(
    inner: &Arc<PollerInner>,
    session_id: &str,
    latest: &GhPrRecord,
) -> Option<Transition> {
    let key = (session_id.to_string(), latest.pr_number);
    let next = PrState {
        head_sha: latest.head_sha.clone(),
        check_state: latest.last_seen_check_state.clone(),
    };

    let changed = {
        let mut state = inner.last_state.lock_or_recover("last_state");
        match state.get(&key) {
            Some(prior) if prior == &next => false,
            _ => {
                state.insert(key, next.clone());
                true
            }
        }
    };

    if !changed {
        return None;
    }

    let mut transition = Transition {
        is_failure: false,
        context: CheckFailureContext {
            session_id: session_id.to_string(),
            workspace_id: String::new(),
            pr_number: latest.pr_number,
            head_sha: latest.head_sha.clone(),
        },
    };

    if next.check_state == "failure" {
        let ledger_key = format!("{}:{}:{}", session_id, latest.pr_number, latest.head_sha);
        if !inner.ledger_has(&ledger_key) && latest.notified_at.is_none() {
            // Resolve workspace_id at fire time so the hook gets the live value
            // rather than whatever was on disk at startup. Only record the
            // ledger entry once resolution succeeds — otherwise a transient
            // lookup failure would dedupe the failure forever and the hook
            // would never fire on a later tick.
            match resolve_workspace_id(&inner.database, session_id) {
                Ok(workspace_id) => {
                    inner.ledger_add(ledger_key);
                    transition.context.workspace_id = workspace_id;
                    transition.is_failure = true;
                }
                Err(error) => {
                    tracing::warn!(
                        %session_id,
                        ?error,
                        "gh poller: could not resolve workspace for failed check; will retry next tick"
                    );
                }
            }
        }
    }

    Some(transition)
}

fn resolve_workspace_id(database: &Arc<Database>, session_id: &str) -> ArgmaxResult<String> {
    let conn = database.connection();
    let session = crate::persistence::sessions::find_session_by_id(&conn, session_id)?;
    Ok(session.workspace_id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::ArgmaxError;
    use crate::persistence::gh::upsert_gh_pr;
    use crate::persistence::projects::{persist_project, PersistProjectInput, ProjectSettings};
    use crate::persistence::sessions::{persist_session, PersistSessionInput};
    use crate::persistence::time::now_iso;
    use crate::persistence::workspaces::{persist_workspace, PersistWorkspaceInput};
    use crate::util::gh_runner::GhRunner;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Mutex;
    use tempfile::TempDir;

    struct StubRunner {
        responses: Mutex<Vec<ArgmaxResult<String>>>,
    }

    impl StubRunner {
        fn new(responses: Vec<ArgmaxResult<String>>) -> Arc<Self> {
            Arc::new(Self {
                responses: Mutex::new(responses),
            })
        }

        fn runner(self: Arc<Self>) -> GhRunner {
            Arc::new(move |_cwd, _args| {
                let next = {
                    let mut responses = self.responses.lock().expect("stub responses poisoned");
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
    }

    fn open_db() -> (TempDir, Arc<Database>) {
        let dir = TempDir::new().unwrap();
        let database = Arc::new(Database::open(dir.path().join("argmax.sqlite")).unwrap());
        (dir, database)
    }

    fn fixture(database: &Arc<Database>) {
        let conn = database.connection();
        persist_project(
            &conn,
            &PersistProjectInput {
                id: "p1".to_string(),
                name: "fixture".to_string(),
                repo_path: "/tmp/argmax-gh-poller".to_string(),
                default_branch: Some("main".to_string()),
                current_branch: "main".to_string(),
                settings: ProjectSettings {
                    default_provider: "claude".to_string(),
                    default_model_label: "Haiku 4.5".to_string(),
                    worktree_location: "/tmp/argmax-gh-poller/.worktrees".to_string(),
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
                task_label: "gh-poll".to_string(),
                branch: "feature/x".to_string(),
                base_ref: "main".to_string(),
                path: "/tmp/argmax-gh-poller".to_string(),
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
                model_label: "Haiku 4.5".to_string(),
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
    }

    #[tokio::test]
    async fn poller_publishes_delta_on_state_change() {
        let (_dir, database) = open_db();
        fixture(&database);
        // Seed a row in pending state so the first tick has a baseline.
        {
            let conn = database.connection();
            upsert_gh_pr(
                &conn,
                &GhPrRecord {
                    session_id: "s1".to_string(),
                    pr_number: 42,
                    head_sha: "feedface".to_string(),
                    last_seen_check_state: "pending".to_string(),
                    updated_at: now_iso(),
                    pr_state: Some("OPEN".to_string()),
                    notified_at: None,
                },
            )
            .expect("seed gh_pr");
        }
        // First gh call: state stays "pending" (no change vs the seed in DB,
        // but the poller's in-memory ledger is empty so this counts as the
        // initial recording — emits a delta).
        let pending_payload = r#"{"number": 42, "headRefOid": "feedface", "state": "OPEN", "statusCheckRollup": [{"conclusion": "pending"}]}"#;
        let failure_payload = r#"{"number": 42, "headRefOid": "feedface", "state": "OPEN", "statusCheckRollup": [{"conclusion": "failure"}]}"#;
        let stub = StubRunner::new(vec![
            Ok(pending_payload.to_string()),
            Ok(pending_payload.to_string()),
            Ok(failure_payload.to_string()),
        ]);
        let service = GhService::with_runner(Arc::clone(&database), Arc::clone(&stub).runner());

        let publish_count = Arc::new(AtomicUsize::new(0));
        let publisher_count = Arc::clone(&publish_count);
        let publisher: DeltaPublisher = Arc::new(move |_delta: DashboardDelta| {
            publisher_count.fetch_add(1, Ordering::SeqCst);
        });

        let failure_hits = Arc::new(AtomicUsize::new(0));
        let failure_count = Arc::clone(&failure_hits);
        let hook: CheckFailureHook = Arc::new(move |ctx: CheckFailureContext| {
            assert_eq!(ctx.session_id, "s1");
            assert_eq!(ctx.workspace_id, "w1");
            assert_eq!(ctx.pr_number, 42);
            assert_eq!(ctx.head_sha, "feedface");
            failure_count.fetch_add(1, Ordering::SeqCst);
        });

        let poller = GhPoller::new(
            GhPollerConfig::new(Arc::clone(&database), service)
                .with_interval(Duration::from_millis(50))
                .with_delta_publisher(publisher)
                .with_check_failure_hook(hook),
        );

        // Tick 1 — first observation: state recorded, delta published.
        poller.tick_for_test().await.expect("tick 1");
        assert_eq!(publish_count.load(Ordering::SeqCst), 1);
        assert_eq!(failure_hits.load(Ordering::SeqCst), 0);

        // Tick 2 — identical payload, no transition, no delta.
        poller.tick_for_test().await.expect("tick 2");
        assert_eq!(publish_count.load(Ordering::SeqCst), 1);
        assert_eq!(failure_hits.load(Ordering::SeqCst), 0);

        // Tick 3 — transitions to failure: delta + hook fires.
        poller.tick_for_test().await.expect("tick 3");
        assert_eq!(publish_count.load(Ordering::SeqCst), 2);
        assert_eq!(failure_hits.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn poller_dedup_ledger_suppresses_repeat_failure_hook() {
        let (_dir, database) = open_db();
        fixture(&database);
        let failure_payload = r#"{"number": 42, "headRefOid": "feedface", "state": "OPEN", "statusCheckRollup": [{"conclusion": "failure"}]}"#;
        let success_then_failure_payload = r#"{"number": 42, "headRefOid": "feedface", "state": "OPEN", "statusCheckRollup": [{"conclusion": "success"}]}"#;
        let stub = StubRunner::new(vec![
            Ok(failure_payload.to_string()),
            Ok(success_then_failure_payload.to_string()),
            Ok(failure_payload.to_string()),
        ]);
        let service = GhService::with_runner(Arc::clone(&database), Arc::clone(&stub).runner());

        let failure_hits = Arc::new(AtomicUsize::new(0));
        let failure_count = Arc::clone(&failure_hits);
        let hook: CheckFailureHook = Arc::new(move |_| {
            failure_count.fetch_add(1, Ordering::SeqCst);
        });

        let poller = GhPoller::new(
            GhPollerConfig::new(Arc::clone(&database), service).with_check_failure_hook(hook),
        );

        poller.tick_for_test().await.expect("first failure");
        assert_eq!(failure_hits.load(Ordering::SeqCst), 1);

        // Transient flip to success and back — same head_sha, so the ledger
        // suppresses the second failure hook.
        poller.tick_for_test().await.expect("flip to success");
        poller.tick_for_test().await.expect("flip back to failure");
        assert_eq!(
            failure_hits.load(Ordering::SeqCst),
            1,
            "failure hook must not refire for the same head_sha"
        );
    }

    #[tokio::test]
    async fn poller_skips_when_no_sessions_to_poll() {
        let (_dir, database) = open_db();
        // No fixture — DB is empty.
        let stub = StubRunner::new(Vec::new());
        let service = GhService::with_runner(Arc::clone(&database), stub.runner());
        let publish_count = Arc::new(AtomicUsize::new(0));
        let publisher_count = Arc::clone(&publish_count);
        let publisher: DeltaPublisher = Arc::new(move |_delta| {
            publisher_count.fetch_add(1, Ordering::SeqCst);
        });
        let poller = GhPoller::new(
            GhPollerConfig::new(Arc::clone(&database), service).with_delta_publisher(publisher),
        );
        poller.tick_for_test().await.expect("tick with no sessions");
        assert_eq!(publish_count.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn drop_aborts_polling_task() {
        let (_dir, database) = open_db();
        let stub = StubRunner::new(Vec::new());
        let service = GhService::with_runner(Arc::clone(&database), stub.runner());
        let poller = GhPoller::new(
            GhPollerConfig::new(Arc::clone(&database), service)
                .with_interval(Duration::from_millis(10)),
        );
        poller.start();
        assert_eq!(
            poller.tasks.lock().expect("tasks").len(),
            1,
            "polling task spawned"
        );
        poller.dispose();
        assert_eq!(
            poller.tasks.lock().expect("tasks").len(),
            0,
            "dispose aborts the task"
        );
    }
}
