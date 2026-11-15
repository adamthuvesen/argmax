//! The per-turn latency waterfall: where the time goes between the user's send
//! and the first painted answer (docs/performance.md#turn-waterfall).
//!
//! A turn starts timing when a person's launch or follow-up reaches its IPC
//! handler, and opens once the send is admitted to start a turn rather than
//! queued. The code on the path stamps each step by session id. Only the first
//! stamp of each step counts. The turn closes when the renderer reports the
//! first painted answer, when the next send opens a new turn, or a short grace
//! after the turn ends. Closing logs one `turn waterfall` line and writes one
//! row, so nothing on the streaming path touches SQLite for it.
//!
//! Clocks: every backend stamp is an `Instant`, written as milliseconds from
//! the turn's `ipc_received` instant, so a wall-clock step cannot bend them.
//! The renderer's `submit` and `first_painted` are `Date.now()` epoch
//! milliseconds. They are converted with the wall-clock time read at
//! `ipc_received`: `offset = renderer_epoch_ms - ipc_received_epoch_ms`. Both
//! clocks are this Mac's realtime clock, so the conversion holds to about a
//! millisecond unless the clock steps during the turn.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use argmax_contracts::validation::ProviderId;
use argmax_store::sync::LockOrRecover;
use argmax_store::turn_waterfalls::{record_turn_waterfall, NewTurnWaterfall, TurnStamp};
use argmax_store::Database;
use serde_json::Value;

/// How long an ended turn waits for the renderer's paint report before it is
/// written without one. A fixture turn can end before its answer is painted.
const PAINT_GRACE: Duration = Duration::from_secs(5);
/// A renderer stamp further than this from `ipc_received` is from another
/// clock (a remote browser) or a stale click, and is left out.
const RENDERER_CLOCK_WINDOW_MS: f64 = 10.0 * 60.0 * 1000.0;
/// Open turns that never ended (a crashed spawn path) are dropped once the map
/// holds this many.
const MAX_OPEN_TURNS: usize = 256;
const STALE_OPEN_TURN: Duration = Duration::from_secs(30 * 60);

/// The backend steps, in the order a turn passes them.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Stamp {
    /// Workspace admission and the checkout lock are held.
    Admitted,
    CheckpointStart,
    CheckpointEnd,
    /// Arguments and environment are built; the next call spawns.
    EnvReady,
    Spawn,
    InitializeSent,
    InitializeAck,
    /// The launch was ready for the prompt and the pre-turn checkpoint was
    /// not; stamped when it finished. Absent when the checkpoint won.
    PromptGateWaited,
    PromptWritten,
    FirstStdout,
    /// The provider's own init event (Claude `system/init`).
    CliInit,
    /// The first assistant text or tool event parsed from the provider.
    FirstContent,
    /// The writer transaction holding that content committed.
    FirstPersisted,
    /// The first `dashboard:delta` hint for the session after that commit.
    FirstHintEmitted,
}

const STAMPS: [Stamp; 14] = [
    Stamp::Admitted,
    Stamp::CheckpointStart,
    Stamp::CheckpointEnd,
    Stamp::EnvReady,
    Stamp::Spawn,
    Stamp::InitializeSent,
    Stamp::InitializeAck,
    Stamp::PromptGateWaited,
    Stamp::PromptWritten,
    Stamp::FirstStdout,
    Stamp::CliInit,
    Stamp::FirstContent,
    Stamp::FirstPersisted,
    Stamp::FirstHintEmitted,
];

impl Stamp {
    fn index(self) -> usize {
        self as usize
    }

    fn name(self) -> &'static str {
        match self {
            Self::Admitted => "admitted",
            Self::CheckpointStart => "checkpoint_start",
            Self::CheckpointEnd => "checkpoint_end",
            Self::EnvReady => "env_ready",
            Self::Spawn => "spawn",
            Self::InitializeSent => "initialize_sent",
            Self::InitializeAck => "initialize_ack",
            Self::PromptGateWaited => "prompt_gate_waited",
            Self::PromptWritten => "prompt_written",
            Self::FirstStdout => "first_stdout",
            Self::CliInit => "cli_init",
            Self::FirstContent => "first_content",
            Self::FirstPersisted => "first_persisted",
            Self::FirstHintEmitted => "first_hint_emitted",
        }
    }
}

