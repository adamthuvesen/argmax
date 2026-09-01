// End-to-end smoke against the REAL provider launcher (no fakes).
//
// Drives `RealProviderProcessLauncher` with the actual `claude` CLI in
// `--output-format stream-json` mode against a tiny prompt, then asserts
// that:
//   - the launcher spawns the process and we get back a handle
//   - the reader thread emits Output events
//   - the lifecycle thread emits an Exit event with code 0
//   - at least one event is JSON-parseable
//
// Gated with `#[ignore]` so CI without `claude` installed (or unwilling
// to make an API call) stays green. Run manually with:
//   cargo test --test provider_real_cli --manifest-path src-tauri/Cargo.toml -- --ignored --nocapture
//
// The chat bug this guards against: if the launcher block-buffers stdout,
// stdin is left open, or events are silently dropped, this test catches
// it because the events never arrive — assert_event_arrives times out.

use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use argmax_lib::providers::runtime::{
    EventCallback, ProviderProcessLauncher, ProviderRuntimeEvent, ProviderRuntimeEventType,
    RealProviderProcessLauncher,
};
use argmax_lib::providers::{AgentMode, PermissionMode, ProviderId, ProviderLaunchInput};

fn workspace_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("repo root")
        .to_path_buf()
}

fn collect_events() -> (Arc<Mutex<Vec<ProviderRuntimeEvent>>>, EventCallback) {
    let events = Arc::new(Mutex::new(Vec::<ProviderRuntimeEvent>::new()));
    let events_for_callback = Arc::clone(&events);
    let callback: EventCallback = Arc::new(move |event| {
        events_for_callback
            .lock()
            .expect("event log poisoned")
            .push(event);
    });
    (events, callback)
}

fn wait_for<F: Fn(&[ProviderRuntimeEvent]) -> bool>(
    events: &Arc<Mutex<Vec<ProviderRuntimeEvent>>>,
    predicate: F,
    timeout: Duration,
    label: &str,
) -> Vec<ProviderRuntimeEvent> {
    let started = Instant::now();
    loop {
        {
            let snapshot = events.lock().expect("event log poisoned").clone();
            if predicate(&snapshot) {
                return snapshot;
            }
        }
        if started.elapsed() >= timeout {
            let snapshot = events.lock().expect("event log poisoned").clone();
            panic!(
                "timed out after {:?} waiting for {label}; captured {} event(s): {:?}",
                timeout,
                snapshot.len(),
                snapshot
            );
        }
        std::thread::sleep(Duration::from_millis(50));
    }
}

