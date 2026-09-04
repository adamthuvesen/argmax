// Argmax library crate — Rust/Tauri runtime, services, and IPC handlers.

use std::path::Path;
use std::sync::{
    atomic::{AtomicBool, AtomicU64, Ordering},
    Arc,
};

use tauri::{Emitter, Manager};

pub mod approvals;
pub mod attachments;
pub mod browser;
pub mod checks;
pub mod default_agent;
pub mod dock;
pub mod error;
pub mod files;
pub mod gh;
pub mod git;
pub mod ide;
pub mod inbox_hook;
pub mod ipc;
pub mod mcp;
pub mod menu;
pub mod multitask;
pub mod notifications;
pub mod persistence;
pub mod providers;
pub mod remote;
pub mod review;
pub mod routines;
pub mod session_control;
pub mod sessions;
pub mod skills;
pub mod state;
pub mod sync;
pub mod terminal;
pub mod updater;
pub mod usage;
pub mod util;
pub mod workspace_assets;
pub mod workspaces;

use serde_json::json;
use specta_typescript::{BigIntExportBehavior, Typescript};
use util::startup_timer::StartupTimer;

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
struct DashboardDelivery {
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
    fn send(&self, mut delta: providers::flush_queue::DashboardDelta) {
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

/// Construct and run the Tauri app.
pub fn run() {
    if let Err(error) = providers::verification::validate_configuration() {
        eprintln!("argmax: verification configuration invalid: {error}");
        std::process::exit(2);
    }

    let timer = Arc::new(StartupTimer::new());
    timer.mark("boot");

    let specta_builder = ipc::specta_builder();
    timer.mark("specta.builder");

    // Codegen: emit `src/shared/bindings.d.ts` on every debug startup so
    // the renderer's TS surface stays in lockstep with the Rust command
    // surface. `build.rs` cannot do this (build scripts run before the
    // rest of the crate is even type-checked, so they can't import
    // command functions), so the export lives here instead.
    #[cfg(all(debug_assertions, not(feature = "verification")))]
    if let Err(e) = export_bindings("../src/shared/bindings.d.ts") {
        eprintln!("argmax: tauri-specta export failed: {e}");
    }
    #[cfg(all(debug_assertions, not(feature = "verification")))]
    timer.mark("bindings.export");

    let builder = tauri::Builder::default();
    #[cfg(feature = "verification")]
    let builder = if std::env::var("ARGMAX_VERIFICATION").as_deref() == Ok("1") {
        builder.plugin(tauri_plugin_wdio_webdriver::init())
    } else {
        builder
    };

    builder
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        // Serve `argmax-attachment://file/<abs-path>` image URLs from the
        // on-disk attachment store. Without this, pasted-image previews in the
        // composer/chat 404. The store dir depends on `app_data_dir` (only
        // known after setup), so it's resolved per request; serving happens
        // off-thread so the webview's IO isn't blocked.
        .register_asynchronous_uri_scheme_protocol(
            attachments::protocol::ATTACHMENT_PROTOCOL_SCHEME,
            |ctx, request, responder| {
                let app = ctx.app_handle().clone();
                let uri = request.uri().to_string();
                tauri::async_runtime::spawn(async move {
                    let built = match util::data_dir::app_data_dir(&app) {
                        Ok(app_data) => {
                            let base_dir = app_data.join("local-state").join("attachments");
                            let response =
                                attachments::protocol::serve_attachment(&base_dir, &uri).await;
                            let mut builder =
                                tauri::http::Response::builder().status(response.http_status());
                            if let Some(content_type) = response.content_type {
                                builder = builder
                                    .header(tauri::http::header::CONTENT_TYPE, content_type);
                            }
                            builder.body(response.bytes)
                        }
                        Err(error) => {
                            tracing::warn!(?error, "attachment protocol: app_data_dir unavailable");
                            tauri::http::Response::builder().status(500).body(Vec::new())
                        }
                    };
                    match built {
                        Ok(response) => responder.respond(response),
                        Err(error) => {
                            tracing::warn!(?error, "attachment protocol: failed to build response")
                        }
                    }
                });
            },
        )
        // Serve `argmax-asset://file/<abs-path>` image URLs referenced from
        // rendered workspace files (e.g. relative `<img>` in a previewed
        // README.md). Without this, those images 404. Serving is confined to
        // known project/workspace roots (resolved per request from AppState)
        // and runs off-thread so the webview's IO isn't blocked.
        .register_asynchronous_uri_scheme_protocol(
            workspace_assets::protocol::WORKSPACE_ASSET_PROTOCOL_SCHEME,
            |ctx, request, responder| {
                let app = ctx.app_handle().clone();
                let uri = request.uri().to_string();
                tauri::async_runtime::spawn(async move {
                    // Resolved inside the task, not in the callback: the
                    // callback runs on the webview's thread, and the root
                    // lookup is a SQLite read.
                    let roots = workspace_assets::protocol::known_roots(&app);
                    let response =
                        workspace_assets::protocol::serve_workspace_asset(&roots, &uri).await;
                    let mut builder =
                        tauri::http::Response::builder().status(response.http_status());
                    if let Some(content_type) = response.content_type {
                        builder = builder.header(tauri::http::header::CONTENT_TYPE, content_type);
                    }
                    match builder.body(response.bytes) {
                        Ok(response) => responder.respond(response),
                        Err(error) => {
                            tracing::warn!(?error, "asset protocol: failed to build response")
                        }
                    }
                });
            },
        )
        .manage(state::AppState::with_startup_timer(timer.clone()))
        // `window.ready-to-show`: the budgeted end of cold start (see
        // docs/performance.md). Marked once — a later reload must not restamp.
        .on_page_load(|webview, payload| {
            if payload.event() == tauri::webview::PageLoadEvent::Finished {
                let state = tauri::Manager::state::<state::AppState>(webview.app_handle());
                if state.startup_timer.mark_once("window.ready-to-show") {
                    tracing::info!(
                        ready_to_show_ms = state.startup_timer.boot_to_now_ms() as u64,
                        "window ready-to-show"
                    );
                }
            }
        })
        .invoke_handler(specta_builder.invoke_handler())
        .on_menu_event(|app, event| menu::handle_menu_event(app, event.id().as_ref()))
        .on_window_event(dock::clear_badge_on_focus)
        .setup(move |app| {
            timer.mark("setup.enter");
            // Tracing init is deferred to setup() because `app.path()` is
            // only valid here — that's how we resolve the user_data_dir
            // the release-mode rolling-file appender writes into.
            let user_data = util::data_dir::app_data_dir(app).ok();
            if let Err(e) = util::tracing_init::init(user_data.as_deref()) {
                eprintln!("argmax: tracing init failed: {e}");
            }
            timer.mark("tracing.init");
            // Keep macOS App Nap from suspending the webview while the window is
            // backgrounded — otherwise emitted `dashboard:delta` events don't
            // reach the renderer until the user refocuses, so finished turns
            // look stuck on the thinking bubble.
            util::app_nap::prevent_app_nap();
            // Resolving the login shell runs `zsh -lic`, which costs whatever
            // the user's rc files cost. Every git command needs its PATH, so
            // pay it here on a plain thread rather than letting the first
            // status poll block a runtime worker on someone else's `.zshrc`.
            std::thread::spawn(util::login_shell::warm);
            // Warm provider discovery in the background so the first surface
            // that needs it (WelcomePane, settings, launcher availability)
            // reads cached reports instead of paying the cold probe cost
            // (`cursor-agent --version` alone runs ~350ms).
            let provider_discovery = Arc::clone(
                &tauri::Manager::state::<state::AppState>(app).provider_discovery,
            );
            tauri::async_runtime::spawn(async move {
                provider_discovery.discover_all().await;
            });
            if let Some(user_data) = user_data.as_ref() {
                let data_dir = user_data.join("local-state");
                if let Err(e) = std::fs::create_dir_all(&data_dir) {
                    tracing::warn!(error = ?e, path = %data_dir.display(), "failed to create data directory");
                    // No data directory means the database will never open, so
                    // record the reason: without one every handler reports
                    // "startup may still be in progress" forever.
                    let state = tauri::Manager::state::<state::AppState>(app);
                    let _ = state.db_open_error.set(format!(
                        "could not create the data directory {}: {e}",
                        data_dir.display()
                    ));
                } else {
                    let state = tauri::Manager::state::<state::AppState>(app);
                    if state
                        .attachments
                        .set(Arc::new(attachments::store::AttachmentStore::from_data_dir(
                            &data_dir,
                        )))
                        .is_err()
                    {
                        tracing::warn!("attachment store was already initialized");
                    }
                    // Refuse to run against local state another live instance
                    // owns: the boot recovery below would mark that instance's
                    // running sessions failed (they look orphaned from here).
                    match util::instance_lock::acquire(&data_dir) {
                        Ok(Some(lock)) => {
                            // Held until process exit; nothing reads it back.
                            std::mem::forget(lock);
                        }
                        Ok(None) => {
                            tracing::error!(
                                "another Argmax instance owns the local state; exiting"
                            );
                            // Tauri builds the config's `main` window before the
                            // setup hook runs; hide it so the doomed instance
                            // doesn't flash a dead UI behind the dialog.
                            if let Some(window) = app.get_window("main") {
                                let _ = window.hide();
                            }
                            use tauri_plugin_dialog::DialogExt;
                            app.dialog()
                                .message("Argmax is already running. Use the existing window.")
                                .title("Argmax is already running")
                                .kind(tauri_plugin_dialog::MessageDialogKind::Warning)
                                .show(|_| std::process::exit(0));
                            // The process idles (window hidden) until the
                            // dialog's exit callback fires.
                            return Ok(());
                        }
                        Err(error) => {
                            // A missing lock only loses the double-launch
                            // guard; the app itself still works.
                            tracing::warn!(?error, "could not create the instance lock; continuing unlocked");
                        }
                    }
                    match persistence::Database::open(data_dir.join("argmax.sqlite")) {
                        Ok(database) => {
                            timer.mark("db.open");
                            let database = Arc::new(database);
                            let state = tauri::Manager::state::<state::AppState>(app);
                            if state.db.set(Arc::clone(&database)).is_err() {
                                tracing::warn!("database state was already initialized");
                            }
                            let usage_scanner = Arc::new(usage::scanner::UsageScanner::new(
                                Arc::clone(&database),
                                sync::home_dir(),
                            ));
                            // A ledger that has completed before is refreshed
                            // in the background so the page opens fresh. The
                            // first cold sweep reads gigabytes and waits for
                            // the user to ask for it.
                            if usage_scanner.has_completed_once() {
                                usage::scanner::spawn_sweep(&usage_scanner);
                            }
                            if state.usage_scanner.set(usage_scanner).is_err() {
                                tracing::warn!("usage scanner was already initialized");
                            }
                            let dock_badge = Arc::new(dock::DockBadgeService::new(
                                dock::TauriDockBadgeSink::new(app.handle().clone()),
                                {
                                    let database = Arc::clone(&database);
                                    Arc::new(move || {
                                        persistence::dashboard::count_attention(
                                            &database.read_connection(),
                                        )
                                        .map(|counts| counts.total)
                                    })
                                },
                            ));
                            if state.dock_badge.set(Arc::clone(&dock_badge)).is_err() {
                                tracing::warn!("dock badge state was already initialized");
                            }
                            // Approvals left pending by the previous run badge
                            // the dock from the first frame.
                            if let Err(error) = dock_badge.update() {
                                tracing::warn!(?error, "failed to set the dock badge at boot");
                            }
                            // Warm the FTS5 message index on the blocking pool so the
                            // user's first ⌘K message search skips the cold-start cost:
                            // FTS5 module init, compiling the `session:search` statement
                            // (cached and reused for every search after), and paging in
                            // the index structure. The throwaway term matches nothing, so
                            // it reads few pages and won't contend with startup reads; a
                            // failure (empty/fresh DB) is traced, never fatal.
                            let warm_db = Arc::clone(&database);
                            tauri::async_runtime::spawn_blocking(move || {
                                let connection = warm_db.connection();
                                if let Err(error) =
                                    persistence::learnings::search_events(&connection, "warmup", 1)
                                {
                                    tracing::trace!(?error, "fts warm-up query failed");
                                }
                            });
                            let notifications = Arc::new(notifications::NotificationService::new(
                                notifications::main_window_focus_probe(app.handle().clone()),
                                notifications::TauriNotificationSink::new(app.handle().clone()),
                            ));
                            if state.notifications.set(Arc::clone(&notifications)).is_err() {
                                tracing::warn!("notifications state was already initialized");
                            }
                            // Single bounded FIFO for every dashboard
                            // invalidation (providers + gh poller + workspaces).
                            // One worker task pulls from it and emits in order.
                            // Previously each publish spawned its own
                            // tauri::async_runtime task — with tokio's
                            // multi-worker scheduler that meant two deltas
                            // emitted back-to-back could land at the renderer
                            // in reverse order, occasionally letting a
                            // `session.completed` arrive before its preceding
                            // `message.completed`.
                            let (delta_tx, mut delta_rx) = DashboardDelivery::new();
                            let delta_resync_required = Arc::clone(&delta_tx.resync_required);
                            let delta_generation = Arc::clone(&delta_tx.generation);
                            let emit_handle = app.handle().clone();
                            let remote_events = state.remote_events.clone();
                            let dock_badge_for_delta = Arc::clone(&dock_badge);
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
                                        if let Err(error) = dock_badge_for_delta.update() {
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
                            let notifications_for_delta = Arc::clone(&notifications);
                            let ntfy_app = app.handle().clone();
                            let provider_delta_tx = delta_tx.clone();
                            let publish_delta = move |delta: providers::flush_queue::DashboardDelta| {
                                let ntfy = tauri::Manager::state::<state::AppState>(&ntfy_app)
                                    .ntfy
                                    .read()
                                    .ok()
                                    .and_then(|publisher| publisher.clone());
                                for session in &delta.sessions {
                                    if let Err(error) = notifications_for_delta.notify(session) {
                                        tracing::warn!(
                                            ?error,
                                            session_id = %session.id,
                                            "failed to fire terminal-state notification"
                                        );
                                    }
                                    if let Some(ntfy) = ntfy.as_ref() {
                                        ntfy.observe(session);
                                    }
                                }
                                tracing::trace!(
                                    sessions = delta.sessions.len(),
                                    events = delta.events.len(),
                                    raw_outputs = delta.raw_outputs.len(),
                                    workspaces = delta.workspaces.len(),
                                    "queuing dashboard:delta"
                                );
                                provider_delta_tx.send(delta);
                            };
                            let approval_delta_tx = delta_tx.clone();
                            let approvals = approvals::service::ApprovalService::with_publisher(
                                Arc::clone(&database),
                                move |delta| {
                                    approval_delta_tx.send(delta);
                                },
                            );
                            if state.approvals.set(Arc::clone(&approvals)).is_err() {
                                tracing::warn!("approval service state was already initialized");
                            }
                            let (session_launch_server, session_launch_registry) =
                                match session_control::SessionLaunchServer::bind() {
                                    Ok((server, registry)) => (Some(server), Some(registry)),
                                    Err(error) => {
                                        tracing::warn!(?error, "session launch control unavailable");
                                        (None, None)
                                    }
                                };
                            let lifecycle = workspaces::lifecycle::WorkspaceLifecycle::new();
                            // Share the boot-warmed discovery cache so the first
                            // launch per provider skips the version/auth probe
                            // (`cursor-agent status` alone runs ~800 ms).
                            let cursor_acp =
                                Arc::new(providers::cursor_acp::CursorAcpSessions::new());
                            if state.cursor_acp.set(Arc::clone(&cursor_acp)).is_err() {
                                tracing::warn!("cursor ACP pool state was already initialized");
                            }
                            let provider_launcher: Arc<dyn providers::runtime::ProviderProcessLauncher> =
                                Arc::new(providers::runtime::RealProviderProcessLauncher::with_discovery(
                                    (*state.provider_discovery).clone(),
                                    session_launch_registry.clone(),
                                    Arc::clone(&cursor_acp),
                                ));
                            let providers = providers::session_service::ProviderSessionService::with_launcher_and_lifecycle_and_approvals(
                                Arc::clone(&database),
                                provider_launcher,
                                publish_delta,
                                Arc::clone(&lifecycle),
                                Some(Arc::clone(&approvals)),
                            );
                            if let Some(registry) = session_launch_registry {
                                providers.set_session_control(registry);
                            }
                            if let Err(error) = providers.recover_orphaned_sessions() {
                                tracing::warn!(?error, "failed to recover orphaned sessions");
                            }
                            timer.mark("sessions.recover");
                            if state.providers.set(Arc::clone(&providers)).is_err() {
                                tracing::warn!("provider service state was already initialized");
                            }
                            // Terminal pushes take the same shape as
                            // `dashboard:delta`: a FIFO queue and one worker
                            // that conflates what piled up into a single
                            // main-thread hop. The PTY reader thread produces
                            // an 8 KiB chunk at a time, at MB/s, with no
                            // backpressure — one `run_on_main_thread` +
                            // `Emitter::emit` per chunk is what makes a `cat`
                            // of a large file freeze the window.
                            let (terminal_tx, mut terminal_rx) =
                                tokio::sync::mpsc::channel::<TerminalPush>(TERMINAL_DELIVERY_ITEMS);
                            let emit_handle = app.handle().clone();
                            let remote_terminal_events = state.remote_terminal_events.clone();
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
                                            TerminalPush::Data(chunk) => remote::publish(
                                                &remote_terminal_events,
                                                "terminal:data",
                                                chunk,
                                            ),
                                            TerminalPush::Exit(info) => remote::publish(
                                                &remote_terminal_events,
                                                "terminal:exit",
                                                info,
                                            ),
                                        }
                                    }
                                    let handle = emit_handle.clone();
                                    let (emitted_tx, emitted_rx) = tokio::sync::oneshot::channel();
                                    if let Err(error) = emit_handle.run_on_main_thread(move || {
                                        for push in pushes {
                                            let emitted = match push {
                                                TerminalPush::Data(chunk) => {
                                                    handle.emit("terminal:data", chunk)
                                                }
                                                TerminalPush::Exit(info) => {
                                                    handle.emit("terminal:exit", info)
                                                }
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
                            let on_terminal_data = Arc::new(move |chunk: terminal::service::TerminalChunk| {
                                if let Err(error) = terminal_data_tx.blocking_send(TerminalPush::Data(chunk)) {
                                    tracing::warn!(?error, "terminal event channel closed");
                                }
                            });
                            let on_terminal_exit = Arc::new(move |info: terminal::service::TerminalExitInfo| {
                                if let Err(error) = terminal_tx.blocking_send(TerminalPush::Exit(info)) {
                                    tracing::warn!(?error, "terminal event channel closed");
                                }
                            });
                            let terminals = terminal::service::TerminalService::with_lifecycle(
                                Arc::clone(&database),
                                on_terminal_data,
                                on_terminal_exit,
                                Arc::clone(&lifecycle),
                            );
                            if state.terminals.set(terminals).is_err() {
                                tracing::warn!("terminal service state was already initialized");
                            }
                            if state
                                .checks
                                .set(checks::service::CheckService::with_lifecycle(
                                    Arc::clone(&database),
                                    Arc::clone(&lifecycle),
                                ))
                                .is_err()
                            {
                                tracing::warn!("check service state was already initialized");
                            }
                            let gh_service = gh::service::GhService::new(Arc::clone(&database));
                            let poller_database = Arc::clone(&database);
                            let poller_providers = Arc::clone(&providers);
                            let poller_notifications = Arc::clone(&notifications);
                            // The fix chat launches on the app-wide default
                            // agent, mirrored into the app data dir by the
                            // renderer (see crate::default_agent).
                            let poller_data_dir = user_data.clone();
                            let failure_hook = Arc::new(move |context: gh::poller::CheckFailureContext| {
                                let database = Arc::clone(&poller_database);
                                let providers = Arc::clone(&poller_providers);
                                let notifications = Arc::clone(&poller_notifications);
                                let data_dir = poller_data_dir.clone();
                                tauri::async_runtime::spawn(async move {
                                    if let Err(error) =
                                        handle_gh_check_failure(database, providers, notifications, data_dir, context)
                                            .await
                                    {
                                        tracing::warn!(?error, "failed to handle gh check failure");
                                    }
                                });
                            });
                            let gh_delta_tx = delta_tx.clone();
                            let publish_delta = move |delta| {
                                gh_delta_tx.send(delta);
                            };
                            let gh_poller = gh::poller::GhPoller::new(
                                gh::poller::GhPollerConfig::new(
                                    Arc::clone(&database),
                                    gh_service,
                                )
                                .with_delta_publisher(Arc::new(publish_delta))
                                .with_check_failure_hook(failure_hook),
                            );
                            // Defer start() onto the Tauri runtime — calling it
                            // synchronously here panics with "there is no
                            // reactor running" because Tauri's Tokio runtime
                            // is not yet alive during setup().
                            let gh_poller_for_start = Arc::clone(&gh_poller);
                            tauri::async_runtime::spawn(async move {
                                gh_poller_for_start.start();
                            });
                            if state.gh_poller.set(gh_poller).is_err() {
                                tracing::warn!("gh poller state was already initialized");
                            }
                            let workspace_delta_tx = delta_tx.clone();
                            let publish_delta = move |delta| {
                                workspace_delta_tx.send(delta);
                            };
                            let workspaces = workspaces::WorkspaceService::with_services(
                                Arc::clone(&database),
                                publish_delta,
                                lifecycle,
                                Some(Arc::clone(&providers)),
                                state.checks.get().cloned(),
                                state.terminals.get().cloned(),
                                Some(Arc::clone(&approvals)),
                                Some(data_dir.join("side-chats")),
                            );
                            // Archive and project teardown evict the workspace's
                            // warm `cursor-agent acp` process; without the pool
                            // here that eviction is a no-op and the child
                            // outlives its removed worktree.
                            workspaces.set_cursor_acp(cursor_acp);
                            if let Err(error) = workspaces.recover_interrupted_archives() {
                                tracing::warn!(?error, "failed to recover interrupted workspace archives");
                            }
                            timer.mark("archives.recover");
                            let workspaces_for_watchers = Arc::clone(&workspaces);
                            if state.workspaces.set(workspaces).is_err() {
                                tracing::warn!("workspace service state was already initialized");
                            }
                            if let Some(server) = session_launch_server {
                                match server.start(
                                    Some(app.handle().clone()),
                                    Arc::clone(&database),
                                    Arc::clone(&workspaces_for_watchers),
                                    Arc::clone(&providers),
                                ) {
                                    Ok(server) => {
                                        if state.session_launch_server.set(server).is_err() {
                                            tracing::warn!(
                                                "session launch server state was already initialized"
                                            );
                                        }
                                    }
                                    Err(error) => {
                                        tracing::warn!(?error, "session launch server failed to start")
                                    }
                                }
                            }
                            // Watcher refresh loops use tokio::spawn. Setup runs
                            // during the synchronous macOS launch callback, so
                            // defer restoration until Tauri's runtime is alive.
                            tauri::async_runtime::spawn(async move {
                                match workspaces_for_watchers.start_open_watchers() {
                                    // Workspaces sharing a checkout share its
                                    // watch, so the two counts diverge sharply
                                    // once a repo has many sessions.
                                    Ok(watched) => tracing::info!(
                                        watched,
                                        os_watches =
                                            workspaces_for_watchers.watched_checkout_count(),
                                        "restored workspace watchers"
                                    ),
                                    Err(error) => {
                                        tracing::warn!(?error, "failed to start workspace watchers")
                                    }
                                }
                            });
                            // Mark services as constructed only on the success
                            // path — otherwise a failed DB open still reported a
                            // healthy boot while every handler returned
                            // SERVICE_ERROR.
                            timer.mark("services.construct");
                        }
                        Err(e) => {
                            tracing::warn!(error = ?e, "failed to open database");
                            let state = tauri::Manager::state::<state::AppState>(app);
                            let _ = state.db_open_error.set(e.to_string());
                        }
                    }
                }
            } else {
                tracing::warn!("no app data dir; the database cannot be opened");
                let state = tauri::Manager::state::<state::AppState>(app);
                let _ = state
                    .db_open_error
                    .set("the app data directory could not be resolved".to_string());
            }
            if let Err(e) = menu::install_app_menu(app.handle(), cfg!(debug_assertions)) {
                tracing::warn!(error = ?e, "failed to install app menu");
            }
            timer.mark("ipc.register");
            // Deferred like the discovery warm-up: reading remote.json and
            // binding a socket must never sit on the boot path, and the bridge
            // stays off entirely unless the config enables it.
            let remote_app = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                remote::start(remote_app).await;
            });
            // Session sync polls the provider transcript stores on a timer.
            // Deliberately not a filesystem watcher: those stores churn on
            // every keystroke of every running CLI.
            let sync_app = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                sync_sweep_loop(sync_app).await;
            });
            // Scheduled tasks ("routines") fire stored prompts on a schedule.
            // The loop pulls services from state per tick, so starting it
            // here — before the database may have opened — is safe.
            routines::scheduler::spawn(app.handle().clone());
            if app.get_window("main").is_some() {
                timer.mark("window.create");
            }
            tracing::info!(
                boot_ms = timer.boot_to_now_ms() as u64,
                phases = ?timer.snapshot(),
                "tracing online"
            );
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            if let tauri::RunEvent::Exit = event {
                // Warm cursor ACP processes must not outlive the app: boot
                // orphan recovery cannot match `cursor-agent acp` argv (no
                // session id), so a leak here would linger until logout. This
                // callback runs on the main thread, not a tokio worker, so
                // the blocking pool lock is safe.
                let state = tauri::Manager::state::<state::AppState>(app_handle);
                if let Some(pool) = state.cursor_acp.get() {
                    pool.kill_all_blocking();
                }
            }
        });
}

/// How often the provider transcript stores are re-scanned. Slow on purpose:
/// an import is a convenience, and a sweep stats every transcript file.
const SYNC_SWEEP_INTERVAL: std::time::Duration = std::time::Duration::from_secs(60);

/// Poll for sessions started outside Argmax. The first sweep is also the
/// catch-up for everything that happened while the app was closed.
async fn sync_sweep_loop(app: tauri::AppHandle) {
    use crate::util::sync::LockOrRecover;
    use tauri::Manager;

    let Ok(app_data_dir) = crate::util::data_dir::app_data_dir(&app) else {
        tracing::warn!("session sync disabled: no app data dir");
        return;
    };
    let mut interval = tokio::time::interval(SYNC_SWEEP_INTERVAL);
    // A sweep that overran its tick must not be followed by a burst of
    // catch-up sweeps: they would all scan the same unchanged files.
    interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        interval.tick().await;
        let config = crate::sync::load_or_create_config(&app_data_dir);
        // Clone the handles out and drop the `State` borrow before awaiting.
        let (database, workspaces, sweep_lock) = {
            let state = app.state::<crate::state::AppState>();
            let (Some(database), Some(workspaces)) = (state.db.get(), state.workspaces.get())
            else {
                continue;
            };
            (
                Arc::clone(database),
                Arc::clone(workspaces),
                Arc::clone(&state.sync_sweep),
            )
        };
        // The sweep stats every transcript file under the provider store and
        // writes SQLite, so it belongs on the blocking pool, not on a worker.
        let outcome = tauri::async_runtime::spawn_blocking(move || {
            let _serialized = sweep_lock.lock_or_recover("sync sweep");
            crate::sync::run_sync(
                &database,
                &workspaces,
                &config,
                &crate::sync::home_dir(),
                crate::sync::now_ms(),
            )
        })
        .await;
        let outcome = match outcome {
            Ok(outcome) => outcome,
            Err(error) => {
                tracing::warn!(?error, "session sync sweep task failed to join");
                continue;
            }
        };
        let report = match outcome {
            Ok(outcome) => {
                if outcome.imported > 0 || outcome.pruned > 0 || outcome.extended > 0 {
                    tracing::info!(
                        imported = outcome.imported,
                        extended = outcome.extended,
                        pruned = outcome.pruned,
                        "session sync sweep"
                    );
                }
                crate::sync::SyncReport::ok(outcome)
            }
            Err(error) => {
                tracing::warn!(?error, "session sync sweep failed");
                crate::sync::SyncReport::failed(error.to_string())
            }
        };
        *app.state::<crate::state::AppState>()
            .sync_report
            .lock_or_recover("sync report") = Some(report);
    }
}