struct TurnOrigin {
    at: Instant,
    epoch_ms: f64,
    submitted_epoch_ms: Option<f64>,
}

struct OpenTurn {
    generation: u64,
    origin: Instant,
    origin_epoch_ms: f64,
    submitted_epoch_ms: Option<f64>,
    turn_key: Option<String>,
    provider: Option<ProviderId>,
    stamps: [Option<Instant>; STAMPS.len()],
    /// The turn ended: later backend stamps belong to the next turn.
    ended: bool,
    /// The person typed into a live terminal. The terminal echoes the typed
    /// text, so its first output is not the provider answering.
    typed_input: bool,
}

static OPEN_TURNS: LazyLock<Mutex<HashMap<String, OpenTurn>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));
/// Sends that reached their IPC handler and wait to be admitted, by token.
static PENDING_ORIGINS: LazyLock<Mutex<HashMap<u64, TurnOrigin>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));
static GENERATION: AtomicU64 = AtomicU64::new(0);
static NEXT_ORIGIN_TOKEN: AtomicU64 = AtomicU64::new(0);

// The streaming path asks these before it touches `OPEN_TURNS`, so a chat with
// no open turn, or a turn whose step is stamped, never takes the lock. They are
// rewritten from the whole map by `publish_counts` after every change to it.
static OPEN_TURN_COUNT: AtomicUsize = AtomicUsize::new(0);
/// Open turns whose first content is committed and whose hint is not yet out.
static AWAITING_HINT_COUNT: AtomicUsize = AtomicUsize::new(0);
/// Bumped after each turn is inserted. A turn can only open through `admit`,
/// so a step stamped at one epoch stays stamped until the epoch moves.
static TURN_EPOCH: AtomicU64 = AtomicU64::new(0);

fn publish_counts(open: &HashMap<String, OpenTurn>) {
    OPEN_TURN_COUNT.store(open.len(), Ordering::Relaxed);
    let awaiting = open
        .values()
        .filter(|turn| {
            !turn.ended
                && turn.stamps[Stamp::FirstPersisted.index()].is_some()
                && turn.stamps[Stamp::FirstHintEmitted.index()].is_none()
        })
        .count();
    AWAITING_HINT_COUNT.store(awaiting, Ordering::Relaxed);
}

fn any_open_turn() -> bool {
    OPEN_TURN_COUNT.load(Ordering::Relaxed) > 0
}

/// True while some open turn waits for the hint that carries its first
/// content. The dashboard emit path checks this before it copies session ids.
pub(crate) fn awaits_hint() -> bool {
    AWAITING_HINT_COUNT.load(Ordering::Relaxed) > 0
}

/// Where one chat's streaming path remembers that a step is already stamped, so
/// the next event of the turn does not lock the registry again. Keep one per
/// step, in state that one provider run owns.
#[derive(Debug, Default)]
pub(crate) struct StampGate {
    stamped_at_epoch: Option<u64>,
}

impl StampGate {
    fn pending_at(&self, epoch: u64, any_open: bool) -> bool {
        any_open && self.stamped_at_epoch != Some(epoch)
    }

    /// False when stamping cannot change anything: no turn is open, or this
    /// gate stamped since the last turn opened.
    pub(crate) fn pending(&self) -> bool {
        self.pending_at(TURN_EPOCH.load(Ordering::Acquire), any_open_turn())
    }

    pub(crate) fn stamp(&mut self, session_id: &str, step: Stamp) {
        // Read first: a turn that opens during the call moves the epoch, and
        // the next call stamps again.
        let epoch = TURN_EPOCH.load(Ordering::Acquire);
        if !self.pending_at(epoch, any_open_turn()) {
            return;
        }
        stamp(session_id, step);
        self.stamped_at_epoch = Some(epoch);
    }
}

fn epoch_ms_now() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_secs_f64() * 1000.0)
        .unwrap_or(0.0)
}

