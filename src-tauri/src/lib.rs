// Argmax library crate. The Rust/Tauri runtime is being filled in section by
// section under openspec/changes/port-to-rust-tauri.

use std::sync::Arc;

use tauri::{Emitter, Manager};

pub mod approvals;
pub mod attachments;
pub mod checks;
pub mod dock;
pub mod error;
pub mod files;
pub mod gh;
pub mod git;
pub mod ide;
pub mod ipc;
pub mod mcp;
pub mod memory;
pub mod menu;
pub mod notifications;
pub mod persistence;
pub mod providers;
pub mod review;
pub mod sessions;
pub mod skills;
pub mod state;
pub mod terminal;
pub mod updater;
pub mod util;
pub mod workspaces;

use serde_json::json;
#[cfg(any(debug_assertions, test))]
use specta_typescript::{BigIntExportBehavior, Typescript};
use util::startup_timer::StartupTimer;

/// If one emit cycle has to conflate at least this many queued `dashboard:delta`
/// messages, the main-thread event loop is lagging behind producers — log it so
/// the backpressure is visible rather than silently growing the channel.
const DELTA_CONFLATE_WARN: usize = 256;

/// Construct and run the Tauri app.
pub fn run() {
    let timer = Arc::new(StartupTimer::new());
    timer.mark("boot");

    let specta_builder = ipc::specta_builder();

    // Codegen: emit `src/shared/bindings.d.ts` on every debug startup so
    // the renderer's TS surface stays in lockstep with the Rust command
    // surface. `build.rs` cannot do this (build scripts run before the
    // rest of the crate is even type-checked, so they can't import
    // command functions), so the export lives here instead.
    #[cfg(debug_assertions)]
    if let Err(e) = specta_builder.export(specta_typescript(), "../src/shared/bindings.d.ts") {
        eprintln!("argmax: tauri-specta export failed: {e}");
    }

    tauri::Builder::default()
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
                    let built = match tauri::Manager::path(&app).app_data_dir() {
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
        .manage(state::AppState::with_startup_timer(timer.clone()))
        .invoke_handler(specta_builder.invoke_handler())
        .on_menu_event(|app, event| menu::handle_menu_event(app, event.id().as_ref()))
        .on_window_event(dock::clear_badge_on_focus)
        .setup(move |app| {
            // Tracing init is deferred to setup() because `app.path()` is
            // only valid here — that's how we resolve the user_data_dir
            // the release-mode rolling-file appender writes into.
            let user_data = tauri::Manager::path(app).app_data_dir().ok();
            if let Err(e) = util::tracing_init::init(user_data.as_deref()) {
                eprintln!("argmax: tracing init failed: {e}");
            }
            // Keep macOS App Nap from suspending the webview while the window is
            // backgrounded — otherwise emitted `dashboard:delta` events don't
            // reach the renderer until the user refocuses, so finished turns
            // look stuck on the thinking bubble.
            util::app_nap::prevent_app_nap();
            if let Some(user_data) = user_data.as_ref() {
                let data_dir = user_data.join("local-state");
                if let Err(e) = std::fs::create_dir_all(&data_dir) {
                    tracing::warn!(error = ?e, path = %data_dir.display(), "failed to create data directory");
                } else {
                    match persistence::Database::open(data_dir.join("argmax.sqlite")) {
                        Ok(database) => {
                            let database = Arc::new(database);
                            let state = tauri::Manager::state::<state::AppState>(app);
                            if state.db.set(Arc::clone(&database)).is_err() {
                                tracing::warn!("database state was already initialized");
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
                            // Single FIFO channel for every `dashboard:delta`
                            // emit (providers + gh poller + workspaces). One
                            // worker task pulls from it and emits in order.
                            // Previously each publish spawned its own
                            // tauri::async_runtime task — with tokio's
                            // multi-worker scheduler that meant two deltas
                            // emitted back-to-back could land at the renderer
                            // in reverse order, occasionally letting a
                            // `session.completed` arrive before its preceding
                            // `message.completed`.
                            let (delta_tx, mut delta_rx) =
                                tokio::sync::mpsc::unbounded_channel::<providers::flush_queue::DashboardDelta>();
                            let emit_handle = app.handle().clone();
                            tauri::async_runtime::spawn(async move {
                                while let Some(mut delta) = delta_rx.recv().await {
                                    // Conflate any deltas that piled up while the previous emit
                                    // ran: drain everything currently queued and merge it into one
                                    // push. A fast token-stream produces a `dashboard:delta` per
                                    // chunk (the 16ms throttle is intentionally disabled so chunks
                                    // render live), so without this the channel could grow unbounded
                                    // behind a busy main thread. Merging into a single atomic delta
                                    // also removes any inter-emit ordering risk. No added latency in
                                    // the common case (try_recv returns empty → emit the one delta).
                                    let mut conflated = 1usize;
                                    while let Ok(next) = delta_rx.try_recv() {
                                        delta.merge_from(next);
                                        conflated += 1;
                                    }
                                    if conflated >= DELTA_CONFLATE_WARN {
                                        tracing::warn!(
                                            conflated,
                                            "coalesced a large dashboard:delta burst; main-thread emit may be lagging"
                                        );
                                    }
                                    // Emit on the main thread. On macOS, an event emitted
                                    // from a background thread does not reliably wake the
                                    // NSApp event loop, so `dashboard:delta` pushes can sit
                                    // undelivered until some unrelated UI event pumps the
                                    // loop — mid-turn streaming then stalls and the chat
                                    // only fills in when the turn ends (process exit pumps
                                    // the loop). Hopping onto the main thread via
                                    // `run_on_main_thread` dispatches the webview eval as a
                                    // main-thread task the loop processes promptly, so the
                                    // chat streams live. Electron's async `webContents.send`
                                    // never had this problem. See tao#625 / winit#219 and
                                    // agents/docs/runtime.md "Event delivery".
                                    let handle = emit_handle.clone();
                                    if let Err(error) = emit_handle.run_on_main_thread(move || {
                                        if let Err(error) = handle.emit("dashboard:delta", delta) {
                                            tracing::warn!(?error, "failed to emit dashboard delta");
                                        }
                                    }) {
                                        tracing::warn!(?error, "failed to schedule dashboard delta emit");
                                    }
                                }
                            });
                            let notifications_for_delta = Arc::clone(&notifications);
                            let provider_delta_tx = delta_tx.clone();
                            let publish_delta = move |delta: providers::flush_queue::DashboardDelta| {
                                for session in &delta.sessions {
                                    if let Err(error) = notifications_for_delta.notify(session) {
                                        tracing::warn!(
                                            ?error,
                                            session_id = %session.id,
                                            "failed to fire terminal-state notification"
                                        );
                                    }
                                }
                                tracing::trace!(
                                    sessions = delta.sessions.len(),
                                    events = delta.events.len(),
                                    raw_outputs = delta.raw_outputs.len(),
                                    workspaces = delta.workspaces.len(),
                                    "queuing dashboard:delta"
                                );
                                if let Err(error) = provider_delta_tx.send(delta) {
                                    tracing::warn!(?error, "dashboard delta channel closed");
                                }
                            };
                            let providers = providers::session_service::ProviderSessionService::with_launcher(
                                Arc::clone(&database),
                                Arc::new(providers::runtime::RealProviderProcessLauncher::new()),
                                publish_delta,
                            );
                            if let Err(error) = providers.recover_orphaned_sessions() {
                                tracing::warn!(?error, "failed to recover orphaned sessions");
                            }
                            if state.providers.set(Arc::clone(&providers)).is_err() {
                                tracing::warn!("provider service state was already initialized");
                            }
                            let app_handle = app.handle().clone();
                            let on_terminal_data = Arc::new(move |chunk: terminal::service::TerminalChunk| {
                                let emit_handle = app_handle.clone();
                                let handle = emit_handle.clone();
                                if let Err(error) = emit_handle.run_on_main_thread(move || {
                                    if let Err(error) = handle.emit("terminal:data", chunk) {
                                        tracing::warn!(?error, "failed to emit terminal data");
                                    }
                                }) {
                                    tracing::warn!(?error, "failed to schedule terminal data emit");
                                }
                            });
                            let app_handle = app.handle().clone();
                            let on_terminal_exit = Arc::new(move |info: terminal::service::TerminalExitInfo| {
                                let emit_handle = app_handle.clone();
                                let handle = emit_handle.clone();
                                if let Err(error) = emit_handle.run_on_main_thread(move || {
                                    if let Err(error) = handle.emit("terminal:exit", info) {
                                        tracing::warn!(?error, "failed to emit terminal exit");
                                    }
                                }) {
                                    tracing::warn!(?error, "failed to schedule terminal exit emit");
                                }
                            });
                            let terminals = terminal::service::TerminalService::new(
                                Arc::clone(&database),
                                on_terminal_data,
                                on_terminal_exit,
                            );
                            if state.terminals.set(terminals).is_err() {
                                tracing::warn!("terminal service state was already initialized");
                            }
                            if state.mcp_auth.set(mcp::auth::McpAuthService::new()).is_err() {
                                tracing::warn!("mcp auth service state was already initialized");
                            }
                            if state
                                .checks
                                .set(checks::service::CheckService::new(Arc::clone(&database)))
                                .is_err()
                            {
                                tracing::warn!("check service state was already initialized");
                            }
                            let gh_service = gh::service::GhService::new(Arc::clone(&database));
                            let poller_database = Arc::clone(&database);
                            let poller_providers = Arc::clone(&providers);
                            let poller_notifications = Arc::clone(&notifications);
                            let failure_hook = Arc::new(move |context: gh::poller::CheckFailureContext| {
                                let database = Arc::clone(&poller_database);
                                let providers = Arc::clone(&poller_providers);
                                let notifications = Arc::clone(&poller_notifications);
                                tauri::async_runtime::spawn(async move {
                                    if let Err(error) =
                                        handle_gh_check_failure(database, providers, notifications, context).await
                                    {
                                        tracing::warn!(?error, "failed to handle gh check failure");
                                    }
                                });
                            });
                            let gh_delta_tx = delta_tx.clone();
                            let publish_delta = move |delta| {
                                if let Err(error) = gh_delta_tx.send(delta) {
                                    tracing::warn!(?error, "dashboard delta channel closed");
                                }
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
                                if let Err(error) = workspace_delta_tx.send(delta) {
                                    tracing::warn!(?error, "dashboard delta channel closed");
                                }
                            };
                            let workspaces = workspaces::WorkspaceService::with_publisher(
                                Arc::clone(&database),
                                publish_delta,
                            );
                            if state.workspaces.set(workspaces).is_err() {
                                tracing::warn!("workspace service state was already initialized");
                            }
                            state.startup_timer.mark("db.open");
                            // Mark services as constructed only on the success
                            // path — otherwise a failed DB open still reported a
                            // healthy boot while every handler returned
                            // SERVICE_ERROR.
                            timer.mark("services.construct");
                        }
                        Err(e) => tracing::warn!(error = ?e, "failed to open database"),
                    }
                }
            }
            if let Err(e) = menu::install_app_menu(app.handle(), cfg!(debug_assertions)) {
                tracing::warn!(error = ?e, "failed to install app menu");
            }
            timer.mark("ipc.register");
            if app.get_webview_window("main").is_some() {
                timer.mark("window.create");
            }
            tracing::info!(boot_ms = timer.boot_to_now_ms() as u64, "tracing online");
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

async fn handle_gh_check_failure(
    database: Arc<persistence::Database>,
    providers: Arc<providers::session_service::ProviderSessionService>,
    notifications: Arc<
        notifications::NotificationService<notifications::TauriNotificationSink<tauri::Wry>>,
    >,
    context: gh::poller::CheckFailureContext,
) -> error::ArgmaxResult<()> {
    let (session, pr, input) = {
        let connection = database.connection();
        let session = persistence::sessions::find_session_by_id(&connection, &context.session_id)?;
        let workspace =
            persistence::workspaces::find_workspace_by_id(&connection, &context.workspace_id)?;
        let project = persistence::projects::require_project(&connection, &workspace.project_id)?;
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
            });
        let input = build_check_failure_follow_up_input(&workspace.id, &project, &context)?;
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
    project: &persistence::projects::ProjectSummary,
    context: &gh::poller::CheckFailureContext,
) -> error::ArgmaxResult<ipc::inputs::ProvidersLaunchInput> {
    let defaults = provider_defaults(&project.settings.default_provider);
    serde_json::from_value(json!({
        "workspaceId": workspace_id,
        "provider": project.settings.default_provider,
        "prompt": format!(
            "Checks on PR #{} (commit {}) are failing. Run `gh pr checks {}` to see which checks failed, then investigate and fix.",
            context.pr_number,
            context.head_sha.chars().take(12).collect::<String>(),
            context.pr_number
        ),
        "modelLabel": defaults.model_label,
        "modelId": defaults.model_id,
        "reasoningEffort": defaults.reasoning_effort,
        "cols": 120,
        "rows": 36
    }))
    .map_err(|error| error::ArgmaxError::service("GH_FOLLOW_UP_INPUT_INVALID", error.to_string()))
}

#[derive(Clone, Copy)]
struct ProviderDefaults {
    model_label: &'static str,
    model_id: &'static str,
    reasoning_effort: Option<&'static str>,
}

fn provider_defaults(provider: &str) -> ProviderDefaults {
    match provider {
        "codex" => ProviderDefaults {
            model_label: "Codex Spark",
            model_id: "gpt-5.3-codex-spark",
            reasoning_effort: Some("medium"),
        },
        "cursor" => ProviderDefaults {
            model_label: "Composer 2.5 (Cursor)",
            model_id: "composer-2.5",
            reasoning_effort: None,
        },
        _ => ProviderDefaults {
            model_label: "Claude Haiku 4.5",
            model_id: "claude-haiku-4-5",
            reasoning_effort: None,
        },
    }
}

#[cfg(any(debug_assertions, test))]
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
    /// actually emits TypeScript", paired with `npm run check:bindings`
    /// which guards "the committed bindings.d.ts is at least as new as
    /// every backend input".
    #[test]
    fn specta_export_emits_command_surface() {
        let dir = tempdir().expect("tempdir");
        let out = dir.path().join("bindings.d.ts");

        let builder = ipc::specta_builder();
        builder
            .export(specta_typescript(), &out)
            .expect("specta export ok");

        let contents = fs::read_to_string(&out).expect("read generated bindings");
        assert!(
            contents.contains("health_ping") || contents.contains("healthPing"),
            "expected command surface in bindings:\n{contents}",
        );
    }
}
