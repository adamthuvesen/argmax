//! Native Codex app-server transport.
//!
//! The installed Codex CLI publishes this protocol through
//! `codex app-server generate-json-schema`. This module intentionally keeps
//! the wire values as JSON rather than copying the large generated type graph:
//! Argmax uses four client methods, translates the documented v2 lifecycle
//! notifications into the existing `codex exec --json` event shape, and
//! answers every server request so Codex can never wait on an unsupported UI.

use std::collections::{HashMap, HashSet};
use std::process::Stdio;
use std::sync::{
    atomic::{AtomicBool, AtomicU64, Ordering},
    Arc, Mutex,
};
use std::time::Duration;

use serde_json::{json, Map, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{ChildStdin, Command};
use tokio::sync::{mpsc, oneshot, watch};
use uuid::Uuid;

use super::adapters::prompt_for_agent_mode;
use super::environment::build_provider_environment;
use super::normalizer::ProviderOutputStream;
use super::runtime::{
    BoxFuture, EventCallback, ProviderRuntimeEvent, ProviderRuntimeEventType, ProviderRuntimeHandle,
};
use super::{mcp_injection, AgentMode, PermissionMode, ProviderId, ProviderLaunchInput};
use crate::approvals::service::ApprovalService;
use crate::error::{ArgmaxError, ArgmaxResult};
use crate::persistence::time::now_iso;
use crate::session_control::{
    SessionLaunchProcessConfig, SESSION_LAUNCH_SOCKET_ENV, SESSION_LAUNCH_TOKEN_ENV,
};
use crate::util::sync::LockOrRecover;

const RESPONSE_TIMEOUT: Duration = Duration::from_secs(20);
const CANCEL_TIMEOUT: Duration = Duration::from_secs(5);

/// Launch one Codex turn over its native app-server protocol.
///
/// A process is scoped to the turn. Codex threads remain durable, so a later
/// turn resumes the provider conversation in a fresh app-server process. This
/// avoids leaving an idle daemon behind and gives the runtime handle exact
/// ownership of cancellation and cleanup.
pub async fn launch_turn(
    binary_path: &str,
    input: &ProviderLaunchInput,
    session_launch: Option<&SessionLaunchProcessConfig>,
    approvals: Arc<ApprovalService>,
    on_event: EventCallback,
) -> ArgmaxResult<Arc<dyn ProviderRuntimeHandle>> {
    let mut environment_overrides = vec![("NO_COLOR".to_string(), "1".to_string())];
    if let Some(config) = session_launch {
        environment_overrides.extend(config.env_pairs());
    }
    let mut command = Command::new(binary_path);
    command
        .args(["app-server", "--stdio"])
        .current_dir(&input.workspace_path)
        .env_clear()
        .envs(build_provider_environment(environment_overrides))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(unix)]
    command.process_group(0);
    let mut child = command.spawn().map_err(|error| {
        ArgmaxError::service(
            "CODEX_APP_SERVER_SPAWN_FAILED",
            format!("could not launch Codex app-server: {error}"),
        )
    })?;

    let stdin = child.stdin.take().ok_or_else(|| {
        ArgmaxError::service("CODEX_APP_SERVER_IO", "Codex app-server has no stdin")
    })?;
    let stdout = child.stdout.take().ok_or_else(|| {
        ArgmaxError::service("CODEX_APP_SERVER_IO", "Codex app-server has no stdout")
    })?;
    let stderr = child.stderr.take().ok_or_else(|| {
        ArgmaxError::service("CODEX_APP_SERVER_IO", "Codex app-server has no stderr")
    })?;

    let child = Arc::new(tokio::sync::Mutex::new(child));
    let rpc = Arc::new(RpcPeer::new(stdin));
    let (incoming_tx, mut incoming_rx) = mpsc::unbounded_channel();
    tokio::spawn(read_protocol(
        BufReader::new(stdout),
        Arc::clone(&rpc),
        incoming_tx,
    ));
    spawn_stderr_reader(stderr, input.session_id.clone(), Arc::clone(&on_event));

    let initialized = async {
        rpc.request(
            "initialize",
            json!({
                "clientInfo": {
                    "name": "argmax",
                    "title": "Argmax",
                    "version": env!("CARGO_PKG_VERSION"),
                },
                "capabilities": {},
            }),
        )
        .await?;
        rpc.notify("initialized", json!({})).await?;

        let thread_method = if input.resume_conversation_id.is_some() {
            if input.resume_fork {
                "thread/fork"
            } else {
                "thread/resume"
            }
        } else {
            "thread/start"
        };
        let thread_params = thread_params(input, session_launch);
        let thread_response = rpc.request(thread_method, thread_params).await?;
        let thread_id = thread_response
            .pointer("/thread/id")
            .and_then(Value::as_str)
            .ok_or_else(|| {
                ArgmaxError::service(
                    "CODEX_APP_SERVER_PROTOCOL",
                    format!("{thread_method} returned no thread.id"),
                )
            })?
            .to_string();

        // The process launcher prepends the shared Argmax tool instruction
        // before choosing this transport. Add only Codex's plan-mode guard.
        let prompt = prompt_for_agent_mode(&input.prompt, input.agent_mode);
        let turn_response = rpc
            .request("turn/start", turn_params(input, &thread_id, prompt))
            .await?;
        let turn_id = turn_response
            .pointer("/turn/id")
            .and_then(Value::as_str)
            .ok_or_else(|| {
                ArgmaxError::service(
                    "CODEX_APP_SERVER_PROTOCOL",
                    "turn/start returned no turn.id",
                )
            })?
            .to_string();
        Ok::<_, ArgmaxError>((thread_id, turn_id))
    }
    .await;

    let (thread_id, turn_id) = match initialized {
        Ok(ids) => ids,
        Err(error) => {
            let _ = child.lock().await.kill().await;
            return Err(error);
        }
    };

    emit(
        &on_event,
        &input.session_id,
        ProviderRuntimeEventType::StreamStarted,
        ProviderOutputStream::System,
        String::new(),
        None,
    );
    emit_line(
        &on_event,
        &input.session_id,
        json!({ "type": "thread.started", "thread_id": thread_id }),
    );
    emit_line(
        &on_event,
        &input.session_id,
        json!({
            "type": "turn_context",
            "model": input.model_id,
            "reasoning_effort": effective_effort(input),
        }),
    );

    let (done_tx, done_rx) = watch::channel(false);
    let (cancel_tx, mut cancel_rx) = watch::channel(false);
    let handle = Arc::new(CodexTurnHandle {
        cancel: cancel_tx,
        disposed: AtomicBool::new(false),
        done_rx,
    });
    let session_id = input.session_id.clone();
    let invocation_id = Uuid::new_v4().to_string();
    let approvals: Arc<dyn NativeApprovalBroker> = approvals;
    tokio::spawn(async move {
        let mut translation = EventTranslation::default();
        let mut scope = TurnScope::new(&thread_id, &turn_id);
        let mut root_completion: Option<Value> = None;
        let outcome = loop {
            let incoming = tokio::select! {
                _ = cancel_rx.changed() => {
                    let _ = tokio::time::timeout(Duration::from_secs(2), rpc.request("turn/interrupt", json!({"threadId":thread_id,"turnId":turn_id}))).await;
                    break Ok(true);
                }
                incoming = incoming_rx.recv() => incoming,
            };
            match incoming {
                Some(Incoming::Message(message)) => {
                    if message.get("id").is_some() && message.get("method").is_some() {
                        spawn_server_request(
                            message,
                            Arc::clone(&rpc),
                            Arc::clone(&approvals),
                            session_id.clone(),
                            invocation_id.clone(),
                            thread_id.clone(),
                            turn_id.clone(),
                        );
                        continue;
                    }
                    let Some(method) = message.get("method").and_then(Value::as_str) else {
                        continue;
                    };
                    let params = message.get("params").cloned().unwrap_or_else(|| json!({}));
                    let is_root = scope.observe(method, &params);
                    if is_root {
                        if method == "turn/completed" {
                            root_completion = Some(params);
                        } else {
                            for line in translation.translate(method, &params) {
                                emit_line(&on_event, &session_id, line);
                            }
                        }
                    }
                    if let Some(completion) = root_completion.as_ref() {
                        let status = completion
                            .pointer("/turn/status")
                            .and_then(Value::as_str)
                            .unwrap_or("failed");
                        if status != "completed" || scope.running_children.is_empty() {
                            for line in translation.translate("turn/completed", completion) {
                                emit_line(&on_event, &session_id, line);
                            }
                            break match status {
                                "completed" => Ok(false),
                                "interrupted" => Ok(true),
                                _ => Err(completion
                                    .pointer("/turn/error/message")
                                    .and_then(Value::as_str)
                                    .unwrap_or("Codex turn failed")
                                    .to_string()),
                            };
                        }
                    }
                }
                Some(Incoming::Closed(reason)) => break Err(reason),
                None => break Err("Codex app-server event channel closed".to_string()),
            }
        };

        let _ = crate::util::process_control::terminate_process_group_with_escalation(
            &mut *child.lock().await,
        )
        .await;
        match outcome {
            Ok(cancelled) => emit(
                &on_event,
                &session_id,
                ProviderRuntimeEventType::Exit,
                ProviderOutputStream::System,
                if cancelled {
                    "Codex app-server turn cancelled."
                } else {
                    "Codex app-server turn completed."
                }
                .to_string(),
                Some(0),
            ),
            Err(error) => emit(
                &on_event,
                &session_id,
                ProviderRuntimeEventType::Error,
                ProviderOutputStream::System,
                format!("Codex app-server turn failed: {error}"),
                Some(1),
            ),
        }
        let _ = done_tx.send(true);
    });

    Ok(handle)
}