fn renderer_offset(origin_epoch_ms: f64, renderer_epoch_ms: f64) -> Option<f64> {
    let offset = renderer_epoch_ms - origin_epoch_ms;
    (renderer_epoch_ms.is_finite() && offset.abs() <= RENDERER_CLOCK_WINDOW_MS).then_some(offset)
}

/// True for the timeline rows the waterfall calls content: assistant text
/// (answer or thinking) and a tool start. Raw stdout echoes are not content.
pub(crate) fn is_turn_content(event_type: &str, payload: &Value) -> bool {
    matches!(
        event_type,
        "message.delta" | "message.completed" | "command.started"
    ) && !matches!(
        payload.get("stream").and_then(Value::as_str),
        Some("stdout" | "stderr" | "pty")
    )
}

/// Names one person's send from its IPC handler to its admission, so no other
/// send on the session (a queue drain, an agent) can take its origin.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct OriginToken(u64);

/// The send reached its IPC handler (`ipc_received`). The turn opens only when
/// the send is admitted to start one; a queued send leaves no turn.
pub(crate) fn begin(submitted_epoch_ms: Option<f64>) -> OriginToken {
    let origin = TurnOrigin {
        at: Instant::now(),
        epoch_ms: epoch_ms_now(),
        submitted_epoch_ms,
    };
    let token = OriginToken(NEXT_ORIGIN_TOKEN.fetch_add(1, Ordering::Relaxed));
    let mut pending = PENDING_ORIGINS.lock_or_recover("turn waterfall origins");
    if pending.len() >= MAX_OPEN_TURNS {
        pending.retain(|_, origin| origin.at.elapsed() < STALE_OPEN_TURN);
    }
    pending.insert(token.0, origin);
    token
}

/// The send's IPC call returned. If it did not start a turn (queued, refused,
/// or empty), its origin goes.
pub(crate) fn discard_unadmitted(token: OriginToken) {
    PENDING_ORIGINS
        .lock_or_recover("turn waterfall origins")
        .remove(&token.0);
}

/// The send holds workspace admission and the checkout lock (`admitted_at`)
/// and starts a turn. Opens the turn when the send carries the token of a
/// person's send that is still waiting; sends with no token (queue drains,
/// agents, schedules) open none. A turn still open on the session is written
/// first.
pub(crate) fn admit(
    database: &Arc<Database>,
    session_id: &str,
    admitted_at: Instant,
    token: Option<OriginToken>,
) {
    let Some(origin) = token.and_then(|token| {
        PENDING_ORIGINS
            .lock_or_recover("turn waterfall origins")
            .remove(&token.0)
    }) else {
        return;
    };
    let mut stamps = [None; STAMPS.len()];
    stamps[Stamp::Admitted.index()] = Some(admitted_at);
    let turn = OpenTurn {
        generation: GENERATION.fetch_add(1, Ordering::Relaxed),
        origin: origin.at,
        origin_epoch_ms: origin.epoch_ms,
        submitted_epoch_ms: origin.submitted_epoch_ms,
        turn_key: None,
        provider: None,
        stamps,
        ended: false,
        typed_input: false,
    };
    let replaced = {
        let mut open = OPEN_TURNS.lock_or_recover("turn waterfalls");
        if open.len() >= MAX_OPEN_TURNS {
            open.retain(|_, turn| turn.origin.elapsed() < STALE_OPEN_TURN);
        }
        let replaced = open.insert(session_id.to_string(), turn);
        publish_counts(&open);
        // After the insert: a gate that reads the new epoch finds the turn.
        TURN_EPOCH.fetch_add(1, Ordering::Release);
        replaced
    };
    if let Some(replaced) = replaced {
        persist(database, session_id, replaced, None);
    }
}

/// Names the turn after the `user.message` it answers, once that is persisted.
pub(crate) fn set_turn_key(session_id: &str, user_message_id: &str) {
    if !any_open_turn() {
        return;
    }
    if let Some(turn) = OPEN_TURNS
        .lock_or_recover("turn waterfalls")
        .get_mut(session_id)
        .filter(|turn| !turn.ended && turn.turn_key.is_none())
    {
        turn.turn_key = Some(user_message_id.to_string());
    }
}

