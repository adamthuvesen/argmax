//! OpenCode's authenticated per-turn HTTP/SSE runtime.
//!
//! `opencode run --format json` owns its permission loop and rejects every
//! request it cannot answer itself. The headless server exposes the same event
//! stream plus a real permission response endpoint, so Argmax can preserve the
//! existing JSON normalizer while answering the exact provider-owned gate.

use super::{
    adapters::get_provider_definition,
    environment::build_provider_environment,
    mcp_injection,
    normalizer::ProviderOutputStream,
    runtime::{
        BoxFuture, EventCallback, ProviderRuntimeEvent, ProviderRuntimeEventType,
        ProviderRuntimeHandle,
    },
    AgentMode, PermissionMode, ProviderId, ProviderLaunchInput,
};
use crate::{
    approvals::service::ApprovalService,
    error::{ArgmaxError, ArgmaxResult},
    persistence::time::now_iso,
    session_control::SessionLaunchProcessConfig,
};
use serde_json::{json, Map, Value};
use std::{
    collections::HashSet,
    io::{BufRead, BufReader, ErrorKind, Read},
    net::TcpListener,
    process::Stdio,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::Duration,
};
use tokio::{
    sync::{mpsc, watch},
    task::{JoinHandle, JoinSet},
};

const SERVER_USERNAME: &str = "argmax";
const SERVER_START_TIMEOUT: Duration = Duration::from_secs(15);
const HTTP_TIMEOUT: Duration = Duration::from_secs(10);
const SSE_READ_TIMEOUT: Duration = Duration::from_millis(250);
const SSE_LINE_LIMIT: usize = 16 * 1024 * 1024;
const MAX_SESSION_LINEAGE_DEPTH: usize = 64;
const OPENCODE_CONFIG_CONTENT: &str = "OPENCODE_CONFIG_CONTENT";

pub async fn launch_turn(
    binary_path: &str,
    input: &ProviderLaunchInput,
    config: Option<&SessionLaunchProcessConfig>,
    approvals: Arc<ApprovalService>,
    emit: EventCallback,
) -> ArgmaxResult<Arc<dyn ProviderRuntimeHandle>> {
    let port = available_loopback_port()?;
    let password = uuid::Uuid::new_v4().to_string();
    let endpoint = format!("http://{SERVER_USERNAME}:{password}@127.0.0.1:{port}");

    let mut overrides = vec![("NO_COLOR".to_string(), "1".to_string())];
    if let Some(config) = config {
        overrides.extend(config.env_pairs());
    }
    let (mcp_environment, launch_scratch) = mcp_injection::launch_files(
        ProviderId::Opencode,
        &input.workspace_path,
        &input.session_id,
        config,
    );
    overrides.extend([
        (
            "OPENCODE_SERVER_USERNAME".to_string(),
            SERVER_USERNAME.to_string(),
        ),
        ("OPENCODE_SERVER_PASSWORD".to_string(), password),
    ]);
    let mut environment = build_provider_environment(overrides);
    if let Err(error) = merge_launch_environment(&mut environment, mcp_environment)
        .and_then(|()| apply_permission_override(&mut environment, input))
    {
        launch_scratch.restore();
        return Err(error);
    }

    let mut command = tokio::process::Command::new(binary_path);
    command
        .args([
            "serve",
            "--hostname",
            "127.0.0.1",
            "--port",
            &port.to_string(),
            "--log-level",
            "ERROR",
        ])
        .current_dir(&input.workspace_path)
        .env_clear()
        .envs(environment)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    #[cfg(unix)]
    command.process_group(0);
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(_) => {
            launch_scratch.restore();
            return Err(server_error(
                "OPENCODE_SERVER_SPAWN",
                "Could not start the OpenCode approval server",
            ));
        }
    };

    let http = ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_millis(250))
        .timeout_read(HTTP_TIMEOUT)
        .timeout_write(HTTP_TIMEOUT)
        .build();
    let setup = prepare_turn(&http, &endpoint, input).await;
    let (native_session_id, event_rx, sse_cancel, sse_task) = match setup {
        Ok(setup) => setup,
        Err(error) => {
            let _ =
                crate::util::process_control::terminate_process_group_with_escalation(&mut child)
                    .await;
            launch_scratch.restore();
            return Err(error);
        }
    };

    let (cancel, cancelled) = watch::channel(false);
    let (done_tx, done) = watch::channel(false);
    let disposed = Arc::new(AtomicBool::new(false));
    let handle = Arc::new(OpencodeServerHandle {
        cancel,
        done,
        disposed: Arc::clone(&disposed),
    });
    let input = input.clone();
    tokio::spawn(async move {
        run_turn(
            &http,
            &endpoint,
            input,
            native_session_id,
            approvals,
            emit,
            child,
            launch_scratch,
            event_rx,
            sse_cancel,
            sse_task,
            cancelled,
        )
        .await;
        disposed.store(true, Ordering::SeqCst);
        let _ = done_tx.send(true);
    });

    Ok(handle)
}

type PreparedTurn = (
    String,
    mpsc::UnboundedReceiver<SseMessage>,
    Arc<AtomicBool>,
    JoinHandle<()>,
);

async fn prepare_turn(
    http: &ureq::Agent,
    endpoint: &str,
    input: &ProviderLaunchInput,
) -> ArgmaxResult<PreparedTurn> {
    wait_until_ready(http, endpoint).await?;
    let (event_tx, mut event_rx) = mpsc::unbounded_channel();
    let sse_cancel = Arc::new(AtomicBool::new(false));
    let sse_task = subscribe(
        endpoint.to_string(),
        input.workspace_path.to_string_lossy().into_owned(),
        Arc::clone(&sse_cancel),
        event_tx,
    );
    match tokio::time::timeout(Duration::from_secs(5), event_rx.recv()).await {
        Ok(Some(SseMessage::Connected)) => {}
        Ok(Some(SseMessage::Failed(message))) => return Err(message),
        Ok(Some(SseMessage::Event(_))) | Ok(Some(SseMessage::Closed)) | Ok(None) => {
            return Err(server_error(
                "OPENCODE_SSE_CONNECT",
                "OpenCode closed its event stream during startup",
            ));
        }
        Err(_) => {
            return Err(server_error(
                "OPENCODE_SSE_CONNECT",
                "OpenCode did not open its event stream in time",
            ));
        }
    }

    let native_session_id = native_session(http, endpoint, input).await?;
    prompt(http, endpoint, input, &native_session_id).await?;
    Ok((native_session_id, event_rx, sse_cancel, sse_task))
}