fn thread_params(
    input: &ProviderLaunchInput,
    session_launch: Option<&SessionLaunchProcessConfig>,
) -> Value {
    let mut params = Map::new();
    params.insert("cwd".to_string(), json!(input.workspace_path));
    params.insert("model".to_string(), json!(input.model_id));
    if let Some(resume_id) = &input.resume_conversation_id {
        params.insert("threadId".to_string(), json!(resume_id));
    }
    apply_permission_policy(&mut params, input, false);
    if let Some(config) = session_launch {
        params.insert("config".to_string(), mcp_config(config));
    }
    Value::Object(params)
}

fn turn_params(input: &ProviderLaunchInput, thread_id: &str, prompt: String) -> Value {
    let mut params = Map::from_iter([
        ("threadId".to_string(), json!(thread_id)),
        (
            "input".to_string(),
            json!([{ "type": "text", "text": prompt }]),
        ),
        ("cwd".to_string(), json!(input.workspace_path)),
        ("model".to_string(), json!(input.model_id)),
        ("summary".to_string(), json!("auto")),
    ]);
    if let Some(effort) = effective_effort(input) {
        params.insert("effort".to_string(), json!(effort));
    }
    if input.fast_mode {
        params.insert("serviceTier".to_string(), json!("priority"));
    }
    apply_permission_policy(&mut params, input, true);
    Value::Object(params)
}

fn apply_permission_policy(
    params: &mut Map<String, Value>,
    input: &ProviderLaunchInput,
    is_turn: bool,
) {
    match input.permission_mode {
        PermissionMode::ProviderDefaults => {}
        PermissionMode::AutoApprove if input.agent_mode == AgentMode::Auto => {
            params.insert("approvalPolicy".to_string(), json!("never"));
            if is_turn {
                params.insert(
                    "sandboxPolicy".to_string(),
                    json!({ "type": "dangerFullAccess" }),
                );
            } else {
                params.insert("sandbox".to_string(), json!("danger-full-access"));
            }
        }
        PermissionMode::AutoApprove | PermissionMode::AskEachTime => {
            params.insert("approvalPolicy".to_string(), json!("on-request"));
            params.insert("approvalsReviewer".to_string(), json!("user"));
            if is_turn {
                params.insert(
                    "sandboxPolicy".to_string(),
                    json!({
                        "type": "workspaceWrite",
                        "writableRoots": [input.workspace_path],
                        "networkAccess": false,
                        "excludeTmpdirEnvVar": false,
                        "excludeSlashTmp": false,
                    }),
                );
            } else {
                params.insert("sandbox".to_string(), json!("workspace-write"));
            }
        }
    }
}

