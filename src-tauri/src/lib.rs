// Argmax library crate — Rust/Tauri runtime, services, and IPC handlers.

use std::sync::Arc;

use tauri::Manager;

pub mod activity;
pub mod application;
pub mod approvals;
pub mod arcs;
pub mod attachments;
pub mod browser;
pub mod checkpoints;
pub mod checks;
pub mod connections;
pub mod default_agent;
pub mod dock;
mod event_delivery;
pub mod files;
pub mod gh;
pub mod git;
pub mod goals;
pub mod ide;
pub mod inbox_hook;
pub mod ipc;
pub mod mcp;
pub mod menu;
pub mod multitask;
pub mod notifications;
pub mod providers;
pub mod questions;
pub mod remote;
pub mod review;
pub mod routines;
pub mod routing;
pub mod session_control;
pub mod skills;
pub mod state;
pub mod sync;
pub mod terminal;
pub mod text_substitutions;
pub mod updater;
pub mod usage;
pub mod util;
pub mod visualizations;
pub mod window_snapshot;
pub mod windows;
pub mod workspace_assets;
pub mod workspaces;

use util::startup_timer::StartupTimer;

/// `tauri::async_runtime` rather than `tokio::spawn`: the setup hook that opens
/// the database runs on the main thread with no current runtime handle, so a
/// `tokio` spawn there would panic.
pub(crate) fn start_raw_output_prune(database: &argmax_store::Database) {
    let task = tauri::async_runtime::spawn(database.raw_output_prune_loop());
    database.track_prune_task(task.inner().abort_handle());
}

