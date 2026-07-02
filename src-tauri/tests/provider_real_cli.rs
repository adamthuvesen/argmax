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
use argmax_lib::providers::{
    AgentMode, PermissionMode, ProviderId, ProviderLaunchInput, ProviderMode,
};

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
        mode: ProviderMode::StructuredJson,
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