fn effective_effort(input: &ProviderLaunchInput) -> Option<&'static str> {
    let effort = input.reasoning_effort?;
    Some(match input.model_id.as_str() {
        "gpt-6-astra" | "gpt-5.6-sol" | "gpt-5.6-terra" => effort.as_str(),
        "gpt-5.6-luna" if effort.as_str() == "ultra" => "max",
        "gpt-5.6-luna" => effort.as_str(),
        _ if matches!(effort.as_str(), "max" | "ultra") => "xhigh",
        _ => effort.as_str(),
    })
}

fn mcp_config(config: &SessionLaunchProcessConfig) -> Value {
    json!({
        "mcp_servers": {
            mcp_injection::SERVER_NAME: {
                "command": config.argmax_bin(),
                "args": ["mcp"],
                "env": {
                    SESSION_LAUNCH_SOCKET_ENV: config.socket_path(),
                    SESSION_LAUNCH_TOKEN_ENV: config.token(),
                },
            }
        }
    })
}

struct RpcPeer {
    writer: tokio::sync::Mutex<ChildStdin>,
    pending: Mutex<HashMap<String, oneshot::Sender<Result<Value, String>>>>,
    next_id: AtomicU64,
}

impl RpcPeer {
    fn new(writer: ChildStdin) -> Self {
        Self {
            writer: tokio::sync::Mutex::new(writer),
            pending: Mutex::new(HashMap::new()),
            next_id: AtomicU64::new(1),
        }
    }

    async fn request(&self, method: &str, params: Value) -> ArgmaxResult<Value> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (sender, receiver) = oneshot::channel();
        self.pending
            .lock_or_recover("codex app-server requests")
            .insert(id.to_string(), sender);
        if let Err(error) = self
            .write(&json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params }))
            .await
        {
            self.pending
                .lock_or_recover("codex app-server requests")
                .remove(&id.to_string());
            return Err(error);
        }
        match tokio::time::timeout(RESPONSE_TIMEOUT, receiver).await {
            Ok(Ok(Ok(result))) => Ok(result),
            Ok(Ok(Err(message))) => Err(ArgmaxError::service("CODEX_APP_SERVER_RPC", message)),
            Ok(Err(_)) => Err(ArgmaxError::service(
                "CODEX_APP_SERVER_CLOSED",
                format!("Codex app-server closed while answering {method}"),
            )),
            Err(_) => {
                self.pending
                    .lock_or_recover("codex app-server requests")
                    .remove(&id.to_string());
                Err(ArgmaxError::service(
                    "CODEX_APP_SERVER_TIMEOUT",
                    format!("Codex app-server did not answer {method}"),
                ))
            }
        }
    }

    async fn notify(&self, method: &str, params: Value) -> ArgmaxResult<()> {
        self.write(&json!({ "jsonrpc": "2.0", "method": method, "params": params }))
            .await
    }

    async fn write(&self, message: &Value) -> ArgmaxResult<()> {
        let mut writer = self.writer.lock().await;
        writer
            .write_all(format!("{message}\n").as_bytes())
            .await
            .map_err(|error| {
                ArgmaxError::service(
                    "CODEX_APP_SERVER_IO",
                    format!("could not write to Codex app-server: {error}"),
                )
            })?;
        writer.flush().await.map_err(|error| {
            ArgmaxError::service(
                "CODEX_APP_SERVER_IO",
                format!("could not flush Codex app-server input: {error}"),
            )
        })
    }
}

enum Incoming {
    Message(Value),
    Closed(String),
}

async fn read_protocol(
    mut reader: BufReader<tokio::process::ChildStdout>,
    rpc: Arc<RpcPeer>,
    incoming: mpsc::UnboundedSender<Incoming>,
) {
    let mut line = String::new();
    loop {
        line.clear();
        match reader.read_line(&mut line).await {
            Ok(0) => {
                close_pending(&rpc, "Codex app-server exited");
                let _ = incoming.send(Incoming::Closed("Codex app-server exited".to_string()));
                return;
            }
            Ok(_) => match serde_json::from_str::<Value>(&line) {
                Ok(message) if message.get("method").is_some() => {
                    let _ = incoming.send(Incoming::Message(message));
                }
                Ok(message) if message.get("id").is_some() => resolve_response(&rpc, message),
                Ok(_) => {}
                Err(error) => {
                    close_pending(&rpc, "Codex app-server emitted malformed JSON");
                    let _ = incoming.send(Incoming::Closed(format!(
                        "Codex app-server emitted malformed JSON: {error}"
                    )));
                    return;
                }
            },
            Err(error) => {
                close_pending(&rpc, "Could not read Codex app-server output");
                let _ = incoming.send(Incoming::Closed(format!(
                    "could not read Codex app-server output: {error}"
                )));
                return;
            }
        }
    }
}

fn resolve_response(rpc: &RpcPeer, message: Value) {
    let Some(id) = message.get("id").and_then(request_id) else {
        return;
    };
    let Some(sender) = rpc
        .pending
        .lock_or_recover("codex app-server requests")
        .remove(&id)
    else {
        return;
    };
    let result = if let Some(error) = message.get("error") {
        Err(error
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or("Codex app-server request failed")
            .to_string())
    } else {
        Ok(message.get("result").cloned().unwrap_or(Value::Null))
    };
    let _ = sender.send(result);
}

fn close_pending(rpc: &RpcPeer, reason: &str) {
    for (_, sender) in rpc
        .pending
        .lock_or_recover("codex app-server requests")
        .drain()
    {
        let _ = sender.send(Err(reason.to_string()));
    }
}

fn spawn_stderr_reader(
    stderr: tokio::process::ChildStderr,
    session_id: String,
    on_event: EventCallback,
) {
    tokio::spawn(async move {
        let mut lines = BufReader::new(stderr).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            emit(
                &on_event,
                &session_id,
                ProviderRuntimeEventType::Output,
                ProviderOutputStream::Stderr,
                format!("{line}\n"),
                None,
            );
        }
    });
}

trait NativeApprovalBroker: Send + Sync {
    fn request<'a>(
        &'a self,
        session_id: &'a str,
        invocation_id: &'a str,
        request_id: &'a str,
        command: &'a str,
        cwd: &'a str,
    ) -> BoxFuture<'a, ArgmaxResult<bool>>;
}