async fn handle_gh_check_failure(
    database: Arc<persistence::Database>,
    providers: Arc<providers::session_service::ProviderSessionService>,
    notifications: Arc<
        notifications::NotificationService<notifications::TauriNotificationSink<tauri::Wry>>,
    >,
    app_data_dir: std::path::PathBuf,
    context: gh::poller::CheckFailureContext,
) -> error::ArgmaxResult<()> {
    let (session, pr, input) = {
        let connection = database.connection();
        let session = persistence::sessions::find_session_by_id(&connection, &context.session_id)?;
        let workspace =
            persistence::workspaces::find_workspace_by_id(&connection, &context.workspace_id)?;
        persistence::projects::require_project(&connection, &workspace.project_id)?;
        let pr = persistence::gh::list_gh_pr_for_session(&connection, &context.session_id)?
            .into_iter()
            .find(|row| row.pr_number == context.pr_number && row.head_sha == context.head_sha)
            .unwrap_or_else(|| persistence::gh::GhPrRecord {
                session_id: context.session_id.clone(),
                pr_number: context.pr_number,
                head_sha: context.head_sha.clone(),
                last_seen_check_state: "failure".to_string(),
                updated_at: persistence::time::now_iso(),
                pr_state: Some("OPEN".to_string()),
                notified_at: None,
                pr_created_at: None,
                pr_merged_at: None,
                // Display-only fallback for a row that went missing between
                // poll and notify; never persisted, so leave the branch unset
                // rather than guessing it from the workspace's current one.
                head_ref_name: None,
            });
        let agent = default_agent::read_default_agent(&app_data_dir);
        let input = build_check_failure_follow_up_input(&workspace.id, &agent, &context)?;
        (session, pr, input)
    };

    if let Err(error) = notifications.notify_check_failure(&session, &pr) {
        tracing::warn!(?error, session_id = %session.id, "failed to fire check-failure notification");
    }
    providers.launch(input).await?;
    let connection = database.connection();
    persistence::gh::mark_gh_pr_notified(
        &connection,
        &context.session_id,
        context.pr_number,
        &context.head_sha,
        &persistence::time::now_iso(),
    )
}

