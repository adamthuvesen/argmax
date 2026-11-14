//! The two queues that carry pushes to the renderer and remote clients:
//! `dashboard:delta` and terminal output. Each has one worker that conflates
//! what piled up into a single main-thread emit. See docs/runtime.md
//! "Event delivery".

use std::sync::{
    atomic::{AtomicBool, AtomicU64, Ordering},
    Arc,
};

use tauri::Emitter;
use tokio::sync::broadcast;

use crate::{providers, remote, state, terminal};

/// If one emit cycle has to conflate at least this many queued `dashboard:delta`
/// messages, the main-thread event loop is lagging behind producers — log it so
/// the backpressure is visible rather than silently growing the channel.
const DELTA_CONFLATE_WARN: usize = 256;

/// Maximum number and exact serialized bytes waiting behind the main thread.
/// Producers never block on this queue because some of them publish while
/// finishing database work. Overflow becomes a recoverable resync marker.
const DASHBOARD_DELIVERY_ITEMS: usize = 512;
const DASHBOARD_DELIVERY_BYTES: usize = 4 * 1024 * 1024;

/// PTY reads are at most 8 KiB before UTF-8 decoding and use dedicated OS
/// threads, so bounded lossless backpressure is safe here. Invalid UTF-8 can
/// expand to replacement characters, making the byte ceiling about 1.5 MiB.
const TERMINAL_DELIVERY_ITEMS: usize = 64;

/// How much event text one `dashboard:delta` push may carry.
///
/// The emit path evals a JS source string containing the serialized payload, so
/// this is really a cap on how long JavaScriptCore parses on the main thread.
/// 256 KB keeps that in the low milliseconds while still coalescing an ordinary
/// token burst into a single push.
const MAX_CONFLATED_DELTA_BYTES: usize = 256 * 1024;

/// How much terminal text one main-thread emit cycle may carry, for the same
/// reason as `MAX_CONFLATED_DELTA_BYTES`: the payload becomes a JS source
/// string the main thread evals, so this caps how long JavaScriptCore parses
/// per hop. Whatever does not fit stays queued for the next cycle, in order.
const MAX_CONFLATED_TERMINAL_BYTES: usize = 256 * 1024;

/// One queued terminal push. Data and exit share a queue so a `terminal:exit`
/// can never overtake output still queued for the same terminal.
#[derive(Debug)]
enum TerminalPush {
    Data(terminal::service::TerminalChunk),
    Exit(terminal::service::TerminalExitInfo),
}

struct QueuedDashboardDelta {
    delta: providers::flush_queue::DashboardDelta,
    serialized_bytes: usize,
    generation: u64,
    _byte_permit: tokio::sync::OwnedSemaphorePermit,
}

// `Wake` is the rare variant, so the size gap costs padding on almost no
// queue slot, and boxing `Delta` would put an allocation on the streaming path.
#[allow(clippy::large_enum_variant)]
enum DashboardDeliveryItem {
    Delta(QueuedDashboardDelta),
    Wake,
}

#[derive(Clone)]
pub(crate) struct DashboardDelivery {
    sender: tokio::sync::mpsc::Sender<DashboardDeliveryItem>,
    byte_budget: Arc<tokio::sync::Semaphore>,
    resync_required: Arc<AtomicBool>,
    generation: Arc<AtomicU64>,
}

impl DashboardDelivery {
    fn new() -> (Self, tokio::sync::mpsc::Receiver<DashboardDeliveryItem>) {
        let (sender, receiver) = tokio::sync::mpsc::channel(DASHBOARD_DELIVERY_ITEMS);
        (
            Self {
                sender,
                byte_budget: Arc::new(tokio::sync::Semaphore::new(DASHBOARD_DELIVERY_BYTES)),
                resync_required: Arc::new(AtomicBool::new(false)),
                generation: Arc::new(AtomicU64::new(0)),
            },
            receiver,
        )
    }