impl NativeApprovalBroker for ApprovalService {
    fn request<'a>(
        &'a self,
        session_id: &'a str,
        invocation_id: &'a str,
        request_id: &'a str,
        command: &'a str,
        cwd: &'a str,
    ) -> BoxFuture<'a, ArgmaxResult<bool>> {
        Box::pin(self.request_native(
            session_id,
            invocation_id,
            request_id,
            command,
            cwd,
            ProviderId::Codex.as_str(),
        ))
    }
}

fn spawn_server_request(
    request: Value,
    rpc: Arc<RpcPeer>,
    approvals: Arc<dyn NativeApprovalBroker>,
    session_id: String,
    invocation_id: String,
    root_thread_id: String,
    root_turn_id: String,
) {
    tokio::spawn(async move {
        let response = server_request_response(
            &request,
            approvals.as_ref(),
            &session_id,
            &invocation_id,
            &root_thread_id,
            &root_turn_id,
        )
        .await;
        if let Err(error) = rpc.write(&response).await {
            tracing::warn!(?error, "could not answer Codex app-server request");
        }
    });
}

async fn server_request_response(
    request: &Value,
    approvals: &dyn NativeApprovalBroker,
    session_id: &str,
    invocation_id: &str,
    root_thread_id: &str,
    root_turn_id: &str,
) -> Value {
    let id = request.get("id").cloned().unwrap_or(Value::Null);
    let method = request.get("method").and_then(Value::as_str).unwrap_or("");
    let params = request.get("params").unwrap_or(&Value::Null);
    if !matches!(
        method,
        "item/commandExecution/requestApproval"
            | "item/fileChange/requestApproval"
            | "item/permissions/requestApproval"
    ) {
        return rpc_error(
            id,
            -32601,
            format!("Argmax does not support Codex app-server request {method}"),
        );
    }
    let Some(request_thread_id) = params.get("threadId").and_then(Value::as_str) else {
        return rpc_error(id, -32602, "Approval request has no threadId");
    };
    // This app-server process is created for one Argmax turn, so every child
    // thread it owns belongs to the same session. The root is the only thread
    // that can have a stale persisted turn on resume; reject that exact case.
    if request_thread_id == root_thread_id
        && params.get("turnId").and_then(Value::as_str) != Some(root_turn_id)
    {
        return rpc_error(id, -32602, "Approval belongs to another Codex turn");
    }
    let Some(request_id) = request.get("id").and_then(request_id) else {
        return rpc_error(id, -32602, "Approval request has no usable id");
    };
    let mut command = if method == "item/permissions/requestApproval" {
        let Some(permissions) = params.get("permissions").filter(|value| value.is_object()) else {
            return rpc_error(id, -32602, "Permission request has no permission profile");
        };
        format!(
            "Grant these permissions for the current turn only:\n{}",
            serde_json::to_string_pretty(permissions).unwrap_or_default()
        )
    } else if method == "item/fileChange/requestApproval" {
        match params.get("grantRoot").and_then(Value::as_str) {
            Some(root) => format!("Apply file changes under {root}"),
            None => "Apply the proposed file changes".to_string(),
        }
    } else {
        command_text(params.get("command"))
            .filter(|command| !command.trim().is_empty())
            .unwrap_or_else(|| "Execute command".to_string())
    };
    if let Some(reason) = params
        .get("reason")
        .and_then(Value::as_str)
        .filter(|reason| !reason.is_empty())
    {
        command.push_str(&format!("\n\nReason: {reason}"));
    }
    let cwd = params
        .get("cwd")
        .and_then(Value::as_str)
        .unwrap_or_default();
    match approvals
        .request(session_id, invocation_id, &request_id, &command, cwd)
        .await
    {
        Ok(allowed) => {
            let result = if method == "item/permissions/requestApproval" {
                json!({"permissions": if allowed { params["permissions"].clone() } else { json!({}) }, "scope": "turn"})
            } else {
                json!({ "decision": if allowed { "accept" } else { "decline" } })
            };
            json!({"jsonrpc":"2.0", "id":id, "result":result})
        }
        Err(error) => rpc_error(id, -32001, error.to_string()),
    }
}

fn command_text(value: Option<&Value>) -> Option<String> {
    match value? {
        Value::String(command) => Some(command.clone()),
        Value::Array(words) => Some(
            words
                .iter()
                .filter_map(Value::as_str)
                .collect::<Vec<_>>()
                .join(" "),
        ),
        _ => None,
    }
}

fn request_id(value: &Value) -> Option<String> {
    (value.is_string() || value.is_i64() || value.is_u64()).then(|| value.to_string())
}

fn rpc_error(id: Value, code: i64, message: impl Into<String>) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "error": { "code": code, "message": message.into() },
    })
}

#[derive(Default)]
struct EventTranslation {
    last_usage: Option<Value>,
}

impl EventTranslation {
    fn translate(&mut self, method: &str, params: &Value) -> Vec<Value> {
        match method {
            "turn/started" => vec![json!({ "type": "turn.started" })],
            "item/started" | "item/completed" => {
                let Some(item) = params.get("item") else {
                    return Vec::new();
                };
                let event_type = if method == "item/started" {
                    "item.started"
                } else {
                    "item.completed"
                };
                vec![json!({ "type": event_type, "item": exec_item(item) })]
            }
            "item/agentMessage/delta" => params
                .get("delta")
                .and_then(Value::as_str)
                .map(|text| vec![json!({ "type": "message.delta", "text": text })])
                .unwrap_or_default(),
            "item/reasoning/summaryTextDelta" | "item/reasoning/textDelta" => params
                .get("delta")
                .and_then(Value::as_str)
                .map(|text| {
                    vec![json!({
                        "type": "message.delta",
                        "text": text,
                        "thinking": true,
                    })]
                })
                .unwrap_or_default(),
            "thread/tokenUsage/updated" => {
                self.last_usage = params.get("tokenUsage").cloned();
                Vec::new()
            }
            "error" => params
                .pointer("/error/message")
                .and_then(Value::as_str)
                .map(|message| vec![json!({ "type": "error", "message": message })])
                .unwrap_or_default(),
            "turn/completed" => {
                let mut line = Map::from_iter([(
                    "type".to_string(),
                    Value::String("turn.completed".to_string()),
                )]);
                if let Some(usage) = self.last_usage.as_ref().and_then(app_server_usage) {
                    line.insert("usage".to_string(), usage);
                }
                vec![Value::Object(line)]
            }
            _ => Vec::new(),
        }
    }
}