async fn wait_until_ready(http: &ureq::Agent, endpoint: &str) -> ArgmaxResult<()> {
    let deadline = tokio::time::Instant::now() + SERVER_START_TIMEOUT;
    loop {
        let http = http.clone();
        let url = format!("{endpoint}/global/health");
        let ready = tokio::task::spawn_blocking(move || http.get(&url).call().is_ok())
            .await
            .unwrap_or(false);
        if ready {
            return Ok(());
        }
        if tokio::time::Instant::now() >= deadline {
            return Err(server_error(
                "OPENCODE_SERVER_START",
                "OpenCode did not start its approval server in time",
            ));
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

async fn native_session(
    http: &ureq::Agent,
    endpoint: &str,
    input: &ProviderLaunchInput,
) -> ArgmaxResult<String> {
    let http = http.clone();
    let endpoint = endpoint.to_string();
    let directory = input.workspace_path.to_string_lossy().into_owned();
    let resume_id = input.resume_conversation_id.clone();
    let fork = input.resume_fork;
    tokio::task::spawn_blocking(move || {
        let response = match resume_id {
            Some(id) if fork => {
                validate_provider_id(&id, "session")?;
                let response = http
                    .post(&format!("{endpoint}/session/{id}/fork"))
                    .query("directory", &directory)
                    .set("Content-Type", "application/json")
                    .send_string("{}")
                    .map_err(|error| request_error("fork the OpenCode session", &error))?;
                response_json(response, "fork session")?
            }
            Some(id) => {
                validate_provider_id(&id, "session")?;
                return Ok(id);
            }
            None => {
                let response = http
                    .post(&format!("{endpoint}/session"))
                    .query("directory", &directory)
                    .set("Content-Type", "application/json")
                    .send_string("{}")
                    .map_err(|error| request_error("create an OpenCode session", &error))?;
                response_json(response, "create session")?
            }
        };
        let id = response
            .get("id")
            .and_then(Value::as_str)
            .ok_or_else(|| invalid_response("read the session id"))?;
        validate_provider_id(id, "session")?;
        Ok(id.to_string())
    })
    .await
    .map_err(|_| server_error("OPENCODE_SERVER_TASK", "OpenCode session setup stopped"))?
}

async fn prompt(
    http: &ureq::Agent,
    endpoint: &str,
    input: &ProviderLaunchInput,
    native_session_id: &str,
) -> ArgmaxResult<()> {
    let body = prompt_body(input)?;
    let http = http.clone();
    let endpoint = endpoint.to_string();
    let directory = input.workspace_path.to_string_lossy().into_owned();
    let native_session_id = native_session_id.to_string();
    tokio::task::spawn_blocking(move || {
        http.post(&format!(
            "{endpoint}/session/{native_session_id}/prompt_async"
        ))
        .query("directory", &directory)
        .set("Content-Type", "application/json")
        .send_string(&body.to_string())
        .map_err(|error| request_error("send the OpenCode prompt", &error))?;
        Ok(())
    })
    .await
    .map_err(|_| server_error("OPENCODE_SERVER_TASK", "OpenCode prompt setup stopped"))?
}

fn prompt_body(input: &ProviderLaunchInput) -> ArgmaxResult<Value> {
    let (provider_id, model_id) = split_model_id(&input.model_id)?;
    let mut body = json!({
        "model": { "providerID": provider_id, "modelID": model_id },
        "parts": [{ "type": "text", "text": input.prompt }],
    });
    if input.agent_mode == AgentMode::Plan {
        body["agent"] = Value::String("plan".to_string());
    }
    if let Some(variant) = opencode_variant(input) {
        body["variant"] = Value::String(variant);
    }
    Ok(body)
}

#[allow(clippy::too_many_arguments)]
async fn run_turn(
    http: &ureq::Agent,
    endpoint: &str,
    input: ProviderLaunchInput,
    native_session_id: String,
    approvals: Arc<ApprovalService>,
    emit: EventCallback,
    mut child: tokio::process::Child,
    launch_scratch: mcp_injection::LaunchScratch,
    mut event_rx: mpsc::UnboundedReceiver<SseMessage>,
    sse_cancel: Arc<AtomicBool>,
    sse_task: JoinHandle<()>,
    mut cancelled: watch::Receiver<bool>,
) {
    let invocation_id = uuid::Uuid::new_v4().to_string();
    let directory = input.workspace_path.to_string_lossy().into_owned();
    let mut tracked_sessions = HashSet::from([native_session_id.clone()]);
    let mut seen_requests = HashSet::new();
    let mut active_requests = HashSet::new();
    let mut permission_tasks: JoinSet<(String, ArgmaxResult<()>)> = JoinSet::new();
    let mut stream_started = false;
    let mut exit_code = 0;
    let mut was_cancelled = false;

    loop {
        tokio::select! {
            _ = cancelled.changed() => {
                was_cancelled = true;
                break;
            }
            outcome = permission_tasks.join_next(), if !permission_tasks.is_empty() => {
                match outcome {
                    Some(Ok((request_id, Ok(())))) => { active_requests.remove(&request_id); }
                    Some(Ok((request_id, Err(error)))) => {
                        active_requests.remove(&request_id);
                        emit_runtime(&emit, &input, ProviderRuntimeEventType::Error, ProviderOutputStream::System, error.to_string(), Some(1));
                        exit_code = 1;
                        break;
                    }
                    Some(Err(_)) => {
                        emit_runtime(&emit, &input, ProviderRuntimeEventType::Error, ProviderOutputStream::System, "OpenCode's permission response task stopped unexpectedly".to_string(), Some(1));
                        exit_code = 1;
                        break;
                    }
                    None => {}
                }
            }
            message = event_rx.recv() => {
                match message {
                    Some(SseMessage::Event(event)) => {
                        if let Some(session_id) = untracked_permission_session(&event, &tracked_sessions) {
                            match session_lineage(
                                http,
                                endpoint,
                                &directory,
                                &session_id,
                                &tracked_sessions,
                            ).await {
                                Ok(Some(lineage)) => tracked_sessions.extend(lineage),
                                Ok(None) => {}
                                Err(error) => {
                                    emit_runtime(&emit, &input, ProviderRuntimeEventType::Error, ProviderOutputStream::System, error.to_string(), Some(1));
                                    exit_code = 1;
                                    break;
                                }
                            }
                        }
                        match classify_event(&event, &mut tracked_sessions, &native_session_id) {
                        EventAction::Output(line) => {
                            if !stream_started {
                                stream_started = true;
                                emit_runtime(&emit, &input, ProviderRuntimeEventType::StreamStarted, ProviderOutputStream::Stdout, String::new(), None);
                            }
                            emit_runtime(&emit, &input, ProviderRuntimeEventType::Output, ProviderOutputStream::Stdout, format!("{line}\n"), None);
                        }
                        EventAction::Permission(request) => {
                            if seen_requests.insert(request.id.clone()) {
                                active_requests.insert(request.id.clone());
                                let http = http.clone();
                                let endpoint = endpoint.to_string();
                                let directory = directory.clone();
                                let approval_service = Arc::clone(&approvals);
                                let argmax_session_id = input.session_id.clone();
                                let invocation_id = invocation_id.clone();
                                let request_id = request.id.clone();
                                permission_tasks.spawn(async move {
                                    let result = answer_permission(
                                        &http,
                                        &endpoint,
                                        &directory,
                                        &approval_service,
                                        &argmax_session_id,
                                        &invocation_id,
                                        &request,
                                    ).await;
                                    (request_id, result)
                                });
                            }
                        }
                        EventAction::Error(line) => {
                            if !stream_started {
                                stream_started = true;
                                emit_runtime(&emit, &input, ProviderRuntimeEventType::StreamStarted, ProviderOutputStream::Stdout, String::new(), None);
                            }
                            emit_runtime(&emit, &input, ProviderRuntimeEventType::Output, ProviderOutputStream::Stdout, format!("{line}\n"), None);
                            exit_code = 1;
                        }
                        EventAction::Complete => break,
                            EventAction::Ignore => {}
                        }
                    }
                    Some(SseMessage::Failed(error)) => {
                        emit_runtime(&emit, &input, ProviderRuntimeEventType::Error, ProviderOutputStream::System, error.to_string(), Some(1));
                        exit_code = 1;
                        break;
                    }
                    Some(SseMessage::Closed) | None => {
                        emit_runtime(&emit, &input, ProviderRuntimeEventType::Error, ProviderOutputStream::System, "OpenCode closed its event stream before the turn finished".to_string(), Some(1));
                        exit_code = 1;
                        break;
                    }
                    Some(SseMessage::Connected) => {}
                }
            }
        }
    }

    permission_tasks.abort_all();
    for request_id in active_requests {
        let _ = approvals.cancel_native_request(&input.session_id, &invocation_id, &request_id);
    }
    if was_cancelled {
        abort_session(
            http,
            endpoint,
            &input.workspace_path.to_string_lossy(),
            &native_session_id,
        )
        .await;
    }
    sse_cancel.store(true, Ordering::SeqCst);
    let _ = crate::util::process_control::terminate_process_group_with_escalation(&mut child).await;
    let _ = tokio::time::timeout(Duration::from_secs(1), sse_task).await;
    launch_scratch.restore();
    emit_runtime(
        &emit,
        &input,
        ProviderRuntimeEventType::Exit,
        ProviderOutputStream::System,
        String::new(),
        Some(exit_code),
    );
}

async fn answer_permission(
    http: &ureq::Agent,
    endpoint: &str,
    directory: &str,
    approvals: &ApprovalService,
    argmax_session_id: &str,
    invocation_id: &str,
    request: &PermissionRequest,
) -> ArgmaxResult<()> {
    let cwd = if request.cwd.is_empty() {
        directory
    } else {
        &request.cwd
    };
    let allowed = approvals
        .request_native(
            argmax_session_id,
            invocation_id,
            &request.id,
            &request.command,
            cwd,
            "opencode",
        )
        .await?;
    reply_permission(
        http,
        endpoint,
        directory,
        &request.id,
        if allowed { "once" } else { "reject" },
    )
    .await
}

async fn reply_permission(
    http: &ureq::Agent,
    endpoint: &str,
    directory: &str,
    request_id: &str,
    reply: &'static str,
) -> ArgmaxResult<()> {
    validate_provider_id(request_id, "permission")?;
    let http = http.clone();
    let endpoint = endpoint.to_string();
    let directory = directory.to_string();
    let request_id = request_id.to_string();
    tokio::task::spawn_blocking(move || {
        http.post(&format!("{endpoint}/permission/{request_id}/reply"))
            .query("directory", &directory)
            .set("Content-Type", "application/json")
            .send_string(&json!({ "reply": reply }).to_string())
            .map_err(|error| request_error("answer the OpenCode permission", &error))?;
        Ok(())
    })
    .await
    .map_err(|_| {
        server_error(
            "OPENCODE_SERVER_TASK",
            "OpenCode permission response stopped",
        )
    })?
}

fn untracked_permission_session(
    event: &Value,
    tracked_sessions: &HashSet<String>,
) -> Option<String> {
    (event.get("type").and_then(Value::as_str) == Some("permission.asked"))
        .then(|| {
            event
                .pointer("/properties/sessionID")
                .and_then(Value::as_str)
        })
        .flatten()
        .filter(|session_id| !tracked_sessions.contains(*session_id))
        .map(str::to_string)
}

async fn session_lineage(
    http: &ureq::Agent,
    endpoint: &str,
    directory: &str,
    session_id: &str,
    tracked_sessions: &HashSet<String>,
) -> ArgmaxResult<Option<Vec<String>>> {
    validate_provider_id(session_id, "session")?;
    let http = http.clone();
    let endpoint = endpoint.to_string();
    let directory = directory.to_string();
    let session_id = session_id.to_string();
    let tracked_sessions = tracked_sessions.clone();
    tokio::task::spawn_blocking(move || {
        let mut lineage = Vec::new();
        let mut visited = HashSet::new();
        let mut current_id = session_id;
        for _ in 0..MAX_SESSION_LINEAGE_DEPTH {
            if tracked_sessions.contains(&current_id) {
                return Ok(Some(lineage));
            }
            if !visited.insert(current_id.clone()) {
                return Err(invalid_response("verify the OpenCode session lineage"));
            }

            let response = http
                .get(&format!("{endpoint}/session/{current_id}"))
                .query("directory", &directory)
                .call()
                .map_err(|error| request_error("verify the OpenCode session lineage", &error))?;
            let session = response_json(response, "verify the OpenCode session lineage")?;
            let returned_id = session
                .get("id")
                .and_then(Value::as_str)
                .ok_or_else(|| invalid_response("verify the OpenCode session lineage"))?;
            validate_provider_id(returned_id, "session")?;
            if returned_id != current_id {
                return Err(invalid_response("verify the OpenCode session lineage"));
            }
            lineage.push(current_id);

            match session.get("parentID") {
                Some(Value::String(parent_id)) => {
                    validate_provider_id(parent_id, "session")?;
                    current_id = parent_id.clone();
                }
                None | Some(Value::Null) => return Ok(None),
                Some(_) => {
                    return Err(invalid_response("verify the OpenCode session lineage"));
                }
            }
        }
        if tracked_sessions.contains(&current_id) {
            return Ok(Some(lineage));
        }
        Err(server_error(
            "OPENCODE_SERVER_RESPONSE",
            "Could not verify the OpenCode session lineage: the lineage was too deep",
        ))
    })
    .await
    .map_err(|_| {
        server_error(
            "OPENCODE_SERVER_TASK",
            "OpenCode session lineage verification stopped",
        )
    })?
}

async fn abort_session(http: &ureq::Agent, endpoint: &str, directory: &str, session_id: &str) {
    let http = http.clone();
    let url = format!("{endpoint}/session/{session_id}/abort");
    let directory = directory.to_string();
    let _ = tokio::task::spawn_blocking(move || {
        let _ = http.post(&url).query("directory", &directory).call();
    })
    .await;
}

fn subscribe(
    endpoint: String,
    directory: String,
    cancel: Arc<AtomicBool>,
    sender: mpsc::UnboundedSender<SseMessage>,
) -> JoinHandle<()> {
    tokio::task::spawn_blocking(move || {
        let stream_http = ureq::AgentBuilder::new()
            .timeout_connect(Duration::from_secs(5))
            .timeout_read(SSE_READ_TIMEOUT)
            .timeout_write(HTTP_TIMEOUT)
            .build();
        // The authenticated URL's userinfo becomes a Basic authorization
        // header. Errors are sanitized before leaving this module.
        let response = match stream_http
            .get(&format!("{endpoint}/event"))
            .query("directory", &directory)
            .set("Accept", "text/event-stream")
            .call()
        {
            Ok(response) => response,
            Err(error) => {
                let _ = sender.send(SseMessage::Failed(request_error(
                    "subscribe to OpenCode events",
                    &error,
                )));
                return;
            }
        };
        let _ = sender.send(SseMessage::Connected);
        let mut reader = BufReader::new(response.into_reader());
        let mut data = Vec::new();
        let mut line = Vec::new();
        loop {
            if cancel.load(Ordering::SeqCst) {
                return;
            }
            match reader.read_until(b'\n', &mut line) {
                Ok(0) => {
                    let _ = sender.send(SseMessage::Closed);
                    return;
                }
                Ok(_) => {
                    if line.len() > SSE_LINE_LIMIT {
                        let _ = sender.send(SseMessage::Failed(server_error(
                            "OPENCODE_SSE_PARSE",
                            "OpenCode sent an event that exceeded the size limit",
                        )));
                        return;
                    }
                    let Ok(text) = std::str::from_utf8(&line) else {
                        let _ = sender.send(SseMessage::Failed(server_error(
                            "OPENCODE_SSE_PARSE",
                            "OpenCode sent non-UTF-8 event data",
                        )));
                        return;
                    };
                    let text = text.trim_end_matches(['\r', '\n']);
                    if text.is_empty() {
                        if !data.is_empty() {
                            let payload = data.join("\n");
                            data.clear();
                            let event = match serde_json::from_str(&payload) {
                                Ok(event) => event,
                                Err(_) => {
                                    let _ = sender.send(SseMessage::Failed(server_error(
                                        "OPENCODE_SSE_PARSE",
                                        "OpenCode sent an invalid JSON event",
                                    )));
                                    return;
                                }
                            };
                            let _ = sender.send(SseMessage::Event(event));
                        }
                    } else if let Some(value) = text.strip_prefix("data:") {
                        data.push(value.strip_prefix(' ').unwrap_or(value).to_string());
                    }
                    line.clear();
                }
                Err(error)
                    if matches!(error.kind(), ErrorKind::TimedOut | ErrorKind::WouldBlock) =>
                {
                    if line.len() > SSE_LINE_LIMIT {
                        let _ = sender.send(SseMessage::Failed(server_error(
                            "OPENCODE_SSE_PARSE",
                            "OpenCode sent an event that exceeded the size limit",
                        )));
                        return;
                    }
                }
                Err(_) => {
                    let _ = sender.send(SseMessage::Failed(server_error(
                        "OPENCODE_SSE_READ",
                        "Could not read OpenCode's event stream",
                    )));
                    return;
                }
            }
        }
    })
}

enum SseMessage {
    Connected,
    Event(Value),
    Failed(ArgmaxError),
    Closed,
}

#[derive(Debug, PartialEq)]
struct PermissionRequest {
    id: String,
    command: String,
    cwd: String,
}

#[derive(Debug, PartialEq)]
enum EventAction {
    Output(Value),
    Permission(PermissionRequest),
    Error(Value),
    Complete,
    Ignore,
}

fn classify_event(
    event: &Value,
    tracked_sessions: &mut HashSet<String>,
    root_session_id: &str,
) -> EventAction {
    let event_type = event.get("type").and_then(Value::as_str);
    let properties = event.get("properties").and_then(Value::as_object);
    match event_type {
        Some("session.created") => {
            let info = properties.and_then(|value| value.get("info"));
            let parent_id = info
                .and_then(|value| value.get("parentID"))
                .and_then(Value::as_str);
            let session_id = info
                .and_then(|value| value.get("id"))
                .and_then(Value::as_str);
            if parent_id.is_some_and(|id| tracked_sessions.contains(id)) {
                if let Some(id) = session_id {
                    tracked_sessions.insert(id.to_string());
                }
            }
            EventAction::Ignore
        }
        Some("message.part.updated") => {
            let Some(part) = properties.and_then(|value| value.get("part")) else {
                return EventAction::Ignore;
            };
            if part.get("sessionID").and_then(Value::as_str) != Some(root_session_id) {
                return EventAction::Ignore;
            }
            let part_type = part.get("type").and_then(Value::as_str);
            let output_type = match part_type {
                Some("tool")
                    if matches!(
                        part.pointer("/state/status").and_then(Value::as_str),
                        Some("completed" | "error")
                    ) =>
                {
                    Some("tool_use")
                }
                Some("step-start") => Some("step_start"),
                Some("step-finish") => Some("step_finish"),
                Some("text") if part.pointer("/time/end").is_some() => Some("text"),
                Some("reasoning") if part.pointer("/time/end").is_some() => Some("reasoning"),
                _ => None,
            };
            output_type
                .map(|kind| EventAction::Output(run_envelope(kind, root_session_id, "part", part)))
                .unwrap_or(EventAction::Ignore)
        }
        Some("session.error") => {
            let session_id = properties
                .and_then(|value| value.get("sessionID"))
                .and_then(Value::as_str);
            if session_id != Some(root_session_id) {
                return EventAction::Ignore;
            }
            let Some(error) = properties.and_then(|value| value.get("error")) else {
                return EventAction::Ignore;
            };
            EventAction::Error(run_envelope("error", root_session_id, "error", error))
        }
        Some("session.status") => {
            let session_id = properties
                .and_then(|value| value.get("sessionID"))
                .and_then(Value::as_str);
            let status = properties
                .and_then(|value| value.get("status"))
                .and_then(|value| value.get("type"))
                .and_then(Value::as_str);
            if session_id == Some(root_session_id) && status == Some("idle") {
                EventAction::Complete
            } else {
                EventAction::Ignore
            }
        }
        Some("permission.asked") => {
            let Some(properties) = properties else {
                return EventAction::Ignore;
            };
            let native_session_id = properties.get("sessionID").and_then(Value::as_str);
            if !native_session_id.is_some_and(|id| tracked_sessions.contains(id)) {
                return EventAction::Ignore;
            }
            let Some(id) = properties.get("id").and_then(Value::as_str) else {
                return EventAction::Ignore;
            };
            let cwd = properties
                .get("metadata")
                .and_then(Value::as_object)
                .and_then(|metadata| metadata.get("cwd"))
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            EventAction::Permission(PermissionRequest {
                id: id.to_string(),
                command: permission_command(properties),
                cwd,
            })
        }
        _ => EventAction::Ignore,
    }
}

fn run_envelope(kind: &str, session_id: &str, key: &str, value: &Value) -> Value {
    json!({
        "type": kind,
        "timestamp": chrono::Utc::now().timestamp_millis(),
        "sessionID": session_id,
        key: value,
    })
}

fn permission_command(properties: &Map<String, Value>) -> String {
    properties
        .get("metadata")
        .and_then(Value::as_object)
        .and_then(|metadata| metadata.get("command"))
        .and_then(Value::as_str)
        .filter(|command| !command.trim().is_empty())
        .map(str::to_string)
        .or_else(|| {
            properties
                .get("patterns")
                .and_then(Value::as_array)
                .map(|patterns| {
                    patterns
                        .iter()
                        .filter_map(Value::as_str)
                        .collect::<Vec<_>>()
                        .join("\n")
                })
                .filter(|patterns| !patterns.is_empty())
        })
        .or_else(|| {
            properties
                .get("permission")
                .and_then(Value::as_str)
                .map(str::to_string)
        })
        .unwrap_or_else(|| "OpenCode permission request".to_string())
}

fn apply_permission_override(
    environment: &mut Vec<(String, String)>,
    input: &ProviderLaunchInput,
) -> ArgmaxResult<()> {
    let permission = match (input.permission_mode, input.agent_mode) {
        (PermissionMode::ProviderDefaults, _) | (_, AgentMode::Plan) => return Ok(()),
        (PermissionMode::AutoApprove, AgentMode::Auto) => "allow",
        (PermissionMode::AskEachTime, _) => "ask",
    };
    let config = environment
        .iter_mut()
        .find(|(name, _)| name == OPENCODE_CONFIG_CONTENT);
    if let Some((_, body)) = config {
        let mut value = parse_inline_config(body)?;
        value
            .as_object_mut()
            .expect("parse_inline_config returned a non-object")
            .insert(
                "permission".to_string(),
                Value::String(permission.to_string()),
            );
        *body = value.to_string();
    } else {
        environment.push((
            OPENCODE_CONFIG_CONTENT.to_string(),
            json!({ "permission": permission }).to_string(),
        ));
    }
    Ok(())
}

fn merge_launch_environment(
    environment: &mut Vec<(String, String)>,
    launch_environment: Vec<(String, String)>,
) -> ArgmaxResult<()> {
    for (name, body) in launch_environment {
        if name != OPENCODE_CONFIG_CONTENT {
            if let Some((_, existing)) = environment
                .iter_mut()
                .find(|(existing_name, _)| existing_name == &name)
            {
                *existing = body;
            } else {
                environment.push((name, body));
            }
            continue;
        }

        let launch_config = parse_inline_config(&body)?;
        if let Some((_, inherited_body)) = environment
            .iter_mut()
            .find(|(existing_name, _)| existing_name == OPENCODE_CONFIG_CONTENT)
        {
            let mut inherited_config = parse_inline_config(inherited_body)?;
            deep_merge(&mut inherited_config, launch_config);
            *inherited_body = inherited_config.to_string();
        } else {
            environment.push((name, launch_config.to_string()));
        }
    }
    Ok(())
}

fn parse_inline_config(body: &str) -> ArgmaxResult<Value> {
    let value: Value = serde_json::from_str(body).map_err(|_| {
        server_error(
            "OPENCODE_CONFIG",
            "OpenCode's inline launch config is not valid JSON",
        )
    })?;
    if value.is_object() {
        Ok(value)
    } else {
        Err(server_error(
            "OPENCODE_CONFIG",
            "OpenCode's inline launch config must be a JSON object",
        ))
    }
}

fn deep_merge(target: &mut Value, incoming: Value) {
    match (target, incoming) {
        (Value::Object(target), Value::Object(incoming)) => {
            for (key, value) in incoming {
                if let Some(existing) = target.get_mut(&key) {
                    deep_merge(existing, value);
                } else {
                    target.insert(key, value);
                }
            }
        }
        (target, incoming) => *target = incoming,
    }
}

fn opencode_variant(input: &ProviderLaunchInput) -> Option<String> {
    let args = (get_provider_definition(ProviderId::Opencode).structured_args)(input, None);
    args.windows(2)
        .find(|pair| pair[0] == "--variant")
        .map(|pair| pair[1].clone())
}

fn split_model_id(model_id: &str) -> ArgmaxResult<(String, String)> {
    let (provider, model) = model_id.split_once('/').ok_or_else(|| {
        server_error(
            "OPENCODE_MODEL",
            "OpenCode model ids must include a provider and model",
        )
    })?;
    if provider.is_empty() || model.is_empty() {
        return Err(server_error(
            "OPENCODE_MODEL",
            "OpenCode model ids must include a provider and model",
        ));
    }
    Ok((provider.to_string(), model.to_string()))
}

fn available_loopback_port() -> ArgmaxResult<u16> {
    TcpListener::bind(("127.0.0.1", 0))
        .and_then(|listener| listener.local_addr())
        .map(|address| address.port())
        .map_err(|_| {
            server_error(
                "OPENCODE_SERVER_PORT",
                "Could not reserve a local port for OpenCode",
            )
        })
}

fn validate_provider_id(id: &str, kind: &str) -> ArgmaxResult<()> {
    if !id.is_empty()
        && id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
    {
        Ok(())
    } else {
        Err(server_error(
            "OPENCODE_RESPONSE",
            format!("OpenCode returned an invalid {kind} id"),
        ))
    }
}

fn request_error(action: &str, error: &ureq::Error) -> ArgmaxError {
    let message = match error {
        ureq::Error::Status(status, _) => {
            format!("Could not {action}: OpenCode returned HTTP {status}")
        }
        ureq::Error::Transport(_) => format!("Could not {action}: OpenCode was unavailable"),
    };
    server_error("OPENCODE_SERVER_HTTP", message)
}

fn invalid_response(action: &str) -> ArgmaxError {
    server_error(
        "OPENCODE_SERVER_RESPONSE",
        format!("Could not {action}: OpenCode returned an invalid response"),
    )
}

fn response_json(response: ureq::Response, action: &str) -> ArgmaxResult<Value> {
    let mut body = String::new();
    response
        .into_reader()
        .read_to_string(&mut body)
        .map_err(|_| invalid_response(action))?;
    serde_json::from_str(&body).map_err(|_| invalid_response(action))
}

fn server_error(code: &'static str, message: impl Into<String>) -> ArgmaxError {
    ArgmaxError::service(code, message.into())
}

fn emit_runtime(
    emit: &EventCallback,
    input: &ProviderLaunchInput,
    kind: ProviderRuntimeEventType,
    stream: ProviderOutputStream,
    message: String,
    exit_code: Option<i32>,
) {
    emit(ProviderRuntimeEvent {
        session_id: input.session_id.clone(),
        r#type: kind,
        stream,
        message,
        exit_code,
        created_at: now_iso(),
    });
}

struct OpencodeServerHandle {
    cancel: watch::Sender<bool>,
    done: watch::Receiver<bool>,
    disposed: Arc<AtomicBool>,
}

impl ProviderRuntimeHandle for OpencodeServerHandle {
    fn accepts_input(&self) -> bool {
        false
    }

    fn disposed(&self) -> bool {
        self.disposed.load(Ordering::SeqCst)
    }

    fn send_input(&self, _input: &str) {}

    fn resize(&self, _cols: u16, _rows: u16) {}

    fn terminate(&self) -> BoxFuture<'_, ArgmaxResult<()>> {
        Box::pin(async move {
            let _ = self.cancel.send(true);
            let mut done = self.done.clone();
            if !*done.borrow() {
                tokio::time::timeout(Duration::from_secs(5), done.changed())
                    .await
                    .map_err(|_| {
                        server_error(
                            "OPENCODE_SERVER_STOP",
                            "OpenCode did not stop its turn in time",
                        )
                    })?
                    .map_err(|_| {
                        server_error(
                            "OPENCODE_SERVER_STOP",
                            "OpenCode's turn stopped unexpectedly",
                        )
                    })?;
            }
            Ok(())
        })
    }
}

impl Drop for OpencodeServerHandle {
    fn drop(&mut self) {
        let _ = self.cancel.send(true);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{
        body::Body,
        extract::{Path, State},
        http::{header, HeaderMap},
        response::Response,
        routing::{get, post},
        Json, Router,
    };
    use std::{collections::HashMap, sync::Mutex};

    fn input(permission_mode: PermissionMode, agent_mode: AgentMode) -> ProviderLaunchInput {
        ProviderLaunchInput {
            provider: ProviderId::Opencode,
            session_id: "argmax-session".to_string(),
            workspace_path: "/workspace".into(),
            prompt: "Do the work".to_string(),
            model_label: "GLM".to_string(),
            model_id: "opencode-go/glm-5.3-flash".to_string(),
            reasoning_effort: Some(super::super::ReasoningEffort::High),
            fast_mode: false,
            resume_conversation_id: None,
            resume_fork: false,
            permission_mode,
            agent_mode,
            cols: 80,
            rows: 24,
        }
    }

    #[test]
    fn explicit_permission_modes_override_only_the_inline_launch_config() {
        let mut defaults = vec![(
            "OPENCODE_CONFIG_CONTENT".to_string(),
            json!({ "mcp": { "argmax": { "enabled": true } }, "permission": { "bash": "deny" } })
                .to_string(),
        )];
        apply_permission_override(
            &mut defaults,
            &input(PermissionMode::ProviderDefaults, AgentMode::Auto),
        )
        .unwrap();
        let default_config: Value = serde_json::from_str(&defaults[0].1).unwrap();
        assert_eq!(default_config["permission"]["bash"], "deny");

        let mut full_access = defaults.clone();
        apply_permission_override(
            &mut full_access,
            &input(PermissionMode::AutoApprove, AgentMode::Auto),
        )
        .unwrap();
        let full_access_config: Value = serde_json::from_str(&full_access[0].1).unwrap();
        assert_eq!(full_access_config["permission"], "allow");
        assert_eq!(full_access_config["mcp"]["argmax"]["enabled"], true);

        let mut ask = defaults;
        apply_permission_override(
            &mut ask,
            &input(PermissionMode::AskEachTime, AgentMode::Auto),
        )
        .unwrap();
        let ask_config: Value = serde_json::from_str(&ask[0].1).unwrap();
        assert_eq!(ask_config["permission"], "ask");
    }

    #[test]
    fn provider_defaults_merge_argmax_mcp_into_the_inherited_native_config() {
        let mut environment = vec![(
            OPENCODE_CONFIG_CONTENT.to_string(),
            json!({
                "mcp": {
                    "personal": { "type": "remote", "url": "https://example.com/mcp" },
                    "argmax": { "timeout": 30 }
                },
                "provider": { "local": { "npm": "@ai-sdk/openai-compatible" } },
                "permission": { "bash": "ask", "edit": "deny" }
            })
            .to_string(),
        )];
        let launch_environment = vec![(
            OPENCODE_CONFIG_CONTENT.to_string(),
            json!({
                "mcp": {
                    "argmax": {
                        "type": "local",
                        "command": ["/Applications/Argmax.app/argmax", "mcp"],
                        "enabled": true,
                        "environment": { "ARGMAX_SESSION_LAUNCH_TOKEN": "token" }
                    }
                }
            })
            .to_string(),
        )];

        merge_launch_environment(&mut environment, launch_environment).unwrap();
        apply_permission_override(
            &mut environment,
            &input(PermissionMode::ProviderDefaults, AgentMode::Auto),
        )
        .unwrap();

        let config: Value = serde_json::from_str(&environment[0].1).unwrap();
        assert_eq!(config["mcp"]["personal"]["type"], "remote");
        assert_eq!(config["mcp"]["argmax"]["type"], "local");
        assert_eq!(config["mcp"]["argmax"]["timeout"], 30);
        assert_eq!(
            config["provider"]["local"]["npm"],
            "@ai-sdk/openai-compatible"
        );
        assert_eq!(config["permission"]["bash"], "ask");
        assert_eq!(config["permission"]["edit"], "deny");
    }

    #[test]
    fn invalid_inherited_native_config_fails_before_argmax_mcp_is_injected() {
        let mut environment = vec![(OPENCODE_CONFIG_CONTENT.to_string(), "{not-json".to_string())];
        let launch_environment = vec![(
            OPENCODE_CONFIG_CONTENT.to_string(),
            json!({ "mcp": { "argmax": { "enabled": true } } }).to_string(),
        )];

        let error = merge_launch_environment(&mut environment, launch_environment).unwrap_err();

        assert!(error
            .to_string()
            .contains("inline launch config is not valid JSON"));
        assert_eq!(environment[0].1, "{not-json");
    }

    #[test]
    fn plan_keeps_its_native_restrictions_and_prompt_keeps_the_selected_variant() {
        let mut environment = Vec::new();
        let plan = input(PermissionMode::AutoApprove, AgentMode::Plan);
        apply_permission_override(&mut environment, &plan).unwrap();
        assert!(environment.is_empty());
        let body = prompt_body(&plan).unwrap();
        assert_eq!(body["agent"], "plan");
        assert_eq!(body["model"]["providerID"], "opencode-go");
        assert_eq!(body["model"]["modelID"], "glm-5.3-flash");
        assert_eq!(body["variant"], "high");
        assert_eq!(body["parts"][0]["text"], "Do the work");
    }

    #[test]
    fn server_events_match_the_existing_run_json_contract() {
        let mut sessions = HashSet::from(["ses_root".to_string()]);
        let text = json!({
            "type": "message.part.updated",
            "properties": { "part": {
                "id": "prt_1", "sessionID": "ses_root", "messageID": "msg_1",
                "type": "text", "text": "Done", "time": { "start": 1, "end": 2 }
            }}
        });
        let EventAction::Output(output) = classify_event(&text, &mut sessions, "ses_root") else {
            panic!("expected output");
        };
        assert_eq!(output["type"], "text");
        assert_eq!(output["sessionID"], "ses_root");
        assert_eq!(output["part"]["text"], "Done");

        let unfinished = json!({
            "type": "message.part.updated",
            "properties": { "part": {
                "sessionID": "ses_root", "type": "tool",
                "state": { "status": "running" }
            }}
        });
        assert_eq!(
            classify_event(&unfinished, &mut sessions, "ses_root"),
            EventAction::Ignore
        );
    }

    #[test]
    fn child_session_permissions_are_tracked_and_described_by_command() {
        let mut sessions = HashSet::from(["ses_root".to_string()]);
        let child = json!({
            "type": "session.created",
            "properties": { "info": { "id": "ses_child", "parentID": "ses_root" } }
        });
        assert_eq!(
            classify_event(&child, &mut sessions, "ses_root"),
            EventAction::Ignore
        );
        let permission = json!({
            "type": "permission.asked",
            "properties": {
                "id": "per_1", "sessionID": "ses_child", "permission": "bash",
                "patterns": ["npm test"], "metadata": { "command": "npm test", "cwd": "/workspace" }
            }
        });
        assert_eq!(
            classify_event(&permission, &mut sessions, "ses_root"),
            EventAction::Permission(PermissionRequest {
                id: "per_1".to_string(),
                command: "npm test".to_string(),
                cwd: "/workspace".to_string(),
            })
        );
    }

    #[derive(Clone, Default)]
    struct FakeState {
        requests: Arc<Mutex<Vec<(String, Value)>>>,
        sessions: Arc<Mutex<HashMap<String, Value>>>,
    }

    async fn fake_events(headers: HeaderMap) -> Response<Body> {
        assert!(headers
            .get(header::AUTHORIZATION)
            .and_then(|value| value.to_str().ok())
            .is_some_and(|value| value.starts_with("Basic ")));
        let events = [
            json!({"type":"server.connected","properties":{}}),
            json!({"type":"session.status","properties":{"sessionID":"ses_root","status":{"type":"idle"}}}),
        ];
        let body = events
            .iter()
            .map(|event| format!("data: {event}\n\n"))
            .collect::<String>();
        Response::builder()
            .header(header::CONTENT_TYPE, "text/event-stream")
            .body(Body::from(body))
            .unwrap()
    }

    async fn fake_reply(
        State(state): State<FakeState>,
        headers: HeaderMap,
        Json(body): Json<Value>,
    ) -> Json<bool> {
        let auth = headers
            .get(header::AUTHORIZATION)
            .and_then(|value| value.to_str().ok())
            .unwrap_or_default()
            .to_string();
        state.requests.lock().unwrap().push((auth, body));
        Json(true)
    }

    async fn fake_session(
        State(state): State<FakeState>,
        Path(session_id): Path<String>,
        headers: HeaderMap,
    ) -> Json<Value> {
        assert!(headers
            .get(header::AUTHORIZATION)
            .and_then(|value| value.to_str().ok())
            .is_some_and(|value| value.starts_with("Basic ")));
        Json(
            state
                .sessions
                .lock()
                .unwrap()
                .get(&session_id)
                .cloned()
                .unwrap_or_else(|| json!({ "id": session_id })),
        )
    }

    async fn fake_server() -> (String, FakeState) {
        let state = FakeState::default();
        let app = Router::new()
            .route("/event", get(fake_events))
            .route("/session/{session_id}", get(fake_session))
            .route("/permission/per_1/reply", post(fake_reply))
            .with_state(state.clone());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        (format!("http://argmax:test-secret@{address}"), state)
    }

    #[tokio::test]
    async fn resumed_descendant_permissions_require_authoritative_session_lineage() {
        let (endpoint, state) = fake_server().await;
        state.sessions.lock().unwrap().extend([
            (
                "ses_resumed".to_string(),
                json!({ "id": "ses_resumed", "parentID": "ses_middle" }),
            ),
            (
                "ses_middle".to_string(),
                json!({ "id": "ses_middle", "parentID": "ses_root" }),
            ),
            (
                "ses_other".to_string(),
                json!({ "id": "ses_other", "parentID": "ses_unrelated" }),
            ),
            (
                "ses_unrelated".to_string(),
                json!({ "id": "ses_unrelated" }),
            ),
            (
                "ses_cycle_a".to_string(),
                json!({ "id": "ses_cycle_a", "parentID": "ses_cycle_b" }),
            ),
            (
                "ses_cycle_b".to_string(),
                json!({ "id": "ses_cycle_b", "parentID": "ses_cycle_a" }),
            ),
        ]);
        let http = ureq::AgentBuilder::new()
            .timeout_read(Duration::from_secs(1))
            .build();
        let mut sessions = HashSet::from(["ses_root".to_string()]);
        let resumed_permission = json!({
            "type": "permission.asked",
            "properties": {
                "id": "per_resumed", "sessionID": "ses_resumed", "permission": "bash",
                "metadata": { "command": "npm test", "cwd": "/workspace" }
            }
        });

        let resumed_id = untracked_permission_session(&resumed_permission, &sessions).unwrap();
        let lineage = session_lineage(&http, &endpoint, "/workspace", &resumed_id, &sessions)
            .await
            .unwrap()
            .unwrap();
        sessions.extend(lineage);
        assert!(matches!(
            classify_event(&resumed_permission, &mut sessions, "ses_root"),
            EventAction::Permission(_)
        ));
        assert!(sessions.contains("ses_resumed"));
        assert!(sessions.contains("ses_middle"));

        let unrelated_permission = json!({
            "type": "permission.asked",
            "properties": {
                "id": "per_other", "sessionID": "ses_other", "permission": "bash"
            }
        });
        let unrelated_id = untracked_permission_session(&unrelated_permission, &sessions).unwrap();
        assert_eq!(
            session_lineage(&http, &endpoint, "/workspace", &unrelated_id, &sessions,)
                .await
                .unwrap(),
            None
        );
        assert_eq!(
            classify_event(&unrelated_permission, &mut sessions, "ses_root"),
            EventAction::Ignore
        );
        assert!(!sessions.contains("ses_other"));
        assert!(!sessions.contains("ses_unrelated"));

        let error = session_lineage(&http, &endpoint, "/workspace", "ses_cycle_a", &sessions)
            .await
            .unwrap_err();
        assert!(error.to_string().contains("invalid response"));
        assert!(!error.to_string().contains("test-secret"));
        assert!(!sessions.contains("ses_cycle_a"));
        assert!(!sessions.contains("ses_cycle_b"));
    }

    #[tokio::test]
    async fn authenticated_http_and_sse_use_the_current_permission_endpoint() {
        let (endpoint, state) = fake_server().await;
        let http = ureq::AgentBuilder::new()
            .timeout_read(Duration::from_secs(1))
            .build();
        let (sender, mut receiver) = mpsc::unbounded_channel();
        let cancel = Arc::new(AtomicBool::new(false));
        let task = subscribe(
            endpoint.clone(),
            "/workspace".to_string(),
            Arc::clone(&cancel),
            sender,
        );
        assert!(matches!(receiver.recv().await, Some(SseMessage::Connected)));
        assert!(matches!(receiver.recv().await, Some(SseMessage::Event(_))));
        assert!(matches!(receiver.recv().await, Some(SseMessage::Event(_))));

        reply_permission(&http, &endpoint, "/workspace", "per_1", "once")
            .await
            .unwrap();
        {
            let requests = state.requests.lock().unwrap();
            assert_eq!(requests.len(), 1);
            assert!(requests[0].0.starts_with("Basic "));
            assert_eq!(requests[0].1, json!({ "reply": "once" }));
        }
        cancel.store(true, Ordering::SeqCst);
        let _ = task.await;
    }
}
