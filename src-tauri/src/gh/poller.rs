// GhPoller periodically calls
// `GhService::refresh` against running sessions, recently completed sessions,
// sessions with an open PR, and sessions with a PR watch (see `gh::watch`). It watches for `check_state` / `head_sha`
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
use crate::persistence::gh::{list_open_gh_pr_session_ids, list_session_prs, GhPrRecord};
use crate::persistence::pr_watches::{list_pr_watches, watched_pr_state};
use crate::providers::flush_queue::DashboardDelta;

use super::service::GhService;
use super::watch::{run_watch_pass, PrWatchNoticeHook};

pub const DEFAULT_POLL_INTERVAL: Duration = Duration::from_secs(60);

/// Longest wait between refreshes of a settled PR that is polled only because
/// it is open. Every `gh pr view` is a process spawn, and long-lived open PRs
/// would otherwise cost one per tick while nobody is working. This is also the
/// worst-case delay before a push or merge made outside Argmax is noticed.
const OPEN_PR_BACKOFF_CAP: Duration = Duration::from_secs(600);

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
/// for a head_sha we haven't surfaced before. The implementation is the
/// caller's.
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

/// Optional hook fired when a PR with WORK evidence on a session belonging to
/// a *live* Arc (see `crate::persistence::arcs::arc_is_live`) transitions to
/// checks failing, checks passing, or merged. The caller notifies the Arc's
/// coordinator; the poller owns the deduplication. Independent of
/// `on_check_failure` / `on_pr_merged`: a live Arc's member gets this instead
/// of the automatic check-failure follow-up (see `arc_id` on the session
/// resolved in `detect_transition`), and gets it regardless of the
/// `archive_on_merge` project setting.
pub type ArcEventHook = Arc<dyn Fn(ArcEventContext) + Send + Sync>;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ArcEventKind {
    ChecksFailing,
    ChecksPassing,
    Merged,
}

impl ArcEventKind {
    fn tag(self) -> &'static str {
        match self {
            Self::ChecksFailing => "checks_failing",
            Self::ChecksPassing => "checks_passing",
            Self::Merged => "merged",
        }
    }
}