/// `ThreadTokenUsage.last` is one model request; `total` is every request the
/// app-server has made. Argmax runs one app-server per turn, so `total` at
/// `turn/completed` is exactly this turn's usage — reading `last` billed only
/// the final request of a multi-step turn.
fn app_server_usage(usage: &Value) -> Option<Value> {
    let usage = usage.get("total")?;
    Some(json!({
        "input_tokens": usage.get("inputTokens")?.as_u64()?,
        "cached_input_tokens": usage.get("cachedInputTokens")?.as_u64()?,
        "output_tokens": usage.get("outputTokens")?.as_u64()?,
    }))
}

fn exec_item(item: &Value) -> Value {
    let mut converted = snake_case_value(item);
    let Some(object) = converted.as_object_mut() else {
        return converted;
    };
    if let Some(item_type) = object.get("type").and_then(Value::as_str) {
        let item_type = match item_type {
            // `codex exec --json` predates the app-server spelling. The shared
            // normalizer uses this legacy value to recognize native agents.
            "collabAgentToolCall" => "collab_tool_call".to_string(),
            item_type => snake_case(item_type),
        };
        object.insert("type".to_string(), Value::String(item_type));
    }
    if object.get("type").and_then(Value::as_str) == Some("reasoning") {
        let text = ["summary", "content"]
            .iter()
            .filter_map(|key| object.get(*key).and_then(Value::as_array))
            .flatten()
            .filter_map(Value::as_str)
            .collect::<Vec<_>>()
            .join("\n");
        object.insert("text".to_string(), Value::String(text));
    }
    converted
}

fn snake_case_value(value: &Value) -> Value {
    match value {
        Value::Object(fields) => Value::Object(
            fields
                .iter()
                .map(|(key, value)| {
                    let value = match key.as_str() {
                        // These are provider/tool-owned JSON maps. Their keys
                        // are opaque data, not app-server field names.
                        "arguments" | "structuredContent" | "_meta" => value.clone(),
                        // Thread ids are opaque map keys. Normalize each state
                        // record, while preserving the ids byte-for-byte.
                        "agentsStates" => preserve_map_keys(value),
                        _ => snake_case_value(value),
                    };
                    let key = snake_case(key);
                    let value = if matches!(key.as_str(), "status" | "tool") {
                        value
                            .as_str()
                            .map(|value| Value::String(snake_case(value)))
                            .unwrap_or(value)
                    } else {
                        value
                    };
                    (key, value)
                })
                .collect(),
        ),
        Value::Array(values) => Value::Array(values.iter().map(snake_case_value).collect()),
        other => other.clone(),
    }
}

fn preserve_map_keys(value: &Value) -> Value {
    let Some(fields) = value.as_object() else {
        return value.clone();
    };
    Value::Object(
        fields
            .iter()
            .map(|(key, value)| (key.clone(), snake_case_value(value)))
            .collect(),
    )
}

fn snake_case(value: &str) -> String {
    let mut out = String::with_capacity(value.len() + 4);
    for (index, character) in value.chars().enumerate() {
        if character.is_ascii_uppercase() {
            if index > 0 {
                out.push('_');
            }
            out.push(character.to_ascii_lowercase());
        } else {
            out.push(character);
        }
    }
    out
}

fn emit_line(on_event: &EventCallback, session_id: &str, line: Value) {
    emit(
        on_event,
        session_id,
        ProviderRuntimeEventType::Output,
        ProviderOutputStream::Stdout,
        format!("{line}\n"),
        None,
    );
}

fn emit(
    on_event: &EventCallback,
    session_id: &str,
    r#type: ProviderRuntimeEventType,
    stream: ProviderOutputStream,
    message: String,
    exit_code: Option<i32>,
) {
    on_event(ProviderRuntimeEvent {
        session_id: session_id.to_string(),
        r#type,
        stream,
        message,
        exit_code,
        created_at: now_iso(),
    });
}

/// Native child threads share the app-server transport, but not the parent's
/// transcript or token counters. Keep them alive until their work settles.
struct TurnScope {
    thread_id: String,
    turn_id: String,
    children: HashSet<String>,
    running_children: HashSet<String>,
    early_terminal_children: HashSet<String>,
}
impl TurnScope {
    fn new(thread_id: &str, turn_id: &str) -> Self {
        Self {
            thread_id: thread_id.into(),
            turn_id: turn_id.into(),
            children: HashSet::new(),
            running_children: HashSet::new(),
            early_terminal_children: HashSet::new(),
        }
    }
    fn observe(&mut self, method: &str, params: &Value) -> bool {
        let Some(thread_id) = params.get("threadId").and_then(Value::as_str) else {
            return false;
        };
        let root = thread_id == self.thread_id;
        let turn_id = params
            .get("turnId")
            .and_then(Value::as_str)
            .or_else(|| params.pointer("/turn/id").and_then(Value::as_str));
        if root && turn_id.is_some_and(|id| id != self.turn_id) {
            return false;
        }
        if !root && !self.children.contains(thread_id) {
            // Child notifications can outrun the parent's spawn completion on
            // the shared connection. Remember terminal activity so a stale
            // `pendingInit` snapshot cannot make root completion wait forever.
            if method == "turn/completed"
                || matches!(
                    params.pointer("/status/type").and_then(Value::as_str),
                    Some("idle" | "systemError" | "notLoaded")
                )
            {
                self.early_terminal_children.insert(thread_id.to_string());
            }
            return false;
        }
        if let Some(item) = params
            .get("item")
            .filter(|item| item.get("type").and_then(Value::as_str) == Some("collabAgentToolCall"))
        {
            if let Some(ids) = item.get("receiverThreadIds").and_then(Value::as_array) {
                for id in ids.iter().filter_map(Value::as_str) {
                    if id == self.thread_id {
                        continue;
                    }
                    self.children.insert(id.to_string());
                    if self.early_terminal_children.remove(id) {
                        self.running_children.remove(id);
                        continue;
                    }
                    let state = item
                        .get("agentsStates")
                        .and_then(|states| states.get(id))
                        .and_then(|state| state.get("status"))
                        .and_then(Value::as_str);
                    match state {
                        Some("pendingInit" | "running") => {
                            self.running_children.insert(id.to_string());
                        }
                        Some("completed" | "errored" | "shutdown" | "notFound" | "interrupted") => {
                            self.running_children.remove(id);
                        }
                        _ if matches!(
                            item.get("tool").and_then(Value::as_str),
                            Some("spawnAgent" | "sendInput" | "resumeAgent")
                        ) =>
                        {
                            self.running_children.insert(id.to_string());
                        }
                        _ => {}
                    }
                }
            }
        }
        if !root {
            match method {
                "turn/started" => {
                    self.running_children.insert(thread_id.to_string());
                }
                "turn/completed" => {
                    self.running_children.remove(thread_id);
                }
                "thread/status/changed" => {
                    match params.pointer("/status/type").and_then(Value::as_str) {
                        Some("active") => {
                            self.running_children.insert(thread_id.to_string());
                        }
                        Some("idle" | "systemError" | "notLoaded") => {
                            self.running_children.remove(thread_id);
                        }
                        _ => {}
                    }
                }
                _ => {}
            }
        }
        root
    }
}