    /// Queue a delta without blocking its producer. Once either bound is hit,
    /// the worker discards the incomplete window and delivers one resync marker.
    pub(crate) fn send(&self, mut delta: providers::flush_queue::DashboardDelta) {
        if self.resync_required.load(Ordering::Acquire) {
            return;
        }
        let generation = self.generation.load(Ordering::Acquire);
        delta
            .changed_session_ids
            .extend(delta.events.iter().map(|event| event.session_id.clone()));
        delta.changed_session_ids.extend(
            delta
                .raw_outputs
                .iter()
                .map(|output| output.session_id.clone()),
        );
        delta
            .changed_session_ids
            .extend(delta.sessions.iter().map(|session| session.id.clone()));
        delta.changed_session_ids.sort_unstable();
        delta.changed_session_ids.dedup();
        delta.dashboard_changed |= !delta.projects.is_empty()
            || !delta.workspaces.is_empty()
            || !delta.sessions.is_empty()
            || !delta.approvals.is_empty()
            || delta.pending_messages.is_some()
            || !delta.removed_session_ids.is_empty()
            || !delta.removed_workspace_ids.is_empty();
        // Transcript rows are already durable before publish. Sending their
        // session ids turns bursts into cheap revision-feed pulls and avoids a
        // delayed payload overwriting a newer update or resurrecting a delete.
        // Move seams remain inline because desktop navigation consumes them
        // before the source session is necessarily subscribed.
        delta.events.retain(|event| event.r#type == "session.moved");
        delta.events.shrink_to_fit();
        // Clearing retains the original allocations, which can dwarf the
        // serialized hint and defeat the queue's byte accounting.
        delta.raw_outputs = Vec::new();
        delta.projects = Vec::new();
        delta.workspaces = Vec::new();
        delta.sessions = Vec::new();
        delta.approvals = Vec::new();
        delta.pending_messages = None;
        delta.removed_session_ids = Vec::new();
        delta.removed_workspace_ids = Vec::new();
        delta.changed_session_ids.shrink_to_fit();
        let serialized_bytes = match delta.serialized_payload_bytes() {
            Ok(bytes) if bytes <= DASHBOARD_DELIVERY_BYTES => bytes,
            Ok(bytes) => {
                tracing::warn!(
                    bytes,
                    "dashboard delta exceeds the delivery byte budget; requesting resync"
                );
                self.require_resync();
                return;
            }
            Err(error) => {
                tracing::warn!(?error, "failed to size dashboard delta; requesting resync");
                self.require_resync();
                return;
            }
        };
        let Ok(byte_permit) =
            Arc::clone(&self.byte_budget).try_acquire_many_owned(serialized_bytes as u32)
        else {
            self.require_resync();
            return;
        };
        let queued = DashboardDeliveryItem::Delta(QueuedDashboardDelta {
            delta,
            serialized_bytes,
            generation,
            _byte_permit: byte_permit,
        });
        // An overflow may have raced the serialization above. Tagging every
        // item with its queue generation lets the consumer reject this stale
        // payload even if it lands after the resync marker was drained.
        if self.resync_required.load(Ordering::Acquire)
            || self.generation.load(Ordering::Acquire) != generation
        {
            return;
        }
        if let Err(error) = self.sender.try_send(queued) {
            match error {
                tokio::sync::mpsc::error::TrySendError::Full(_) => self.require_resync(),
                tokio::sync::mpsc::error::TrySendError::Closed(_) => {
                    tracing::warn!("dashboard delta channel closed")
                }
            }
        }
    }

    fn require_resync(&self) {
        let was_required = self.resync_required.swap(true, Ordering::AcqRel);
        if !was_required {
            self.generation.fetch_add(1, Ordering::AcqRel);
            tracing::warn!(
                max_items = DASHBOARD_DELIVERY_ITEMS,
                max_bytes = DASHBOARD_DELIVERY_BYTES,
                "dashboard delivery queue overflowed; queued window will be replaced by resync"
            );
        }
        // An oversized delta can overflow an otherwise empty queue. Wake the
        // receiver in that case. A full queue already guarantees a wake.
        let _ = self.sender.try_send(DashboardDeliveryItem::Wake);
    }
}

fn prepare_dashboard_batch(
    first: DashboardDeliveryItem,
    receiver: &mut tokio::sync::mpsc::Receiver<DashboardDeliveryItem>,
    resync_required: &AtomicBool,
    generation: &AtomicU64,
    deferred: &mut Option<DashboardDeliveryItem>,
) -> Option<providers::flush_queue::DashboardDelta> {
    let mut first = first;
    if resync_required.swap(false, Ordering::AcqRel) {
        while receiver.try_recv().is_ok() {}
        first = DashboardDeliveryItem::Wake;
    }
    let current_generation = generation.load(Ordering::Acquire);
    let (mut delta, mut pending_bytes) = match first {
        DashboardDeliveryItem::Delta(queued) if queued.generation == current_generation => {
            (queued.delta, queued.serialized_bytes)
        }
        DashboardDeliveryItem::Delta(_) => return None,
        DashboardDeliveryItem::Wake => (
            providers::flush_queue::DashboardDelta {
                dashboard_changed: true,
                resync_required: true,
                ..Default::default()
            },
            0,
        ),
    };
    let mut conflated = 1usize;
    while pending_bytes < MAX_CONFLATED_DELTA_BYTES {
        let Ok(next) = receiver.try_recv() else {
            break;
        };
        match next {
            DashboardDeliveryItem::Delta(next) => {
                if next.generation != current_generation {
                    continue;
                }
                if pending_bytes > 0
                    && pending_bytes + next.serialized_bytes > MAX_CONFLATED_DELTA_BYTES
                {
                    *deferred = Some(DashboardDeliveryItem::Delta(next));
                    break;
                }
                pending_bytes += next.serialized_bytes;
                delta.merge_from(next.delta);
                conflated += 1;
            }
            DashboardDeliveryItem::Wake => {}
        }
    }
    if resync_required.swap(false, Ordering::AcqRel) {
        *deferred = None;
        while receiver.try_recv().is_ok() {}
        return Some(providers::flush_queue::DashboardDelta {
            dashboard_changed: true,
            resync_required: true,
            ..Default::default()
        });
    }
    if conflated >= DELTA_CONFLATE_WARN {
        tracing::warn!(
            conflated,
            "coalesced a large dashboard:delta burst; main-thread emit may be lagging"
        );
    }
    Some(delta)
}

impl TerminalPush {
    fn approx_payload_bytes(&self) -> usize {
        match self {
            TerminalPush::Data(chunk) => chunk.data.len(),
            TerminalPush::Exit(_) => 0,
        }
    }
}

/// Merge a drained batch down to one `terminal:data` per terminal, in order.
///
/// PTY chunk text concatenates trivially, so a burst for one terminal becomes a
/// single push. An exit closes its terminal's open chunk: output that arrived
/// before it still goes out first, and anything that arrives after is not
/// folded back in front of it.
fn coalesce_terminal_pushes(batch: Vec<TerminalPush>) -> Vec<TerminalPush> {
    let mut coalesced: Vec<TerminalPush> = Vec::with_capacity(batch.len());
    let mut open: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
    for push in batch {
        match push {
            TerminalPush::Data(chunk) => match open.get(&chunk.terminal_id) {
                Some(&index) => {
                    if let Some(TerminalPush::Data(existing)) = coalesced.get_mut(index) {
                        existing.data.push_str(&chunk.data);
                    }
                }
                None => {
                    open.insert(chunk.terminal_id.clone(), coalesced.len());
                    coalesced.push(TerminalPush::Data(chunk));
                }
            },
            TerminalPush::Exit(info) => {
                open.remove(&info.terminal_id);
                coalesced.push(TerminalPush::Exit(info));
            }
        }
    }
    coalesced
}

/// Starts the worker that drains the `dashboard:delta` queue and returns the
/// queue's sender. Every producer shares this one FIFO, so a
/// `session.completed` cannot overtake its `message.completed`.
pub(crate) fn spawn_dashboard_delivery(
    app: &tauri::AppHandle,
    remote_events: broadcast::Sender<remote::RemoteEvent>,
    dock_badge: Arc<state::LiveDockBadgeService>,
) -> DashboardDelivery {
    let (delta_tx, mut delta_rx) = DashboardDelivery::new();
    let delta_resync_required = Arc::clone(&delta_tx.resync_required);
    let delta_generation = Arc::clone(&delta_tx.generation);
    let emit_handle = app.clone();
    tauri::async_runtime::spawn(async move {
        let mut deferred = None;
        loop {
            let first = match deferred.take() {
                Some(item) => item,
                None => match delta_rx.recv().await {
                    Some(item) => item,
                    None => break,
                },
            };
            // Conflate hints that piled up while the previous emit ran.
            // `Emitter::emit` renders the payload into a JS source string,
            // so exact serialized bytes bound each batch. The deferred item
            // keeps the remainder ordered for the next acknowledged hop.
            let Some(delta) = prepare_dashboard_batch(
                first,
                &mut delta_rx,
                &delta_resync_required,
                &delta_generation,
                &mut deferred,
            ) else {
                continue;
            };
            // Emit on the main thread. On macOS, an event emitted
            // from a background thread does not reliably wake the
            // NSApp event loop, so `dashboard:delta` pushes can sit
            // undelivered until some unrelated UI event pumps the
            // loop — mid-turn streaming then stalls and the chat
            // only fills in when the turn ends (process exit pumps
            // the loop). Hopping onto the main thread via
            // `run_on_main_thread` dispatches the webview eval as a
            // main-thread task the loop processes promptly, so the
            // chat streams live. See tao#625 / winit#219 and
            // docs/runtime.md "Event delivery".
            //
            // Remote clients are fed before the hop: a WebSocket
            // write needs no NSApp event loop.
            // Session state and approval changes are the
            // only inputs to the attention count, so an
            // events-only streaming delta skips the read.
            if delta.dashboard_changed {
                if let Err(error) = dock_badge.update() {
                    tracing::warn!(?error, "failed to update dock badge");
                }
            }
            remote::publish(&remote_events, "dashboard:delta", &delta);
            let handle = emit_handle.clone();
            let (emitted_tx, emitted_rx) = tokio::sync::oneshot::channel();
            // Diagnostic for the "stream freezes, then everything
            // bursts at once" symptom: if the main-thread hop parks
            // (tao#625-style missed wake-up), the closure runs long
            // after it was scheduled. Log the parking so the next
            // occurrence attributes the stall to this hop rather
            // than the renderer.
            let scheduled_at = std::time::Instant::now();
            if let Err(error) = emit_handle.run_on_main_thread(move || {
                let parked = scheduled_at.elapsed();
                if parked > std::time::Duration::from_millis(500) {
                    tracing::warn!(
                        parked_ms = parked.as_millis() as u64,
                        changed_sessions = delta.changed_session_ids.len(),
                        dashboard_changed = delta.dashboard_changed,
                        "dashboard:delta emit sat scheduled on the main thread; event-loop wake lagged"
                    );
                }
                if let Err(error) = handle.emit("dashboard:delta", delta) {
                    tracing::warn!(?error, "failed to emit dashboard delta");
                }
                let _ = emitted_tx.send(());
            }) {
                tracing::warn!(?error, "failed to schedule dashboard delta emit");
                continue;
            }
            // Do not dequeue another batch until the scheduled closure
            // actually ran. This leaves at most one main-thread emit
            // outstanding while the bounded queue absorbs producers.
            let _ = emitted_rx.await;
        }
    });
    delta_tx
}

/// Starts the terminal worker and returns the sinks the PTY readers push into.
/// Terminal pushes take the same shape as `dashboard:delta`: a FIFO queue and
/// one worker that conflates what piled up into a single main-thread hop. A
/// PTY reader produces an 8 KiB chunk at a time, at MB/s, with no
/// backpressure; one `run_on_main_thread` and `Emitter::emit` per chunk is
/// what makes a `cat` of a large file freeze the window.
pub(crate) fn spawn_terminal_delivery(
    app: &tauri::AppHandle,
    remote_terminal_events: broadcast::Sender<remote::RemoteEvent>,
) -> (terminal::service::OutputSink, terminal::service::ExitSink) {
    let (terminal_tx, mut terminal_rx) =
        tokio::sync::mpsc::channel::<TerminalPush>(TERMINAL_DELIVERY_ITEMS);
    let emit_handle = app.clone();
    tauri::async_runtime::spawn(async move {
        while let Some(first) = terminal_rx.recv().await {
            let mut pending_bytes = first.approx_payload_bytes();
            let mut batch = vec![first];
            while pending_bytes < MAX_CONFLATED_TERMINAL_BYTES {
                let Ok(next) = terminal_rx.try_recv() else {
                    break;
                };
                pending_bytes += next.approx_payload_bytes();
                batch.push(next);
            }
            let pushes = coalesce_terminal_pushes(batch);
            // Remote clients are fed before the hop: a
            // WebSocket write needs no NSApp event loop.
            for push in &pushes {
                match push {
                    TerminalPush::Data(chunk) => {
                        remote::publish(&remote_terminal_events, "terminal:data", chunk)
                    }
                    TerminalPush::Exit(info) => {
                        remote::publish(&remote_terminal_events, "terminal:exit", info)
                    }
                }
            }
            let handle = emit_handle.clone();
            let (emitted_tx, emitted_rx) = tokio::sync::oneshot::channel();
            if let Err(error) = emit_handle.run_on_main_thread(move || {
                for push in pushes {
                    let emitted = match push {
                        TerminalPush::Data(chunk) => handle.emit("terminal:data", chunk),
                        TerminalPush::Exit(info) => handle.emit("terminal:exit", info),
                    };
                    if let Err(error) = emitted {
                        tracing::warn!(?error, "failed to emit terminal event");
                    }
                }
                let _ = emitted_tx.send(());
            }) {
                tracing::warn!(?error, "failed to schedule terminal event emit");
                continue;
            }
            let _ = emitted_rx.await;
        }
    });
    let terminal_data_tx = terminal_tx.clone();
    let on_data: terminal::service::OutputSink =
        Arc::new(move |chunk: terminal::service::TerminalChunk| {
            if let Err(error) = terminal_data_tx.blocking_send(TerminalPush::Data(chunk)) {
                tracing::warn!(?error, "terminal event channel closed");
            }
        });
    let on_exit: terminal::service::ExitSink =
        Arc::new(move |info: terminal::service::TerminalExitInfo| {
            if let Err(error) = terminal_tx.blocking_send(TerminalPush::Exit(info)) {
                tracing::warn!(?error, "terminal event channel closed");
            }
        });
    (on_data, on_exit)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn chunk(terminal_id: &str, data: &str) -> TerminalPush {
        TerminalPush::Data(terminal::service::TerminalChunk {
            terminal_id: terminal_id.to_string(),
            data: data.to_string(),
        })
    }

    fn exit(terminal_id: &str) -> TerminalPush {
        TerminalPush::Exit(terminal::service::TerminalExitInfo {
            terminal_id: terminal_id.to_string(),
            exit_code: 0,
            signal: None,
        })
    }

    fn timeline_event(
        id: &str,
        session_id: &str,
        event_type: &str,
    ) -> argmax_store::events::TimelineEvent {
        let payload = serde_json::json!({ "text": "payload" });
        argmax_store::events::TimelineEvent {
            id: id.to_string(),
            session_id: session_id.to_string(),
            r#type: event_type.to_string(),
            message: "payload".to_string(),
            semantic: argmax_store::timeline_semantics::derive(event_type, id, &payload),
            payload,
            created_at: "2026-01-01T00:00:00Z".to_string(),
            row_cursor: Some(1),
        }
    }

    fn raw_output(id: &str, session_id: &str) -> argmax_store::events::RawProviderOutput {
        argmax_store::events::RawProviderOutput {
            id: id.to_string(),
            session_id: session_id.to_string(),
            stream: "stdout".to_string(),
            content: "raw payload".to_string(),
            created_at: "2026-01-01T00:00:00Z".to_string(),
            row_cursor: Some(1),
        }
    }

    #[tokio::test]
    async fn dashboard_delivery_replaces_an_overflowed_window_with_resync() {
        let (delivery, mut receiver) = DashboardDelivery::new();
        for index in 0..=DASHBOARD_DELIVERY_ITEMS {
            delivery.send(providers::flush_queue::DashboardDelta {
                removed_session_ids: vec![format!("session-{index}")],
                ..Default::default()
            });
        }
        assert!(delivery.resync_required.load(Ordering::Acquire));

        let first = receiver.recv().await.expect("queued delivery");
        let mut deferred = None;
        let delta = prepare_dashboard_batch(
            first,
            &mut receiver,
            &delivery.resync_required,
            &delivery.generation,
            &mut deferred,
        )
        .expect("resync delta");
        assert!(delta.resync_required);
        assert!(delta.dashboard_changed);
        assert!(delta.removed_session_ids.is_empty());
        assert!(
            receiver.try_recv().is_err(),
            "overflowed backlog was discarded"
        );
        assert_eq!(
            delivery.byte_budget.available_permits(),
            DASHBOARD_DELIVERY_BYTES,
            "discarding the backlog releases its exact byte reservations"
        );
    }

    #[tokio::test]
    async fn dashboard_delivery_sends_transcript_hints_without_heavy_rows() {
        let (delivery, mut receiver) = DashboardDelivery::new();
        let mut events = Vec::with_capacity(10_000);
        events.extend([
            timeline_event("e1", "s1", "message.delta"),
            timeline_event("e2", "s2", "session.moved"),
        ]);
        let mut outputs = Vec::with_capacity(10_000);
        outputs.push(raw_output("r1", "s3"));
        delivery.send(providers::flush_queue::DashboardDelta {
            events,
            raw_outputs: outputs,
            removed_workspace_ids: vec!["w1".to_string()],
            ..Default::default()
        });

        let DashboardDeliveryItem::Delta(queued) = receiver.recv().await.expect("queued") else {
            panic!("expected a delta");
        };
        assert_eq!(queued.delta.changed_session_ids, vec!["s1", "s2", "s3"]);
        assert_eq!(queued.delta.events.len(), 1);
        assert_eq!(queued.delta.events[0].r#type, "session.moved");
        assert!(queued.delta.raw_outputs.is_empty());
        assert!(queued.delta.dashboard_changed);
        assert!(queued.delta.removed_workspace_ids.is_empty());
        assert_eq!(queued.delta.events.capacity(), queued.delta.events.len());
        assert_eq!(queued.delta.raw_outputs.capacity(), 0);
        assert_eq!(queued.delta.removed_workspace_ids.capacity(), 0);
        assert_eq!(
            queued.serialized_bytes,
            serde_json::to_vec(&queued.delta).unwrap().len()
        );
    }

    #[tokio::test]
    async fn an_oversized_dashboard_delta_wakes_the_worker_with_resync() {
        let (delivery, mut receiver) = DashboardDelivery::new();
        let mut oversized_move = timeline_event("move", "s1", "session.moved");
        oversized_move.message = "x".repeat(DASHBOARD_DELIVERY_BYTES + 1);
        delivery.send(providers::flush_queue::DashboardDelta {
            events: vec![oversized_move],
            ..Default::default()
        });

        let first = receiver.recv().await.expect("resync wake");
        let mut deferred = None;
        let delta = prepare_dashboard_batch(
            first,
            &mut receiver,
            &delivery.resync_required,
            &delivery.generation,
            &mut deferred,
        )
        .expect("resync delta");
        assert!(delta.resync_required);
    }

    #[tokio::test]
    async fn a_pre_overflow_sender_cannot_land_stale_metadata_after_resync() {
        let (delivery, mut receiver) = DashboardDelivery::new();
        delivery.require_resync();
        let wake = receiver.recv().await.expect("wake");
        let mut deferred = None;
        let marker = prepare_dashboard_batch(
            wake,
            &mut receiver,
            &delivery.resync_required,
            &delivery.generation,
            &mut deferred,
        )
        .expect("marker");
        assert!(marker.resync_required);

        let stale_delta = providers::flush_queue::DashboardDelta {
            removed_session_ids: vec!["stale".to_string()],
            ..Default::default()
        };
        let bytes = stale_delta.serialized_payload_bytes().unwrap();
        let permit = Arc::clone(&delivery.byte_budget)
            .try_acquire_many_owned(bytes as u32)
            .unwrap();
        delivery
            .sender
            .try_send(DashboardDeliveryItem::Delta(QueuedDashboardDelta {
                delta: stale_delta,
                serialized_bytes: bytes,
                generation: 0,
                _byte_permit: permit,
            }))
            .expect("inject delayed old-generation send");
        let stale = receiver.recv().await.expect("stale item");
        assert!(
            prepare_dashboard_batch(
                stale,
                &mut receiver,
                &delivery.resync_required,
                &delivery.generation,
                &mut deferred,
            )
            .is_none(),
            "old-generation metadata must not follow a completed resync"
        );
    }

    #[tokio::test]
    async fn terminal_delivery_applies_lossless_backpressure_at_its_item_bound() {
        let (sender, mut receiver) =
            tokio::sync::mpsc::channel::<TerminalPush>(TERMINAL_DELIVERY_ITEMS);
        let (filled_tx, filled_rx) = std::sync::mpsc::channel();
        let (finished_tx, finished_rx) = std::sync::mpsc::channel();
        let producer = std::thread::spawn(move || {
            for _ in 0..TERMINAL_DELIVERY_ITEMS {
                sender
                    .blocking_send(chunk("t1", "12345678"))
                    .expect("queue open");
            }
            filled_tx.send(()).unwrap();
            sender
                .blocking_send(chunk("t1", "last"))
                .expect("queue resumes");
            finished_tx.send(()).unwrap();
        });

        filled_rx
            .recv_timeout(std::time::Duration::from_secs(1))
            .expect("producer filled queue");
        assert_eq!(receiver.len(), TERMINAL_DELIVERY_ITEMS);
        assert!(
            finished_rx.try_recv().is_err(),
            "producer must block instead of dropping output"
        );
        receiver.recv().await.expect("free one slot");
        finished_rx
            .recv_timeout(std::time::Duration::from_secs(1))
            .expect("producer resumed after consumer made room");
        drop(receiver);
        producer.join().expect("producer thread");
    }

    #[test]
    fn terminal_pushes_conflate_per_terminal_without_reordering_an_exit() {
        let coalesced = coalesce_terminal_pushes(vec![
            chunk("a", "one"),
            chunk("b", "B1"),
            chunk("a", "-two"),
            exit("a"),
            // Output that lands after the shell exited must stay behind the
            // exit rather than being folded into the chunk in front of it.
            chunk("a", "-late"),
            chunk("b", "-B2"),
        ]);

        let rendered: Vec<(String, String)> = coalesced
            .iter()
            .map(|push| match push {
                TerminalPush::Data(chunk) => {
                    (chunk.terminal_id.clone(), format!("data:{}", chunk.data))
                }
                TerminalPush::Exit(info) => (info.terminal_id.clone(), "exit".to_string()),
            })
            .collect();

        assert_eq!(
            rendered,
            vec![
                ("a".to_string(), "data:one-two".to_string()),
                ("b".to_string(), "data:B1-B2".to_string()),
                ("a".to_string(), "exit".to_string()),
                ("a".to_string(), "data:-late".to_string()),
            ]
        );
    }

    #[tokio::test]
    async fn a_burst_of_large_deltas_leaves_in_pushes_inside_the_conflation_cap() {
        // The main thread parses each push as JavaScript source, so a push
        // past the cap holds up the window. 60 deltas of 40 KB fill a queue
        // that stays under the 4 MiB delivery bound.
        let (delivery, mut receiver) = DashboardDelivery::new();
        let sent = 60;
        for index in 0..sent {
            let mut moved = timeline_event(&format!("e{index}"), "s1", "session.moved");
            moved.message = "m".repeat(40 * 1024);
            delivery.send(providers::flush_queue::DashboardDelta {
                events: vec![moved],
                ..Default::default()
            });
        }
        assert!(!delivery.resync_required.load(Ordering::Acquire));

        let (mut pushes, mut rows) = (0, 0);
        let mut deferred = None;
        while let Some(first) = deferred.take().or_else(|| receiver.try_recv().ok()) {
            let delta = prepare_dashboard_batch(
                first,
                &mut receiver,
                &delivery.resync_required,
                &delivery.generation,
                &mut deferred,
            )
            .expect("batch");
            let bytes = serde_json::to_vec(&delta).unwrap().len();
            assert!(
                bytes <= MAX_CONFLATED_DELTA_BYTES,
                "push {pushes} weighs {bytes} bytes"
            );
            pushes += 1;
            rows += delta.events.len();
        }
        assert_eq!(rows, sent, "every queued row leaves in some push");
    }
}
