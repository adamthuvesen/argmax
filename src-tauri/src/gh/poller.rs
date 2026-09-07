// GhPoller periodically calls
// `GhService::refresh` against running sessions, recently completed sessions,
// and sessions with an open PR. It watches for `check_state` / `head_sha`
// and milestone transitions and publishes a `DashboardDelta` so the renderer
// can re-render PR status without polling itself.

use crate::util::sync::LockOrRecover;
use std::{
    collections::{HashMap, HashSet, VecDeque},
    sync::{Arc, Mutex},
    time::Duration,
};

use tauri::async_runtime::JoinHandle;

use crate::error::ArgmaxResult;
use crate::persistence::dashboard::{
    list_recently_completed_session_ids, list_running_session_ids,
};
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

/// How long after a session completes we still `gh pr view` its branch. Covers
/// the agent that opened a PR and finished before the next 60s tick.
const RECENTLY_COMPLETED_POLL_WINDOW: Duration = Duration::from_secs(120);

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

/// Optional hook fired once per workspace when the PR on its branch reaches
/// `MERGED`, and only for projects with `archive_on_merge` on. The caller
/// archives the workspace; the poller owns the deduplication.
pub type MergedPrHook = Arc<dyn Fn(MergedPrContext) + Send + Sync>;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MergedPrContext {
    pub workspace_id: String,
    pub pr_number: i64,
}

/// Dependencies for `GhPoller`. Everything except `database` and `service`
/// is optional so tests can wire one piece at a time.
pub struct GhPollerConfig {
    pub database: Arc<Database>,
    pub service: Arc<GhService>,
    pub interval: Duration,
    pub publish_delta: Option<DeltaPublisher>,
    pub on_check_failure: Option<CheckFailureHook>,
    pub on_pr_merged: Option<MergedPrHook>,
}

impl GhPollerConfig {
    pub fn new(database: Arc<Database>, service: Arc<GhService>) -> Self {
        Self {
            database,
            service,
            interval: DEFAULT_POLL_INTERVAL,
            publish_delta: None,
            on_check_failure: None,
            on_pr_merged: None,
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

    pub fn with_pr_merged_hook(mut self, hook: MergedPrHook) -> Self {
        self.on_pr_merged = Some(hook);
        self
    }
}

/// Owned per-session state the poller carries across ticks.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
struct PrState {
    head_sha: String,
    check_state: String,
    pr_state: Option<String>,
    pr_created_at: Option<String>,
    pr_merged_at: Option<String>,
}

struct PollerInner {
    database: Arc<Database>,
    service: Arc<GhService>,
    publish_delta: Option<DeltaPublisher>,
    on_check_failure: Option<CheckFailureHook>,
    on_pr_merged: Option<MergedPrHook>,
    /// Last-seen PR state per `(session_id, pr_number)` so a repeated tick is
    /// a no-op while recovered milestone timestamps still publish.
    last_state: Mutex<HashMap<(String, i64), PrState>>,
    /// Insertion-ordered ledger of the hooks we've already fired: check
    /// failures keyed `workspace:pr:head_sha`, merges keyed
    /// `merged:workspace:pr`. Bounded so a long-running app doesn't grow it.
    fired_ledger: Mutex<VecDeque<String>>,
}

impl PollerInner {
    fn ledger_has(&self, key: &str) -> bool {
        let ledger = self.fired_ledger.lock_or_recover("ledger");
        ledger.iter().any(|entry| entry == key)
    }

    fn ledger_add(&self, key: String) {
        let mut ledger = self.fired_ledger.lock_or_recover("ledger");
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
                on_pr_merged: config.on_pr_merged,
                last_state: Mutex::new(HashMap::new()),
                fired_ledger: Mutex::new(VecDeque::new()),
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
    let mut refreshed_sessions = Vec::new();
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
            match refresh_result {
                Ok(_) => refreshed_sessions.push(session_id),
                Err(error) => {
                    tracing::debug!(
                        session_id = %session_id,
                        error = %error,
                        "gh.poller: refresh failed; skipping",
                    );
                    continue;
                }
            }
        }
    }

    // A later refresh can synchronize an earlier session's rows. Read after
    // the full fanout so hooks never act on a superseded OPEN response.
    let mut transitions: Vec<Transition> = Vec::new();
    for session_id in refreshed_sessions {
        let rows = inner.service.list_for_session(&session_id)?;
        let Some(latest) = pr_for_workspace_transition(&inner.database, &session_id, &rows)? else {
            continue;
        };
        if let Some(transition) = detect_transition(&inner, &session_id, &latest) {
            transitions.push(transition);
        }
    }

    if transitions.is_empty() {
        return Ok(());
    }

    // Publish one delta per tick carrying the refreshed workspace rows. An
    // empty delta would merge into an identical snapshot and never re-render,
    // so the rows have to ride along — `find_workspace_by_id` re-attaches the
    // latest `pr_state` / `pr_number`.
    if let Some(publisher) = inner.publish_delta.as_ref() {
        let mut seen: HashSet<String> = HashSet::new();
        let mut workspaces = Vec::new();
        {
            let conn = inner.database.connection();
            for transition in transitions.iter().filter(|entry| entry.publish) {
                let affected = match crate::gh::workspaces_for_pr_refresh(
                    &conn,
                    &transition.context.session_id,
                ) {
                    Ok(workspaces) => workspaces,
                    Err(error) => {
                        tracing::warn!(
                            session_id = %transition.context.session_id,
                            ?error,
                            "gh.poller: could not resolve workspace for PR transition",
                        );
                        continue;
                    }
                };
                for workspace in affected {
                    if seen.insert(workspace.id.clone()) {
                        workspaces.push(workspace);
                    }
                }
            }
        }
        if !workspaces.is_empty() {
            (publisher)(DashboardDelta {
                workspaces,
                ..Default::default()
            });
        }
    }

    for transition in transitions {
        if transition.is_failure {
            if let Some(hook) = inner.on_check_failure.as_ref() {
                (hook)(transition.context.clone());
            }
        }
        if let Some(merged) = transition.merged {
            if let Some(hook) = inner.on_pr_merged.as_ref() {
                (hook)(merged);
            }
        }
    }

    Ok(())
}

/// Union of `running` sessions, recently completed sessions, and sessions with
/// an OPEN gh_pr row, dedup'd.
fn pollable_session_ids(database: &Arc<Database>) -> ArgmaxResult<Vec<String>> {
    let conn = database.connection();
    let mut ids: HashSet<String> = list_running_session_ids(&conn)?.into_iter().collect();
    for id in list_open_gh_pr_session_ids(&conn)? {
        ids.insert(id);
    }
    let since = chrono::Utc::now()
        .checked_sub_signed(chrono::Duration::seconds(
            RECENTLY_COMPLETED_POLL_WINDOW.as_secs() as i64,
        ))
        .unwrap_or_else(chrono::Utc::now)
        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    for id in list_recently_completed_session_ids(&conn, &since)? {
        ids.insert(id);
    }
    Ok(ids.into_iter().collect())
}

#[derive(Debug, Clone)]
struct Transition {
    /// The renderer's view of this PR changed. Independent of `is_failure`: a
    /// failure whose launch is deferred re-reads the same state every tick and
    /// must not re-publish it.
    publish: bool,
    is_failure: bool,
    /// Set once per workspace when its PR merges and the project archives on
    /// merge. Independent of `publish` for the same reason as `is_failure`.
    merged: Option<MergedPrContext>,
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
        pr_state: latest.pr_state.clone(),
        pr_created_at: latest.pr_created_at.clone(),
        pr_merged_at: latest.pr_merged_at.clone(),
    };