fn build_check_failure_follow_up_input(
    workspace_id: &str,
    agent: &default_agent::DefaultAgent,
    context: &gh::poller::CheckFailureContext,
) -> error::ArgmaxResult<ipc::inputs::ProvidersLaunchInput> {
    serde_json::from_value(json!({
        "workspaceId": workspace_id,
        "provider": agent.provider,
        "prompt": format!(
            "Checks on PR #{} (commit {}) are failing. Run `gh pr checks {}` to see which checks failed, then investigate and fix.",
            context.pr_number,
            context.head_sha.chars().take(12).collect::<String>(),
            context.pr_number
        ),
        "modelLabel": agent.model_label,
        "modelId": agent.model_id,
        "reasoningEffort": agent.reasoning_effort,
        "cols": 120,
        "rows": 36
    }))
    .map_err(|error| error::ArgmaxError::service("GH_FOLLOW_UP_INPUT_INVALID", error.to_string()))
}

/// Per-provider catalog default, mirroring PROVIDER_MODEL_DEFAULTS in
/// src/shared/providerModels.ts. Used where a provider is already fixed and
/// only its model needs filling in (session control, imported sessions); the
/// app-wide default agent lives in [`default_agent`].
#[derive(Clone, Copy)]
pub struct ProviderDefaults {
    pub model_label: &'static str,
    pub model_id: &'static str,
    pub reasoning_effort: Option<&'static str>,
}