pub(crate) fn set_provider(session_id: &str, provider: ProviderId) {
    if !any_open_turn() {
        return;
    }
    if let Some(turn) = OPEN_TURNS
        .lock_or_recover("turn waterfalls")
        .get_mut(session_id)
        .filter(|turn| !turn.ended)
    {
        turn.provider = Some(provider);
    }
}

/// The person typed the prompt into a live terminal. The terminal echoes it,
/// so `first_stdout` is left out of this turn.
pub(crate) fn mark_typed_input(session_id: &str) {
    if !any_open_turn() {
        return;
    }
    if let Some(turn) = OPEN_TURNS
        .lock_or_recover("turn waterfalls")
        .get_mut(session_id)
        .filter(|turn| !turn.ended)
    {
        turn.typed_input = true;
    }
}

pub(crate) fn stamp(session_id: &str, step: Stamp) {
    if !any_open_turn() {
        return;
    }
    let now = Instant::now();
    let mut open = OPEN_TURNS.lock_or_recover("turn waterfalls");
    let Some(turn) = open.get_mut(session_id).filter(|turn| !turn.ended) else {
        return;
    };
    if step == Stamp::FirstStdout && turn.typed_input {
        return;
    }
    let slot = &mut turn.stamps[step.index()];
    if slot.is_none() {
        *slot = Some(now);
        if step == Stamp::FirstPersisted {
            publish_counts(&open);
        }
    }
}

/// Called after a `dashboard:delta` reached the webviews. A hint counts once
/// the session's first content is committed, which makes it the hint that
/// carries that content.
pub(crate) fn note_hints_emitted(session_ids: &[String]) {
    if session_ids.is_empty() || !awaits_hint() {
        return;
    }
    let now = Instant::now();
    let mut open = OPEN_TURNS.lock_or_recover("turn waterfalls");
    for session_id in session_ids {
        let Some(turn) = open.get_mut(session_id).filter(|turn| !turn.ended) else {
            continue;
        };
        if turn.stamps[Stamp::FirstPersisted.index()].is_some() {
            turn.stamps[Stamp::FirstHintEmitted.index()].get_or_insert(now);
        }
    }
    publish_counts(&open);
}

/// The renderer painted the turn's first content: the turn is complete. A
/// report for a turn that is no longer open, or for another turn, is ignored.
pub(crate) fn painted(
    database: &Arc<Database>,
    session_id: &str,
    turn_key: &str,
    painted_epoch_ms: f64,
) {
    let closed = {
        let mut open = OPEN_TURNS.lock_or_recover("turn waterfalls");
        if open
            .get(session_id)
            .is_none_or(|turn| turn.turn_key.as_deref() != Some(turn_key))
        {
            return;
        }
        let closed = open.remove(session_id);
        publish_counts(&open);
        closed
    };
    if let Some(turn) = closed {
        persist(database, session_id, turn, Some(painted_epoch_ms));
    }
}

/// The turn ended. It waits `PAINT_GRACE` for the paint report, then is
/// written without one.
pub(crate) fn turn_ended(database: &Arc<Database>, session_id: &str) {
    if !any_open_turn() {
        return;
    }
    let generation = {
        let mut open = OPEN_TURNS.lock_or_recover("turn waterfalls");
        let Some(turn) = open.get_mut(session_id) else {
            return;
        };
        if turn.ended {
            return;
        }
        turn.ended = true;
        let generation = turn.generation;
        publish_counts(&open);
        generation
    };
    let database = Arc::clone(database);
    let session_id = session_id.to_string();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(PAINT_GRACE).await;
        let closed = {
            let mut open = OPEN_TURNS.lock_or_recover("turn waterfalls");
            if open
                .get(&session_id)
                .is_none_or(|turn| turn.generation != generation)
            {
                return;
            }
            let closed = open.remove(&session_id);
            publish_counts(&open);
            closed
        };
        if let Some(turn) = closed {
            persist(&database, &session_id, turn, None);
        }
    });
}