    let changed = {
        let mut state = inner.last_state.lock_or_recover("last_state");
        // Bounded like `failure_ledger`: entries for archived workspaces and
        // closed PRs are never removed individually, so a long-running app
        // would grow this forever. Past the cap the whole map is dropped —
        // an empty entry only costs one redundant delta on the next tick.
        if state.len() > TRANSITION_LEDGER_CAPACITY {
            state.clear();
        }
        match state.get(&key) {
            Some(prior) if prior == &next => false,
            _ => {
                state.insert(key, next.clone());
                true
            }
        }
    };

    // A still-failing PR — and a PR that stays merged — is re-evaluated on
    // every tick, not only on the tick its state changed: the work below can
    // decline for reasons that clear on their own (a running turn, a workspace
    // lookup that failed), and a state that stays put never produces a second
    // change to hang a retry on.
    let is_merged = next.pr_state.as_deref() == Some("MERGED");
    if !changed && next.check_state != "failure" && !is_merged {
        return None;
    }

    let mut transition = Transition {
        publish: changed,
        is_failure: false,
        merged: None,
        context: CheckFailureContext {
            session_id: session_id.to_string(),
            workspace_id: String::new(),
            pr_number: latest.pr_number,
            head_sha: latest.head_sha.clone(),
        },
    };

    if next.check_state == "failure" {
        // Resolve workspace_id at fire time so the hook gets the live value
        // rather than whatever was on disk at startup. Only record the
        // ledger entry once resolution succeeds — otherwise a transient
        // lookup failure would dedupe the failure forever and the hook
        // would never fire on a later tick.
        match resolve_workspace_id_for_pr_action(&inner.database, session_id, latest) {
            Ok(Some(workspace_id)) => {
                // Keyed by workspace, not session: every session in a checkout
                // sees the same branch's PR, and the follow-up we launch joins
                // them. A per-session key fires once per observer and doubles
                // the observers each tick.
                let ledger_key =
                    format!("{}:{}:{}", workspace_id, latest.pr_number, latest.head_sha);
                if !inner.ledger_has(&ledger_key)
                    && !already_launched(inner, &workspace_id, latest)
                    && !workspace_is_busy(inner, &workspace_id)
                {
                    inner.ledger_add(ledger_key);
                    transition.context.workspace_id = workspace_id;
                    transition.is_failure = true;
                }
            }
            Ok(None) => {}
            Err(error) => {
                tracing::warn!(
                    %session_id,
                    ?error,
                    "gh poller: could not resolve workspace for failed check; will retry next tick"
                );
            }
        }
    }