/// The message's dedup id, keyed on the persisted state that produced this
/// event rather than a wall-clock timestamp: `observed_at` is the canonical
/// PR row's `updated_at`, which only moves when `last_seen_check_state` /
/// `pr_state` / `head_sha` actually changes (see `upsert_canonical_pr`). That
/// makes the id identical for every session in the same Arc observing the
/// same PR in the same tick, so `INSERT OR IGNORE` on `session_messages`
/// collapses concurrent observers into one delivery, and identical for the
/// same transition across ticks, so a later tick can look this id up again
/// (see `detect_transition`'s Arc-live check-failure fallback) without
/// recomputing anything from an in-memory ledger. Includes `project_id`
/// because `pr_number` alone collides across two projects in the same Arc.
/// Merged omits `head_sha`: a merge is a one-time milestone, not a per-commit
/// state like checks.
fn arc_event_message_id(
    arc_id: &str,
    project_id: &str,
    pr_number: i64,
    kind: ArcEventKind,
    head_sha: &str,
    observed_at: &str,
) -> String {
    match kind {
        ArcEventKind::Merged => {
            format!(
                "arc:{arc_id}:project:{project_id}:pr:{pr_number}:{}:{observed_at}",
                kind.tag()
            )
        }
        ArcEventKind::ChecksFailing | ArcEventKind::ChecksPassing => format!(
            "arc:{arc_id}:project:{project_id}:pr:{pr_number}:{}:{head_sha}:{observed_at}",
            kind.tag()
        ),
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ArcEventContext {
    pub arc_id: String,
    pub arc_name: String,
    pub coordinator_session_id: String,
    pub session_id: String,
    pub workspace_id: String,
    pub project_id: String,
    pub pr_number: i64,
    pub head_sha: String,
    /// Precomputed by `arc_event_message_id` so the delivery hook and the
    /// poller's own later-tick lookup (whether this exact transition already
    /// reached `session_messages`) always agree on the same id.
    pub message_id: String,
    pub kind: ArcEventKind,
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
    pub on_arc_event: Option<ArcEventHook>,
    /// Delivers PR watch notices. Without it the watch pass does not run.
    pub on_watch_notice: Option<PrWatchNoticeHook>,
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
            on_arc_event: None,
            on_watch_notice: None,
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

    pub fn with_arc_event_hook(mut self, hook: ArcEventHook) -> Self {
        self.on_arc_event = Some(hook);
        self
    }

    pub fn with_watch_notice_hook(mut self, hook: PrWatchNoticeHook) -> Self {
        self.on_watch_notice = Some(hook);
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
    refresh_error: Option<String>,
    relationship: Option<String>,
    is_primary: bool,
    title: Option<String>,
    url: Option<String>,
}

struct PollerInner {
    database: Arc<Database>,
    service: Arc<GhService>,
    publish_delta: Option<DeltaPublisher>,
    on_check_failure: Option<CheckFailureHook>,
    on_pr_merged: Option<MergedPrHook>,
    on_arc_event: Option<ArcEventHook>,
    on_watch_notice: Option<PrWatchNoticeHook>,
    /// Last-seen PR state per `(session_id, pr_number)` so a repeated tick is
    /// a no-op while recovered milestone timestamps still publish.
    last_state: Mutex<HashMap<(String, i64), PrState>>,
    /// Insertion-ordered ledger of the hooks we've already fired: check
    /// failures keyed `workspace:pr:head_sha`, merges keyed
    /// `merged:workspace:pr`. Arc events are *not* kept here — they dedupe on
    /// the persisted `gh_pull_requests` row instead (see
    /// `arc_event_message_id`), which survives a restart the way this
    /// in-memory ledger does not. Bounded so a long-running app doesn't grow
    /// it.
    fired_ledger: Mutex<VecDeque<String>>,
    /// Backoff for sessions polled only because they have an open PR, keyed by
    /// session id. A missing entry means every tick. Pruned each tick to the
    /// sessions that are still open-PR-only.
    open_pr_backoff: Mutex<HashMap<String, OpenPrBackoff>>,
    /// `OPEN_PR_BACKOFF_CAP` expressed in ticks of this poller's interval.
    backoff_cap_ticks: u32,
}

/// Counted in ticks rather than wall time so the schedule follows the ticker.
#[derive(Debug, Clone, Copy)]
struct OpenPrBackoff {
    /// Ticks between refreshes: 1, 2, 4, 8, … up to `backoff_cap_ticks`.
    wait_ticks: u32,
    /// Ticks still to skip before the next refresh.
    skip_ticks: u32,
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
                on_arc_event: config.on_arc_event,
                on_watch_notice: config.on_watch_notice,
                last_state: Mutex::new(HashMap::new()),
                fired_ledger: Mutex::new(VecDeque::new()),
                open_pr_backoff: Mutex::new(HashMap::new()),
                backoff_cap_ticks: (OPEN_PR_BACKOFF_CAP.as_millis()
                    / config.interval.as_millis().max(1))
                .clamp(1, u32::MAX as u128) as u32,
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
            // Skip the immediate tick the first interval fires; the first
            // poll is one interval out.
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
    // Repair old associations in bounded batches even when their PRs are
    // already merged and would never enter the ordinary polling set.
    let repaired_workspaces = {
        let conn = inner.database.connection();
        let sessions =
            crate::persistence::gh::list_session_ids_needing_pr_evidence_repair(&conn, 16)?;
        let mut workspaces = Vec::new();
        let mut seen = HashSet::new();
        for session_id in sessions {
            super::service::repair_session_pr_evidence(&conn, &session_id)?;
            for workspace in crate::gh::workspaces_for_pr_refresh(&conn, &session_id)? {
                if seen.insert(workspace.id.clone()) {
                    workspaces.push(workspace);
                }
            }
        }
        workspaces
    };
    if !repaired_workspaces.is_empty() {
        if let Some(publisher) = inner.publish_delta.as_ref() {
            publisher(DashboardDelta {
                workspaces: repaired_workspaces,
                ..Default::default()
            });
        }
    }
    let pollable = pollable_sessions(&inner.database)?;
    let session_ids = sessions_due_this_tick(&inner, &pollable.open_pr_only, pollable.all);
    if session_ids.is_empty() {
        return Ok(());
    }

    // Snapshot every canonical PR's persisted state before this tick's own
    // refreshes upsert it. Arc event transitions compare against this rather
    // than the in-memory `last_state` map, which a restart empties — reading
    // after the fanout below would only ever see this tick's own write.
    let prior_pr_states = {
        let conn = inner.database.read_connection();
        crate::persistence::gh::snapshot_gh_pr_states(&conn)?
    };

    // Bounded-concurrency fanout — one stuck `gh` no longer holds the
    // remaining sessions hostage.
    let tick_started_at = crate::persistence::time::now_iso();
    let mut refreshed_sessions = Vec::new();
    for chunk in session_ids.chunks(TICK_CONCURRENCY) {
        let mut join_set = tokio::task::JoinSet::new();
        for session_id in chunk.iter().cloned() {
            let inner = Arc::clone(&inner);
            let watched_prs = pollable
                .watched_prs
                .get(&session_id)
                .cloned()
                .unwrap_or_default();
            let tick_started_at = tick_started_at.clone();
            join_set.spawn(async move {
                let result = inner.service.refresh(&session_id).await;
                if result.is_ok() {
                    refresh_watched_prs(&inner, &session_id, &watched_prs, &tick_started_at).await;
                }
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
    let mut reserved_checkouts = HashSet::new();
    let mut settled_open_pr_sessions = HashSet::new();
    for session_id in refreshed_sessions {
        let rows = inner.service.list_for_session(&session_id)?;
        let mut settled = true;
        for pr in rows {
            if let Some(transition) = detect_transition(
                &inner,
                &session_id,
                &pr,
                &mut reserved_checkouts,
                &prior_pr_states,
            ) {
                settled &= !transition.publish && !transition.retry;
                transitions.push(transition);
            }
            settled &= pr_is_settled(&inner, &session_id, pr.pr_number);
        }
        if settled && pollable.open_pr_only.contains(&session_id) {
            settled_open_pr_sessions.insert(session_id);
        }
    }
    update_open_pr_backoff(
        &inner,
        session_ids
            .iter()
            .filter(|session_id| pollable.open_pr_only.contains(*session_id)),
        &settled_open_pr_sessions,
    );

    // After the fanout and transition detection, from the same refreshed
    // rows: the watch pass reads `gh_pull_requests` and never writes it.
    if let Some(deliver) = inner.on_watch_notice.as_ref() {
        if let Err(error) =
            run_watch_pass(&inner.database, &inner.service, deliver, &tick_started_at).await
        {
            tracing::warn!(?error, "gh.poller: watch pass failed");
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
        if let Some(hook) = inner.on_arc_event.as_ref() {
            for arc_event in transition.arc_events {
                (hook)(arc_event);
            }
        }
    }

    Ok(())
}

struct PollableSessions {
    /// Union of `running` sessions, recently completed sessions, sessions
    /// with an OPEN PR, and sessions with a PR watch, dedup'd.
    all: Vec<String>,
    /// The subset polled only because of an open PR. These back off while
    /// their PRs stay settled; everything else is refreshed every tick.
    open_pr_only: HashSet<String>,
    /// `(project_id, pr_number)` of each PR a session watches.
    watched_prs: HashMap<String, Vec<(String, i64)>>,
}

fn pollable_sessions(database: &Arc<Database>) -> ArgmaxResult<PollableSessions> {
    let conn = database.connection();
    let mut active: HashSet<String> = list_running_session_ids(&conn)?.into_iter().collect();
    let since = chrono::Utc::now()
        .checked_sub_signed(chrono::Duration::seconds(
            RECENTLY_COMPLETED_POLL_WINDOW.as_secs() as i64,
        ))
        .unwrap_or_else(chrono::Utc::now)
        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    active.extend(list_recently_completed_session_ids(&conn, &since)?);
    // A watched session is always due: no backoff, and no workspace-state
    // filter, so a watch outlives an archived chat until its PR ends.
    let mut watched_prs: HashMap<String, Vec<(String, i64)>> = HashMap::new();
    for watch in list_pr_watches(&conn)? {
        watched_prs
            .entry(watch.session_id)
            .or_default()
            .push((watch.project_id, watch.pr_number));
    }
    active.extend(watched_prs.keys().cloned());
    let open_pr_only: HashSet<String> = list_open_gh_pr_session_ids(&conn)?
        .into_iter()
        .filter(|id| !active.contains(id))
        .collect();
    let all = active
        .into_iter()
        .chain(open_pr_only.iter().cloned())
        .collect();
    Ok(PollableSessions {
        all,
        open_pr_only,
        watched_prs,
    })
}

/// A session refresh views only the PRs it can attribute to the session, and
/// at most `MAX_OPEN_PR_NUMBER_VIEWS` of them. A watched PR the refresh did
/// not reach this tick is viewed by number, still inside the fanout, so the
/// watch pass reads a fresh row and the tick keeps one writer phase.
async fn refresh_watched_prs(
    inner: &PollerInner,
    session_id: &str,
    watched_prs: &[(String, i64)],
    tick_started_at: &str,
) {
    for (project_id, pr_number) in watched_prs {
        let refreshed_this_tick = {
            let conn = inner.database.read_connection();
            match watched_pr_state(&conn, project_id, *pr_number) {
                Ok(state) => state.is_some_and(|pr| pr.refreshed_at.as_str() >= tick_started_at),
                Err(error) => {
                    tracing::warn!(%session_id, pr_number, %error, "gh.poller: could not read watched PR");
                    continue;
                }
            }
        };
        if refreshed_this_tick {
            continue;
        }
        if let Err(error) = inner
            .service
            .refresh_pr_number(session_id, *pr_number)
            .await
        {
            tracing::debug!(%session_id, pr_number, %error, "gh.poller: watched PR refresh failed");
        }
    }
}

/// Drops backoff entries for sessions that are no longer open-PR-only — a
/// session that is running again restarts at every tick when it settles back
/// — and holds back the open-PR-only sessions still waiting out their backoff.
fn sessions_due_this_tick(
    inner: &PollerInner,
    open_pr_only: &HashSet<String>,
    all: Vec<String>,
) -> Vec<String> {
    let mut backoff = inner.open_pr_backoff.lock_or_recover("open_pr_backoff");
    backoff.retain(|session_id, _| open_pr_only.contains(session_id));
    all.into_iter()
        .filter(|session_id| match backoff.get_mut(session_id) {
            Some(entry) if entry.skip_ticks > 0 => {
                entry.skip_ticks -= 1;
                false
            }
            _ => true,
        })
        .collect()
}

/// Checks still running or a failed read can resolve on any tick, so neither
/// counts as settled.
fn pr_is_settled(inner: &PollerInner, session_id: &str, pr_number: i64) -> bool {
    let state = inner.last_state.lock_or_recover("last_state");
    state
        .get(&(session_id.to_string(), pr_number))
        .is_some_and(|pr| pr.check_state != "pending" && pr.refresh_error.is_none())
}

/// Doubles the wait for each open-PR-only session refreshed this tick whose
/// PRs were settled and unchanged. Any other one goes back to every tick,
/// including a session whose refresh failed.
fn update_open_pr_backoff<'a>(
    inner: &PollerInner,
    refreshed_open_pr_only: impl Iterator<Item = &'a String>,
    settled: &HashSet<String>,
) {
    let mut backoff = inner.open_pr_backoff.lock_or_recover("open_pr_backoff");
    for session_id in refreshed_open_pr_only {
        if !settled.contains(session_id) {
            backoff.remove(session_id);
            continue;
        }
        let wait_ticks = backoff
            .get(session_id)
            .map_or(2, |entry| entry.wait_ticks.saturating_mul(2))
            .min(inner.backoff_cap_ticks);
        backoff.insert(
            session_id.clone(),
            OpenPrBackoff {
                wait_ticks,
                skip_ticks: wait_ticks - 1,
            },
        );
    }
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
    /// A hook wanted to act but declined for a reason that clears on its own
    /// (a running turn, a failed lookup), so the session must not back off.
    retry: bool,
    context: CheckFailureContext,
    /// Arc events to deliver, independent of `is_failure`/`merged` above: a
    /// live Arc's member session gets these instead of (checks failing) or
    /// in addition to (merged, checks passing) the ordinary hooks.
    arc_events: Vec<ArcEventContext>,
}

fn detect_transition(
    inner: &Arc<PollerInner>,
    session_id: &str,
    latest: &GhPrRecord,
    reserved_checkouts: &mut HashSet<String>,
    prior_pr_states: &crate::persistence::gh::PersistedPrStates,
) -> Option<Transition> {
    let association = {
        let conn = inner.database.read_connection();
        match list_session_prs(&conn, session_id) {
            Ok(prs) => prs.into_iter().find(|pr| pr.pr_number == latest.pr_number),
            Err(error) => {
                tracing::warn!(%session_id, %error, "gh poller: could not read PR association");
                return None;
            }
        }
    }?;
    let key = (session_id.to_string(), latest.pr_number);
    let next = PrState {
        head_sha: latest.head_sha.clone(),
        check_state: latest.last_seen_check_state.clone(),
        pr_state: latest.pr_state.clone(),
        pr_created_at: latest.pr_created_at.clone(),
        pr_merged_at: latest.pr_merged_at.clone(),
        refresh_error: association.refresh_error,
        relationship: Some(association.relationship),
        is_primary: association.is_primary,
        title: association.title,
        url: association.url,
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
            Some(_) | None => {
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
        retry: false,
        context: CheckFailureContext {
            session_id: session_id.to_string(),
            workspace_id: String::new(),
            pr_number: latest.pr_number,
            head_sha: latest.head_sha.clone(),
        },
        arc_events: Vec::new(),
    };

    // A live Arc's member session hands PR/CI events to its coordinator
    // instead: the automatic check-failure follow-up below is suppressed for
    // it (see `live_arc` use just below), and the Arc event block further
    // down fires in its place. Resolved once so both sites agree on it and
    // fetch the row only once per (session, pr) per tick.
    let live_arc = live_arc_for_session(inner, session_id);

    // The persisted state this PR was in before this tick's refresh — used
    // both by the ordinary follow-up's Arc-live suppression just below and by
    // the Arc event block further down. Reading it once here keeps both
    // sites looking at the same snapshot for this (project, pr).
    let prior_persisted_check_state = |project_id: &str| -> Option<&str> {
        prior_pr_states
            .get(&(project_id.to_string(), latest.pr_number))
            .map(|(check_state, _)| check_state.as_str())
    };

    if next.check_state == "failure"
        && next.pr_state.as_deref() == Some("OPEN")
        && next.refresh_error.is_none()
    {
        // Resolve workspace_id at fire time so the hook gets the live value
        // rather than whatever was on disk at startup. Only record the
        // ledger entry once resolution succeeds — otherwise a transient
        // lookup failure would dedupe the failure forever and the hook
        // would never fire on a later tick.
        match resolve_workspace_id_for_pr_action(&inner.database, session_id, latest) {
            Ok(Some((workspace_id, project_id))) => {
                // A live Arc's member hands this to its coordinator instead —
                // but only once delivery of that notice actually succeeds.
                // `suppressed_by_live_arc` decides that at delivery time, not
                // up front: a fresh transition into failure gives the Arc
                // event (queued below) first crack at delivery this tick; a
                // later tick re-checks whether that delivery's message row
                // actually landed in `session_messages`, and falls through to
                // this ordinary path when it didn't (the send failed, or
                // nothing ever attempted it — no `on_arc_event` hook wired,
                // say). This re-evaluates every tick a still-failing PR does,
                // the same as the non-Arc case below it.
                let suppressed_by_live_arc = match live_arc.as_ref() {
                    None => false,
                    Some(arc) => {
                        let is_fresh_transition =
                            prior_persisted_check_state(&project_id) != Some("failure");
                        if is_fresh_transition && inner.on_arc_event.is_some() {
                            true
                        } else {
                            let message_id = arc_event_message_id(
                                &arc.id,
                                &project_id,
                                latest.pr_number,
                                ArcEventKind::ChecksFailing,
                                &latest.head_sha,
                                &latest.updated_at,
                            );
                            let conn = inner.database.read_connection();
                            crate::persistence::session_messages::session_message_exists(
                                &conn,
                                &message_id,
                            )
                            .unwrap_or_else(|error| {
                                tracing::warn!(
                                    %session_id,
                                    ?error,
                                    "gh poller: could not check arc delivery state; assuming delivered"
                                );
                                true
                            })
                        }
                    }
                };
                // Keyed by workspace, not session: every session in a checkout
                // sees the same branch's PR, and the follow-up we launch joins
                // them. A per-session key fires once per observer and doubles
                // the observers each tick.
                let ledger_key =
                    format!("{}:{}:{}", workspace_id, latest.pr_number, latest.head_sha);
                if !inner.ledger_has(&ledger_key)
                    && !already_launched(inner, &workspace_id, latest)
                    && !suppressed_by_live_arc
                    && !pr_is_watched(inner, &project_id, latest.pr_number)
                {
                    if !workspace_is_busy(inner, &workspace_id)
                        && reserve_checkout(inner, &workspace_id, reserved_checkouts)
                    {
                        inner.ledger_add(ledger_key);
                        transition.context.workspace_id = workspace_id;
                        transition.is_failure = true;
                    } else {
                        transition.retry = true;
                    }
                }
            }
            Ok(None) => {}
            Err(error) => {
                transition.retry = true;
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
            Ok(Some((workspace_id, project_id))) => {
                // Keyed by workspace and PR, not by session or head_sha: every
                // session in the checkout sees the same merge, and a merged PR
                // keeps reporting the same commit on every later tick.
                let ledger_key = format!("merged:{}:{}", workspace_id, latest.pr_number);
                if !inner.ledger_has(&ledger_key)
                    && archives_on_merge(inner, &workspace_id)
                    && workspace_prs_are_merged(inner, &workspace_id)
                {
                    if workspace_is_busy(inner, &workspace_id) {
                        // Deferred, not dropped, exactly like the check-failure
                        // follow-up: archiving cancels the running agent's
                        // processes and removes the tree it is editing.
                        tracing::info!(
                            %workspace_id,
                            pr_number = latest.pr_number,
                            "gh poller: PR merged but a turn is still running; archive deferred"
                        );
                        transition.retry = true;
                    } else if merged_pr_has_watch(
                        inner,
                        &workspace_id,
                        &project_id,
                        latest.pr_number,
                    ) {
                        // The watch pass later in this tick sends the merged
                        // notice, which starts a turn, and removes the watch.
                        // Archiving now would cancel that turn, so the archive
                        // waits for a tick with no watch and a settled turn.
                        transition.retry = true;
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
                transition.retry = true;
                tracing::warn!(
                    %session_id,
                    ?error,
                    "gh poller: could not resolve workspace for merged PR; will retry next tick"
                );
            }
        }
    }

    // Arc PR/CI events: checks failing, checks passing, or merged, for a live
    // Arc's member session with WORK evidence — the same rule
    // `resolve_workspace_id_for_pr_action` already applies for the ordinary
    // hooks above. Evaluated independently of their own gating (busy
    // checkout, `archive_on_merge`): the coordinator decides what to do next,
    // not the poller. A coordinator that is itself the PR's worker still gets
    // it — nothing here excludes `session_id == coordinator_session_id`.
    //
    // Each kind fires on a persisted-state transition, not a wall-clock
    // ledger: checks failing needs `prior != failure` (now failure); checks
    // passing needs `prior == failure` (now success) — the simplest correct
    // rule, not `prior in (failure, pending)`, so a failure -> pending ->
    // success sequence spread across separate ticks reports passing only
    // when the poller's immediately preceding snapshot was failure (see
    // docs/gh.md); merged needs `prior != MERGED` (now MERGED). Once fired,
    // the next tick's snapshot already shows the new state, so each kind
    // fires exactly once per transition without any ledger bookkeeping.
    if inner.on_arc_event.is_some() {
        if let Some(arc) = live_arc.as_ref() {
            match resolve_workspace_id_for_pr_action(&inner.database, session_id, latest) {
                Ok(Some((workspace_id, project_id))) => {
                    let prior = prior_pr_states.get(&(project_id.clone(), latest.pr_number));
                    let prior_check_state = prior.map(|(state, _)| state.as_str());
                    let prior_pr_state = prior.and_then(|(_, pr_state)| pr_state.as_deref());

                    let is_checks_failing = next.check_state == "failure"
                        && next.pr_state.as_deref() == Some("OPEN")
                        && next.refresh_error.is_none()
                        && prior_check_state != Some("failure");
                    let is_checks_passing =
                        next.check_state == "success" && prior_check_state == Some("failure");
                    let is_merged_transition = is_merged && prior_pr_state != Some("MERGED");

                    let mut kinds = Vec::new();
                    if is_checks_failing {
                        kinds.push(ArcEventKind::ChecksFailing);
                    }
                    if is_checks_passing {
                        kinds.push(ArcEventKind::ChecksPassing);
                    }
                    if is_merged_transition {
                        kinds.push(ArcEventKind::Merged);
                    }
                    let coordinator_session_id =
                        arc.coordinator_session_id.clone().unwrap_or_default();
                    for kind in kinds {
                        let message_id = arc_event_message_id(
                            &arc.id,
                            &project_id,
                            latest.pr_number,
                            kind,
                            &latest.head_sha,
                            &latest.updated_at,
                        );
                        transition.arc_events.push(ArcEventContext {
                            arc_id: arc.id.clone(),
                            arc_name: arc.name.clone(),
                            coordinator_session_id: coordinator_session_id.clone(),
                            session_id: session_id.to_string(),
                            workspace_id: workspace_id.clone(),
                            project_id: project_id.clone(),
                            pr_number: latest.pr_number,
                            head_sha: latest.head_sha.clone(),
                            message_id,
                            kind,
                        });
                    }
                }
                Ok(None) => {}
                Err(error) => {
                    tracing::warn!(
                        %session_id,
                        ?error,
                        "gh poller: could not resolve workspace for arc event; will retry next tick"
                    );
                }
            }
        }
    }

    if !transition.publish
        && !transition.is_failure
        && transition.merged.is_none()
        && !transition.retry
        && transition.arc_events.is_empty()
    {
        return None;
    }
    Some(transition)
}

/// The session's Arc, only when that Arc is live (see
/// `crate::persistence::arcs::arc_is_live`). A lookup error is treated as "no
/// live Arc" — the poller retries every tick, and this only ever widens or
/// narrows which of two notification paths a transition takes, never drops
/// it outright.
fn live_arc_for_session(
    inner: &Arc<PollerInner>,
    session_id: &str,
) -> Option<crate::persistence::arcs::ArcRecord> {
    let conn = inner.database.connection();
    let arc = match crate::persistence::arcs::find_session_arc(&conn, session_id) {
        Ok(arc) => arc?,
        Err(error) => {
            tracing::warn!(%session_id, %error, "gh poller: could not resolve session's arc");
            return None;
        }
    };
    match crate::persistence::arcs::arc_is_live(&conn, &arc) {
        Ok(true) => Some(arc),
        Ok(false) => None,
        Err(error) => {
            tracing::warn!(%session_id, %error, "gh poller: could not resolve arc liveness");
            None
        }
    }
}

/// Hooks launch asynchronously after detection. Reserve a checkout during
/// this tick so two failing PRs cannot schedule overlapping editing agents.
fn reserve_checkout(
    inner: &Arc<PollerInner>,
    workspace_id: &str,
    reserved: &mut HashSet<String>,
) -> bool {
    let conn = inner.database.read_connection();
    match conn.query_row(
        "SELECT path FROM workspaces WHERE id = ?1",
        [workspace_id],
        |row| row.get::<_, String>(0),
    ) {
        Ok(path) => reserved.insert(path),
        Err(error) => {
            tracing::warn!(%workspace_id, %error, "gh poller: could not reserve checkout");
            false
        }
    }
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

/// A watched PR's session owns its fix, so the follow-up stands down. A lookup
/// error counts as watched, for the same reason as `already_launched`.
fn pr_is_watched(inner: &Arc<PollerInner>, project_id: &str, pr_number: i64) -> bool {
    let conn = inner.database.read_connection();
    crate::persistence::pr_watches::pr_has_watch(&conn, project_id, pr_number).unwrap_or_else(
        |error| {
            tracing::warn!(%project_id, pr_number, ?error, "gh poller: PR watch lookup failed");
            true
        },
    )
}

/// A session in this workspace still watches the merged PR. A lookup error
/// counts as watched: the archive is only deferred, and a tick retries it.
fn merged_pr_has_watch(
    inner: &Arc<PollerInner>,
    workspace_id: &str,
    project_id: &str,
    pr_number: i64,
) -> bool {
    let conn = inner.database.read_connection();
    conn.query_row(
        "SELECT EXISTS (SELECT 1 FROM pr_watches w JOIN sessions s ON s.id = w.session_id
         WHERE s.workspace_id = ?1 AND w.project_id = ?2 AND w.pr_number = ?3)",
        rusqlite::params![workspace_id, project_id, pr_number],
        |row| row.get::<_, bool>(0),
    )
    .unwrap_or_else(|error| {
        tracing::warn!(%workspace_id, ?error, "gh poller: PR watch guard failed");
        true
    })
}

/// A turn is still live in the checkout. Skip *without* recording the ledger:
/// the follow-up is still wanted, just not next to a running agent, so the
/// next tick after that turn settles fires it.
fn workspace_is_busy(inner: &Arc<PollerInner>, workspace_id: &str) -> bool {
    let conn = inner.database.connection();
    conn.query_row(
        "SELECT EXISTS (SELECT 1 FROM sessions s JOIN workspaces w ON w.id = s.workspace_id
         JOIN workspaces target ON target.id = ?1
         WHERE w.path = target.path AND s.state IN ('running', 'waiting', 'blocked'))",
        [workspace_id],
        |row| row.get::<_, bool>(0),
    )
    .unwrap_or_else(|error| {
        tracing::warn!(%workspace_id, ?error, "gh poller: running-session guard failed");
        true
    })
}

/// Only verified work on the checkout's branch can launch an editing agent.
/// Referencing or pinning a PR alone does not authorize automatic work on it.
/// Returns the workspace and its project, so a caller (the Arc event block,
/// the ordinary check-failure branch's live-Arc lookup) does not need its own
/// separate round trip just for `project_id`.
fn resolve_workspace_id_for_pr_action(
    database: &Arc<Database>,
    session_id: &str,
    latest: &GhPrRecord,
) -> ArgmaxResult<Option<(String, String)>> {
    let conn = database.connection();
    let session = crate::persistence::sessions::find_session_by_id(&conn, session_id)?;
    let workspace =
        crate::persistence::workspaces::find_workspace_by_id(&conn, &session.workspace_id)?;
    if list_session_prs(&conn, session_id)?.iter().any(|pr| {
        pr.pr_number == latest.pr_number
            && pr.relationship == "worked"
            && pr.refresh_error.is_none()
            && (latest.pr_state.as_deref() == Some("MERGED")
                || pr.head_ref_name.as_deref() == Some(workspace.branch.as_str()))
    }) {
        Ok(Some((workspace.id, workspace.project_id)))
    } else {
        Ok(None)
    }
}

fn workspace_prs_are_merged(inner: &Arc<PollerInner>, workspace_id: &str) -> bool {
    let conn = inner.database.read_connection();
    match crate::persistence::workspaces::find_workspace_by_id(&conn, workspace_id) {
        Ok(workspace) => {
            let primary_is_merged_work = workspace.prs.iter().any(|pr| {
                pr.is_primary
                    && pr.relationship == "worked"
                    && pr.pr_state.as_deref() == Some("MERGED")
                    && pr.refresh_error.is_none()
            });
            let unfinished_work = conn.query_row(
                "SELECT EXISTS (
                    SELECT 1 FROM session_pr_links links
                    JOIN sessions s ON s.id = links.session_id
                    JOIN gh_pull_requests pr ON pr.project_id = links.project_id AND pr.pr_number = links.pr_number
                    WHERE s.workspace_id = ?1 AND links.relationship = 'worked'
                      AND links.dismissed_at IS NULL
                      AND (pr.pr_state IS NOT 'MERGED' OR pr.refresh_error IS NOT NULL)
                )", [workspace_id], |row| row.get::<_, bool>(0),
            );
            match unfinished_work {
                Ok(unfinished) => primary_is_merged_work && !unfinished,
                Err(error) => {
                    tracing::warn!(%workspace_id, %error, "gh poller: could not read unfinished work");
                    false
                }
            }
        }
        Err(error) => {
            tracing::warn!(%workspace_id, %error, "gh poller: could not check remaining PR work");
            false
        }
    }
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

    /// A second project/workspace/session (`p2`/`w2`/`s2`), separate from the
    /// primary fixture's `p1`/`w1`/`s1`. Used to prove an Arc event dedupes on
    /// `(arc_id, project_id, pr_number, ...)` rather than `pr_number` alone —
    /// two projects can each have their own PR #42.
    fn fixture_second_project(database: &Arc<Database>) {
        let conn = database.connection();
        persist_project(
            &conn,
            &PersistProjectInput {
                id: "p2".to_string(),
                name: "fixture-2".to_string(),
                repo_path: "/tmp/argmax-gh-poller-2".to_string(),
                default_branch: Some("main".to_string()),
                current_branch: "main".to_string(),
                settings: ProjectSettings {
                    archive_on_merge: false,
                    worktree_location: "/tmp/argmax-gh-poller-2/.worktrees".to_string(),
                    setup_command: String::new(),
                    check_commands: Vec::new(),
                },
            },
        )
        .expect("second project");
        persist_workspace(
            &conn,
            &PersistWorkspaceInput {
                id: "w2".to_string(),
                project_id: "p2".to_string(),
                task_label: "gh-poll-2".to_string(),
                branch: "feature/x".to_string(),
                base_ref: "main".to_string(),
                path: "/tmp/argmax-gh-poller-2".to_string(),
                state: "running".to_string(),
                shared_workspace: false,
                kind: "git".to_string(),
                dirty: false,
                changed_files: 0,
            },
        )
        .expect("second workspace");
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
                state: SessionState::Running,
            },
        )
        .expect("second session");
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
        record_explicit_pr_for_session(
            database,
            "s1",
            pr_number,
            pr_state,
            check_state,
            head_ref_name,
        )
    }

    fn record_explicit_pr_for_session(
        database: &Arc<Database>,
        session_id: &str,
        pr_number: i64,
        pr_state: &str,
        check_state: &str,
        head_ref_name: &str,
    ) -> GhPrRecord {
        let record = GhPrRecord {
            session_id: session_id.to_string(),
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
    fn refresh_fanout_includes_sessions_linked_without_legacy_cache_rows() {
        let (_dir, database) = open_db();
        fixture(&database);
        let conn = database.connection();
        conn.execute(
            "INSERT INTO workspaces (id, project_id, task_label, branch, base_ref, path, state, last_activity_at, created_at, updated_at)
             SELECT 'w2', project_id, task_label, branch, base_ref, path, state, last_activity_at, created_at, updated_at FROM workspaces WHERE id = 'w1'",
            [],
        ).unwrap();
        conn.execute(
            "INSERT INTO sessions (id, workspace_id, provider, model_label, prompt, state, attention, started_at, last_activity_at)
             SELECT 's2', 'w2', provider, model_label, prompt, state, attention, started_at, last_activity_at FROM sessions WHERE id = 's1'",
            [],
        ).unwrap();
        for session_id in ["s1", "s2"] {
            crate::persistence::gh::record_session_pr_evidence(
                &conn,
                session_id,
                48,
                "referenced",
                "view-48",
                "2026-09-14T06:50:00Z",
            )
            .unwrap();
        }
        let legacy_count: i64 = conn
            .query_row("SELECT COUNT(*) FROM gh_pr", [], |row| row.get(0))
            .unwrap();
        assert_eq!(legacy_count, 0);
        let mut ids = crate::gh::workspaces_for_pr_refresh(&conn, "s1")
            .unwrap()
            .into_iter()
            .map(|workspace| workspace.id)
            .collect::<Vec<_>>();
        ids.sort();
        assert_eq!(ids, vec!["w1", "w2"]);
    }

    #[test]
    fn older_session_work_still_controls_workspace_automation() {
        let (_dir, database) = open_db();
        fixture(&database);
        settle_session(&database, "s1");
        enable_archive_on_merge(&database);
        let older = record_explicit_pr(&database, 100, "OPEN", "failure", "feature/x");
        {
            let conn = database.connection();
            conn.execute(
                "INSERT INTO sessions (id, workspace_id, provider, model_label, prompt, state, attention, started_at, completed_at, last_activity_at)
                 SELECT 's2', workspace_id, provider, model_label, prompt, 'complete', attention, started_at, completed_at, '2026-09-15T00:00:00Z' FROM sessions WHERE id = 's1'", [],
            ).unwrap();
            crate::persistence::gh::record_session_pr_evidence(
                &conn,
                "s1",
                100,
                "worked",
                "create-100",
                "2026-09-14T06:00:00Z",
            )
            .unwrap();
            let mut newer = older.clone();
            newer.session_id = "s2".into();
            newer.pr_number = 101;
            newer.pr_state = Some("MERGED".into());
            crate::persistence::gh::store_gh_pr_observation(&conn, &newer).unwrap();
            crate::persistence::gh::record_session_pr_evidence(
                &conn,
                "s2",
                101,
                "worked",
                "create-101",
                "2026-09-14T07:00:00Z",
            )
            .unwrap();
        }
        let service =
            GhService::with_runner(Arc::clone(&database), StubRunner::new(Vec::new()).runner());
        let poller = GhPoller::new(
            GhPollerConfig::new(Arc::clone(&database), service)
                .with_pr_merged_hook(Arc::new(|_| {})),
        );
        assert!(
            detect_transition(
                &poller.inner,
                "s1",
                &older,
                &mut HashSet::new(),
                &HashMap::new()
            )
            .unwrap()
            .is_failure
        );
        assert!(
            !workspace_prs_are_merged(&poller.inner, "w1"),
            "older open work prevents archive"
        );
        record_explicit_pr(&database, 100, "CLOSED", "success", "feature/x");
        assert!(
            !workspace_prs_are_merged(&poller.inner, "w1"),
            "closed unmerged work prevents archive"
        );
        let merged = record_explicit_pr(&database, 100, "MERGED", "success", "feature/x");
        assert!(workspace_prs_are_merged(&poller.inner, "w1"));
        assert!(detect_transition(
            &poller.inner,
            "s1",
            &merged,
            &mut HashSet::new(),
            &HashMap::new()
        )
        .unwrap()
        .merged
        .is_some());
    }

    #[test]
    fn automation_requires_work_evidence_and_all_work_to_be_merged() {
        let (_dir, database) = open_db();
        fixture(&database);
        settle_session(&database, "s1");
        enable_archive_on_merge(&database);
        let stub = StubRunner::new(Vec::new());
        let service = GhService::with_runner(Arc::clone(&database), stub.runner());
        let poller = GhPoller::new(
            GhPollerConfig::new(Arc::clone(&database), service)
                .with_pr_merged_hook(Arc::new(|_| {})),
        );
        let mut reserved = HashSet::new();
        let reference = record_explicit_pr(&database, 200, "OPEN", "failure", "feature/x");
        {
            let conn = database.connection();
            crate::persistence::gh::record_session_pr_evidence(
                &conn,
                "s1",
                200,
                "referenced",
                "view-200",
                "2026-09-07T10:00:00Z",
            )
            .unwrap();
        }
        let transition = detect_transition(
            &poller.inner,
            "s1",
            &reference,
            &mut reserved,
            &HashMap::new(),
        )
        .unwrap();
        assert!(transition.publish);
        assert!(
            !transition.is_failure,
            "a viewed PR cannot launch an editing agent"
        );

        let failure = record_explicit_pr(&database, 100, "OPEN", "failure", "feature/x");
        {
            let conn = database.connection();
            crate::persistence::gh::record_session_pr_evidence(
                &conn,
                "s1",
                100,
                "worked",
                "create-100",
                "2026-09-07T10:01:00Z",
            )
            .unwrap();
        }
        assert!(
            detect_transition(
                &poller.inner,
                "s1",
                &failure,
                &mut reserved,
                &HashMap::new()
            )
            .unwrap()
            .is_failure
        );
        let other = record_explicit_pr(&database, 101, "OPEN", "failure", "feature/x");
        {
            let conn = database.connection();
            crate::persistence::gh::record_session_pr_evidence(
                &conn,
                "s1",
                101,
                "worked",
                "create-101",
                "2026-09-07T10:02:00Z",
            )
            .unwrap();
        }
        assert!(
            !detect_transition(&poller.inner, "s1", &other, &mut reserved, &HashMap::new())
                .unwrap()
                .is_failure,
            "one tick cannot schedule two agents in a checkout"
        );
        reserved.clear();
        assert!(
            detect_transition(&poller.inner, "s1", &other, &mut reserved, &HashMap::new())
                .unwrap()
                .is_failure,
            "deferred failures remain eligible next tick"
        );

        let merged = record_explicit_pr(&database, 101, "MERGED", "success", "feature/x");
        assert!(
            detect_transition(&poller.inner, "s1", &merged, &mut reserved, &HashMap::new())
                .unwrap()
                .merged
                .is_none(),
            "one merge cannot archive remaining open work"
        );
        record_explicit_pr(&database, 100, "MERGED", "success", "feature/x");
        assert_eq!(
            detect_transition(&poller.inner, "s1", &merged, &mut reserved, &HashMap::new())
                .unwrap()
                .merged,
            Some(MergedPrContext {
                workspace_id: "w1".into(),
                pr_number: 101
            })
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

        let pollable = pollable_sessions(&database).expect("pollable");
        assert!(!pollable.all.iter().any(|id| id == "s2"));
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
        assert!(deltas.last().unwrap().workspaces.iter().all(|workspace| {
            if workspace.id == "w1" {
                workspace.pr_state.as_deref() == Some("MERGED")
            } else {
                workspace.pr_state.is_none() && workspace.prs.is_empty()
            }
        }));
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

    /// Snoozing only hides a sidebar row. The poller still settles the
    /// workspace when its PR merges.
    #[tokio::test]
    async fn a_snoozed_workspace_is_still_archived_when_its_pr_merges() {
        let (_dir, database) = open_db();
        fixture(&database);
        settle_session(&database, "s1");
        enable_archive_on_merge(&database);
        let until = (chrono::Utc::now() + chrono::Duration::days(3))
            .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        crate::persistence::workspaces::set_workspace_snoozed_until(
            &database.connection(),
            "w1",
            Some(&until),
        )
        .expect("snooze");
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

        assert_eq!(merged.lock().expect("merged contexts poisoned").len(), 1);
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

    /// Answers every `gh` call with the current payload and counts the calls,
    /// so a test can tell which ticks actually refreshed.
    struct PayloadRunner {
        payload: Mutex<String>,
        calls: AtomicUsize,
    }

    impl PayloadRunner {
        fn new(payload: String) -> Arc<Self> {
            Arc::new(Self {
                payload: Mutex::new(payload),
                calls: AtomicUsize::new(0),
            })
        }

        fn set(&self, payload: String) {
            *self.payload.lock().expect("payload poisoned") = payload;
        }

        fn runner(self: Arc<Self>) -> GhRunner {
            Arc::new(move |_cwd, _args| {
                self.calls.fetch_add(1, Ordering::SeqCst);
                let payload = self.payload.lock().expect("payload poisoned").clone();
                Box::pin(async move { Ok(payload) })
            })
        }
    }

    fn pr_payload(head_sha: &str, conclusion: &str) -> String {
        format!(
            r#"{{"number": 42, "headRefOid": "{head_sha}", "headRefName": "feature/x", "state": "OPEN", "statusCheckRollup": [{{"conclusion": "{conclusion}"}}]}}"#
        )
    }

    /// Runs the ticks numbered `ticks` and returns the ones that called `gh`.
    async fn ticks_that_refreshed(
        poller: &GhPoller,
        runner: &PayloadRunner,
        ticks: std::ops::RangeInclusive<usize>,
    ) -> Vec<usize> {
        let mut refreshed = Vec::new();
        for tick in ticks {
            let before = runner.calls.load(Ordering::SeqCst);
            poller.tick_for_test().await.expect("tick");
            if runner.calls.load(Ordering::SeqCst) > before {
                refreshed.push(tick);
            }
        }
        refreshed
    }

    /// Outside the recently completed window, so only its open PR polls it.
    fn complete_session_long_ago(database: &Arc<Database>, session_id: &str) {
        let conn = database.connection();
        conn.execute(
            "UPDATE sessions SET state = 'complete', completed_at = '2000-01-01T00:00:00.000Z' WHERE id = ?",
            [session_id],
        )
        .expect("complete session long ago");
    }

    fn set_session_running(database: &Arc<Database>, session_id: &str) {
        let conn = database.connection();
        conn.execute(
            "UPDATE sessions SET state = 'running', completed_at = NULL WHERE id = ?",
            [session_id],
        )
        .expect("resume session");
    }

    fn seed_open_pr(database: &Arc<Database>) {
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

    fn open_pr_poller(
        database: &Arc<Database>,
        runner: &Arc<PayloadRunner>,
        failure_hook: Option<CheckFailureHook>,
    ) -> Arc<GhPoller> {
        let service = GhService::with_runner(Arc::clone(database), Arc::clone(runner).runner());
        let mut config = GhPollerConfig::new(Arc::clone(database), service);
        config.on_check_failure = failure_hook;
        GhPoller::new(config)
    }

    // A long-lived open PR nobody is working on costs a `gh` spawn per tick.
    // Once its checks settle and nothing moves, the wait doubles to the cap.
    #[tokio::test]
    async fn settled_open_pr_backs_off_to_the_cap() {
        let (_dir, database) = open_db();
        fixture(&database);
        complete_session_long_ago(&database, "s1");
        seed_open_pr(&database);
        let runner = PayloadRunner::new(pr_payload("feedface", "success"));
        let poller = open_pr_poller(&database, &runner, None);

        assert_eq!(
            ticks_that_refreshed(&poller, &runner, 1..=36).await,
            vec![1, 2, 4, 8, 16, 26, 36],
            "waits 1, 2, 4, 8, then the 10-tick cap"
        );
    }

    #[tokio::test]
    async fn a_pr_change_resets_the_backoff() {
        let (_dir, database) = open_db();
        fixture(&database);
        complete_session_long_ago(&database, "s1");
        seed_open_pr(&database);
        let runner = PayloadRunner::new(pr_payload("feedface", "success"));
        let poller = open_pr_poller(&database, &runner, None);

        assert_eq!(
            ticks_that_refreshed(&poller, &runner, 1..=7).await,
            vec![1, 2, 4]
        );
        runner.set(pr_payload("c0ffee", "success"));
        assert_eq!(
            ticks_that_refreshed(&poller, &runner, 8..=12).await,
            vec![8, 9, 11],
            "the push seen on tick 8 puts the PR back on every tick"
        );
    }

    // Pending checks can finish on any tick, so they never back off.
    #[tokio::test]
    async fn pending_checks_keep_an_open_pr_on_every_tick() {
        let (_dir, database) = open_db();
        fixture(&database);
        complete_session_long_ago(&database, "s1");
        seed_open_pr(&database);
        let runner = PayloadRunner::new(pr_payload("feedface", "pending"));
        let poller = open_pr_poller(&database, &runner, None);

        assert_eq!(
            ticks_that_refreshed(&poller, &runner, 1..=5).await,
            vec![1, 2, 3, 4, 5]
        );
    }

    #[tokio::test]
    async fn a_running_session_refreshes_every_tick_and_restarts_its_backoff() {
        let (_dir, database) = open_db();
        fixture(&database);
        complete_session_long_ago(&database, "s1");
        seed_open_pr(&database);
        let runner = PayloadRunner::new(pr_payload("feedface", "success"));
        let poller = open_pr_poller(&database, &runner, None);

        assert_eq!(
            ticks_that_refreshed(&poller, &runner, 1..=4).await,
            vec![1, 2, 4]
        );
        set_session_running(&database, "s1");
        assert_eq!(
            ticks_that_refreshed(&poller, &runner, 5..=7).await,
            vec![5, 6, 7],
            "a running session ignores the backoff it had built up"
        );
        complete_session_long_ago(&database, "s1");
        assert_eq!(
            ticks_that_refreshed(&poller, &runner, 8..=11).await,
            vec![8, 10],
            "back to open-PR-only, it starts over from every tick"
        );
    }

    // The follow-up must survive both the backoff and its own deferral: the
    // failure lands while another turn holds the checkout, and a check that
    // stays red offers no second change to reset the backoff on.
    #[tokio::test]
    async fn a_failing_push_fires_the_follow_up_after_backoff_started() {
        let (_dir, database) = open_db();
        fixture(&database);
        complete_session_long_ago(&database, "s1");
        seed_open_pr(&database);
        let runner = PayloadRunner::new(pr_payload("feedface", "success"));
        let failure_hits = Arc::new(AtomicUsize::new(0));
        let failure_count = Arc::clone(&failure_hits);
        let hook: CheckFailureHook = Arc::new(move |ctx: CheckFailureContext| {
            assert_eq!(ctx.head_sha, "badc0de");
            failure_count.fetch_add(1, Ordering::SeqCst);
        });
        let poller = open_pr_poller(&database, &runner, Some(hook));

        assert_eq!(
            ticks_that_refreshed(&poller, &runner, 1..=4).await,
            vec![1, 2, 4]
        );

        runner.set(pr_payload("badc0de", "failure"));
        {
            // Waiting holds the checkout without joining the every-tick set.
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
                    prompt: "busy".to_string(),
                    state: SessionState::Waiting,
                },
            )
            .expect("busy session");
        }
        assert_eq!(
            ticks_that_refreshed(&poller, &runner, 5..=9).await,
            vec![8, 9]
        );
        assert_eq!(
            failure_hits.load(Ordering::SeqCst),
            0,
            "deferred while the checkout is busy"
        );

        complete_session_long_ago(&database, "s2");
        assert_eq!(
            ticks_that_refreshed(&poller, &runner, 10..=10).await,
            vec![10],
            "a deferred follow-up keeps the PR on every tick"
        );
        assert_eq!(failure_hits.load(Ordering::SeqCst), 1);
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

    // --- Arc PR/CI events ---------------------------------------------

    /// A coordinator session in its own workspace, distinct from the
    /// fixture's `w1`/`s1` member. Not archiving/archived, which combined
    /// with `state = 'active'` is what makes an Arc pointed at it live.
    fn seed_coordinator(database: &Arc<Database>, workspace_id: &str, session_id: &str) {
        let conn = database.connection();
        persist_workspace(
            &conn,
            &PersistWorkspaceInput {
                id: workspace_id.to_string(),
                project_id: "p1".to_string(),
                task_label: "coordinator".to_string(),
                branch: "coordinator".to_string(),
                base_ref: "main".to_string(),
                path: format!("/tmp/argmax-gh-poller-{workspace_id}"),
                state: "running".to_string(),
                shared_workspace: false,
                kind: "git".to_string(),
                dirty: false,
                changed_files: 0,
            },
        )
        .expect("coordinator workspace");
        persist_session(
            &conn,
            &PersistSessionInput {
                id: session_id.to_string(),
                workspace_id: workspace_id.to_string(),
                provider: "claude".to_string(),
                model_label: "Haiku 4.5".to_string(),
                model_id: "claude-haiku-4.5".to_string(),
                reasoning_effort: None,
                permission_mode: Some("auto-approve".to_string()),
                agent_mode: Some("auto".to_string()),
                prompt: "coordinate".to_string(),
                state: SessionState::Waiting,
            },
        )
        .expect("coordinator session");
    }

    fn seed_arc(
        database: &Arc<Database>,
        arc_id: &str,
        state: &str,
        coordinator_session_id: Option<&str>,
    ) {
        let conn = database.connection();
        conn.execute(
            "INSERT INTO arcs (id, name, brief, state, home_project_id, coordinator_session_id, dir, created_at, updated_at)
             VALUES (?1, 'Test Arc', '', ?2, 'p1', ?3, '/tmp/argmax-arc', ?4, ?4)",
            rusqlite::params![arc_id, state, coordinator_session_id, now_iso()],
        )
        .expect("seed arc");
    }

    fn set_session_arc(database: &Arc<Database>, session_id: &str, arc_id: &str) {
        let conn = database.connection();
        conn.execute(
            "UPDATE sessions SET arc_id = ? WHERE id = ?",
            rusqlite::params![arc_id, session_id],
        )
        .expect("set session arc");
    }

    fn arc_event_recorder() -> (Arc<Mutex<Vec<ArcEventContext>>>, ArcEventHook) {
        let events = Arc::new(Mutex::new(Vec::new()));
        let recorded = Arc::clone(&events);
        let hook: ArcEventHook = Arc::new(move |context| {
            recorded.lock().expect("arc events poisoned").push(context);
        });
        (events, hook)
    }

    /// Records like `arc_event_recorder`, and also inserts the
    /// `session_messages` row `send_system_notice` would leave behind on a
    /// successful delivery — the real hook (`handle_gh_arc_event` in lib.rs)
    /// does this via the provider send; the poller's own later-tick
    /// suppression check only cares that the row with this exact
    /// `message_id` exists, so a direct insert is a faithful stand-in without
    /// wiring a real `ProviderSessionService`.
    fn arc_event_recorder_with_delivery(
        database: &Arc<Database>,
    ) -> (Arc<Mutex<Vec<ArcEventContext>>>, ArcEventHook) {
        let events = Arc::new(Mutex::new(Vec::new()));
        let recorded = Arc::clone(&events);
        let database = Arc::clone(database);
        let hook: ArcEventHook = Arc::new(move |context| {
            let conn = database.connection();
            crate::persistence::session_messages::insert_session_message(
                &conn,
                &crate::persistence::session_messages::NewSessionMessage {
                    id: context.message_id.clone(),
                    from_session_id: None,
                    to_session_id: context.coordinator_session_id.clone(),
                    body: "test notice".to_string(),
                    kind: crate::persistence::session_messages::MESSAGE_KIND.to_string(),
                },
            )
            .expect("simulate delivered arc notice");
            recorded.lock().expect("arc events poisoned").push(context);
        });
        (events, hook)
    }

    /// A failing member PR of a live Arc gets exactly one coordinator
    /// message across repeated ticks, and once that notice is actually
    /// delivered, the automatic check-failure follow-up stays suppressed —
    /// the coordinator decides instead.
    #[tokio::test]
    async fn arc_event_fires_once_for_failing_live_arc_member_and_suppresses_follow_up_on_successful_delivery(
    ) {
        let (_dir, database) = open_db();
        fixture(&database);
        settle_session(&database, "s1");
        seed_coordinator(&database, "w-coord", "s-coord");
        seed_arc(&database, "arc-1", "active", Some("s-coord"));
        set_session_arc(&database, "s1", "arc-1");

        let failure_payload = r#"{"number": 42, "headRefOid": "feedface", "headRefName": "feature/x", "state": "OPEN", "statusCheckRollup": [{"conclusion": "failure"}]}"#;
        let stub = StubRunner::new(vec![
            Ok(failure_payload.to_string()),
            Ok(failure_payload.to_string()),
        ]);
        let service = GhService::with_runner(Arc::clone(&database), Arc::clone(&stub).runner());

        let failure_hits = Arc::new(AtomicUsize::new(0));
        let failure_count = Arc::clone(&failure_hits);
        let failure_hook: CheckFailureHook = Arc::new(move |_| {
            failure_count.fetch_add(1, Ordering::SeqCst);
        });
        let (events, arc_hook) = arc_event_recorder_with_delivery(&database);

        let poller = GhPoller::new(
            GhPollerConfig::new(Arc::clone(&database), service)
                .with_check_failure_hook(failure_hook)
                .with_arc_event_hook(arc_hook),
        );

        poller.tick_for_test().await.expect("first failure tick");
        poller.tick_for_test().await.expect("still failing tick");

        assert_eq!(
            failure_hits.load(Ordering::SeqCst),
            0,
            "a live Arc's member suppresses the automatic check-failure follow-up once its notice is delivered"
        );
        let recorded = events.lock().expect("arc events poisoned");
        assert_eq!(
            recorded.len(),
            1,
            "one coordinator message across repeated failing ticks"
        );
        assert_eq!(recorded[0].kind, ArcEventKind::ChecksFailing);
        assert_eq!(recorded[0].arc_id, "arc-1");
        assert_eq!(recorded[0].coordinator_session_id, "s-coord");
        assert_eq!(recorded[0].session_id, "s1");
        assert_eq!(recorded[0].pr_number, 42);
    }

    /// When the Arc notice's delivery never lands in `session_messages` — the
    /// send failed, or nothing was even wired to attempt it — a later tick's
    /// re-evaluation falls through to the ordinary check-failure follow-up,
    /// with its normal gates (busy checkout, dedupe).
    #[tokio::test]
    async fn arc_event_failing_delivery_falls_through_to_check_failure_follow_up() {
        let (_dir, database) = open_db();
        fixture(&database);
        settle_session(&database, "s1");
        seed_coordinator(&database, "w-coord", "s-coord");
        seed_arc(&database, "arc-1", "active", Some("s-coord"));
        set_session_arc(&database, "s1", "arc-1");

        let failure_payload = r#"{"number": 42, "headRefOid": "feedface", "headRefName": "feature/x", "state": "OPEN", "statusCheckRollup": [{"conclusion": "failure"}]}"#;
        let stub = StubRunner::new(vec![
            Ok(failure_payload.to_string()),
            Ok(failure_payload.to_string()),
        ]);
        let service = GhService::with_runner(Arc::clone(&database), Arc::clone(&stub).runner());

        let failure_hits = Arc::new(AtomicUsize::new(0));
        let failure_count = Arc::clone(&failure_hits);
        let failure_hook: CheckFailureHook = Arc::new(move |_| {
            failure_count.fetch_add(1, Ordering::SeqCst);
        });
        // The plain recorder never inserts into `session_messages` — standing
        // in for a delivery that failed (or was never attempted).
        let (events, arc_hook) = arc_event_recorder();

        let poller = GhPoller::new(
            GhPollerConfig::new(Arc::clone(&database), service)
                .with_check_failure_hook(failure_hook)
                .with_arc_event_hook(arc_hook),
        );

        poller.tick_for_test().await.expect("first failure tick");
        assert_eq!(
            failure_hits.load(Ordering::SeqCst),
            0,
            "the fresh transition gives the Arc event first crack at delivery"
        );
        poller.tick_for_test().await.expect("still failing tick");

        assert_eq!(
            failure_hits.load(Ordering::SeqCst),
            1,
            "an undelivered Arc notice falls through to the ordinary follow-up"
        );
        assert_eq!(
            events.lock().expect("arc events poisoned").len(),
            1,
            "the Arc event itself still only fires once for this transition"
        );
    }

    /// `pr_number` alone is not a unique key: two projects in the same Arc
    /// can each have their own PR #42, and each gets its own notice.
    #[tokio::test]
    async fn arc_event_dedupes_by_project_not_pr_number_alone() {
        let (_dir, database) = open_db();
        fixture(&database);
        fixture_second_project(&database);
        settle_session(&database, "s1");
        settle_session(&database, "s2");
        seed_coordinator(&database, "w-coord", "s-coord");
        seed_arc(&database, "arc-1", "active", Some("s-coord"));
        set_session_arc(&database, "s1", "arc-1");
        set_session_arc(&database, "s2", "arc-1");

        let failure_payload = r#"{"number": 42, "headRefOid": "feedface", "headRefName": "feature/x", "state": "OPEN", "statusCheckRollup": [{"conclusion": "failure"}]}"#;
        let stub = StubRunner::new(vec![
            Ok(failure_payload.to_string()),
            Ok(failure_payload.to_string()),
        ]);
        let service = GhService::with_runner(Arc::clone(&database), Arc::clone(&stub).runner());
        let (events, arc_hook) = arc_event_recorder();
        let poller = GhPoller::new(
            GhPollerConfig::new(Arc::clone(&database), service).with_arc_event_hook(arc_hook),
        );

        poller.tick_for_test().await.expect("both projects fail");

        let recorded = events.lock().expect("arc events poisoned");
        assert_eq!(
            recorded.len(),
            2,
            "each project's PR #42 gets its own notice"
        );
        let mut sessions: Vec<_> = recorded
            .iter()
            .map(|event| event.session_id.clone())
            .collect();
        sessions.sort();
        assert_eq!(sessions, vec!["s1", "s2"]);
        assert_ne!(
            recorded[0].message_id, recorded[1].message_id,
            "the message id must include project_id to avoid colliding"
        );
    }

    /// Failing, then passing, then failing again on the same commit sends
    /// three notices — each is its own transition.
    #[tokio::test]
    async fn arc_event_fires_on_each_swing_between_failing_and_passing() {
        let (_dir, database) = open_db();
        fixture(&database);
        settle_session(&database, "s1");
        seed_coordinator(&database, "w-coord", "s-coord");
        seed_arc(&database, "arc-1", "active", Some("s-coord"));
        set_session_arc(&database, "s1", "arc-1");

        let failure_payload = r#"{"number": 42, "headRefOid": "feedface", "headRefName": "feature/x", "state": "OPEN", "statusCheckRollup": [{"conclusion": "failure"}]}"#;
        let passing_payload = r#"{"number": 42, "headRefOid": "feedface", "headRefName": "feature/x", "state": "OPEN", "statusCheckRollup": [{"conclusion": "success"}]}"#;
        let stub = StubRunner::new(vec![
            Ok(failure_payload.to_string()),
            Ok(passing_payload.to_string()),
            Ok(failure_payload.to_string()),
        ]);
        let service = GhService::with_runner(Arc::clone(&database), Arc::clone(&stub).runner());
        let (events, arc_hook) = arc_event_recorder();
        let poller = GhPoller::new(
            GhPollerConfig::new(Arc::clone(&database), service).with_arc_event_hook(arc_hook),
        );

        poller.tick_for_test().await.expect("failing tick");
        poller.tick_for_test().await.expect("passing tick");
        poller.tick_for_test().await.expect("failing again tick");

        let recorded = events.lock().expect("arc events poisoned");
        let kinds: Vec<_> = recorded.iter().map(|event| event.kind).collect();
        assert_eq!(
            kinds,
            vec![
                ArcEventKind::ChecksFailing,
                ArcEventKind::ChecksPassing,
                ArcEventKind::ChecksFailing
            ],
            "each swing on the same sha is its own transition"
        );
    }

    /// A fresh poller (simulating a restart) against a PR already persisted
    /// as failing sees no transition, so an unchanged red PR gets no notice.
    #[tokio::test]
    async fn arc_event_skips_unchanged_red_pr_after_simulated_restart() {
        let (_dir, database) = open_db();
        fixture(&database);
        settle_session(&database, "s1");
        seed_coordinator(&database, "w-coord", "s-coord");
        seed_arc(&database, "arc-1", "active", Some("s-coord"));
        set_session_arc(&database, "s1", "arc-1");
        // Already failing before the (simulated-restart) poller's first tick.
        record_explicit_pr(&database, 42, "OPEN", "failure", "feature/x");

        let failure_payload = r#"{"number": 42, "headRefOid": "feedface", "headRefName": "feature/x", "state": "OPEN", "statusCheckRollup": [{"conclusion": "failure"}]}"#;
        let stub = StubRunner::new(vec![Ok(failure_payload.to_string())]);
        let service = GhService::with_runner(Arc::clone(&database), Arc::clone(&stub).runner());
        let (events, arc_hook) = arc_event_recorder();
        // A fresh `GhPoller` starts with an empty in-memory `last_state`, the
        // same as a real process restart.
        let poller = GhPoller::new(
            GhPollerConfig::new(Arc::clone(&database), service).with_arc_event_hook(arc_hook),
        );

        poller.tick_for_test().await.expect("unchanged red tick");

        assert_eq!(
            events.lock().expect("arc events poisoned").len(),
            0,
            "no transition means no notice, even from a cold in-memory state"
        );
    }

    /// Checks passing after failing sends exactly one coordinator message.
    #[tokio::test]
    async fn arc_event_fires_once_when_checks_pass_after_failing() {
        let (_dir, database) = open_db();
        fixture(&database);
        settle_session(&database, "s1");
        seed_coordinator(&database, "w-coord", "s-coord");
        seed_arc(&database, "arc-1", "active", Some("s-coord"));
        set_session_arc(&database, "s1", "arc-1");

        let failure_payload = r#"{"number": 42, "headRefOid": "feedface", "headRefName": "feature/x", "state": "OPEN", "statusCheckRollup": [{"conclusion": "failure"}]}"#;
        let passing_payload = r#"{"number": 42, "headRefOid": "feedface", "headRefName": "feature/x", "state": "OPEN", "statusCheckRollup": [{"conclusion": "success"}]}"#;
        let stub = StubRunner::new(vec![
            Ok(failure_payload.to_string()),
            Ok(passing_payload.to_string()),
            Ok(passing_payload.to_string()),
        ]);
        let service = GhService::with_runner(Arc::clone(&database), Arc::clone(&stub).runner());
        let (events, arc_hook) = arc_event_recorder();
        let poller = GhPoller::new(
            GhPollerConfig::new(Arc::clone(&database), service).with_arc_event_hook(arc_hook),
        );

        poller.tick_for_test().await.expect("failing tick");
        poller.tick_for_test().await.expect("passing tick");
        poller.tick_for_test().await.expect("still passing tick");

        let recorded = events.lock().expect("arc events poisoned");
        let passing: Vec<_> = recorded
            .iter()
            .filter(|event| event.kind == ArcEventKind::ChecksPassing)
            .collect();
        assert_eq!(passing.len(), 1, "one message for the passing transition");
    }

    /// A merged PR sends exactly one coordinator message, regardless of the
    /// project's `archive_on_merge` setting (off in the fixture).
    #[tokio::test]
    async fn arc_event_fires_once_on_merge_regardless_of_archive_setting() {
        let (_dir, database) = open_db();
        fixture(&database);
        settle_session(&database, "s1");
        seed_coordinator(&database, "w-coord", "s-coord");
        seed_arc(&database, "arc-1", "active", Some("s-coord"));
        set_session_arc(&database, "s1", "arc-1");

        let merged_payload = r#"{"number": 42, "headRefOid": "feedface", "headRefName": "feature/x", "state": "MERGED", "statusCheckRollup": [{"conclusion": "success"}]}"#;
        let stub = StubRunner::new(vec![
            Ok(merged_payload.to_string()),
            Ok(merged_payload.to_string()),
        ]);
        let service = GhService::with_runner(Arc::clone(&database), Arc::clone(&stub).runner());
        let (events, arc_hook) = arc_event_recorder();
        let poller = GhPoller::new(
            GhPollerConfig::new(Arc::clone(&database), service).with_arc_event_hook(arc_hook),
        );

        poller.tick_for_test().await.expect("merge tick");
        poller.tick_for_test().await.expect("still merged tick");

        let recorded = events.lock().expect("arc events poisoned");
        let merged: Vec<_> = recorded
            .iter()
            .filter(|event| event.kind == ArcEventKind::Merged)
            .collect();
        assert_eq!(
            merged.len(),
            1,
            "one message for the merge, deduped across ticks"
        );
    }

    /// A paused Arc gets no events at all, and the ordinary check-failure
    /// follow-up behaves exactly as it would with no Arc.
    #[tokio::test]
    async fn paused_arc_gets_no_events_and_follow_up_behaviour_unchanged() {
        let (_dir, database) = open_db();
        fixture(&database);
        settle_session(&database, "s1");
        seed_coordinator(&database, "w-coord", "s-coord");
        seed_arc(&database, "arc-1", "paused", Some("s-coord"));
        set_session_arc(&database, "s1", "arc-1");

        let failure_payload = r#"{"number": 42, "headRefOid": "feedface", "headRefName": "feature/x", "state": "OPEN", "statusCheckRollup": [{"conclusion": "failure"}]}"#;
        let stub = StubRunner::new(vec![Ok(failure_payload.to_string())]);
        let service = GhService::with_runner(Arc::clone(&database), Arc::clone(&stub).runner());

        let failure_hits = Arc::new(AtomicUsize::new(0));
        let failure_count = Arc::clone(&failure_hits);
        let failure_hook: CheckFailureHook = Arc::new(move |_| {
            failure_count.fetch_add(1, Ordering::SeqCst);
        });
        let (events, arc_hook) = arc_event_recorder();
        let poller = GhPoller::new(
            GhPollerConfig::new(Arc::clone(&database), service)
                .with_check_failure_hook(failure_hook)
                .with_arc_event_hook(arc_hook),
        );

        poller.tick_for_test().await.expect("paused arc tick");

        assert_eq!(
            events.lock().expect("arc events poisoned").len(),
            0,
            "a paused Arc is not live and gets no events"
        );
        assert_eq!(
            failure_hits.load(Ordering::SeqCst),
            1,
            "a paused Arc does not suppress the ordinary follow-up"
        );
    }

    /// A session with no Arc keeps today's behaviour exactly: the ordinary
    /// follow-up fires and no Arc event is ever recorded.
    #[tokio::test]
    async fn non_arc_session_keeps_existing_check_failure_behaviour() {
        let (_dir, database) = open_db();
        fixture(&database);
        settle_session(&database, "s1");

        let failure_payload = r#"{"number": 42, "headRefOid": "feedface", "headRefName": "feature/x", "state": "OPEN", "statusCheckRollup": [{"conclusion": "failure"}]}"#;
        let stub = StubRunner::new(vec![Ok(failure_payload.to_string())]);
        let service = GhService::with_runner(Arc::clone(&database), Arc::clone(&stub).runner());

        let failure_hits = Arc::new(AtomicUsize::new(0));
        let failure_count = Arc::clone(&failure_hits);
        let failure_hook: CheckFailureHook = Arc::new(move |_| {
            failure_count.fetch_add(1, Ordering::SeqCst);
        });
        let (events, arc_hook) = arc_event_recorder();
        let poller = GhPoller::new(
            GhPollerConfig::new(Arc::clone(&database), service)
                .with_check_failure_hook(failure_hook)
                .with_arc_event_hook(arc_hook),
        );

        poller.tick_for_test().await.expect("no-arc failure tick");

        assert_eq!(failure_hits.load(Ordering::SeqCst), 1);
        assert_eq!(events.lock().expect("arc events poisoned").len(), 0);
    }

    /// A coordinator that is itself the PR's worker still gets the message —
    /// nothing excludes `session_id == coordinator_session_id`.
    #[tokio::test]
    async fn arc_event_fires_when_the_coordinator_is_the_worker_itself() {
        let (_dir, database) = open_db();
        fixture(&database);
        settle_session(&database, "s1");
        seed_arc(&database, "arc-1", "active", Some("s1"));
        set_session_arc(&database, "s1", "arc-1");

        let failure_payload = r#"{"number": 42, "headRefOid": "feedface", "headRefName": "feature/x", "state": "OPEN", "statusCheckRollup": [{"conclusion": "failure"}]}"#;
        let stub = StubRunner::new(vec![Ok(failure_payload.to_string())]);
        let service = GhService::with_runner(Arc::clone(&database), Arc::clone(&stub).runner());
        let (events, arc_hook) = arc_event_recorder();
        let poller = GhPoller::new(
            GhPollerConfig::new(Arc::clone(&database), service).with_arc_event_hook(arc_hook),
        );

        poller.tick_for_test().await.expect("self-coordinator tick");

        let recorded = events.lock().expect("arc events poisoned");
        assert_eq!(recorded.len(), 1);
        assert_eq!(recorded[0].coordinator_session_id, "s1");
        assert_eq!(recorded[0].session_id, "s1");
    }

    // --- PR watch -----------------------------------------------------

    const PR_URL: &str = "https://github.com/acme/widgets/pull/42";
    const OLD: &str = "2020-01-01T00:00:00Z";
    const NEW: &str = "2999-01-01T00:00:00Z";

    /// One `gh pr view` / `gh pr list` payload that both the refresh and the
    /// watch pass read: the refresh ignores the feedback fields.
    struct WatchedPr {
        head: &'static str,
        state: &'static str,
        rollup: serde_json::Value,
        reviews: serde_json::Value,
        comments: serde_json::Value,
        updated_at: &'static str,
        branch: &'static str,
        merge_commit: &'static str,
        /// GitHub's `mergeable`: `MERGEABLE`, `CONFLICTING` or `UNKNOWN`.
        /// Unset reads as no field at all, like older `gh` output.
        mergeable: Option<&'static str>,
    }

    impl Default for WatchedPr {
        fn default() -> Self {
            Self {
                head: "feedface",
                state: "OPEN",
                rollup: serde_json::json!([{"name": "build", "status": "IN_PROGRESS", "conclusion": ""}]),
                reviews: serde_json::json!([]),
                comments: serde_json::json!([]),
                updated_at: "2026-10-01T00:00:00Z",
                branch: "feature/x",
                merge_commit: "abc1234ffff",
                mergeable: None,
            }
        }
    }

    impl WatchedPr {
        fn payload(&self) -> String {
            serde_json::json!({
                "number": 42,
                "title": "Fix parser",
                "url": PR_URL,
                "headRefOid": self.head,
                "headRefName": self.branch,
                "baseRefName": "main",
                "headRepositoryOwner": {"login": "acme"},
                "state": self.state,
                "statusCheckRollup": self.rollup,
                "reviews": self.reviews,
                "comments": self.comments,
                "reviewRequests": [{"__typename": "User", "login": "carol"}],
                "updatedAt": self.updated_at,
                "mergeCommit": (self.state == "MERGED").then(|| serde_json::json!({"oid": self.merge_commit})),
                "mergeable": self.mergeable,
            })
            .to_string()
        }
    }

    fn threads_payload(threads: serde_json::Value) -> String {
        serde_json::json!({"data": {"repository": {"pullRequest": {"reviewThreads": {"nodes": threads}}}}})
            .to_string()
    }

    /// Answers `gh api graphql` with the threads payload and every `gh pr`
    /// call with the PR payload. The watch pass's own view (the one asking for
    /// `reviews`) can be made to fail.
    struct WatchRunner {
        pr: Mutex<String>,
        threads: Mutex<String>,
        watch_view_error: Mutex<Option<String>>,
        calls: AtomicUsize,
    }

    impl WatchRunner {
        fn new(pr: WatchedPr) -> Arc<Self> {
            Arc::new(Self {
                pr: Mutex::new(pr.payload()),
                threads: Mutex::new(threads_payload(serde_json::json!([]))),
                watch_view_error: Mutex::new(None),
                calls: AtomicUsize::new(0),
            })
        }

        fn set(&self, pr: WatchedPr) {
            *self.pr.lock().expect("pr poisoned") = pr.payload();
        }

        fn set_threads(&self, threads: serde_json::Value) {
            *self.threads.lock().expect("threads poisoned") = threads_payload(threads);
        }

        fn fail_watch_view(&self, error: Option<&str>) {
            *self.watch_view_error.lock().expect("error poisoned") = error.map(str::to_string);
        }

        fn runner(self: Arc<Self>) -> GhRunner {
            Arc::new(move |_cwd, args: Vec<String>| {
                self.calls.fetch_add(1, Ordering::SeqCst);
                let result = if args.first().map(String::as_str) == Some("api") {
                    Ok(self.threads.lock().expect("threads poisoned").clone())
                } else if args.iter().any(|arg| arg.contains("reviews")) {
                    match self
                        .watch_view_error
                        .lock()
                        .expect("error poisoned")
                        .clone()
                    {
                        Some(error) => Err(ArgmaxError::service("GH_NON_ZERO_EXIT", error)),
                        None => Ok(self.pr.lock().expect("pr poisoned").clone()),
                    }
                } else {
                    Ok(self.pr.lock().expect("pr poisoned").clone())
                };
                Box::pin(async move { result })
            })
        }
    }

    fn seed_watch(database: &Arc<Database>) {
        let conn = database.connection();
        crate::persistence::pr_watches::upsert_pr_watch(
            &conn, "watch-1", "s1", "p1", 42, false, "",
        )
        .expect("seed watch");
    }

    fn watch_row(
        database: &Arc<Database>,
    ) -> Option<crate::persistence::pr_watches::PrWatchRecord> {
        let conn = database.read_connection();
        crate::persistence::pr_watches::find_pr_watch(&conn, "s1", "p1", 42).expect("read watch")
    }

    /// Stores the inbox row the way `send_system_notice` does, so dedupe is
    /// the real `INSERT OR IGNORE`.
    fn notice_recorder(
        database: &Arc<Database>,
    ) -> (
        Arc<Mutex<Vec<crate::gh::watch::PrWatchNotice>>>,
        PrWatchNoticeHook,
    ) {
        let notices = Arc::new(Mutex::new(Vec::new()));
        let recorded = Arc::clone(&notices);
        let database = Arc::clone(database);
        let hook: PrWatchNoticeHook = Arc::new(move |notice: crate::gh::watch::PrWatchNotice| {
            let inserted = crate::persistence::session_messages::insert_session_message(
                &database.connection(),
                &crate::persistence::session_messages::NewSessionMessage {
                    id: notice.message_id.clone(),
                    from_session_id: None,
                    to_session_id: notice.session_id.clone(),
                    body: notice.body.clone(),
                    kind: crate::persistence::session_messages::MESSAGE_KIND.to_string(),
                },
            );
            recorded.lock().expect("notices poisoned").push(notice);
            Box::pin(async move { inserted })
        });
        (notices, hook)
    }

    fn inbox(database: &Arc<Database>) -> Vec<(String, String)> {
        let conn = database.read_connection();
        let mut statement = conn
            .prepare(
                "SELECT id, body FROM session_messages WHERE to_session_id = 's1' ORDER BY rowid",
            )
            .expect("prepare inbox");
        statement
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
            .expect("query inbox")
            .collect::<Result<Vec<_>, _>>()
            .expect("collect inbox")
    }

    fn watch_poller(
        database: &Arc<Database>,
        runner: &Arc<WatchRunner>,
        hook: PrWatchNoticeHook,
    ) -> Arc<GhPoller> {
        let service = GhService::with_runner(Arc::clone(database), Arc::clone(runner).runner());
        GhPoller::new(
            GhPollerConfig::new(Arc::clone(database), service).with_watch_notice_hook(hook),
        )
    }

    fn failing_build() -> serde_json::Value {
        serde_json::json!([
            {"name": "build", "workflowName": "CI", "status": "COMPLETED", "conclusion": "FAILURE", "detailsUrl": "https://ci.example/build"},
            {"name": "lint", "workflowName": "CI", "status": "COMPLETED", "conclusion": "SUCCESS"}
        ])
    }

    fn green_checks() -> serde_json::Value {
        serde_json::json!([
            {"name": "build", "status": "COMPLETED", "conclusion": "SUCCESS"},
            {"name": "docs", "status": "COMPLETED", "conclusion": "SKIPPED"}
        ])
    }

    #[tokio::test]
    async fn watch_reports_each_failing_check_once_per_head() {
        let (_dir, database) = open_db();
        fixture(&database);
        complete_session_long_ago(&database, "s1");
        seed_watch(&database);
        let runner = WatchRunner::new(WatchedPr {
            rollup: failing_build(),
            ..Default::default()
        });
        let (_notices, hook) = notice_recorder(&database);
        let poller = watch_poller(&database, &runner, hook);

        poller.tick_for_test().await.expect("failing tick");
        poller.tick_for_test().await.expect("still failing tick");
        let rows = inbox(&database);
        assert_eq!(rows.len(), 1, "one notice for one failure: {rows:?}");
        assert_eq!(
            rows[0].1,
            format!(
                "PR #42 (Fix parser): 1 check failing on feedfac.\nChecks failing on feedfac:\n- CI / build: https://ci.example/build\n{PR_URL}"
            )
        );
        assert_eq!(rows[0].0, "pr-watch:watch-1:1:feedfac");

        runner.set(WatchedPr {
            head: "badc0de",
            rollup: failing_build(),
            ..Default::default()
        });
        poller.tick_for_test().await.expect("new head tick");
        let rows = inbox(&database);
        assert_eq!(rows.len(), 2, "a new head reports its own failure");
        assert_eq!(rows[1].0, "pr-watch:watch-1:2:badc0de");
        assert_eq!(
            watch_row(&database).expect("watch").seen_check_failures,
            vec!["CI/build@badc0de".to_string()],
            "the old head's failures are forgotten"
        );
    }

    #[tokio::test]
    async fn watch_reports_new_feedback_once_and_seeds_what_predates_it() {
        let (_dir, database) = open_db();
        fixture(&database);
        complete_session_long_ago(&database, "s1");
        seed_watch(&database);
        let comments = serde_json::json!([
            {"id": "IC_old", "author": {"login": "alice"}, "body": "Old note", "createdAt": OLD, "url": "https://x/old"},
            {"id": "IC_bot", "author": {"login": "coderabbitai[bot]"}, "body": "\n## Walkthrough\nmore", "createdAt": NEW, "url": "https://x/bot"},
            {"id": "IC_mine", "author": {"login": "me"}, "body": "Fixed in abc", "createdAt": NEW, "viewerDidAuthor": true}
        ]);
        let reviews = serde_json::json!([
            {"id": "PRR_1", "author": {"login": "bob"}, "state": "CHANGES_REQUESTED", "body": "Please split this.\nDetails", "submittedAt": NEW, "commit": {"oid": "feedface"}},
            {"id": "PRR_2", "author": {"login": "bob"}, "state": "COMMENTED", "body": "", "submittedAt": NEW, "commit": {"oid": "feedface"}}
        ]);
        let runner = WatchRunner::new(WatchedPr {
            comments: comments.clone(),
            reviews,
            ..Default::default()
        });
        runner.set_threads(serde_json::json!([{
            "id": "PRRT_1", "isResolved": false, "path": "src/x.rs", "line": 12,
            "comments": {"nodes": [{"id": "PRRC_1", "author": {"login": "chatgpt-codex-connector", "__typename": "Bot"}, "body": "Off by one", "url": "https://x/r1", "createdAt": NEW}]}
        }]));
        let (_notices, hook) = notice_recorder(&database);
        let poller = watch_poller(&database, &runner, hook);

        poller.tick_for_test().await.expect("feedback tick");
        poller.tick_for_test().await.expect("quiet tick");
        let rows = inbox(&database);
        assert_eq!(rows.len(), 1, "{rows:?}");
        assert_eq!(
            rows[0].1,
            format!(
                "PR #42 (Fix parser): 3 new feedback items.\nNew feedback:\n\
- review by bob: CHANGES_REQUESTED on feedfac: Please split this.\n\
- comment by coderabbitai[bot]: ## Walkthrough https://x/bot\n\
- thread comment by chatgpt-codex-connector [bot] on src/x.rs:12: Off by one https://x/r1\n{PR_URL}"
            )
        );

        let mut more = comments.as_array().expect("comments").clone();
        more.push(serde_json::json!({"id": "IC_late", "author": {"login": "dave"}, "body": "One more", "createdAt": NEW}));
        runner.set(WatchedPr {
            comments: serde_json::Value::Array(more),
            updated_at: "2026-10-02T00:00:00Z",
            ..Default::default()
        });
        poller.tick_for_test().await.expect("later feedback tick");
        let rows = inbox(&database);
        assert_eq!(rows.len(), 2);
        assert!(
            rows[1].1.contains("- comment by dave: One more"),
            "{}",
            rows[1].1
        );
        assert!(!rows[1].1.contains("coderabbitai"), "nothing is repeated");
    }

    #[tokio::test]
    async fn watch_reports_checks_green_once_with_what_the_merge_gate_needs() {
        let (_dir, database) = open_db();
        fixture(&database);
        complete_session_long_ago(&database, "s1");
        seed_watch(&database);
        let runner = WatchRunner::new(WatchedPr {
            rollup: green_checks(),
            ..Default::default()
        });
        runner.set_threads(serde_json::json!([
            {"id": "PRRT_1", "isResolved": false, "path": "src/x.rs", "line": 12,
             "comments": {"nodes": [{"id": "PRRC_1", "author": {"login": "bob", "__typename": "User"}, "body": "Rename this", "url": "https://x/r1", "createdAt": OLD}]}},
            {"id": "PRRT_2", "isResolved": true, "path": "src/y.rs", "line": 3,
             "comments": {"nodes": [{"id": "PRRC_2", "author": {"login": "bob"}, "body": "Done", "createdAt": OLD}]}}
        ]));
        let (_notices, hook) = notice_recorder(&database);
        let poller = watch_poller(&database, &runner, hook);

        poller.tick_for_test().await.expect("green tick");
        poller.tick_for_test().await.expect("still green tick");
        let rows = inbox(&database);
        assert_eq!(rows.len(), 1, "green is reported once per head");
        assert_eq!(
            rows[0].1,
            format!(
                "PR #42 (Fix parser): checks green on feedfac.\nUnresolved review threads (1):\n\
- src/x.rs:12 by bob: Rename this https://x/r1\nReview requested from: carol.\n\
Apply the merge gate before merging.\n{PR_URL}"
            )
        );
        assert_eq!(
            watch_row(&database)
                .expect("watch")
                .reported_ready_sha
                .as_deref(),
            Some("feedface")
        );
    }

    #[tokio::test]
    async fn watch_ends_with_one_notice_when_the_pr_merges_or_closes() {
        for (state, summary) in [
            ("MERGED", "merged as abc1234 (head feedfac)"),
            ("CLOSED", "closed without merging"),
        ] {
            let (_dir, database) = open_db();
            fixture(&database);
            complete_session_long_ago(&database, "s1");
            seed_watch(&database);
            let runner = WatchRunner::new(WatchedPr {
                state,
                rollup: failing_build(),
                ..Default::default()
            });
            let (_notices, hook) = notice_recorder(&database);
            let poller = watch_poller(&database, &runner, hook);

            poller.tick_for_test().await.expect("terminal tick");
            poller.tick_for_test().await.expect("after terminal tick");
            let rows = inbox(&database);
            assert_eq!(rows.len(), 1, "{state}: {rows:?}");
            assert_eq!(
                rows[0].1,
                format!("PR #42 (Fix parser): {summary}.\nThis watch has ended.\n{PR_URL}"),
                "a terminal PR reports only its ending"
            );
            assert!(watch_row(&database).is_none(), "{state} removes the watch");
        }
    }

    /// A notice is staged with the cursors it advances, then delivered. A
    /// crash after the inbox row is stored redelivers that exact notice; the
    /// inbox ignores the repeated id. Feedback that arrives in between goes in
    /// the next notice and the old events are not reported again.
    #[tokio::test]
    async fn watch_never_repeats_a_notice_across_ticks_restarts_or_a_crash() {
        let (_dir, database) = open_db();
        fixture(&database);
        complete_session_long_ago(&database, "s1");
        seed_watch(&database);
        let runner = WatchRunner::new(WatchedPr {
            rollup: failing_build(),
            ..Default::default()
        });

        let stored_then_crashed: PrWatchNoticeHook = {
            let (_notices, store) = notice_recorder(&database);
            Arc::new(move |notice| {
                let stored = store(notice);
                Box::pin(async move {
                    stored.await.expect("store");
                    Err(ArgmaxError::service(
                        "CRASH",
                        "process died before the notice was cleared",
                    ))
                })
            })
        };
        watch_poller(&database, &runner, stored_then_crashed)
            .tick_for_test()
            .await
            .expect("crashing tick");
        let first = inbox(&database);
        assert_eq!(first.len(), 1);
        let staged = watch_row(&database).expect("watch");
        assert_eq!(
            staged
                .pending_notice
                .as_ref()
                .map(|notice| notice.id.as_str()),
            Some(first[0].0.as_str()),
            "the notice stays staged until delivery is confirmed"
        );
        assert_eq!(
            staged.seen_check_failures,
            vec!["CI/build@feedface".to_string()],
            "its cursors moved with it"
        );

        // New feedback lands before the next tick.
        runner.set(WatchedPr {
            rollup: failing_build(),
            comments: serde_json::json!([{"id": "IC_new", "author": {"login": "dave"}, "body": "One more", "createdAt": NEW}]),
            updated_at: "2026-10-02T00:00:00Z",
            ..Default::default()
        });
        let (notices, hook) = notice_recorder(&database);
        let restarted = watch_poller(&database, &runner, hook);
        restarted.tick_for_test().await.expect("restarted tick");
        {
            let notices = notices.lock().expect("notices");
            assert_eq!(notices.len(), 1, "the staged notice goes out again");
            assert_eq!(notices[0].message_id, first[0].0);
            assert_eq!(notices[0].body, first[0].1, "exactly as staged");
        }
        assert_eq!(inbox(&database).len(), 1, "the same id was ignored");
        assert!(watch_row(&database)
            .expect("watch")
            .pending_notice
            .is_none());

        restarted.tick_for_test().await.expect("feedback tick");
        let rows = inbox(&database);
        assert_eq!(rows.len(), 2, "{rows:?}");
        assert!(
            rows[1].1.contains("- comment by dave: One more"),
            "{}",
            rows[1].1
        );
        assert!(
            !rows[1].1.contains("failing"),
            "the failure is not repeated"
        );

        let (notices, hook) = notice_recorder(&database);
        watch_poller(&database, &runner, hook)
            .tick_for_test()
            .await
            .expect("quiet tick");
        assert!(
            notices.lock().expect("notices").is_empty(),
            "nothing new to send"
        );
        assert_eq!(inbox(&database).len(), 2);
    }

    #[tokio::test]
    async fn watch_keeps_polling_an_archived_chat_until_the_pr_ends() {
        let (_dir, database) = open_db();
        fixture(&database);
        complete_session_long_ago(&database, "s1");
        seed_watch(&database);
        database
            .connection()
            .execute(
                "UPDATE workspaces SET state = 'archived' WHERE id = 'w1'",
                [],
            )
            .expect("archive workspace");
        let runner = WatchRunner::new(WatchedPr {
            rollup: failing_build(),
            ..Default::default()
        });
        let (notices, hook) = notice_recorder(&database);
        let poller = watch_poller(&database, &runner, hook);

        let before = runner.calls.load(Ordering::SeqCst);
        poller.tick_for_test().await.expect("archived tick");
        assert!(
            runner.calls.load(Ordering::SeqCst) > before,
            "an archived chat's watched PR is still polled"
        );
        assert!(
            notices.lock().expect("notices").is_empty(),
            "an archived chat cannot be woken"
        );
        assert!(watch_row(&database).is_some());

        runner.set(WatchedPr {
            state: "MERGED",
            ..Default::default()
        });
        poller.tick_for_test().await.expect("merged tick");
        assert!(watch_row(&database).is_none(), "the merge ends the watch");
        assert!(notices.lock().expect("notices").is_empty());
    }

    #[tokio::test]
    async fn a_watched_pr_suppresses_the_check_failure_follow_up() {
        let (_dir, database) = open_db();
        fixture(&database);
        settle_session(&database, "s1");
        seed_watch(&database);
        let runner = WatchRunner::new(WatchedPr {
            rollup: failing_build(),
            ..Default::default()
        });
        let failure_hits = Arc::new(AtomicUsize::new(0));
        let failure_count = Arc::clone(&failure_hits);
        let failure_hook: CheckFailureHook = Arc::new(move |_| {
            failure_count.fetch_add(1, Ordering::SeqCst);
        });
        let (_notices, hook) = notice_recorder(&database);
        let service = GhService::with_runner(Arc::clone(&database), Arc::clone(&runner).runner());
        let poller = GhPoller::new(
            GhPollerConfig::new(Arc::clone(&database), service)
                .with_check_failure_hook(failure_hook)
                .with_watch_notice_hook(hook),
        );

        poller.tick_for_test().await.expect("failing tick");
        poller.tick_for_test().await.expect("still failing tick");
        assert_eq!(
            failure_hits.load(Ordering::SeqCst),
            0,
            "the watching chat owns the fix"
        );
        assert_eq!(inbox(&database).len(), 1, "it was told instead");

        crate::persistence::pr_watches::delete_pr_watch(&database.connection(), "s1", "p1", 42)
            .expect("unwatch");
        poller.tick_for_test().await.expect("unwatched tick");
        assert_eq!(
            failure_hits.load(Ordering::SeqCst),
            1,
            "unwatched, the follow-up runs"
        );
    }

    /// The watch pass runs after transition detection and never writes
    /// `gh_pull_requests`, so a watched PR's Arc events fire exactly as an
    /// unwatched one's.
    #[tokio::test]
    async fn arc_events_still_fire_for_a_watched_pr() {
        let (_dir, database) = open_db();
        fixture(&database);
        settle_session(&database, "s1");
        seed_coordinator(&database, "w-coord", "s-coord");
        seed_arc(&database, "arc-1", "active", Some("s-coord"));
        set_session_arc(&database, "s1", "arc-1");
        seed_watch(&database);
        let runner = WatchRunner::new(WatchedPr {
            rollup: failing_build(),
            ..Default::default()
        });
        let (events, arc_hook) = arc_event_recorder();
        let (_notices, hook) = notice_recorder(&database);
        let service = GhService::with_runner(Arc::clone(&database), Arc::clone(&runner).runner());
        let poller = GhPoller::new(
            GhPollerConfig::new(Arc::clone(&database), service)
                .with_arc_event_hook(arc_hook)
                .with_watch_notice_hook(hook),
        );

        poller.tick_for_test().await.expect("failing tick");
        runner.set(WatchedPr {
            rollup: green_checks(),
            ..Default::default()
        });
        poller.tick_for_test().await.expect("passing tick");
        runner.set(WatchedPr {
            state: "MERGED",
            rollup: green_checks(),
            ..Default::default()
        });
        poller.tick_for_test().await.expect("merged tick");

        let kinds: Vec<_> = events
            .lock()
            .expect("arc events poisoned")
            .iter()
            .map(|event| event.kind)
            .collect();
        assert_eq!(
            kinds,
            vec![
                ArcEventKind::ChecksFailing,
                ArcEventKind::ChecksPassing,
                ArcEventKind::Merged
            ]
        );
        let bodies: Vec<String> = inbox(&database).into_iter().map(|(_, body)| body).collect();
        assert_eq!(bodies.len(), 3, "{bodies:?}");
        assert!(bodies[0].contains("1 check failing"));
        assert!(bodies[1].contains("checks green"));
        assert!(bodies[2].contains("merged as abc1234"));
    }

    /// The merged notice starts a turn in the chat. Archive on merge waits for
    /// the watch to end, then for that turn, rather than cancelling it.
    #[tokio::test]
    async fn archive_on_merge_waits_for_the_merged_notice() {
        let (_dir, database) = open_db();
        fixture(&database);
        settle_session(&database, "s1");
        enable_archive_on_merge(&database);
        seed_watch(&database);
        let runner = WatchRunner::new(WatchedPr {
            state: "MERGED",
            rollup: green_checks(),
            ..Default::default()
        });
        let merged_hits = Arc::new(AtomicUsize::new(0));
        let merged_count = Arc::clone(&merged_hits);
        let merged_hook: MergedPrHook = Arc::new(move |_| {
            merged_count.fetch_add(1, Ordering::SeqCst);
        });
        let (_notices, hook) = notice_recorder(&database);
        let service = GhService::with_runner(Arc::clone(&database), Arc::clone(&runner).runner());
        let poller = GhPoller::new(
            GhPollerConfig::new(Arc::clone(&database), service)
                .with_pr_merged_hook(merged_hook)
                .with_watch_notice_hook(hook),
        );

        poller.tick_for_test().await.expect("merged tick");
        assert_eq!(inbox(&database).len(), 1, "the chat hears about the merge");
        assert!(watch_row(&database).is_none());
        assert_eq!(merged_hits.load(Ordering::SeqCst), 0, "archive waits");

        poller.tick_for_test().await.expect("next tick");
        assert_eq!(merged_hits.load(Ordering::SeqCst), 1, "then archives");
    }

    #[tokio::test]
    async fn a_rate_limited_watch_read_skips_the_pr_for_the_tick() {
        let (_dir, database) = open_db();
        fixture(&database);
        complete_session_long_ago(&database, "s1");
        seed_watch(&database);
        let runner = WatchRunner::new(WatchedPr {
            rollup: failing_build(),
            ..Default::default()
        });
        runner.fail_watch_view(Some("gh failed: API rate limit exceeded for user"));
        let (notices, hook) = notice_recorder(&database);
        let poller = watch_poller(&database, &runner, hook);

        poller.tick_for_test().await.expect("rate limited tick");
        assert!(notices.lock().expect("notices").is_empty());
        let watch = watch_row(&database).expect("watch");
        assert_eq!(watch.head_sha, "", "no cursor moved");
        assert!(watch.seen_feedback_ids.is_none());

        runner.fail_watch_view(None);
        poller.tick_for_test().await.expect("recovered tick");
        assert_eq!(inbox(&database).len(), 1);
    }

    #[tokio::test]
    async fn watch_reports_a_rerun_that_fails_again_on_the_same_head() {
        let (_dir, database) = open_db();
        fixture(&database);
        complete_session_long_ago(&database, "s1");
        seed_watch(&database);
        let runner = WatchRunner::new(WatchedPr {
            rollup: failing_build(),
            ..Default::default()
        });
        let (_notices, hook) = notice_recorder(&database);
        let poller = watch_poller(&database, &runner, hook);

        poller.tick_for_test().await.expect("failing tick");
        runner.set(WatchedPr {
            rollup: serde_json::json!([
                {"name": "build", "workflowName": "CI", "status": "IN_PROGRESS", "conclusion": ""},
                {"name": "lint", "workflowName": "CI", "status": "COMPLETED", "conclusion": "SUCCESS"}
            ]),
            ..Default::default()
        });
        poller.tick_for_test().await.expect("re-run tick");
        assert_eq!(inbox(&database).len(), 1, "a running check is not news");
        runner.set(WatchedPr {
            rollup: failing_build(),
            ..Default::default()
        });
        poller.tick_for_test().await.expect("failed again tick");
        let rows = inbox(&database);
        assert_eq!(rows.len(), 2, "the second failure wakes the chat: {rows:?}");
        assert!(rows[1].1.contains("- CI / build: https://ci.example/build"));
    }

    #[tokio::test]
    async fn watch_tells_apart_same_named_checks_in_different_workflows() {
        let (_dir, database) = open_db();
        fixture(&database);
        complete_session_long_ago(&database, "s1");
        seed_watch(&database);
        let runner = WatchRunner::new(WatchedPr {
            rollup: serde_json::json!([
                {"name": "build", "workflowName": "CI", "status": "COMPLETED", "conclusion": "FAILURE"},
                {"name": "build", "workflowName": "Deploy", "status": "COMPLETED", "conclusion": "FAILURE"}
            ]),
            ..Default::default()
        });
        let (_notices, hook) = notice_recorder(&database);
        watch_poller(&database, &runner, hook)
            .tick_for_test()
            .await
            .expect("failing tick");
        let rows = inbox(&database);
        assert_eq!(rows.len(), 1);
        assert!(
            rows[0]
                .1
                .starts_with("PR #42 (Fix parser): 2 checks failing on feedfac."),
            "{}",
            rows[0].1
        );
    }

    #[tokio::test]
    async fn watch_wakes_again_when_the_head_returns_to_an_earlier_sha() {
        let (_dir, database) = open_db();
        fixture(&database);
        complete_session_long_ago(&database, "s1");
        seed_watch(&database);
        let runner = WatchRunner::new(WatchedPr {
            rollup: failing_build(),
            ..Default::default()
        });
        let (_notices, hook) = notice_recorder(&database);
        let poller = watch_poller(&database, &runner, hook);

        for head in ["feedface", "badc0de", "feedface"] {
            runner.set(WatchedPr {
                head,
                rollup: failing_build(),
                ..Default::default()
            });
            poller.tick_for_test().await.expect("failing tick");
        }
        let ids: Vec<String> = inbox(&database).into_iter().map(|(id, _)| id).collect();
        assert_eq!(
            ids,
            vec![
                "pr-watch:watch-1:1:feedfac",
                "pr-watch:watch-1:2:badc0de",
                "pr-watch:watch-1:3:feedfac"
            ]
        );
    }

    fn conflict_pr(mergeable: &'static str) -> WatchedPr {
        WatchedPr {
            mergeable: Some(mergeable),
            ..Default::default()
        }
    }

    #[tokio::test]
    async fn watch_reports_entering_and_leaving_a_merge_conflict_and_ignores_unknown() {
        let (_dir, database) = open_db();
        fixture(&database);
        complete_session_long_ago(&database, "s1");
        seed_watch(&database);
        let runner = WatchRunner::new(conflict_pr("MERGEABLE"));
        let (_notices, hook) = notice_recorder(&database);
        let poller = watch_poller(&database, &runner, hook);

        // The first clean read seeds the cursor and says nothing.
        poller.tick_for_test().await.expect("seed tick");
        assert!(inbox(&database).is_empty());
        assert_eq!(
            watch_row(&database).expect("watch").conflict_state,
            Some(crate::persistence::pr_watches::ConflictState::Clean)
        );

        runner.set(conflict_pr("CONFLICTING"));
        poller.tick_for_test().await.expect("conflict tick");
        poller.tick_for_test().await.expect("same conflict tick");
        let rows = inbox(&database);
        assert_eq!(rows.len(), 1, "one notice for one conflict: {rows:?}");
        assert_eq!(
            rows[0].1,
            format!(
                "PR #42 (Fix parser): merge conflict.\nMerge conflict: this PR cannot merge into main until the conflict is resolved. Update the branch from main and resolve it.\n{PR_URL}"
            )
        );

        // GitHub reports UNKNOWN while it recomputes. That is neither a
        // resolution nor a new conflict.
        runner.set(conflict_pr("UNKNOWN"));
        poller.tick_for_test().await.expect("unknown tick");
        runner.set(conflict_pr("CONFLICTING"));
        poller.tick_for_test().await.expect("conflict again tick");
        assert_eq!(inbox(&database).len(), 1, "UNKNOWN invented no transition");
        assert_eq!(
            watch_row(&database).expect("watch").conflict_state,
            Some(crate::persistence::pr_watches::ConflictState::Conflicting)
        );

        runner.set(conflict_pr("MERGEABLE"));
        poller.tick_for_test().await.expect("resolved tick");
        let rows = inbox(&database);
        assert_eq!(rows.len(), 2, "{rows:?}");
        assert_eq!(
            rows[1].1,
            format!("PR #42 (Fix parser): merge conflict resolved.\n{PR_URL}")
        );

        runner.set(conflict_pr("UNKNOWN"));
        poller
            .tick_for_test()
            .await
            .expect("unknown after clean tick");
        runner.set(conflict_pr("CONFLICTING"));
        poller.tick_for_test().await.expect("second conflict tick");
        assert_eq!(
            inbox(&database).len(),
            3,
            "a second conflict is a second notice"
        );
    }

    #[tokio::test]
    async fn the_checks_green_notice_mentions_a_conflict_only_when_this_read_shows_one() {
        let (_dir, database) = open_db();
        fixture(&database);
        complete_session_long_ago(&database, "s1");
        seed_watch(&database);
        let runner = WatchRunner::new(WatchedPr {
            rollup: green_checks(),
            mergeable: Some("CONFLICTING"),
            ..Default::default()
        });
        let (_notices, hook) = notice_recorder(&database);
        let poller = watch_poller(&database, &runner, hook);

        poller.tick_for_test().await.expect("green and conflicting");
        let rows = inbox(&database);
        assert_eq!(rows.len(), 1, "{rows:?}");
        assert!(
            rows[0].1.contains("The PR still has a merge conflict"),
            "{}",
            rows[0].1
        );

        // A push: the head moved, the checks are green again, and GitHub is
        // still recomputing mergeability. The stored cursor says "conflicting",
        // but nothing in this read does, so the notice must not say it.
        runner.set(WatchedPr {
            head: "badc0de",
            rollup: green_checks(),
            mergeable: Some("UNKNOWN"),
            ..Default::default()
        });
        poller.tick_for_test().await.expect("green and unknown");
        let rows = inbox(&database);
        assert_eq!(rows.len(), 2, "{rows:?}");
        assert!(rows[1].1.contains("checks green"), "{}", rows[1].1);
        assert!(!rows[1].1.contains("merge conflict"), "{}", rows[1].1);
    }

    #[tokio::test]
    async fn a_reported_conflict_is_not_repeated_after_a_restart() {
        let (_dir, database) = open_db();
        fixture(&database);
        complete_session_long_ago(&database, "s1");
        seed_watch(&database);
        let runner = WatchRunner::new(conflict_pr("CONFLICTING"));
        let (_notices, hook) = notice_recorder(&database);
        watch_poller(&database, &runner, Arc::clone(&hook))
            .tick_for_test()
            .await
            .expect("first run");
        assert_eq!(
            inbox(&database).len(),
            1,
            "a conflict at the first read is reported"
        );

        // A new poller reads the persisted cursor, not an in-memory ledger.
        let restarted = watch_poller(&database, &runner, hook);
        restarted.tick_for_test().await.expect("after restart");
        assert_eq!(inbox(&database).len(), 1);
    }

    #[tokio::test]
    async fn a_merged_pr_reports_the_merge_and_no_conflict() {
        let (_dir, database) = open_db();
        fixture(&database);
        complete_session_long_ago(&database, "s1");
        seed_watch(&database);
        let runner = WatchRunner::new(WatchedPr {
            state: "MERGED",
            mergeable: Some("CONFLICTING"),
            ..Default::default()
        });
        let (_notices, hook) = notice_recorder(&database);
        watch_poller(&database, &runner, hook)
            .tick_for_test()
            .await
            .expect("merged tick");
        let rows = inbox(&database);
        assert_eq!(rows.len(), 1, "{rows:?}");
        assert!(rows[0].1.contains("merged as abc1234"), "{}", rows[0].1);
        assert!(!rows[0].1.contains("conflict"), "{}", rows[0].1);
    }

    #[tokio::test]
    async fn watch_ends_after_ten_polls_that_cannot_find_the_pr() {
        let (_dir, database) = open_db();
        fixture(&database);
        complete_session_long_ago(&database, "s1");
        seed_watch(&database);
        let runner: GhRunner = Arc::new(|_cwd, args: Vec<String>| {
            let result = if args.first().map(String::as_str) == Some("api") {
                Ok(threads_payload(serde_json::json!([])))
            } else {
                Err(ArgmaxError::service(
                    "GH_NON_ZERO_EXIT",
                    "gh failed: GraphQL: Could not resolve to a PullRequest with the number of 42. (repository.pullRequest)",
                ))
            };
            Box::pin(async move { result })
        });
        let (_notices, hook) = notice_recorder(&database);
        let service = GhService::with_runner(Arc::clone(&database), runner);
        let poller = GhPoller::new(
            GhPollerConfig::new(Arc::clone(&database), service).with_watch_notice_hook(hook),
        );

        for _ in 0..9 {
            poller.tick_for_test().await.expect("not found tick");
        }
        assert!(inbox(&database).is_empty());
        assert_eq!(watch_row(&database).expect("watch").not_found_count, 9);
        poller.tick_for_test().await.expect("tenth tick");
        let rows = inbox(&database);
        assert_eq!(rows.len(), 1);
        assert!(
            rows[0].1.starts_with("PR #42 not found; watch removed."),
            "{}",
            rows[0].1
        );
        assert!(watch_row(&database).is_none());
    }

    /// A tick whose refresh did not reach the PR leaves a stale row. The watch
    /// waits for a fresh one rather than calling a merged PR green.
    #[tokio::test]
    async fn watch_skips_a_pr_its_tick_did_not_refresh() {
        let (_dir, database) = open_db();
        fixture(&database);
        complete_session_long_ago(&database, "s1");
        seed_watch(&database);
        let runner = WatchRunner::new(WatchedPr::default());
        let (_notices, hook) = notice_recorder(&database);
        let poller = watch_poller(&database, &runner, hook);
        poller.tick_for_test().await.expect("pending tick");
        assert!(inbox(&database).is_empty());

        // The refresh returns cached rows for a workspace with no path.
        database
            .connection()
            .execute("UPDATE workspaces SET path = '' WHERE id = 'w1'", [])
            .expect("clear path");
        runner.set(WatchedPr {
            state: "MERGED",
            rollup: green_checks(),
            ..Default::default()
        });
        poller.tick_for_test().await.expect("stale tick");
        assert!(inbox(&database).is_empty(), "{:?}", inbox(&database));

        database
            .connection()
            .execute(
                "UPDATE workspaces SET path = '/tmp/argmax-gh-poller' WHERE id = 'w1'",
                [],
            )
            .expect("restore path");
        poller.tick_for_test().await.expect("fresh tick");
        let rows = inbox(&database);
        assert_eq!(rows.len(), 1);
        assert!(rows[0].1.contains("merged as abc1234"), "{}", rows[0].1);
    }

    #[tokio::test]
    async fn archive_on_merge_waits_only_for_a_watch_on_the_merged_pr() {
        let (_dir, database) = open_db();
        fixture(&database);
        settle_session(&database, "s1");
        enable_archive_on_merge(&database);
        crate::persistence::pr_watches::upsert_pr_watch(
            &database.connection(),
            "watch-43",
            "s1",
            "p1",
            43,
            false,
            "",
        )
        .expect("watch another PR");
        let runner = WatchRunner::new(WatchedPr {
            state: "MERGED",
            rollup: green_checks(),
            ..Default::default()
        });
        let merged_hits = Arc::new(AtomicUsize::new(0));
        let merged_count = Arc::clone(&merged_hits);
        let merged_hook: MergedPrHook = Arc::new(move |_| {
            merged_count.fetch_add(1, Ordering::SeqCst);
        });
        let (_notices, hook) = notice_recorder(&database);
        let service = GhService::with_runner(Arc::clone(&database), Arc::clone(&runner).runner());
        let poller = GhPoller::new(
            GhPollerConfig::new(Arc::clone(&database), service)
                .with_pr_merged_hook(merged_hook)
                .with_watch_notice_hook(hook),
        );

        poller.tick_for_test().await.expect("merged tick");
        assert_eq!(merged_hits.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn watch_marks_bot_reviews_and_comments_found_over_graphql() {
        let (_dir, database) = open_db();
        fixture(&database);
        complete_session_long_ago(&database, "s1");
        seed_watch(&database);
        let codex = serde_json::json!({"login": "chatgpt-codex-connector"});
        let runner = WatchRunner::new(WatchedPr {
            reviews: serde_json::json!([{"id": "PRR_c", "author": codex, "state": "COMMENTED", "body": "Codex Review: 1 issue", "submittedAt": NEW}]),
            comments: serde_json::json!([{"id": "IC_c", "author": codex, "body": "Summary", "createdAt": NEW}]),
            ..Default::default()
        });
        let bot = serde_json::json!({"author": {"login": "chatgpt-codex-connector", "__typename": "Bot"}});
        *runner.threads.lock().expect("threads") =
            serde_json::json!({"data": {"repository": {"pullRequest": {
                "reviewThreads": {"nodes": []},
                "reviews": {"nodes": [bot]},
                "comments": {"nodes": [bot]}
            }}}})
            .to_string();
        let (_notices, hook) = notice_recorder(&database);
        watch_poller(&database, &runner, hook)
            .tick_for_test()
            .await
            .expect("feedback tick");
        let rows = inbox(&database);
        assert_eq!(rows.len(), 1);
        assert!(
            rows[0].1.contains(
                "- review by chatgpt-codex-connector [bot]: COMMENTED: Codex Review: 1 issue"
            ),
            "{}",
            rows[0].1
        );
        assert!(rows[0]
            .1
            .contains("- comment by chatgpt-codex-connector [bot]: Summary"));
    }

    /// Points the fixture's project and chat at a real merged repository.
    fn use_merged_repo(
        database: &Arc<Database>,
        repo: &crate::git::pr_cleanup::test_repo::MergedRepo,
    ) {
        let conn = database.connection();
        conn.execute(
            "UPDATE projects SET repo_path = ?1 WHERE id = 'p1'",
            [repo.main.display().to_string()],
        )
        .expect("project path");
        conn.execute(
            "UPDATE workspaces SET path = ?1, branch = 'fix-parser' WHERE id = 'w1'",
            [repo.chat.display().to_string()],
        )
        .expect("workspace path");
    }

    fn merged_repo_pr(repo: &crate::git::pr_cleanup::test_repo::MergedRepo) -> WatchedPr {
        WatchedPr {
            head: Box::leak(repo.merged_head.clone().into_boxed_str()),
            merge_commit: Box::leak(repo.merge_commit.clone().into_boxed_str()),
            branch: "fix-parser",
            state: "MERGED",
            rollup: green_checks(),
            ..Default::default()
        }
    }

    /// Cleanup runs in the watch pass, so it finishes before archive on merge
    /// (which waits for the watch to end), and its report rides the merged
    /// notice.
    #[tokio::test]
    async fn watch_cleans_up_a_merged_pr_before_the_merged_notice_and_the_archive() {
        use crate::git::pr_cleanup::test_repo::{git, merged_repo};
        let repo = merged_repo(true).await;
        let (_dir, database) = open_db();
        fixture(&database);
        use_merged_repo(&database, &repo);
        settle_session(&database, "s1");
        enable_archive_on_merge(&database);
        crate::persistence::pr_watches::upsert_pr_watch(
            &database.connection(),
            "watch-1",
            "s1",
            "p1",
            42,
            true,
            "",
        )
        .expect("watch with cleanup");
        let runner = WatchRunner::new(merged_repo_pr(&repo));
        let remote_at_archive = Arc::new(Mutex::new(Vec::new()));
        let merged_hook: MergedPrHook = {
            let remote_at_archive = Arc::clone(&remote_at_archive);
            let main = repo.main.clone();
            Arc::new(move |_| {
                let listing = crate::git::exec::run_git_text_blocking(
                    &main,
                    ["ls-remote", "--heads", "origin", "fix-parser"],
                    crate::git::exec::GIT_DEFAULT_TIMEOUT,
                )
                .expect("ls-remote");
                remote_at_archive.lock().expect("archive").push(listing);
            })
        };
        let (_notices, hook) = notice_recorder(&database);
        let service = GhService::with_runner(Arc::clone(&database), Arc::clone(&runner).runner());
        let poller = GhPoller::new(
            GhPollerConfig::new(Arc::clone(&database), service)
                .with_pr_merged_hook(merged_hook)
                .with_watch_notice_hook(hook),
        );

        poller.tick_for_test().await.expect("merged tick");
        let rows = inbox(&database);
        assert_eq!(rows.len(), 1, "{rows:?}");
        let head7 = &repo.merged_head[..7];
        let merge7 = &repo.merge_commit[..7];
        assert_eq!(
            rows[0].1,
            format!(
                "PR #42 (Fix parser): merged as {merge7} (head {head7}).\nCleanup:\n\
PR #42 merged as {merge7} (head {head7})\nRemote: origin/fix-parser deleted\n\
Base: main fast-forwarded in {}\nLocal: fix-parser kept (checked out by this chat's worktree)\n\
Chat: kept, checkout {} kept\nThis watch has ended.\n{PR_URL}",
                repo.main.display(),
                repo.chat.display()
            )
        );
        assert!(
            remote_at_archive.lock().expect("archive").is_empty(),
            "archive waits"
        );
        assert_eq!(
            git(&repo.main, &["rev-parse", "HEAD"]).await,
            repo.merge_commit
        );

        poller.tick_for_test().await.expect("next tick");
        assert_eq!(
            *remote_at_archive.lock().expect("archive"),
            vec![String::new()],
            "the archive ran after cleanup deleted the remote branch"
        );
    }

    #[tokio::test]
    async fn watch_cleans_up_for_an_archived_chat_without_a_notice() {
        use crate::git::pr_cleanup::test_repo::{git, merged_repo};
        let repo = merged_repo(false).await;
        let (_dir, database) = open_db();
        fixture(&database);
        use_merged_repo(&database, &repo);
        complete_session_long_ago(&database, "s1");
        database
            .connection()
            .execute(
                "UPDATE workspaces SET state = 'archived' WHERE id = 'w1'",
                [],
            )
            .expect("archive");
        crate::persistence::pr_watches::upsert_pr_watch(
            &database.connection(),
            "watch-1",
            "s1",
            "p1",
            42,
            true,
            "",
        )
        .expect("watch with cleanup");
        let runner = WatchRunner::new(merged_repo_pr(&repo));
        let (notices, hook) = notice_recorder(&database);
        watch_poller(&database, &runner, hook)
            .tick_for_test()
            .await
            .expect("merged tick");
        assert!(notices.lock().expect("notices").is_empty());
        assert!(watch_row(&database).is_none());
        assert!(
            git(
                &repo.main,
                &["ls-remote", "--heads", "origin", "fix-parser"]
            )
            .await
            .is_empty(),
            "cleanup still ran"
        );
    }
}