fn waterfall(session_id: &str, turn: &OpenTurn, painted_epoch_ms: Option<f64>) -> NewTurnWaterfall {
    let renderer_stamp = |name: &str, epoch_ms: Option<f64>| {
        epoch_ms
            .and_then(|epoch_ms| renderer_offset(turn.origin_epoch_ms, epoch_ms))
            .map(|offset_ms| TurnStamp {
                name: name.to_string(),
                offset_ms,
            })
    };
    let backend = STAMPS.iter().filter_map(|step| {
        turn.stamps[step.index()].map(|at| TurnStamp {
            name: step.name().to_string(),
            offset_ms: at.saturating_duration_since(turn.origin).as_secs_f64() * 1000.0,
        })
    });
    let stamps = renderer_stamp("submit", turn.submitted_epoch_ms)
        .into_iter()
        .chain([TurnStamp {
            name: "ipc_received".to_string(),
            offset_ms: 0.0,
        }])
        .chain(backend)
        .chain(renderer_stamp("first_painted", painted_epoch_ms))
        .collect();
    NewTurnWaterfall {
        session_id: session_id.to_string(),
        turn_key: turn.turn_key.clone(),
        provider: turn.provider.map(|provider| provider.as_str().to_string()),
        stamps,
    }
}

fn log_line(waterfall: &NewTurnWaterfall) -> String {
    waterfall
        .stamps
        .iter()
        .map(|stamp| format!("{}={:.0}", stamp.name, stamp.offset_ms))
        .collect::<Vec<_>>()
        .join(" ")
}

fn persist(database: &Arc<Database>, session_id: &str, turn: OpenTurn, painted: Option<f64>) {
    let waterfall = waterfall(session_id, &turn, painted);
    tracing::info!(
        session_id = %waterfall.session_id,
        turn_key = waterfall.turn_key.as_deref().unwrap_or(""),
        provider = waterfall.provider.as_deref().unwrap_or(""),
        "turn waterfall {}",
        log_line(&waterfall)
    );
    let database = Arc::clone(database);
    tauri::async_runtime::spawn_blocking(move || {
        if let Err(error) = record_turn_waterfall(&mut database.connection(), &waterfall) {
            tracing::warn!(session_id = %waterfall.session_id, ?error, "could not store turn waterfall");
        }
    });
}

/// A turn opened for a test in another module, and whether it has ended.
#[cfg(test)]
pub(crate) fn open_for_test(session_id: &str) {
    let mut stamps = [None; STAMPS.len()];
    stamps[Stamp::Admitted.index()] = Some(Instant::now());
    let mut open = OPEN_TURNS.lock_or_recover("turn waterfalls");
    open.insert(
        session_id.to_string(),
        OpenTurn {
            generation: GENERATION.fetch_add(1, Ordering::Relaxed),
            origin: Instant::now(),
            origin_epoch_ms: epoch_ms_now(),
            submitted_epoch_ms: None,
            turn_key: None,
            provider: None,
            stamps,
            ended: false,
            typed_input: false,
        },
    );
    publish_counts(&open);
}