struct CodexTurnHandle {
    cancel: watch::Sender<bool>,
    disposed: AtomicBool,
    done_rx: watch::Receiver<bool>,
}

impl ProviderRuntimeHandle for CodexTurnHandle {
    fn accepts_input(&self) -> bool {
        false
    }

    fn disposed(&self) -> bool {
        self.disposed.load(Ordering::SeqCst)
    }

    fn send_input(&self, _input: &str) {}

    fn resize(&self, _cols: u16, _rows: u16) {}

    fn terminate<'a>(&'a self) -> BoxFuture<'a, ArgmaxResult<()>> {
        Box::pin(async move {
            self.disposed.store(true, Ordering::SeqCst);
            let mut done_rx = self.done_rx.clone();
            if *done_rx.borrow() {
                return Ok(());
            }
            let _ = self.cancel.send(true);
            tokio::time::timeout(CANCEL_TIMEOUT, done_rx.wait_for(|done| *done))
                .await
                .map_err(|_| {
                    ArgmaxError::service(
                        "CODEX_APP_SERVER_CANCEL_TIMEOUT",
                        "Timed out waiting for the cancelled Codex turn to stop",
                    )
                })?
                .map_err(|_| {
                    ArgmaxError::service(
                        "CODEX_APP_SERVER_CLOSED",
                        "Codex turn closed before cancellation completed",
                    )
                })?;
            Ok(())
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::persistence::database::Database;
    use crate::providers::ReasoningEffort;

    fn input(permission_mode: PermissionMode) -> ProviderLaunchInput {
        ProviderLaunchInput {
            provider: ProviderId::Codex,
            session_id: "session-1".to_string(),
            workspace_path: "/tmp/project".into(),
            prompt: "Do the work".to_string(),
            model_label: "Astra".to_string(),
            model_id: "gpt-6-astra".to_string(),
            reasoning_effort: Some(ReasoningEffort::Ultra),
            fast_mode: true,
            resume_conversation_id: None,
            resume_fork: false,
            permission_mode,
            agent_mode: AgentMode::Auto,
            cols: 80,
            rows: 24,
        }
    }

    /// `last` is the final model request of the turn; a turn that ran three of
    /// them reported a third of what it spent, and the resumed turn after it
    /// almost nothing.
    #[test]
    fn turn_usage_comes_from_the_threads_total_not_its_last_request() {
        let usage = json!({
            "last": { "inputTokens": 22662, "cachedInputTokens": 22016, "outputTokens": 5 },
            "total": { "inputTokens": 67329, "cachedInputTokens": 44288, "outputTokens": 319 },
        });
        assert_eq!(
            app_server_usage(&usage).expect("usage"),
            json!({
                "input_tokens": 67329,
                "cached_input_tokens": 44288,
                "output_tokens": 319,
            })
        );
        assert!(app_server_usage(&json!({ "last": { "inputTokens": 1 } })).is_none());
    }

    #[test]
    fn permission_modes_use_the_documented_app_server_policies() {
        let defaults = thread_params(&input(PermissionMode::ProviderDefaults), None);
        assert!(defaults.get("approvalPolicy").is_none());
        assert!(defaults.get("sandbox").is_none());
        assert!(defaults.get("approvalsReviewer").is_none());

        let ask = thread_params(&input(PermissionMode::AskEachTime), None);
        assert_eq!(ask["approvalPolicy"], "on-request");
        assert_eq!(ask["sandbox"], "workspace-write");
        assert_eq!(ask["approvalsReviewer"], "user");

        let full = thread_params(&input(PermissionMode::AutoApprove), None);
        assert_eq!(full["approvalPolicy"], "never");
        assert_eq!(full["sandbox"], "danger-full-access");
    }

    #[test]
    fn turn_keeps_model_effort_fast_tier_and_working_directory() {
        let input = input(PermissionMode::ProviderDefaults);
        let params = turn_params(&input, "thread-1", input.prompt.clone());
        assert_eq!(params["threadId"], "thread-1");
        assert_eq!(params["cwd"], "/tmp/project");
        assert_eq!(params["model"], "gpt-6-astra");
        assert_eq!(params["effort"], "ultra");
        assert_eq!(params["serviceTier"], "priority");
        assert_eq!(params["input"][0]["text"], "Do the work");
    }

    #[test]
    fn app_server_items_translate_to_existing_codex_exec_shape() {
        let mut translation = EventTranslation::default();
        let started = translation.translate(
            "item/started",
            &json!({
                "threadId": "thread-1",
                "turnId": "turn-1",
                "item": {
                    "id": "cmd-1",
                    "type": "commandExecution",
                    "command": "cargo test",
                    "cwd": "/tmp/project",
                    "status": "inProgress",
                }
            }),
        );
        assert_eq!(started[0]["type"], "item.started");
        assert_eq!(started[0]["item"]["type"], "command_execution");
        assert_eq!(started[0]["item"]["status"], "in_progress");

        let message = translation.translate(
            "item/completed",
            &json!({ "item": { "id": "msg-1", "type": "agentMessage", "text": "Done" } }),
        );
        assert_eq!(message[0]["item"]["type"], "agent_message");
        assert_eq!(message[0]["item"]["text"], "Done");

        let dynamic_tool = translation.translate(
            "item/completed",
            &json!({
                "item": {
                    "id": "tool-1",
                    "type": "dynamicToolCall",
                    "tool": "customTool",
                    "arguments": { "userCamelCase": 1 },
                    "result": {
                        "structuredContent": { "providerCamelCase": true },
                        "_meta": { "opaqueKeyName": "kept" }
                    }
                }
            }),
        );
        assert_eq!(dynamic_tool[0]["item"]["arguments"]["userCamelCase"], 1);
        assert_eq!(
            dynamic_tool[0]["item"]["result"]["structured_content"]["providerCamelCase"],
            true
        );
        assert_eq!(
            dynamic_tool[0]["item"]["result"]["_meta"]["opaqueKeyName"],
            "kept"
        );
    }

    #[test]
    fn collab_items_keep_opaque_thread_ids_and_reach_native_agent_normalization() {
        use crate::providers::normalizer::{
            normalize_provider_event, NormalizerSessionContext, ProviderOutputEvent,
        };

        let mut translation = EventTranslation::default();
        let child_id = "ChildThread-ABC";
        let translated = translation.translate(
            "item/completed",
            &json!({
                "threadId": "thread-1",
                "turnId": "turn-1",
                "item": {
                    "id": "spawn-1",
                    "type": "collabAgentToolCall",
                    "tool": "spawnAgent",
                    "status": "completed",
                    "senderThreadId": "thread-1",
                    "receiverThreadIds": [child_id],
                    "agentsStates": {
                        "ChildThread-ABC": { "status": "running", "message": null }
                    }
                }
            }),
        );
        assert_eq!(translated[0]["item"]["type"], "collab_tool_call");
        assert_eq!(
            translated[0]["item"]["agents_states"][child_id]["status"],
            "running"
        );

        let event = ProviderOutputEvent {
            session_id: "session-1".to_string(),
            stream: ProviderOutputStream::Stdout,
            message: format!("{}\n", translated[0]),
            created_at: "2026-09-07T12:00:00Z".to_string(),
        };
        let normalized = normalize_provider_event(
            ProviderId::Codex,
            &event,
            &mut NormalizerSessionContext::default(),
        );
        assert!(normalized.events.iter().any(|event| {
            event.r#type == "agent.started" && event.payload["providerChildSessionId"] == child_id
        }));
    }

    #[test]
    fn turn_scope_handles_child_completion_before_parent_declaration() {
        let mut scope = TurnScope::new("thread-1", "turn-1");
        assert!(!scope.observe(
            "turn/completed",
            &json!({
                "threadId": "child-1",
                "turn": { "id": "child-turn-1", "status": "completed", "items": [] }
            }),
        ));
        assert!(scope.observe(
            "item/completed",
            &json!({
                "threadId": "thread-1",
                "turnId": "turn-1",
                "item": {
                    "type": "collabAgentToolCall",
                    "tool": "spawnAgent",
                    "receiverThreadIds": ["child-1"],
                    "agentsStates": { "child-1": { "status": "pendingInit" } }
                }
            }),
        ));
        assert!(scope.children.contains("child-1"));
        assert!(scope.running_children.is_empty());

        assert!(!scope.observe(
            "turn/started",
            &json!({
                "threadId": "child-1",
                "turn": { "id": "child-turn-2", "status": "inProgress", "items": [] }
            }),
        ));
        assert!(scope.running_children.contains("child-1"));
        assert!(!scope.observe(
            "item/completed",
            &json!({
                "threadId": "thread-1",
                "turnId": "stale-turn",
                "item": { "type": "agentMessage", "text": "stale" }
            }),
        ));
    }

    #[derive(Default)]
    struct FakeApproval {
        calls: Mutex<Vec<(String, String, String)>>,
        allow: bool,
    }

    impl NativeApprovalBroker for FakeApproval {
        fn request<'a>(
            &'a self,
            _session_id: &'a str,
            _invocation_id: &'a str,
            request_id: &'a str,
            command: &'a str,
            cwd: &'a str,
        ) -> BoxFuture<'a, ArgmaxResult<bool>> {
            self.calls.lock().unwrap().push((
                request_id.to_string(),
                command.to_string(),
                cwd.to_string(),
            ));
            Box::pin(async move { Ok(self.allow) })
        }
    }

    #[tokio::test]
    async fn command_approval_roundtrip_returns_the_users_decision() {
        let approvals = FakeApproval {
            allow: true,
            ..FakeApproval::default()
        };
        let response = server_request_response(
            &json!({
                "jsonrpc": "2.0",
                "id": 50,
                "method": "item/commandExecution/requestApproval",
                "params": {
                    "threadId": "thread-1",
                    "turnId": "turn-1",
                    "itemId": "cmd-1",
                    "command": "rm -rf /tmp/build",
                    "cwd": "/tmp/project",
                }
            }),
            &approvals,
            "session-1",
            "invocation-1",
            "thread-1",
            "turn-1",
        )
        .await;
        assert_eq!(response["id"], 50);
        assert_eq!(response["result"]["decision"], "accept");
        assert_eq!(
            approvals.calls.lock().unwrap().as_slice(),
            &[(
                "50".to_string(),
                "rm -rf /tmp/build".to_string(),
                "/tmp/project".to_string(),
            )]
        );
    }

    #[tokio::test]
    async fn owned_child_approval_is_answered_but_a_stale_root_turn_is_rejected() {
        let approvals = FakeApproval {
            allow: true,
            ..FakeApproval::default()
        };
        let child_response = server_request_response(
            &json!({
                "id": "child-request",
                "method": "item/commandExecution/requestApproval",
                "params": {
                    "threadId": "child-1",
                    "turnId": "child-turn-1",
                    "command": ["cargo", "test"],
                    "cwd": "/tmp/project"
                }
            }),
            &approvals,
            "session-1",
            "invocation-1",
            "thread-1",
            "turn-1",
        )
        .await;
        assert_eq!(child_response["result"]["decision"], "accept");
        assert_eq!(approvals.calls.lock().unwrap().len(), 1);

        let stale_root_response = server_request_response(
            &json!({
                "id": "stale-root-request",
                "method": "item/fileChange/requestApproval",
                "params": {
                    "threadId": "thread-1",
                    "turnId": "old-turn",
                    "cwd": "/tmp/project"
                }
            }),
            &approvals,
            "session-1",
            "invocation-1",
            "thread-1",
            "turn-1",
        )
        .await;
        assert_eq!(stale_root_response["error"]["code"], -32602);
        assert_eq!(approvals.calls.lock().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn permission_profile_grants_are_turn_scoped_and_reject_grants_nothing() {
        let permissions =
            json!({"network":{"enabled":true},"fileSystem":{"write":["/tmp/project"]}});
        for allow in [false, true] {
            let approvals = FakeApproval {
                allow,
                ..FakeApproval::default()
            };
            let response = server_request_response(&json!({"id":"permission-1","method":"item/permissions/requestApproval","params":{"threadId":"thread-1","turnId":"turn-1","permissions":permissions,"cwd":"/tmp/project"}}), &approvals, "session-1", "invocation-1", "thread-1", "turn-1").await;
            assert_eq!(response["id"], "permission-1");
            assert_eq!(response["result"]["scope"], "turn");
            assert_eq!(
                response["result"]["permissions"],
                if allow {
                    permissions.clone()
                } else {
                    json!({})
                }
            );
            assert!(approvals.calls.lock().unwrap()[0]
                .1
                .contains("current turn only"));
        }
    }

    #[tokio::test]
    async fn unsupported_server_request_gets_an_immediate_rpc_error() {
        let approvals = FakeApproval::default();
        let response = server_request_response(
            &json!({
                "jsonrpc": "2.0",
                "id": "question-1",
                "method": "item/tool/requestUserInput",
                "params": { "threadId": "thread-1" },
            }),
            &approvals,
            "session-1",
            "invocation-1",
            "thread-1",
            "turn-1",
        )
        .await;
        assert_eq!(response["id"], "question-1");
        assert_eq!(response["error"]["code"], -32601);
        assert!(approvals.calls.lock().unwrap().is_empty());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn fake_app_server_process_completes_a_translated_turn() {
        use std::fs;
        use std::os::unix::fs::PermissionsExt;

        let temp = tempfile::tempdir().unwrap();
        let server = temp.path().join("fake-codex-app-server");
        fs::write(
            &server,
            r#"#!/bin/sh
while IFS= read -r line; do
  case "$line" in
    *'"method":"initialize"'*)
      printf '%s\n' '{"jsonrpc":"2.0","id":1,"result":{"codexHome":"/tmp/codex","platformFamily":"unix","platformOs":"test","userAgent":"fake"}}'
      ;;
    *'"method":"thread/start"'*)
      printf '%s\n' '{"jsonrpc":"2.0","id":2,"result":{"thread":{"id":"thread-1"},"model":"gpt-6-astra","modelProvider":"openai","cwd":"/tmp/project","approvalPolicy":"on-request","approvalsReviewer":"user","sandbox":{"type":"workspaceWrite"}}}'
      ;;
    *'"method":"turn/start"'*)
      printf '%s\n' '{"jsonrpc":"2.0","id":3,"result":{"turn":{"id":"turn-1","status":"inProgress","items":[]}}}'
      printf '%s\n' '{"jsonrpc":"2.0","method":"turn/started","params":{"threadId":"thread-1","turn":{"id":"turn-1","status":"inProgress","items":[]}}}'
      printf '%s\n' '{"jsonrpc":"2.0","method":"item/completed","params":{"threadId":"thread-1","turnId":"turn-1","completedAtMs":1,"item":{"id":"message-1","type":"agentMessage","text":"Finished from fake server"}}}'
      printf '%s\n' '{"jsonrpc":"2.0","method":"item/completed","params":{"threadId":"thread-1","turnId":"turn-1","completedAtMs":2,"item":{"id":"spawn-1","type":"collabAgentToolCall","tool":"spawnAgent","status":"completed","senderThreadId":"thread-1","receiverThreadIds":["child-1"],"agentsStates":{"child-1":{"status":"running","message":null}}}}}'
      printf '%s\n' '{"jsonrpc":"2.0","method":"item/completed","params":{"threadId":"child-1","turnId":"child-turn-1","completedAtMs":3,"item":{"id":"child-message","type":"agentMessage","text":"CHILD TEXT MUST NOT LEAK"}}}'
      printf '%s\n' '{"jsonrpc":"2.0","method":"turn/completed","params":{"threadId":"thread-1","turn":{"id":"turn-1","status":"completed","items":[]}}}'
      sleep 0.1
      printf '%s\n' '{"jsonrpc":"2.0","method":"turn/completed","params":{"threadId":"child-1","turn":{"id":"child-turn-1","status":"completed","items":[]}}}'
      ;;
  esac
done
"#,
        )
        .unwrap();
        fs::set_permissions(&server, fs::Permissions::from_mode(0o755)).unwrap();

        let database = Arc::new(Database::open(temp.path().join("argmax.sqlite")).unwrap());
        let approvals = ApprovalService::new(database);
        let events = Arc::new(Mutex::new(Vec::new()));
        let captured = Arc::clone(&events);
        let callback: EventCallback = Arc::new(move |event| {
            captured.lock().unwrap().push(event);
        });
        let mut launch_input = input(PermissionMode::ProviderDefaults);
        launch_input.workspace_path = temp.path().to_path_buf();
        let _handle = launch_turn(
            server.to_str().unwrap(),
            &launch_input,
            None,
            approvals,
            callback,
        )
        .await
        .unwrap();

        tokio::time::timeout(Duration::from_secs(2), async {
            loop {
                if events
                    .lock()
                    .unwrap()
                    .iter()
                    .any(|event| event.r#type == ProviderRuntimeEventType::Exit)
                {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("fake turn completed");

        let events = events.lock().unwrap();
        assert!(events.iter().any(|event| {
            event.message.contains("\"type\":\"thread.started\"")
                && event.message.contains("thread-1")
        }));
        assert!(events.iter().any(|event| {
            event.message.contains("Finished from fake server")
                && event.message.contains("agent_message")
        }));
        assert!(!events
            .iter()
            .any(|event| event.message.contains("CHILD TEXT MUST NOT LEAK")));
        assert_eq!(
            events.last().map(|event| (event.r#type, event.exit_code)),
            Some((ProviderRuntimeEventType::Exit, Some(0)))
        );
    }
}