    // A merged PR is the end of the workspace's job: for projects that opted
    // in, the worktree and its local branch go away with it.
    if is_merged && inner.on_pr_merged.is_some() {
        match resolve_workspace_id_for_pr_action(&inner.database, session_id, latest) {
            Ok(Some(workspace_id)) => {
                // Keyed by workspace and PR, not by session or head_sha: every
                // session in the checkout sees the same merge, and a merged PR
                // keeps reporting the same commit on every later tick.
                let ledger_key = format!("merged:{}:{}", workspace_id, latest.pr_number);
                if !inner.ledger_has(&ledger_key) && archives_on_merge(inner, &workspace_id) {
                    if workspace_is_busy(inner, &workspace_id) {
                        // Deferred, not dropped, exactly like the check-failure
                        // follow-up: archiving cancels the running agent's
                        // processes and removes the tree it is editing.
                        tracing::info!(
                            %workspace_id,
                            pr_number = latest.pr_number,
                            "gh poller: PR merged but a turn is still running; archive deferred"
                        );
                    } else {
                        inner.ledger_add(ledger_key);
                        transition.merged = Some(MergedPrContext {
                            workspace_id,
                            pr_number: latest.pr_number,
                        });
                    }
                }
            }
            Ok(None) => {}
            Err(error) => {
                tracing::warn!(
                    %session_id,
                    ?error,
                    "gh poller: could not resolve workspace for merged PR; will retry next tick"
                );
            }
        }
    }

    if !transition.publish && !transition.is_failure && transition.merged.is_none() {
        return None;
    }
    Some(transition)
}

/// Only projects that opted in archive a workspace when its PR merges. A
/// lookup error means we don't know, and archiving the wrong checkout is the
/// expensive mistake, so treat it as opted out and retry next tick.
fn archives_on_merge(inner: &Arc<PollerInner>, workspace_id: &str) -> bool {
    let conn = inner.database.connection();
    crate::persistence::projects::workspace_project_archives_on_merge(&conn, workspace_id)
        .unwrap_or_else(|error| {
            tracing::warn!(%workspace_id, ?error, "gh poller: archive-on-merge lookup failed");
            false
        })
}

/// Persisted twin of the in-memory ledger, so a restart mid-failure does not
/// launch the follow-up a second time. A lookup error is treated as
/// "already launched": the poller retries every 60s, and a duplicate agent in
/// a live checkout costs more than a missed follow-up.
fn already_launched(inner: &Arc<PollerInner>, workspace_id: &str, latest: &GhPrRecord) -> bool {
    let conn = inner.database.connection();
    crate::persistence::gh::check_failure_launched_in_workspace(
        &conn,
        workspace_id,
        latest.pr_number,
        &latest.head_sha,
    )
    .unwrap_or_else(|error| {
        tracing::warn!(%workspace_id, ?error, "gh poller: check-failure launch guard failed");
        true
    })
}

/// A turn is still live in the checkout. Skip *without* recording the ledger:
/// the follow-up is still wanted, just not next to a running agent, so the
/// next tick after that turn settles fires it.
fn workspace_is_busy(inner: &Arc<PollerInner>, workspace_id: &str) -> bool {
    let conn = inner.database.connection();
    crate::persistence::sessions::workspace_has_running_session(&conn, workspace_id).unwrap_or_else(
        |error| {
            tracing::warn!(%workspace_id, ?error, "gh poller: running-session guard failed");
            true
        },
    )
}

/// Isolated workspaces only act on the PR selected for their owned branch.
/// A session can retain explicit references to other PRs as history, but
/// those rows must not launch an agent or archive the session's worktree.
/// Shared checkouts keep their session-scoped behavior.
fn resolve_workspace_id_for_pr_action(
    database: &Arc<Database>,
    session_id: &str,
    latest: &GhPrRecord,
) -> ArgmaxResult<Option<String>> {
    let conn = database.connection();
    let session = crate::persistence::sessions::find_session_by_id(&conn, session_id)?;
    let workspace =
        crate::persistence::workspaces::find_workspace_by_id(&conn, &session.workspace_id)?;
    if workspace.shared_workspace || workspace.pr_number == Some(latest.pr_number) {
        Ok(Some(workspace.id))
    } else {
        Ok(None)
    }
}