/// Construct and run the Tauri app.
pub fn run() {
    if let Err(error) = util::file_limits::raise_open_file_limit() {
        eprintln!("argmax: failed to raise open-file limit: {error}");
    }

    text_substitutions::disable();

    // rustls 0.23 needs a crypto provider picked explicitly once ring and
    // aws-lc-rs are both reachable in the dependency tree; reqwest's client
    // builder panics instead of erroring when none is installed yet. Nothing
    // else in the tree installs one, so the first `reqwest::Client` built at
    // runtime (APNs, today) is where that panic actually surfaced.
    let _ = rustls::crypto::ring::default_provider().install_default();

    if let Err(error) = providers::verification::validate_configuration() {
        eprintln!("argmax: verification configuration invalid: {error}");
        std::process::exit(2);
    }

    let timer = Arc::new(StartupTimer::new());
    timer.mark("boot");

    let specta_builder = ipc::catalogue::specta_builder();
    timer.mark("specta.builder");

    // Codegen: emit `src/shared/bindings.d.ts` on every debug startup so
    // the renderer's TS surface stays in lockstep with the Rust command
    // surface. `build.rs` cannot do this (build scripts run before the
    // rest of the crate is even type-checked, so they can't import
    // command functions), so the export lives here instead.
    #[cfg(all(debug_assertions, not(feature = "verification")))]
    if let Err(e) = ipc::bindings_export::export_bindings("../src/shared/bindings.d.ts") {
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
        .plugin(windows::chat_navigation_guard())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .register_asynchronous_uri_scheme_protocol(
            attachments::protocol::ATTACHMENT_PROTOCOL_SCHEME,
            |ctx, request, responder| {
                attachments::protocol::respond(
                    ctx.app_handle().clone(),
                    request.uri().to_string(),
                    responder,
                )
            },
        )
        .register_asynchronous_uri_scheme_protocol(
            workspace_assets::protocol::WORKSPACE_ASSET_PROTOCOL_SCHEME,
            |ctx, request, responder| {
                workspace_assets::protocol::respond(
                    ctx.app_handle().clone(),
                    request.uri().to_string(),
                    responder,
                )
            },
        )
        .manage(state::AppState::with_startup_timer(timer.clone()))
        .manage(window_snapshot::shortcut::WindowSnapshotState::default())
        // `window.ready-to-show`: the budgeted end of cold start (see
        // docs/performance.md). Marked once — a later reload must not restamp.
        .on_page_load(|webview, payload| {
            if payload.event() == tauri::webview::PageLoadEvent::Finished {
                // A reload starts the document back at 1.0 and the renderer
                // back at "no zoom"; restate what the user chose.
                if windows::is_chat_window(webview.label()) {
                    menu::restore_main_window_zoom(webview.app_handle());
                }
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
        .on_window_event(|window, event| {
            dock::clear_badge_on_focus(window, event);
            windows::track_window_event(window, event);
        })
        .setup(move |app| setup(app, &timer))
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
                if let Some(pool) = state.grok_acp.get() {
                    pool.kill_all_blocking();
                }
                // Same reason for `codex app-server` and `opencode serve`:
                // no session id in argv, and OpenCode's null stdin gives it
                // no signal that Argmax is gone.
                crate::util::process_control::kill_app_exit_groups_blocking();
            }
        });
}

/// The Tauri setup hook: tracing, the profile, the database, and every
/// service. Runs once, on the main thread, before the first window shows.
fn setup(
    app: &mut tauri::App,
    timer: &Arc<StartupTimer>,
) -> Result<(), Box<dyn std::error::Error>> {
    timer.mark("setup.enter");
    // Tracing init is deferred to setup() because `app.path()` is
    // only valid here — that's how we resolve the user_data_dir
    // the release-mode rolling-file appender writes into.
    let user_data = util::data_dir::app_data_dir(app).ok();
    if let Err(e) = util::tracing_init::init(user_data.as_deref()) {
        eprintln!("argmax: tracing init failed: {e}");
    }
    timer.mark("tracing.init");
    // Resolve the profile once, here, where `app.path()` is finally
    // valid. Handlers the remote bridge dispatches have no AppHandle
    // to resolve it from, so `remote.json` and everything else keyed
    // to the profile is read through AppState from now on.
    if let Some(app_data_dir) = util::data_dir::ensure_app_data_dir(app) {
        let state = tauri::Manager::state::<state::AppState>(app);
        let _ = state.app_data_dir.set(app_data_dir);
    }
    // Keep macOS App Nap from suspending the webview while the window is
    // backgrounded — otherwise emitted `dashboard:delta` events don't
    // reach the renderer until the user refocuses, so finished turns
    // look stuck on the thinking bubble.
    util::app_nap::prevent_app_nap();
    // Resolving the login shell runs `zsh -lic`, which costs whatever
    // the user's rc files cost. Every git command needs its PATH, so
    // pay it here on a plain thread rather than letting the first
    // status poll block a runtime worker on someone else's `.zshrc`.
    std::thread::spawn(argmax_process::login_shell::warm);
    // Warm provider discovery in the background so the first surface
    // that needs it (WelcomePane, settings, launcher availability)
    // reads cached reports instead of paying the cold probe cost
    // (`cursor-agent --version` alone runs ~350ms).
    let provider_discovery =
        Arc::clone(&tauri::Manager::state::<state::AppState>(app).provider_discovery);
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
            let _ = state.attachments.set(Arc::new(
                attachments::store::AttachmentStore::from_data_dir(&data_dir),
            ));
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
                        path = %data_dir.display(),
                        "another Argmax instance owns the local state; exiting \
                         (a second instance needs its own ARGMAX_DATA_DIR, \
                         e.g. `npm run tauri:dev:isolated`)"
                    );
                    // Tauri builds the config's `main` window before the
                    // setup hook runs; hide it so the doomed instance
                    // doesn't flash a dead UI behind the dialog.
                    if let Some(window) = app.get_window("main") {
                        let _ = window.hide();
                    }
                    use tauri_plugin_dialog::DialogExt;
                    app.dialog()
                        .message(
                            "Argmax is already running. Use the existing window, or \
                             start a second instance on its own profile with \
                             ARGMAX_DATA_DIR (npm run tauri:dev:isolated).",
                        )
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
                    tracing::warn!(
                        ?error,
                        "could not create the instance lock; continuing unlocked"
                    );
                }
            }
            match argmax_store::Database::open(data_dir.join("argmax.sqlite")) {
                Ok(database) => start_services(app, timer, user_data, &data_dir, database),
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
        sync::sweep::run(sync_app).await;
    });
    // Archived worktrees past their recovery window are removed on the
    // raw output prune's daily cadence, off the boot path.
    let archive_expiry_app = app.handle().clone();
    tauri::async_runtime::spawn(async move {
        workspaces::archive_expiry::run(archive_expiry_app).await;
    });
    if app.get_window("main").is_some() {
        timer.mark("window.create");
    }
    tracing::info!(
        boot_ms = timer.boot_to_now_ms() as u64,
        phases = ?timer.snapshot(),
        "tracing online"
    );
    Ok(())
}