pub fn provider_defaults(provider: &str) -> ProviderDefaults {
    match provider {
        "codex" => ProviderDefaults {
            model_label: "GPT-5.6 Sol",
            model_id: "gpt-5.6-sol",
            reasoning_effort: Some("medium"),
        },
        "cursor" => ProviderDefaults {
            model_label: "Grok 4.6 (Cursor)",
            model_id: "cursor-grok-4.6-medium",
            reasoning_effort: Some("medium"),
        },
        "opencode" => ProviderDefaults {
            model_label: "GLM-5.3-Flash",
            model_id: "opencode-go/glm-5.3-flash",
            reasoning_effort: Some("high"),
        },
        "grok" => ProviderDefaults {
            model_label: "Grok 4.6",
            model_id: "grok-4.6",
            reasoning_effort: Some("medium"),
        },
        _ => ProviderDefaults {
            model_label: "Opus 5",
            model_id: "claude-opus-5",
            reasoning_effort: Some("medium"),
        },
    }
}

pub fn export_bindings(path: impl AsRef<Path>) -> Result<(), String> {
    let path = path.as_ref();
    ipc::specta_builder()
        .export(specta_typescript(), path)
        .map_err(|error| error.to_string())?;
    // Specta leaves spaces before newlines in documented object fields.
    // Normalize its output so generated bindings pass the whitespace gate.
    let generated = std::fs::read_to_string(path).map_err(|error| error.to_string())?;
    let normalized = generated
        .lines()
        .map(str::trim_end)
        .collect::<Vec<_>>()
        .join("\n")
        + "\n";
    std::fs::write(path, normalized).map_err(|error| error.to_string())
}