/// Shared checkouts keep the prior session-scoped choice of the highest PR
/// number. Isolated workspaces follow the PR selected for their owned branch,
/// even when the session also retains a higher-numbered explicit reference.
fn pr_for_workspace_transition(
    database: &Arc<Database>,
    session_id: &str,
    rows: &[GhPrRecord],
) -> ArgmaxResult<Option<GhPrRecord>> {
    let conn = database.connection();
    let session = crate::persistence::sessions::find_session_by_id(&conn, session_id)?;
    let workspace =
        crate::persistence::workspaces::find_workspace_by_id(&conn, &session.workspace_id)?;
    if workspace.shared_workspace {
        return Ok(rows.last().cloned());
    }
    Ok(workspace
        .pr_number
        .and_then(|pr_number| rows.iter().find(|row| row.pr_number == pr_number).cloned())
        .or_else(|| rows.last().cloned()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::ArgmaxError;
    use crate::persistence::gh::{record_gh_pr_observation, upsert_gh_pr, PrAttribution};
    use crate::persistence::projects::{persist_project, PersistProjectInput, ProjectSettings};
    use crate::persistence::sessions::{persist_session, PersistSessionInput};
    use crate::persistence::time::now_iso;
    use crate::persistence::workspaces::{persist_workspace, PersistWorkspaceInput};
    use crate::sessions::state::SessionState;
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
                    archive_on_merge: false,
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
                kind: "git".to_string(),
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
                state: SessionState::Running,
            },
        )
        .expect("session");
    }

    /// The check-failure follow-up waits for the checkout to be free, so a
    /// test that expects it to fire has to settle the fixture's turn first.
    fn settle_session(database: &Arc<Database>, session_id: &str) {
        let conn = database.connection();
        conn.execute(
            "UPDATE sessions SET state = 'complete', completed_at = ? WHERE id = ?",
            (now_iso(), session_id),
        )
        .expect("settle session");
    }

    /// Archiving on merge is opt-in per project; the fixture starts opted out.
    fn enable_archive_on_merge(database: &Arc<Database>) {
        let conn = database.connection();
        conn.execute(
            "UPDATE projects SET archive_on_merge = 1 WHERE id = 'p1'",
            [],
        )
        .expect("enable archive on merge");
    }

    fn record_explicit_pr(
        database: &Arc<Database>,
        pr_number: i64,
        pr_state: &str,
        check_state: &str,
        head_ref_name: &str,
    ) -> GhPrRecord {
        let record = GhPrRecord {
            session_id: "s1".to_string(),
            pr_number,
            head_sha: "feedface".to_string(),
            last_seen_check_state: check_state.to_string(),
            updated_at: now_iso(),
            pr_state: Some(pr_state.to_string()),
            notified_at: None,
            pr_created_at: Some("2026-09-07T10:00:00Z".to_string()),
            pr_merged_at: (pr_state == "MERGED").then(|| "2026-09-07T11:00:00Z".to_string()),
            head_ref_name: Some(head_ref_name.to_string()),
        };
        let conn = database.connection();
        record_gh_pr_observation(&conn, &record, PrAttribution::Explicit)
            .expect("record explicit PR")
            .expect("associate explicit PR");
        record
    }

    #[test]
    fn isolated_workspace_actions_follow_the_selected_branch_pr() {
        let (_dir, database) = open_db();
        fixture(&database);
        settle_session(&database, "s1");
        enable_archive_on_merge(&database);
        let stub = StubRunner::new(Vec::new());
        let service = GhService::with_runner(Arc::clone(&database), stub.runner());
        let merge_hook: MergedPrHook = Arc::new(|_| {});
        let poller = GhPoller::new(
            GhPollerConfig::new(Arc::clone(&database), service).with_pr_merged_hook(merge_hook),
        );

        record_explicit_pr(&database, 200, "OPEN", "failure", "feature/other");
        let rows = poller.inner.service.list_for_session("s1").unwrap();
        let fallback = pr_for_workspace_transition(&database, "s1", &rows)
            .unwrap()
            .unwrap();
        let fallback_transition = detect_transition(&poller.inner, "s1", &fallback).unwrap();
        assert!(fallback_transition.publish);
        assert!(!fallback_transition.is_failure);

        let matching_failure = record_explicit_pr(&database, 100, "OPEN", "failure", "feature/x");
        let rows = poller.inner.service.list_for_session("s1").unwrap();
        let selected = pr_for_workspace_transition(&database, "s1", &rows)
            .unwrap()
            .unwrap();
        assert_eq!(selected.pr_number, 100);
        assert!(
            detect_transition(&poller.inner, "s1", &matching_failure)
                .unwrap()
                .is_failure
        );

        let matching_merge = record_explicit_pr(&database, 100, "MERGED", "success", "feature/x");
        let off_branch_merge =
            record_explicit_pr(&database, 200, "MERGED", "success", "feature/other");
        assert!(detect_transition(&poller.inner, "s1", &off_branch_merge)
            .unwrap()
            .merged
            .is_none());
        assert_eq!(
            detect_transition(&poller.inner, "s1", &matching_merge)
                .unwrap()
                .merged,
            Some(MergedPrContext {
                workspace_id: "w1".to_string(),
                pr_number: 100,
            })
        );

        let conn = database.connection();
        conn.execute(
            "UPDATE workspaces SET shared_workspace = 1 WHERE id = 'w1'",
            [],
        )
        .expect("share workspace");
        drop(conn);
        let rows = poller.inner.service.list_for_session("s1").unwrap();
        assert_eq!(
            pr_for_workspace_transition(&database, "s1", &rows)
                .unwrap()
                .unwrap()
                .pr_number,
            200,
            "shared checkouts retain the highest-numbered session PR"
        );
    }

    // A worktree that's gone can't be polled: `gh pr view` fails every tick
    // and `pr_state` stays OPEN, so without this exclusion an archived
    // workspace is retried forever.
    #[test]
    fn archived_workspaces_drop_out_of_the_poll_set() {
        let (_dir, database) = open_db();
        fixture(&database);
        {
            let conn = database.connection();
            persist_workspace(
                &conn,
                &PersistWorkspaceInput {
                    id: "w2".to_string(),
                    project_id: "p1".to_string(),
                    task_label: "gone".to_string(),
                    branch: "feature/gone".to_string(),
                    base_ref: "main".to_string(),
                    path: "/tmp/argmax-gh-poller/.worktrees/gone".to_string(),
                    state: "archived".to_string(),
                    shared_workspace: false,
                    kind: "git".to_string(),
                    dirty: false,
                    changed_files: 0,
                },
            )
            .expect("archived workspace");
            persist_session(
                &conn,
                &PersistSessionInput {
                    id: "s2".to_string(),
                    workspace_id: "w2".to_string(),
                    provider: "claude".to_string(),
                    model_label: "Haiku 4.5".to_string(),
                    model_id: "claude-haiku-4.5".to_string(),
                    reasoning_effort: None,
                    permission_mode: Some("auto-approve".to_string()),
                    agent_mode: Some("auto".to_string()),
                    prompt: "test".to_string(),
                    state: SessionState::Complete,
                },
            )
            .expect("archived session");
            for session_id in ["s1", "s2"] {
                upsert_gh_pr(
                    &conn,
                    &GhPrRecord {
                        session_id: session_id.to_string(),
                        pr_number: 7,
                        head_sha: "cafebabe".to_string(),
                        last_seen_check_state: "pending".to_string(),
                        updated_at: now_iso(),
                        pr_state: Some("OPEN".to_string()),
                        notified_at: None,
                        pr_created_at: None,
                        pr_merged_at: None,
                        head_ref_name: None,
                    },
                )
                .expect("seed gh_pr");
            }
        }

        let open = {
            let conn = database.connection();
            list_open_gh_pr_session_ids(&conn).expect("open pr sessions")
        };
        assert_eq!(open, vec!["s1".to_string()]);

        let pollable = pollable_session_ids(&database).expect("pollable");
        assert!(!pollable.iter().any(|id| id == "s2"));
    }

    #[tokio::test]
    async fn poller_publishes_delta_on_state_change() {
        let (_dir, database) = open_db();
        fixture(&database);
        settle_session(&database, "s1");
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
                    pr_created_at: None,
                    pr_merged_at: None,
                    head_ref_name: None,
                },
            )
            .expect("seed gh_pr");
        }
        // First gh call: state stays "pending" (no change vs the seed in DB,
        // but the poller's in-memory ledger is empty so this counts as the
        // initial recording — emits a delta).
        let pending_payload = r#"{"number": 42, "headRefOid": "feedface", "headRefName": "feature/x", "state": "OPEN", "statusCheckRollup": [{"conclusion": "pending"}]}"#;
        let failure_payload = r#"{"number": 42, "headRefOid": "feedface", "headRefName": "feature/x", "state": "OPEN", "statusCheckRollup": [{"conclusion": "failure"}]}"#;
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
    async fn poller_publishes_merge_transition_when_head_and_checks_are_unchanged() {
        let (_dir, database) = open_db();
        fixture(&database);
        {
            let conn = database.connection();
            for (id, shared_workspace) in [("w2", false), ("w3", true)] {
                persist_workspace(
                    &conn,
                    &PersistWorkspaceInput {
                        id: id.into(),
                        project_id: "p1".into(),
                        task_label: "idle on same branch".into(),
                        branch: "feature/x".into(),
                        base_ref: "main".into(),
                        path: format!("/tmp/argmax-gh-poller/{id}"),
                        state: "ready".into(),
                        shared_workspace,
                        kind: "git".into(),
                        dirty: false,
                        changed_files: 0,
                    },
                )
                .expect("idle workspace");
            }
        }
        let open_payload = r#"{"number": 42, "headRefOid": "feedface", "headRefName": "feature/x", "state": "OPEN", "createdAt": "2026-05-24T10:00:00Z", "mergedAt": null, "statusCheckRollup": [{"conclusion": "pending"}]}"#;
        let merged_payload = r#"{"number": 42, "headRefOid": "feedface", "headRefName": "feature/x", "state": "MERGED", "createdAt": "2026-05-24T10:00:00Z", "mergedAt": "2026-05-24T11:00:00Z", "statusCheckRollup": [{"conclusion": "pending"}]}"#;
        let stub = StubRunner::new(vec![
            Ok(open_payload.to_string()),
            Ok(merged_payload.to_string()),
        ]);
        let service = GhService::with_runner(Arc::clone(&database), Arc::clone(&stub).runner());

        let published = Arc::new(Mutex::new(Vec::<DashboardDelta>::new()));
        let published_deltas = Arc::clone(&published);
        let publisher: DeltaPublisher = Arc::new(move |delta| {
            published_deltas
                .lock()
                .expect("published deltas poisoned")
                .push(delta);
        });
        let poller = GhPoller::new(
            GhPollerConfig::new(Arc::clone(&database), service).with_delta_publisher(publisher),
        );

        poller.tick_for_test().await.expect("open tick");
        poller.tick_for_test().await.expect("merged tick");

        let deltas = published.lock().expect("published deltas poisoned");
        assert_eq!(deltas.len(), 2);
        for delta in deltas.iter() {
            assert_eq!(delta.workspaces.len(), 2);
            assert!(delta
                .workspaces
                .iter()
                .any(|workspace| workspace.id == "w2"));
            assert!(!delta
                .workspaces
                .iter()
                .any(|workspace| workspace.id == "w3"));
        }
        assert!(deltas
            .last()
            .unwrap()
            .workspaces
            .iter()
            .all(|workspace| { workspace.pr_state.as_deref() == Some("MERGED") }));
        let workspace = deltas
            .last()
            .and_then(|delta| delta.workspaces.first())
            .expect("merged workspace delta");
        assert_eq!(workspace.pr_state.as_deref(), Some("MERGED"));
        assert_eq!(workspace.pr_number, Some(42));
        assert_eq!(
            workspace.pr_created_at.as_deref(),
            Some("2026-05-24T10:00:00Z")
        );
        assert_eq!(
            workspace.pr_merged_at.as_deref(),
            Some("2026-05-24T11:00:00Z")
        );
    }

    #[tokio::test]
    async fn poller_publishes_when_a_milestone_timestamp_is_backfilled() {
        let (_dir, database) = open_db();
        fixture(&database);
        let without_timestamp = r#"{"number": 42, "headRefOid": "feedface", "headRefName": "feature/x", "state": "OPEN", "statusCheckRollup": [{"conclusion": "pending"}]}"#;
        let with_timestamp = r#"{"number": 42, "headRefOid": "feedface", "headRefName": "feature/x", "state": "OPEN", "createdAt": "2026-05-24T10:00:00Z", "statusCheckRollup": [{"conclusion": "pending"}]}"#;
        let stub = StubRunner::new(vec![
            Ok(without_timestamp.to_string()),
            Ok(with_timestamp.to_string()),
        ]);
        let service = GhService::with_runner(Arc::clone(&database), Arc::clone(&stub).runner());

        let publish_count = Arc::new(AtomicUsize::new(0));
        let publisher_count = Arc::clone(&publish_count);
        let publisher: DeltaPublisher = Arc::new(move |_delta: DashboardDelta| {
            publisher_count.fetch_add(1, Ordering::SeqCst);
        });
        let poller = GhPoller::new(
            GhPollerConfig::new(Arc::clone(&database), service).with_delta_publisher(publisher),
        );

        poller.tick_for_test().await.expect("initial tick");
        poller.tick_for_test().await.expect("backfill tick");

        assert_eq!(publish_count.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn poller_dedup_ledger_suppresses_repeat_failure_hook() {
        let (_dir, database) = open_db();
        fixture(&database);
        settle_session(&database, "s1");
        let failure_payload = r#"{"number": 42, "headRefOid": "feedface", "headRefName": "feature/x", "state": "OPEN", "statusCheckRollup": [{"conclusion": "failure"}]}"#;
        let success_then_failure_payload = r#"{"number": 42, "headRefOid": "feedface", "headRefName": "feature/x", "state": "OPEN", "statusCheckRollup": [{"conclusion": "success"}]}"#;
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

    // Every session in a checkout resolves the same branch's PR, and the
    // follow-up the hook launches becomes one more of them. Keyed per session,
    // one red commit fires once per observer and doubles the observers every
    // tick — the shape that put sixteen agents in one worktree at once.
    #[tokio::test]
    async fn failure_hook_fires_once_per_workspace_not_once_per_session() {
        let (_dir, database) = open_db();
        fixture(&database);
        settle_session(&database, "s1");
        {
            let conn = database.connection();
            persist_session(
                &conn,
                &PersistSessionInput {
                    id: "s2".to_string(),
                    workspace_id: "w1".to_string(),
                    provider: "claude".to_string(),
                    model_label: "Haiku 4.5".to_string(),
                    model_id: "claude-haiku-4.5".to_string(),
                    reasoning_effort: None,
                    permission_mode: Some("auto-approve".to_string()),
                    agent_mode: Some("auto".to_string()),
                    prompt: "Checks on PR #42 are failing".to_string(),
                    state: SessionState::Complete,
                },
            )
            .expect("second session in the same workspace");
            for session_id in ["s1", "s2"] {
                upsert_gh_pr(
                    &conn,
                    &GhPrRecord {
                        session_id: session_id.to_string(),
                        pr_number: 42,
                        head_sha: "feedface".to_string(),
                        last_seen_check_state: "pending".to_string(),
                        updated_at: now_iso(),
                        pr_state: Some("OPEN".to_string()),
                        notified_at: None,
                        pr_created_at: None,
                        pr_merged_at: None,
                        head_ref_name: None,
                    },
                )
                .expect("seed gh_pr");
            }
        }
        let failure_payload = r#"{"number": 42, "headRefOid": "feedface", "headRefName": "feature/x", "state": "OPEN", "statusCheckRollup": [{"conclusion": "failure"}]}"#;
        let stub = StubRunner::new(vec![
            Ok(failure_payload.to_string()),
            Ok(failure_payload.to_string()),
        ]);
        let service = GhService::with_runner(Arc::clone(&database), Arc::clone(&stub).runner());

        let failure_hits = Arc::new(AtomicUsize::new(0));
        let failure_count = Arc::clone(&failure_hits);
        let hook: CheckFailureHook = Arc::new(move |ctx: CheckFailureContext| {
            assert_eq!(ctx.workspace_id, "w1");
            failure_count.fetch_add(1, Ordering::SeqCst);
        });
        let poller = GhPoller::new(
            GhPollerConfig::new(Arc::clone(&database), service).with_check_failure_hook(hook),
        );

        poller.tick_for_test().await.expect("failure tick");
        assert_eq!(
            failure_hits.load(Ordering::SeqCst),
            1,
            "both sessions observed the same failing PR; only the workspace gets a follow-up"
        );
    }

    // Deferred, not dropped: a second agent in a checkout someone is mid-turn
    // in edits the same files, and the sidebar shows only one of them. The
    // check stays red without changing, so the retry can't wait for a
    // transition.
    #[tokio::test]
    async fn failure_hook_waits_for_the_running_turn_to_settle() {
        let (_dir, database) = open_db();
        fixture(&database);
        let failure_payload = r#"{"number": 42, "headRefOid": "feedface", "headRefName": "feature/x", "state": "OPEN", "statusCheckRollup": [{"conclusion": "failure"}]}"#;
        let stub = StubRunner::new(vec![
            Ok(failure_payload.to_string()),
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

        poller.tick_for_test().await.expect("tick while running");
        assert_eq!(failure_hits.load(Ordering::SeqCst), 0);

        settle_session(&database, "s1");
        poller.tick_for_test().await.expect("tick once settled");
        assert_eq!(failure_hits.load(Ordering::SeqCst), 1);
    }

    // A merged PR stays merged: there is no second transition to hang a retry
    // on, so the hook has to be re-evaluated on every tick and deduped by the
    // ledger instead of by `changed`.
    #[tokio::test]
    async fn merge_hook_fires_once_and_only_for_an_opted_in_project() {
        let (_dir, database) = open_db();
        fixture(&database);
        settle_session(&database, "s1");
        let merged_payload = r#"{"number": 42, "headRefOid": "feedface", "headRefName": "feature/x", "state": "MERGED", "mergedAt": "2026-05-24T11:00:00Z", "statusCheckRollup": [{"conclusion": "success"}]}"#;
        let stub = StubRunner::new(vec![
            Ok(merged_payload.to_string()),
            Ok(merged_payload.to_string()),
            Ok(merged_payload.to_string()),
        ]);
        let service = GhService::with_runner(Arc::clone(&database), Arc::clone(&stub).runner());

        let merged = Arc::new(Mutex::new(Vec::<MergedPrContext>::new()));
        let merged_seen = Arc::clone(&merged);
        let hook: MergedPrHook = Arc::new(move |context| {
            merged_seen
                .lock()
                .expect("merged contexts poisoned")
                .push(context);
        });
        let poller = GhPoller::new(
            GhPollerConfig::new(Arc::clone(&database), service).with_pr_merged_hook(hook),
        );

        poller.tick_for_test().await.expect("opted-out tick");
        assert!(
            merged.lock().expect("merged contexts poisoned").is_empty(),
            "a project that never opted in keeps its workspace"
        );

        enable_archive_on_merge(&database);
        poller.tick_for_test().await.expect("opted-in tick");
        poller.tick_for_test().await.expect("still merged tick");

        let contexts = merged.lock().expect("merged contexts poisoned");
        assert_eq!(
            contexts.as_slice(),
            &[MergedPrContext {
                workspace_id: "w1".to_string(),
                pr_number: 42,
            }],
            "one merge archives the workspace once",
        );
    }

    /// Archiving a shared checkout deletes nothing — it would only close a chat
    /// in a tree the user is still working in, which is not the cleanup this
    /// setting is for.
    #[tokio::test]
    async fn merge_hook_leaves_a_shared_checkout_alone() {
        let (_dir, database) = open_db();
        fixture(&database);
        settle_session(&database, "s1");
        enable_archive_on_merge(&database);
        {
            let connection = database.connection();
            connection
                .execute(
                    "UPDATE workspaces SET shared_workspace = 1 WHERE id = 'w1'",
                    [],
                )
                .expect("share the checkout");
        }
        let merged_payload = r#"{"number": 42, "headRefOid": "feedface", "headRefName": "feature/x", "state": "MERGED", "mergedAt": "2026-05-24T11:00:00Z", "statusCheckRollup": [{"conclusion": "success"}]}"#;
        let stub = StubRunner::new(vec![Ok(merged_payload.to_string())]);
        let service = GhService::with_runner(Arc::clone(&database), Arc::clone(&stub).runner());

        let merged = Arc::new(Mutex::new(Vec::<MergedPrContext>::new()));
        let merged_seen = Arc::clone(&merged);
        let hook: MergedPrHook = Arc::new(move |context| {
            merged_seen
                .lock()
                .expect("merged contexts poisoned")
                .push(context);
        });
        let poller = GhPoller::new(
            GhPollerConfig::new(Arc::clone(&database), service).with_pr_merged_hook(hook),
        );

        poller.tick_for_test().await.expect("merged tick");
        assert!(
            merged.lock().expect("merged contexts poisoned").is_empty(),
            "a shared checkout is nobody's to archive on a merge"
        );
    }

    // Archiving cancels the checkout's processes and removes the tree, so a
    // merge that lands mid-turn waits for the turn instead of being dropped.
    #[tokio::test]
    async fn merge_hook_waits_for_the_running_turn_to_settle() {
        let (_dir, database) = open_db();
        fixture(&database);
        enable_archive_on_merge(&database);
        let merged_payload = r#"{"number": 42, "headRefOid": "feedface", "headRefName": "feature/x", "state": "MERGED", "mergedAt": "2026-05-24T11:00:00Z", "statusCheckRollup": [{"conclusion": "success"}]}"#;
        let stub = StubRunner::new(vec![
            Ok(merged_payload.to_string()),
            Ok(merged_payload.to_string()),
        ]);
        let service = GhService::with_runner(Arc::clone(&database), Arc::clone(&stub).runner());

        let merge_hits = Arc::new(AtomicUsize::new(0));
        let merge_count = Arc::clone(&merge_hits);
        let hook: MergedPrHook = Arc::new(move |_| {
            merge_count.fetch_add(1, Ordering::SeqCst);
        });
        let poller = GhPoller::new(
            GhPollerConfig::new(Arc::clone(&database), service).with_pr_merged_hook(hook),
        );

        poller.tick_for_test().await.expect("tick while running");
        assert_eq!(merge_hits.load(Ordering::SeqCst), 0);

        settle_session(&database, "s1");
        poller.tick_for_test().await.expect("tick once settled");
        assert_eq!(merge_hits.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn poller_refreshes_a_recently_completed_session() {
        let (_dir, database) = open_db();
        fixture(&database);
        {
            let conn = database.connection();
            conn.execute(
                "UPDATE sessions SET state = 'complete', completed_at = ? WHERE id = 's1'",
                [now_iso()],
            )
            .expect("complete session");
        }
        let payload = r#"{"number": 9, "headRefOid": "abcd", "headRefName": "feature/x", "state": "OPEN", "statusCheckRollup": [{"conclusion": "pending"}]}"#;
        let stub = StubRunner::new(vec![Ok(payload.to_string())]);
        let service = GhService::with_runner(Arc::clone(&database), Arc::clone(&stub).runner());
        let publish_count = Arc::new(AtomicUsize::new(0));
        let publisher_count = Arc::clone(&publish_count);
        let publisher: DeltaPublisher = Arc::new(move |_delta: DashboardDelta| {
            publisher_count.fetch_add(1, Ordering::SeqCst);
        });
        let poller = GhPoller::new(
            GhPollerConfig::new(Arc::clone(&database), service).with_delta_publisher(publisher),
        );

        poller.tick_for_test().await.expect("tick");
        assert_eq!(publish_count.load(Ordering::SeqCst), 1);
        let rows = {
            let conn = database.connection();
            crate::persistence::gh::list_gh_pr_for_session(&conn, "s1").expect("rows")
        };
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].pr_number, 9);
        assert_eq!(rows[0].head_ref_name.as_deref(), Some("feature/x"));
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