// Warm-pool ACP smoke: the first composer launch must route through
// `cursor-agent acp` (init line tagged `"transport":"acp"`), complete with a
// `result/success` line and Exit(0), and a follow-up resume on the same
// launcher must reuse the warm process (no second ~5.5 s client boot).
// Multi-thread runtime is required: the ACP reader/turn tasks are tokio
// tasks, and `wait_for`'s thread::sleep would starve the single-thread flavor.
#[tokio::test(flavor = "multi_thread")]
#[ignore = "requires installed, logged-in `cursor-agent`; run manually"]
async fn real_cursor_acp_turn_and_warm_follow_up() {
    let launcher = RealProviderProcessLauncher::new();

    let input = ProviderLaunchInput {
        provider: ProviderId::Cursor,
        session_id: uuid::Uuid::new_v4().to_string(),
        workspace_path: workspace_root(),
        prompt: "Reply with exactly the word: pong".to_string(),
        model_label: "Composer 2.5 (Cursor)".to_string(),
        model_id: "composer-2.5".to_string(),
        reasoning_effort: None,
        fast_mode: false,
        resume_conversation_id: None,
        resume_fork: false,
        permission_mode: PermissionMode::AutoApprove,
        agent_mode: AgentMode::Auto,
        cols: 120,
        rows: 32,
    };

    let run_turn = |input: ProviderLaunchInput, label: &'static str| {
        let launcher = launcher.clone();
        async move {
            let (events, callback) = collect_events();
            let started = Instant::now();
            let _handle = launcher
                .launch(input, callback)
                .await
                .expect("ACP launcher returns a handle");
            let snapshot = wait_for(
                &events,
                |events| {
                    events
                        .iter()
                        .any(|event| event.r#type == ProviderRuntimeEventType::Exit)
                },
                Duration::from_secs(120),
                "Exit lifecycle event",
            );
            println!("{label}: turn finished in {:?}", started.elapsed());
            snapshot
        }
    };

    let first = run_turn(input.clone(), "cold (process spawn + session/new)").await;

    let init_line = first
        .iter()
        .filter(|event| event.r#type == ProviderRuntimeEventType::Output)
        .flat_map(|event| event.message.lines())
        .filter_map(|line| serde_json::from_str::<serde_json::Value>(line.trim()).ok())
        .find(|value| value["type"] == "system" && value["subtype"] == "init")
        .expect("ACP turn emits a system/init line");
    assert_eq!(
        init_line["transport"], "acp",
        "composer launch did not route through ACP: {init_line}"
    );
    let acp_session_id = init_line["session_id"]
        .as_str()
        .expect("init carries the ACP session id")
        .to_string();

    let saw_result = first
        .iter()
        .filter(|event| event.r#type == ProviderRuntimeEventType::Output)
        .flat_map(|event| event.message.lines())
        .filter_map(|line| serde_json::from_str::<serde_json::Value>(line.trim()).ok())
        .any(|value| value["type"] == "result" && value["subtype"] == "success");
    assert!(saw_result, "no result/success line; events: {first:?}");

    // Follow-up on the warm process: same launcher, resume id set.
    let mut follow_up = input;
    follow_up.session_id = uuid::Uuid::new_v4().to_string();
    follow_up.prompt = "Reply with exactly the word: pong2".to_string();
    follow_up.resume_conversation_id = Some(acp_session_id);
    let second = run_turn(follow_up, "warm follow-up (session/prompt only)").await;
    let second_init = second
        .iter()
        .filter(|event| event.r#type == ProviderRuntimeEventType::Output)
        .flat_map(|event| event.message.lines())
        .filter_map(|line| serde_json::from_str::<serde_json::Value>(line.trim()).ok())
        .find(|value| value["type"] == "system" && value["subtype"] == "init")
        .expect("follow-up emits a system/init line");
    assert_eq!(second_init["transport"], "acp");
}

#[tokio::test]
#[ignore = "requires installed `claude` CLI + API credit; run manually"]
async fn real_claude_launcher_streams_json_and_exits_cleanly() {
    let launcher = RealProviderProcessLauncher::new();
    let (events, callback) = collect_events();

    // Claude rejects non-UUID session ids; session_service always passes a
    // `Uuid::new_v4().to_string()` here, so this test must do the same.
    let session_id = uuid::Uuid::new_v4().to_string();
    let input = ProviderLaunchInput {
        provider: ProviderId::Claude,
        session_id,
        workspace_path: workspace_root(),
        prompt: "Reply with exactly the word: pong".to_string(),
        model_label: "Haiku 4.5".to_string(),
        model_id: "claude-haiku-4-5".to_string(),
        reasoning_effort: None,
        fast_mode: false,
        resume_conversation_id: None,
        resume_fork: false,
        permission_mode: PermissionMode::AutoApprove,
        agent_mode: AgentMode::Auto,
        cols: 120,
        rows: 32,
    };

    let _handle = launcher
        .launch(input, callback)
        .await
        .expect("real launcher returns a handle");

    // The launcher's reader threads emit Output events as the CLI streams.
    // 30s is generous for a one-word reply; an unfixed block-buffer bug
    // would never deliver any Output event before the child exits.
    let snapshot = wait_for(
        &events,
        |events| {
            events
                .iter()
                .any(|event| event.r#type == ProviderRuntimeEventType::Output)
        },
        Duration::from_secs(30),
        "at least one Output event",
    );

    // At least one Output event line must be JSON — proves the stream-json
    // wire format made it through the pipe → reader thread unscathed.
    let saw_json = snapshot.iter().any(|event| {
        event.r#type == ProviderRuntimeEventType::Output
            && event
                .message
                .lines()
                .filter(|line| !line.trim().is_empty())
                .any(|line| serde_json::from_str::<serde_json::Value>(line.trim()).is_ok())
    });
    assert!(
        saw_json,
        "no JSON line in Output events; captured: {snapshot:?}"
    );

    // Then the lifecycle exit must land.
    wait_for(
        &events,
        |events| {
            events
                .iter()
                .any(|event| event.r#type == ProviderRuntimeEventType::Exit)
        },
        Duration::from_secs(30),
        "Exit lifecycle event",
    );
}

// Same contract for Grok Build. It shares Claude's stream-json wire format,
// so this asserts the *launcher* delivers it: a `-p` turn under a PTY must
// stream JSON lines and exit cleanly. Grok is slower off the line than Claude
// (it connects every configured MCP server before the first `system/init`),
// so the first-output budget is wider.
#[tokio::test]
#[ignore = "requires installed, logged-in `grok` CLI; run manually"]
async fn real_grok_launcher_streams_json_and_exits_cleanly() {
    let launcher = RealProviderProcessLauncher::new();
    let (events, callback) = collect_events();

    // Grok requires `--session-id` to be a UUID that does not already exist
    // under the session directory, matching what session_service mints.
    let session_id = uuid::Uuid::new_v4().to_string();
    let input = ProviderLaunchInput {
        provider: ProviderId::Grok,
        session_id,
        workspace_path: workspace_root(),
        prompt: "Reply with exactly the word: pong".to_string(),
        model_label: "Grok 4.6".to_string(),
        model_id: "grok-4.6".to_string(),
        reasoning_effort: None,
        fast_mode: false,
        resume_conversation_id: None,
        resume_fork: false,
        permission_mode: PermissionMode::AutoApprove,
        agent_mode: AgentMode::Auto,
        cols: 120,
        rows: 32,
    };

    let _handle = launcher
        .launch(input, callback)
        .await
        .expect("real launcher returns a handle");

    let snapshot = wait_for(
        &events,
        |events| {
            events
                .iter()
                .any(|event| event.r#type == ProviderRuntimeEventType::Output)
        },
        Duration::from_secs(90),
        "at least one Output event",
    );

    let saw_json = snapshot.iter().any(|event| {
        event.r#type == ProviderRuntimeEventType::Output
            && event
                .message
                .lines()
                .filter(|line| !line.trim().is_empty())
                .any(|line| serde_json::from_str::<serde_json::Value>(line.trim()).is_ok())
    });
    assert!(
        saw_json,
        "no JSON line in Output events; captured: {snapshot:?}"
    );

    wait_for(
        &events,
        |events| {
            events
                .iter()
                .any(|event| event.r#type == ProviderRuntimeEventType::Exit)
        },
        Duration::from_secs(120),
        "Exit lifecycle event",
    );
}