#[cfg(test)]
pub(crate) fn is_ended_for_test(session_id: &str) -> Option<bool> {
    OPEN_TURNS
        .lock_or_recover("turn waterfalls")
        .get(session_id)
        .map(|turn| turn.ended)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn open_turn(origin_epoch_ms: f64, submitted: Option<f64>) -> OpenTurn {
        OpenTurn {
            generation: 0,
            origin: Instant::now(),
            origin_epoch_ms,
            submitted_epoch_ms: submitted,
            turn_key: Some("u1".into()),
            provider: Some(ProviderId::Claude),
            stamps: [None; STAMPS.len()],
            ended: false,
            typed_input: false,
        }
    }

    fn insert_open(session: &str, turn: OpenTurn) {
        let mut open = OPEN_TURNS.lock_or_recover("turn waterfalls");
        open.insert(session.to_string(), turn);
        publish_counts(&open);
    }

    fn remove_open(session: &str) {
        let mut open = OPEN_TURNS.lock_or_recover("turn waterfalls");
        open.remove(session);
        publish_counts(&open);
    }

    #[test]
    fn renderer_stamps_are_offsets_from_ipc_received_and_backend_stamps_keep_turn_order() {
        let mut turn = open_turn(1_000_000.0, Some(999_960.0));
        turn.stamps[Stamp::Spawn.index()] = Some(turn.origin + Duration::from_millis(250));
        turn.stamps[Stamp::Admitted.index()] = Some(turn.origin + Duration::from_millis(5));
        let row = waterfall("s1", &turn, Some(1_000_800.0));
        let names: Vec<_> = row.stamps.iter().map(|stamp| stamp.name.as_str()).collect();
        assert_eq!(
            names,
            [
                "submit",
                "ipc_received",
                "admitted",
                "spawn",
                "first_painted"
            ]
        );
        assert_eq!(row.stamps[0].offset_ms, -40.0);
        assert!((row.stamps[3].offset_ms - 250.0).abs() < 0.001);
        assert_eq!(row.stamps[4].offset_ms, 800.0);
        assert_eq!(row.provider.as_deref(), Some("claude"));
    }

    #[test]
    fn a_renderer_stamp_from_another_clock_is_left_out() {
        let turn = open_turn(1_000_000_000.0, Some(1.0));
        let row = waterfall("s1", &turn, Some(f64::NAN));
        let names: Vec<_> = row.stamps.iter().map(|stamp| stamp.name.as_str()).collect();
        assert_eq!(names, ["ipc_received"]);
    }

    #[test]
    fn only_the_first_stamp_counts_and_an_ended_turn_takes_no_more() {
        let session = uuid::Uuid::new_v4().to_string();
        insert_open(&session, open_turn(epoch_ms_now(), None));
        stamp(&session, Stamp::Spawn);
        let first =
            OPEN_TURNS.lock_or_recover("turn waterfalls")[&session].stamps[Stamp::Spawn.index()];
        std::thread::sleep(Duration::from_millis(2));
        stamp(&session, Stamp::Spawn);
        OPEN_TURNS
            .lock_or_recover("turn waterfalls")
            .get_mut(&session)
            .expect("open")
            .ended = true;
        stamp(&session, Stamp::FirstStdout);
        let open = OPEN_TURNS.lock_or_recover("turn waterfalls");
        assert_eq!(open[&session].stamps[Stamp::Spawn.index()], first);
        assert_eq!(open[&session].stamps[Stamp::FirstStdout.index()], None);
    }

    #[test]
    fn a_hint_counts_only_after_the_first_content_is_committed() {
        let session = uuid::Uuid::new_v4().to_string();
        insert_open(&session, open_turn(epoch_ms_now(), None));
        note_hints_emitted(std::slice::from_ref(&session));
        assert!(
            OPEN_TURNS.lock_or_recover("turn waterfalls")[&session].stamps
                [Stamp::FirstHintEmitted.index()]
            .is_none()
        );
        stamp(&session, Stamp::FirstPersisted);
        note_hints_emitted(std::slice::from_ref(&session));
        assert!(
            OPEN_TURNS.lock_or_recover("turn waterfalls")[&session].stamps
                [Stamp::FirstHintEmitted.index()]
            .is_some()
        );
        remove_open(&session);
    }

    #[test]
    fn content_is_assistant_text_or_a_tool_start_but_not_a_raw_echo() {
        assert!(is_turn_content("message.delta", &json!({})));
        assert!(is_turn_content("command.started", &json!({ "id": "t1" })));
        assert!(!is_turn_content(
            "message.delta",
            &json!({ "stream": "stdout" })
        ));
        assert!(!is_turn_content("user.message", &json!({})));
        assert!(!is_turn_content("session.streaming", &json!({})));
    }

    fn test_database() -> Arc<Database> {
        Arc::new(Database::open_in_memory().expect("in-memory database"))
    }

    #[test]
    fn a_send_without_its_token_opens_no_turn_and_leaves_the_persons_origin() {
        let database = test_database();
        let session = uuid::Uuid::new_v4().to_string();
        let person = begin(None);
        // A queue drain or agent send on the same session carries no token.
        admit(&database, &session, Instant::now(), None);
        assert!(!OPEN_TURNS
            .lock_or_recover("turn waterfalls")
            .contains_key(&session));
        // A token that belongs to another send does not open this one either.
        let other = begin(None);
        discard_unadmitted(other);
        admit(&database, &session, Instant::now(), Some(other));
        assert!(!OPEN_TURNS
            .lock_or_recover("turn waterfalls")
            .contains_key(&session));
        admit(&database, &session, Instant::now(), Some(person));
        assert!(OPEN_TURNS
            .lock_or_recover("turn waterfalls")
            .contains_key(&session));
        remove_open(&session);
    }

    #[test]
    fn two_sends_on_one_session_keep_separate_origins() {
        let database = test_database();
        let session = uuid::Uuid::new_v4().to_string();
        let first = begin(Some(1.0));
        let second = begin(Some(2.0));
        discard_unadmitted(first);
        admit(&database, &session, Instant::now(), Some(second));
        let submitted = OPEN_TURNS.lock_or_recover("turn waterfalls")[&session].submitted_epoch_ms;
        assert_eq!(submitted, Some(2.0));
        remove_open(&session);
    }

    #[test]
    fn an_admitted_turn_makes_open_turns_visible_to_the_lock_free_check() {
        let database = test_database();
        let session = uuid::Uuid::new_v4().to_string();
        admit(&database, &session, Instant::now(), Some(begin(None)));
        assert!(any_open_turn());
        stamp(&session, Stamp::FirstPersisted);
        assert!(awaits_hint());
        remove_open(&session);
    }

    #[test]
    fn a_stamp_gate_skips_the_registry_until_the_next_turn_opens() {
        let gate = StampGate::default();
        assert!(gate.pending_at(4, true));
        assert!(!gate.pending_at(4, false), "no open turn: nothing to stamp");
        let stamped = StampGate {
            stamped_at_epoch: Some(4),
        };
        assert!(!stamped.pending_at(4, true), "already stamped this epoch");
        assert!(stamped.pending_at(5, true), "a turn opened since");
    }

    #[test]
    fn a_gate_stamps_the_turn_once_and_re_arms_when_a_turn_opens() {
        let database = test_database();
        let session = uuid::Uuid::new_v4().to_string();
        let mut gate = StampGate::default();
        admit(&database, &session, Instant::now(), Some(begin(None)));
        gate.stamp(&session, Stamp::FirstContent);
        let first = OPEN_TURNS.lock_or_recover("turn waterfalls")[&session].stamps
            [Stamp::FirstContent.index()];
        assert!(first.is_some());
        assert!(!gate.pending());
        admit(&database, &session, Instant::now(), Some(begin(None)));
        assert!(gate.pending());
        gate.stamp(&session, Stamp::FirstContent);
        assert!(
            OPEN_TURNS.lock_or_recover("turn waterfalls")[&session].stamps
                [Stamp::FirstContent.index()]
            .is_some()
        );
        remove_open(&session);
    }

    #[test]
    fn first_stdout_is_left_out_of_a_turn_typed_into_a_terminal() {
        let session = uuid::Uuid::new_v4().to_string();
        insert_open(&session, open_turn(epoch_ms_now(), None));
        mark_typed_input(&session);
        stamp(&session, Stamp::FirstStdout);
        stamp(&session, Stamp::PromptWritten);
        let open = OPEN_TURNS.lock_or_recover("turn waterfalls");
        assert_eq!(open[&session].stamps[Stamp::FirstStdout.index()], None);
        assert!(open[&session].stamps[Stamp::PromptWritten.index()].is_some());
        drop(open);
        remove_open(&session);
    }

    #[test]
    fn ending_a_turn_marks_it_ended_once() {
        let database = test_database();
        let session = uuid::Uuid::new_v4().to_string();
        insert_open(&session, open_turn(epoch_ms_now(), None));
        turn_ended(&database, &session);
        assert!(OPEN_TURNS.lock_or_recover("turn waterfalls")[&session].ended);
        turn_ended(&database, &session);
        remove_open(&session);
    }
}