/// Builds every service on an open database and starts the background work
/// that depends on them. The order is load-bearing: see the comments on each
/// recovery pass.
fn start_services(
    app: &mut tauri::App,
    timer: &Arc<StartupTimer>,
    user_data: &std::path::Path,
    data_dir: &std::path::Path,
    database: argmax_store::Database,
) {
    timer.mark("db.open");
    let database = Arc::new(database);
    start_raw_output_prune(&database);
    let state = tauri::Manager::state::<state::AppState>(app);
    let _ = state.db.set(Arc::clone(&database));
    providers::opencode_gateway::load(&database.read_connection());
    // Off by default; registers the saved chord only if
    // the user turned window snapshots on.
    window_snapshot::shortcut::install(app.handle(), &database.read_connection());
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
    let _ = state.usage_scanner.set(usage_scanner);
    let activity_scanner = Arc::new(activity::scanner::ActivityScanner::new(Arc::clone(
        &database,
    )));
    // Same split as the usage ledger: one that has
    // completed before is refreshed in the background so
    // the page opens fresh, while the first cold sweep
    // walks every repository's history and waits to be
    // asked for.
    if activity_scanner.has_completed_once() {
        activity::scanner::spawn_sweep(&activity_scanner);
    }
    let _ = state.activity_scanner.set(activity_scanner);
    let dock_badge = Arc::new(dock::DockBadgeService::new(
        dock::TauriDockBadgeSink::new(app.handle().clone()),
        {
            let database = Arc::clone(&database);
            Arc::new(move || {
                argmax_store::dashboard::count_attention(&database.read_connection())
                    .map(|counts| counts.total)
            })
        },
    ));
    let _ = state.dock_badge.set(Arc::clone(&dock_badge));
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
        if let Err(error) = argmax_store::learnings::search_events(&connection, "warmup", 1) {
            tracing::trace!(?error, "fts warm-up query failed");
        }
    });
    let notifications = Arc::new(notifications::NotificationService::new(
        notifications::main_window_focus_probe(app.handle().clone()),
        notifications::desktop_sink(app.handle().clone()),
    ));
    let _ = state.notifications.set(Arc::clone(&notifications));
    let delta_tx = event_delivery::spawn_dashboard_delivery(
        app.handle(),
        state.remote_events.clone(),
        Arc::clone(&dock_badge),
    );
    let notifications_for_delta = Arc::clone(&notifications);
    let push_database = Arc::clone(&database);
    let ntfy_app = app.handle().clone();
    let provider_delta_tx = delta_tx.clone();
    let publish_delta = move |delta: providers::flush_queue::DashboardDelta| {
        let app_state = tauri::Manager::state::<state::AppState>(&ntfy_app);
        let ntfy = app_state
            .ntfy
            .read()
            .ok()
            .and_then(|publisher| publisher.clone());
        let apns = app_state
            .apns
            .read()
            .ok()
            .and_then(|publisher| publisher.clone());
        let keep_awake = Arc::clone(&app_state.keep_awake);
        for session in &delta.sessions {
            if let Err(error) = notifications_for_delta.notify(session) {
                tracing::warn!(
                    ?error,
                    session_id = %session.id,
                    "failed to fire terminal-state notification"
                );
            }
            // The push body leads with what the agent
            // last said, so read it once for both sinks
            // — and only for a row that will actually
            // push, since a streaming turn walks
            // through here on every chunk.
            let pushes = (ntfy.is_some() || apns.is_some()) && remote::signal::signals(session);
            let latest_answer = pushes
                .then(|| {
                    argmax_store::events::latest_agent_message(
                        &push_database.read_connection(),
                        &session.id,
                    )
                    .unwrap_or_else(|error| {
                        tracing::warn!(
                            ?error,
                            session_id = %session.id,
                            "failed to read the latest agent message for a push"
                        );
                        None
                    })
                })
                .flatten();
            if let Some(ntfy) = ntfy.as_ref() {
                ntfy.observe(session, latest_answer.as_deref());
            }
            if let Some(apns) = apns.as_ref() {
                apns.observe(session, latest_answer.as_deref());
            }
            keep_awake.observe(&session.id, session.state.is_active());
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
    let approvals =
        approvals::service::ApprovalService::with_publisher(Arc::clone(&database), move |delta| {
            approval_delta_tx.send(delta);
        });
    let _ = state.approvals.set(Arc::clone(&approvals));
    let question_delta_tx = delta_tx.clone();
    let questions =
        questions::service::QuestionService::with_publisher(Arc::clone(&database), move |delta| {
            question_delta_tx.send(delta);
        });
    let _ = state.questions.set(Arc::clone(&questions));
    let (session_launch_server, session_launch_registry) =
        match session_control::SessionLaunchServer::bind(Arc::clone(&database)) {
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
    let cursor_acp = Arc::new(providers::cursor_acp::CursorAcpSessions::new());
    let _ = state.cursor_acp.set(Arc::clone(&cursor_acp));
    let grok_acp = Arc::new(providers::grok_acp::GrokAcpSessions::new());
    let _ = state.grok_acp.set(Arc::clone(&grok_acp));
    let provider_launcher: Arc<dyn providers::runtime::ProviderProcessLauncher> = Arc::new(
        providers::runtime::RealProviderProcessLauncher::with_discovery(
            (*state.provider_discovery).clone(),
            session_launch_registry.clone(),
            Arc::clone(&cursor_acp),
        )
        .with_approvals(Arc::clone(&approvals))
        .with_questions(Arc::clone(&questions))
        .with_grok_acp(Arc::clone(&grok_acp)),
    );
    let providers = providers::session_service::ProviderSessionService::with_launcher_and_lifecycle_and_approvals(
        Arc::clone(&database),
        provider_launcher,
        publish_delta,
        Arc::clone(&lifecycle),
        Some(Arc::clone(&approvals)),
    );
    providers.set_question_service(Arc::clone(&questions));
    providers.set_provider_discovery(Arc::clone(&state.provider_discovery));
    // Kept for the boot-recovery pass below, which needs
    // the same registry the socket hands out.
    let after_turn_registry = session_launch_registry.clone();
    if let Some(registry) = session_launch_registry {
        providers.set_session_control(registry);
    }
    if let Err(error) = providers.recover_orphaned_sessions() {
        tracing::warn!(?error, "failed to recover orphaned sessions");
    }
    timer.mark("sessions.recover");
    let checkpoints = checkpoints::service::CheckpointService::new(Arc::clone(&database));
    if let Err(error) = checkpoints.recover_interrupted_rewinds() {
        tracing::warn!(?error, "failed to recover interrupted rewinds");
    }
    providers.set_checkpoint_service(checkpoints);
    let _ = state.providers.set(Arc::clone(&providers));
    // Last of the boot recovery: a recovered wake starts a
    // turn, which must find the checkpoint service (the
    // pre-turn mark) and the session-control registry
    // already in place, and rewinds already settled.
    if let Err(error) = providers.recover_completion_wakes() {
        tracing::warn!(?error, "failed to recover completion wakes");
    }
    let (on_terminal_data, on_terminal_exit) =
        event_delivery::spawn_terminal_delivery(app.handle(), state.remote_terminal_events.clone());
    let terminals = terminal::service::TerminalService::with_lifecycle(
        Arc::clone(&database),
        on_terminal_data,
        on_terminal_exit,
        Arc::clone(&lifecycle),
    );
    let _ = state.terminals.set(terminals);
    let _ = state
        .checks
        .set(checks::service::CheckService::with_lifecycle(
            Arc::clone(&database),
            Arc::clone(&lifecycle),
        ));
    let gh_service = gh::service::GhService::new(Arc::clone(&database));
    match goals::service::GoalService::new(Arc::clone(&database), Arc::clone(&providers)) {
        Ok(goals) => {
            let _ = state.goals.set(goals);
        }
        Err(error) => tracing::error!(?error, "goal service failed to initialize"),
    }
    let failure_hook = gh::hooks::check_failure_hook(
        &database,
        &providers,
        &notifications,
        user_data.to_path_buf(),
    );
    let merged_hook = gh::hooks::merged_pr_hook(app.handle(), &database);
    let arc_event_hook = gh::hooks::arc_event_hook(&database, &providers);
    let watch_notice_hook = gh::hooks::watch_notice_hook(&providers);
    let gh_delta_tx = delta_tx.clone();
    let publish_delta = move |delta| {
        gh_delta_tx.send(delta);
    };
    let gh_poller = gh::poller::GhPoller::new(
        gh::poller::GhPollerConfig::new(Arc::clone(&database), gh_service)
            .with_delta_publisher(Arc::new(publish_delta))
            .with_check_failure_hook(failure_hook)
            .with_pr_merged_hook(merged_hook)
            .with_arc_event_hook(arc_event_hook)
            .with_watch_notice_hook(watch_notice_hook),
    );
    // Defer start() onto the Tauri runtime — calling it
    // synchronously here panics with "there is no
    // reactor running" because Tauri's Tokio runtime
    // is not yet alive during setup().
    let gh_poller_for_start = Arc::clone(&gh_poller);
    tauri::async_runtime::spawn(async move {
        gh_poller_for_start.start();
    });
    let _ = state.gh_poller.set(gh_poller);
    let workspace_delta_tx = delta_tx.clone();
    let publish_delta = move |delta| {
        workspace_delta_tx.send(delta);
    };
    let workspaces = workspaces::orchestration::WorkspaceService::with_services(
        Arc::clone(&database),
        publish_delta,
        lifecycle,
        Some(Arc::clone(&providers)),
        state.checks.get().cloned(),
        state.terminals.get().cloned(),
        Some(Arc::clone(&approvals)),
        Some(data_dir.join("side-chats")),
        Some(data_dir.join(workspaces::orchestration::ARCHIVE_RECOVERY_DIR)),
    );
    // Archive and project teardown evict the workspace's
    // warm `cursor-agent acp` process; without the pool
    // here that eviction is a no-op and the child
    // outlives its removed worktree.
    workspaces.set_cursor_acp(cursor_acp);
    workspaces.set_grok_acp(grok_acp);
    let workspaces_for_watchers = Arc::clone(&workspaces);
    let _ = state.workspaces.set(workspaces);
    tauri::async_runtime::spawn(routines::scheduler::run(
        routines::scheduler::SchedulerDependencies {
            database: Arc::clone(&database),
            workspaces: Arc::clone(&workspaces_for_watchers),
            providers: Arc::clone(&providers),
            runs: Arc::clone(&state.routine_runs),
            app_data_dir: user_data.to_path_buf(),
        },
    ));
    if let Some(server) = session_launch_server {
        match server.start(
            Some(app.handle().clone()),
            Arc::clone(&database),
            Arc::clone(&workspaces_for_watchers),
            Arc::clone(&providers),
        ) {
            Ok(server) => {
                let _ = state.session_launch_server.set(server);
            }
            Err(error) => {
                tracing::warn!(?error, "session launch server failed to start")
            }
        }
    }
    // Watcher refresh loops use tokio::spawn. Setup runs
    // during the synchronous macOS launch callback, so
    // defer restoration until Tauri's runtime is alive.
    let archive_timer = timer.clone();
    let after_turn_database = Arc::clone(&database);
    let after_turn_providers = Arc::clone(&providers);
    tauri::async_runtime::spawn(async move {
        // Archive recovery runs up to five blocking git
        // calls per interrupted row, each with a 30s
        // bound, so it gets a blocking thread rather
        // than the launch callback — and it lands
        // before the watchers, which is the order setup
        // ran it in.
        let recovery = Arc::clone(&workspaces_for_watchers);
        match tauri::async_runtime::spawn_blocking(move || recovery.recover_interrupted_archives())
            .await
        {
            Ok(Ok(_)) => {}
            Ok(Err(error)) => {
                tracing::warn!(?error, "failed to recover interrupted workspace archives")
            }
            Err(error) => tracing::warn!(?error, "archive recovery task failed to join"),
        }
        archive_timer.mark("archives.recover");
        // A move or archive an agent scheduled for the
        // end of its turn, in a run that ended first.
        // After archive recovery, so a half-finished
        // archive is whole again before this decides
        // whether another one still has work to do.
        if let Some(registry) = after_turn_registry {
            session_control::resume_after_turn_actions(
                after_turn_database,
                Arc::clone(&workspaces_for_watchers),
                after_turn_providers,
                registry,
            )
            .await;
        }
        match workspaces_for_watchers.start_open_watchers() {
            // Workspaces sharing a checkout share its
            // watch, so the two counts diverge sharply
            // once a repo has many sessions.
            Ok(watched) => tracing::info!(
                watched,
                os_watches = workspaces_for_watchers.watched_checkout_count(),
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