pub fn export_ipc_inventory(
    channels_path: impl AsRef<Path>,
    schemas_path: impl AsRef<Path>,
) -> Result<(), String> {
    let channels = ipc::REGISTERED_CHANNELS.join("\n") + "\n";
    std::fs::write(channels_path, channels).map_err(|error| error.to_string())?;

    let mut schemas = String::from(
        "// Generated from `ipc::REGISTERED_CHANNELS` by `export-bindings`.\n\
         // Runtime validation lives in Rust input newtypes and command structs.\n\n\
         export const IPC_CHANNELS = [\n",
    );
    for channel in ipc::REGISTERED_CHANNELS {
        schemas.push_str("  \"");
        schemas.push_str(channel);
        schemas.push_str("\",\n");
    }
    schemas.push_str("] as const;\n\nexport type IpcChannel = (typeof IPC_CHANNELS)[number];\n");
    std::fs::write(schemas_path, schemas).map_err(|error| error.to_string())
}

fn specta_typescript() -> Typescript {
    Typescript::default().bigint(BigIntExportBehavior::Number)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::tempdir;

    /// Exercises the tauri-specta export pipeline end-to-end without
    /// launching the app. This is the CI guard for "the codegen wiring
    /// actually emits TypeScript", paired with the integration test
    /// `generated_ipc_files_are_current`, which guards that the committed
    /// bindings and channel inventories are what the exporter emits today.
    #[test]
    fn specta_export_emits_command_surface() {
        let dir = tempdir().expect("tempdir");
        let out = dir.path().join("bindings.d.ts");

        export_bindings(&out).expect("specta export ok");

        let contents = fs::read_to_string(&out).expect("read generated bindings");
        assert!(
            contents.contains("health_ping") || contents.contains("healthPing"),
            "expected command surface in bindings:\n{contents}",
        );
    }

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
    ) -> persistence::events::TimelineEvent {
        persistence::events::TimelineEvent {
            id: id.to_string(),
            session_id: session_id.to_string(),
            r#type: event_type.to_string(),
            message: "payload".to_string(),
            payload: serde_json::json!({ "text": "payload" }),
            created_at: "2026-01-01T00:00:00Z".to_string(),
            row_cursor: Some(1),
        }
    }

    fn raw_output(id: &str, session_id: &str) -> persistence::events::RawProviderOutput {
        persistence::events::RawProviderOutput {
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

    fn follow_up_context() -> gh::poller::CheckFailureContext {
        gh::poller::CheckFailureContext {
            session_id: "s1".to_string(),
            workspace_id: "w1".to_string(),
            pr_number: 7,
            head_sha: "abcdef1234567890".to_string(),
        }
    }

    #[test]
    fn check_failure_follow_up_launches_on_the_app_default_agent() {
        let agent = default_agent::DefaultAgent {
            provider: "codex".to_string(),
            model_label: "GPT-5.6 Luna".to_string(),
            model_id: "gpt-5.6-luna".to_string(),
            reasoning_effort: Some("high".to_string()),
        };
        let input = build_check_failure_follow_up_input("w1", &agent, &follow_up_context())
            .expect("follow-up input");
        assert_eq!(input.model_label.as_str(), "GPT-5.6 Luna");
        assert_eq!(input.model_id.as_str(), "gpt-5.6-luna");
        assert_eq!(
            input.reasoning_effort.map(|effort| effort.as_str()),
            Some("high")
        );
    }

    #[test]
    fn check_failure_follow_up_falls_back_to_the_factory_agent() {
        // Nothing mirrored yet — a fresh install launches the fix chat on the
        // same agent the launcher shows: Opus 5 at Medium.
        let input = build_check_failure_follow_up_input(
            "w1",
            &default_agent::DefaultAgent::factory(),
            &follow_up_context(),
        )
        .expect("follow-up input");
        assert_eq!(input.model_label.as_str(), "Opus 5");
        assert_eq!(input.model_id.as_str(), "claude-opus-5");
        assert_eq!(
            input.reasoning_effort.map(|effort| effort.as_str()),
            Some("medium")
        );
    }
}
