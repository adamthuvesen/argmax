//! Grok Build launches over ACP (`grok agent stdio`).
//!
//! Grok 1.0.13 advertises ACP v1 session load, list, resume, and close. Argmax
//! leaves filesystem and terminal client capabilities disabled so Grok keeps
//! owning its tool execution. Only native permission requests cross back into
//! Argmax for a decision.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
use std::time::Duration;

use serde_json::{json, Value};
use tokio::sync::watch;
use uuid::Uuid;

use super::acp::{AcpClient, AcpPermissionDecision, AcpPermissionHandler, AcpPermissionRequest};
use super::environment::build_provider_environment;
use super::normalizer::ProviderOutputStream;
use super::runtime::{
    BoxFuture, EventCallback, ProviderRuntimeEvent, ProviderRuntimeEventType, ProviderRuntimeHandle,
};
use super::{
    mcp_injection, AgentMode, PermissionMode, ProviderId, ProviderLaunchInput, ReasoningEffort,
};
use crate::approvals::service::ApprovalService;
use crate::error::{ArgmaxError, ArgmaxResult};
use crate::persistence::time::now_iso;
use crate::session_control::SessionLaunchProcessConfig;
use crate::util::sync::LockOrRecover;

const CANCEL_WAIT: Duration = Duration::from_secs(5);

pub fn is_acp_eligible(input: &ProviderLaunchInput) -> bool {
    input.provider == ProviderId::Grok && !input.resume_fork
}

type PermissionContexts = Arc<Mutex<HashMap<String, GrokPermissionContext>>>;

#[derive(Clone)]
struct GrokPermissionContext {
    argmax_session_id: String,
    invocation_id: String,
    cwd: String,
    permission_mode: PermissionMode,
    approvals: Option<Arc<ApprovalService>>,
}

#[derive(Default)]
pub struct GrokAcpSessions {
    workspaces: tokio::sync::Mutex<HashMap<(PathBuf, GrokProcessMode), Arc<GrokWorkspaceSlot>>>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
enum GrokProcessMode {
    ProviderDefaults,
    AskEachTime,
    AutoApprove,
    Plan,
}

fn grok_process_mode(input: &ProviderLaunchInput) -> GrokProcessMode {
    if input.agent_mode == AgentMode::Plan {
        return GrokProcessMode::Plan;
    }
    match input.permission_mode {
        PermissionMode::ProviderDefaults => GrokProcessMode::ProviderDefaults,
        PermissionMode::AskEachTime => GrokProcessMode::AskEachTime,
        PermissionMode::AutoApprove => GrokProcessMode::AutoApprove,
    }
}

fn grok_process_arguments(mode: GrokProcessMode) -> &'static [&'static str] {
    match mode {
        GrokProcessMode::ProviderDefaults => &["agent", "stdio"],
        GrokProcessMode::AskEachTime => &["--permission-mode", "default", "agent", "stdio"],
        GrokProcessMode::AutoApprove => {
            &["--permission-mode", "bypassPermissions", "agent", "stdio"]
        }
        GrokProcessMode::Plan => &["--permission-mode", "plan", "agent", "stdio"],
    }
}

/// One process slot per workspace and launch policy. The pool map is only held
/// long enough to find this slot; a slow initialize handshake must not block
/// launches or shutdown for every other workspace.
#[derive(Default)]
struct GrokWorkspaceSlot {
    boot: tokio::sync::Mutex<()>,
    current: Mutex<Option<Arc<GrokWorkspace>>>,
}

struct GrokWorkspace {
    client: Arc<AcpClient>,
    boot: tokio::sync::Mutex<()>,
    permission_contexts: PermissionContexts,
    active_sessions: Mutex<HashSet<String>>,
}

impl GrokAcpSessions {
    pub fn new() -> Self {
        Self::default()
    }

    pub async fn launch_turn(
        &self,
        binary_path: &str,
        input: &ProviderLaunchInput,
        session_launch: Option<&SessionLaunchProcessConfig>,
        approvals: Option<Arc<ApprovalService>>,
        on_event: EventCallback,
    ) -> ArgmaxResult<Arc<dyn ProviderRuntimeHandle>> {
        let workspace = self.workspace_client(binary_path, input).await?;
        let _boot = workspace.boot.lock().await;
        let mcp_servers = mcp_injection::acp_mcp_servers(session_launch);
        let response = match input.resume_conversation_id.as_deref() {
            Some(session_id) => {
                let is_active = workspace
                    .active_sessions
                    .lock_or_recover("Grok active ACP sessions")
                    .contains(session_id);
                let method = if is_active {
                    "session/resume"
                } else {
                    let mut cursor: Option<String> = None;
                    let mut cursors = std::collections::HashSet::new();
                    let exists = loop {
                        let mut params = json!({"cwd": input.workspace_path});
                        if let Some(cursor) = cursor.as_ref() {
                            params["cursor"] = json!(cursor);
                        }
                        let listed = workspace.client.request("session/list", params).await?;
                        if listed
                            .get("sessions")
                            .and_then(Value::as_array)
                            .is_some_and(|sessions| {
                                sessions.iter().any(|session| {
                                    session.get("sessionId").and_then(Value::as_str)
                                        == Some(session_id)
                                })
                            })
                        {
                            break true;
                        }
                        cursor = listed
                            .get("nextCursor")
                            .and_then(Value::as_str)
                            .map(str::to_string);
                        match cursor.as_ref() {
                            None => break false,
                            Some(cursor) if !cursors.insert(cursor.clone()) => {
                                return Err(ArgmaxError::service(
                                    "ACP_SESSION_LIST_INVALID",
                                    "Grok returned a repeated session-list cursor",
                                ))
                            }
                            Some(_) => {}
                        }
                    };
                    if !exists {
                        return Err(ArgmaxError::service(
                            "ACP_SESSION_UNAVAILABLE",
                            format!("Grok ACP did not list session {session_id}"),
                        ));
                    }
                    "session/load"
                };
                workspace
                    .client
                    .request(
                        method,
                        json!({
                            "sessionId": session_id,
                            "cwd": input.workspace_path,
                            "mcpServers": mcp_servers,
                        }),
                    )
                    .await?
            }
            None => {
                workspace
                    .client
                    .request(
                        "session/new",
                        json!({ "cwd": input.workspace_path, "mcpServers": mcp_servers }),
                    )
                    .await?
            }
        };
        let acp_session_id = response
            .get("sessionId")
            .and_then(Value::as_str)
            .or(input.resume_conversation_id.as_deref())
            .ok_or_else(|| ArgmaxError::service("ACP_PROTOCOL", "Grok returned no sessionId"))?
            .to_string();
        workspace
            .active_sessions
            .lock_or_recover("Grok active ACP sessions")
            .insert(acp_session_id.clone());

        select_grok_model(&workspace.client, &acp_session_id, input, &response).await?;
        let invocation_id = Uuid::new_v4().to_string();
        workspace
            .permission_contexts
            .lock_or_recover("Grok ACP permission contexts")
            .insert(
                acp_session_id.clone(),
                GrokPermissionContext {
                    argmax_session_id: input.session_id.clone(),
                    invocation_id: invocation_id.clone(),
                    cwd: input.workspace_path.to_string_lossy().into_owned(),
                    permission_mode: input.permission_mode,
                    approvals,
                },
            );
        Ok(spawn_turn(
            Arc::clone(&workspace.client),
            acp_session_id,
            invocation_id,
            Arc::clone(&workspace.permission_contexts),
            input,
            on_event,
        ))
    }

    async fn workspace_client(
        &self,
        binary_path: &str,
        input: &ProviderLaunchInput,
    ) -> ArgmaxResult<Arc<GrokWorkspace>> {
        let mode = grok_process_mode(input);
        let slot = {
            let mut workspaces = self.workspaces.lock().await;
            let key = (input.workspace_path.clone(), mode);
            Arc::clone(
                workspaces
                    .entry(key)
                    .or_insert_with(|| Arc::new(GrokWorkspaceSlot::default())),
            )
        };
        let _boot = slot.boot.lock().await;
        if let Some(existing) = slot.current.lock_or_recover("Grok ACP workspace").clone() {
            if !existing.client.is_dead() {
                return Ok(existing);
            }
        }
        let permission_contexts = Arc::new(Mutex::new(HashMap::new()));
        let client = AcpClient::spawn(
            binary_path,
            grok_process_arguments(mode),
            &input.workspace_path,
            build_provider_environment([("NO_COLOR".to_string(), "1".to_string())]),
            Some(grok_permission_handler(Arc::clone(&permission_contexts))),
        )?;
        let workspace = Arc::new(GrokWorkspace {
            client,
            boot: tokio::sync::Mutex::new(()),
            permission_contexts,
            active_sessions: Mutex::new(HashSet::new()),
        });
        // Publish before initialize so app shutdown can kill a child whose
        // handshake has stalled.
        *slot.current.lock_or_recover("Grok ACP workspace") = Some(Arc::clone(&workspace));
        let initialize = workspace
            .client
            .request(
                "initialize",
                json!({
                    "protocolVersion": 1,
                    "clientCapabilities": {
                        "fs": { "readTextFile": false, "writeTextFile": false },
                        "terminal": false
                    },
                    "clientInfo": { "name": "argmax", "version": env!("CARGO_PKG_VERSION") },
                }),
            )
            .await;
        if let Err(error) = initialize {
            workspace.client.kill();
            slot.current.lock_or_recover("Grok ACP workspace").take();
            return Err(error);
        }
        Ok(workspace)
    }

    pub async fn evict(&self, workspace_path: &Path) {
        let slots: Vec<_> = {
            let mut pool = self.workspaces.lock().await;
            let keys: Vec<_> = pool
                .keys()
                .filter(|(path, _)| path == workspace_path)
                .cloned()
                .collect();
            keys.into_iter()
                .filter_map(|key| pool.remove(&key))
                .collect()
        };
        for slot in slots {
            let workspace = slot.current.lock_or_recover("Grok ACP workspace").take();
            let Some(workspace) = workspace else {
                continue;
            };
            let session_ids: Vec<_> = workspace
                .active_sessions
                .lock_or_recover("Grok active ACP sessions")
                .drain()
                .collect();
            for session_id in session_ids {
                let _ = workspace
                    .client
                    .request("session/close", json!({ "sessionId": session_id }))
                    .await;
            }
            workspace.client.kill();
        }
    }

    pub fn kill_all_blocking(&self) {
        for (_, slot) in self.workspaces.blocking_lock().drain() {
            if let Some(workspace) = slot.current.lock_or_recover("Grok ACP workspace").take() {
                workspace.client.kill();
            }
        }
    }
}

async fn select_grok_model(
    client: &AcpClient,
    session_id: &str,
    input: &ProviderLaunchInput,
    response: &Value,
) -> ArgmaxResult<()> {
    let exact_model = response
        .pointer("/models/availableModels")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|model| model.get("modelId").and_then(Value::as_str))
        .find(|model_id| *model_id == input.model_id)
        .ok_or_else(|| {
            ArgmaxError::service(
                "ACP_MODEL_UNAVAILABLE",
                format!("Grok ACP does not advertise model {}", input.model_id),
            )
        })?;
    client
        .request(
            "session/set_model",
            json!({ "sessionId": session_id, "modelId": exact_model }),
        )
        .await?;
    if let Some(effort) = input.reasoning_effort {
        // Grok 1.0.13 exposes its reasoning levels through ACP's mode slot.
        client
            .request(
                "session/set_mode",
                json!({ "sessionId": session_id, "modeId": grok_effort(effort) }),
            )
            .await?;
    }
    Ok(())
}

fn grok_effort(effort: ReasoningEffort) -> &'static str {
    match effort {
        ReasoningEffort::Low => "low",
        ReasoningEffort::Medium => "medium",
        ReasoningEffort::High => "high",
        ReasoningEffort::Xhigh | ReasoningEffort::Max | ReasoningEffort::Ultra => "xhigh",
    }
}

fn grok_permission_handler(contexts: PermissionContexts) -> AcpPermissionHandler {
    Arc::new(move |request: AcpPermissionRequest| {
        let context = request
            .params
            .get("sessionId")
            .and_then(Value::as_str)
            .and_then(|session_id| {
                contexts
                    .lock_or_recover("Grok ACP permission contexts")
                    .get(session_id)
                    .cloned()
            });
        Box::pin(async move {
            let Some(context) = context else {
                return AcpPermissionDecision::Cancelled;
            };
            if context.permission_mode == PermissionMode::AutoApprove {
                return AcpPermissionDecision::Allow;
            }
            let Some(approvals) = context.approvals else {
                return AcpPermissionDecision::Cancelled;
            };
            let command = grok_permission_command(&request.params);
            let request_id = request.request_id.to_string();
            let cwd = request
                .params
                .pointer("/toolCall/rawInput/cwd")
                .and_then(Value::as_str)
                .unwrap_or(&context.cwd);
            match approvals
                .request_native(
                    &context.argmax_session_id,
                    &context.invocation_id,
                    &request_id,
                    &command,
                    cwd,
                    "grok",
                )
                .await
            {
                Ok(true) => AcpPermissionDecision::Allow,
                Ok(false) => AcpPermissionDecision::Reject,
                Err(_) => AcpPermissionDecision::Cancelled,
            }
        })
    })
}

fn grok_permission_command(params: &Value) -> String {
    params
        .pointer("/toolCall/rawInput/command")
        .and_then(Value::as_str)
        .or_else(|| params.pointer("/toolCall/title").and_then(Value::as_str))
        .unwrap_or("Grok tool request")
        .to_string()
}

fn spawn_turn(
    client: Arc<AcpClient>,
    acp_session_id: String,
    invocation_id: String,
    permission_contexts: PermissionContexts,
    input: &ProviderLaunchInput,
    on_event: EventCallback,
) -> Arc<dyn ProviderRuntimeHandle> {
    let (done_tx, done_rx) = watch::channel(false);
    let handle = Arc::new(GrokTurnHandle {
        client: Arc::clone(&client),
        acp_session_id: acp_session_id.clone(),
        disposed: AtomicBool::new(false),
        done_rx,
    });
    let session_id = input.session_id.clone();
    let prompt = input.prompt.clone();
    let model_id = input.model_id.clone();
    tokio::spawn(async move {
        run_turn(
            Arc::clone(&client),
            acp_session_id.clone(),
            session_id,
            prompt,
            model_id,
            on_event,
        )
        .await;
        let mut contexts = permission_contexts.lock_or_recover("Grok ACP permission contexts");
        if contexts
            .get(&acp_session_id)
            .is_some_and(|context| context.invocation_id == invocation_id)
        {
            contexts.remove(&acp_session_id);
        }
        let _ = done_tx.send(true);
    });
    handle
}

async fn run_turn(
    client: Arc<AcpClient>,
    acp_session_id: String,
    session_id: String,
    prompt: String,
    model_id: String,
    on_event: EventCallback,
) {
    let emit = |r#type: ProviderRuntimeEventType, message: String, exit_code: Option<i32>| {
        on_event(ProviderRuntimeEvent {
            session_id: session_id.clone(),
            r#type,
            stream: if r#type == ProviderRuntimeEventType::Output {
                ProviderOutputStream::Stdout
            } else {
                ProviderOutputStream::System
            },
            message,
            exit_code,
            created_at: now_iso(),
        });
    };
    let emit_line = |line: Value| emit(ProviderRuntimeEventType::Output, format!("{line}\n"), None);
    emit(ProviderRuntimeEventType::StreamStarted, String::new(), None);
    emit_line(json!({
        "type": "system", "subtype": "init", "session_id": acp_session_id,
        "model": model_id, "transport": "acp",
    }));
    let (subscription, mut updates) = client.subscribe(&acp_session_id);
    let mut translation = GrokTurnTranslation::default();
    let prompt_request = client.request(
        "session/prompt",
        json!({
            "sessionId": acp_session_id,
            "prompt": [{ "type": "text", "text": prompt }],
        }),
    );
    tokio::pin!(prompt_request);
    let outcome = loop {
        tokio::select! {
            update = updates.recv() => match update {
                Some(update) => {
                    for line in translation.translate(&update, &acp_session_id) {
                        emit_line(line);
                    }
                }
                None => break Err(ArgmaxError::service(
                    "ACP_CONNECTION_DEAD", "Grok ACP server exited mid-turn",
                )),
            },
            response = &mut prompt_request => break response,
        }
    };
    while let Ok(update) = updates.try_recv() {
        for line in translation.translate(&update, &acp_session_id) {
            emit_line(line);
        }
    }
    client.unsubscribe(&acp_session_id, subscription);
    match outcome {
        Ok(response) if response.get("stopReason").and_then(Value::as_str) == Some("cancelled") => {
            emit(
                ProviderRuntimeEventType::Exit,
                "Grok ACP turn cancelled.".to_string(),
                Some(0),
            );
        }
        Ok(response) if response.get("stopReason").and_then(Value::as_str) == Some("end_turn") => {
            emit_line(translation.success_result(&acp_session_id));
            emit(
                ProviderRuntimeEventType::Exit,
                "Grok ACP turn completed.".to_string(),
                Some(0),
            );
        }
        Ok(response) => emit(
            ProviderRuntimeEventType::Error,
            format!(
                "Grok ACP stopped before completing: {}",
                response
                    .get("stopReason")
                    .and_then(Value::as_str)
                    .unwrap_or("unknown reason")
            ),
            Some(1),
        ),
        Err(error) => emit(
            ProviderRuntimeEventType::Error,
            format!("Grok ACP turn failed: {error}"),
            Some(1),
        ),
    }
}

#[derive(Default)]
struct GrokTurnTranslation {
    assistant_text: String,
}

impl GrokTurnTranslation {
    fn translate(&mut self, params: &Value, session_id: &str) -> Vec<Value> {
        let Some(update) = params.get("update") else {
            return Vec::new();
        };
        let Some(kind) = update.get("sessionUpdate").and_then(Value::as_str) else {
            return Vec::new();
        };
        match kind {
            "agent_thought_chunk" => content_text(update)
                .map(|thinking| {
                    vec![json!({
                        "type": "stream_event", "session_id": session_id,
                        "event": { "type": "content_block_delta", "index": 0,
                            "delta": { "type": "thinking_delta", "thinking": thinking } }
                    })]
                })
                .unwrap_or_default(),
            "agent_message_chunk" => content_text(update)
                .map(|text| {
                    append_message_chunk(&mut self.assistant_text, &text);
                    vec![json!({
                        "type": "stream_event", "session_id": session_id,
                        "event": { "type": "content_block_delta", "index": 0,
                            "delta": { "type": "text_delta", "text": text } }
                    })]
                })
                .unwrap_or_default(),
            "tool_call" => {
                let Some(call_id) = update.get("toolCallId").and_then(Value::as_str) else {
                    return Vec::new();
                };
                let name = update
                    .pointer("/rawInput/_toolName")
                    .and_then(Value::as_str)
                    .or_else(|| update.get("title").and_then(Value::as_str))
                    .unwrap_or("tool");
                let input = update.get("rawInput").cloned().unwrap_or_else(|| json!({}));
                let mut lines = vec![json!({
                    "type": "stream_event", "session_id": session_id,
                    "event": { "type": "content_block_start", "index": 0,
                        "content_block": { "type": "tool_use", "id": call_id,
                            "name": name, "input": input } }
                })];
                if matches!(
                    update.get("status").and_then(Value::as_str),
                    Some("completed" | "failed")
                ) {
                    lines.push(grok_tool_result(update, call_id, session_id));
                }
                lines
            }
            "tool_call_update"
                if matches!(
                    update.get("status").and_then(Value::as_str),
                    Some("completed" | "failed")
                ) =>
            {
                let Some(call_id) = update.get("toolCallId").and_then(Value::as_str) else {
                    return Vec::new();
                };
                vec![grok_tool_result(update, call_id, session_id)]
            }
            _ => Vec::new(),
        }
    }

    fn success_result(&self, session_id: &str) -> Value {
        json!({
            "type": "result",
            "subtype": "success",
            "session_id": session_id,
            "result": self.assistant_text,
        })
    }
}

/// Grok answers in bursts, one `agent_message_chunk` per burst, and a burst
/// ends at a full stop with no trailing whitespace. Concatenating them raw
/// gives the turn's final text sentences with no space between them —
/// "mark each item done as I go.The three files are missing" — which is what
/// the chat renders once the turn ends.
///
/// A chunk that opens with whitespace, or continues mid-sentence, is the same
/// burst carrying on and joins as-is. Anything else is a new burst and earns a
/// blank line, so the answer reads as the paragraphs Grok wrote.
fn append_message_chunk(accumulated: &mut String, chunk: &str) {
    if chunk.is_empty() {
        return;
    }
    if accumulated.is_empty() || continues_sentence(accumulated, chunk) {
        accumulated.push_str(chunk);
        return;
    }
    accumulated.push_str("\n\n");
    accumulated.push_str(chunk.trim_start());
}

/// Deliberately narrow: the only seam worth breaking is a finished sentence
/// followed immediately by a capital with no whitespace at all, which no token
/// stream produces on its own. Whitespace on either side already separates the
/// two, so leave it exactly as Grok sent it.
fn continues_sentence(accumulated: &str, chunk: &str) -> bool {
    if chunk.starts_with(char::is_whitespace) || accumulated.ends_with(char::is_whitespace) {
        return true;
    }
    let Some(last) = accumulated.chars().next_back() else {
        return true;
    };
    if !".!?…".contains(last) {
        return true;
    }
    chunk.chars().next().is_none_or(|c| !c.is_uppercase())
}

fn grok_tool_result(update: &Value, call_id: &str, session_id: &str) -> Value {
    let output = update
        .get("rawOutput")
        .map(Value::to_string)
        .unwrap_or_default();
    json!({
        "type": "user", "session_id": session_id,
        "message": { "role": "user", "content": [{
            "type": "tool_result", "tool_use_id": call_id, "content": output
        }]}
    })
}

fn content_text(update: &Value) -> Option<String> {
    update
        .pointer("/content/text")
        .and_then(Value::as_str)
        .map(str::to_string)
}

struct GrokTurnHandle {
    client: Arc<AcpClient>,
    acp_session_id: String,
    disposed: AtomicBool,
    done_rx: watch::Receiver<bool>,
}

impl ProviderRuntimeHandle for GrokTurnHandle {
    fn accepts_input(&self) -> bool {
        false
    }

    fn disposed(&self) -> bool {
        self.disposed.load(Ordering::SeqCst) || *self.done_rx.borrow()
    }

    fn send_input(&self, _input: &str) {}

    fn resize(&self, _cols: u16, _rows: u16) {}

    fn terminate<'a>(&'a self) -> BoxFuture<'a, ArgmaxResult<()>> {
        Box::pin(async move {
            if self.disposed.swap(true, Ordering::SeqCst) {
                return Ok(());
            }
            self.client.notify(
                "session/cancel",
                json!({ "sessionId": self.acp_session_id }),
            );
            let mut done = self.done_rx.clone();
            tokio::time::timeout(CANCEL_WAIT, async move {
                while !*done.borrow() {
                    done.changed().await.map_err(|_| {
                        ArgmaxError::service("ACP_CONNECTION_DEAD", "Grok ACP turn task stopped")
                    })?;
                }
                Ok(())
            })
            .await
            .map_err(|_| {
                ArgmaxError::service(
                    "ACP_CANCEL_TIMEOUT",
                    "Timed out waiting for the cancelled Grok ACP turn to stop.",
                )
            })?
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn message_chunks_from_separate_bursts_get_a_paragraph_break() {
        // Captured from a live Grok ACP turn: each burst ends on a full stop
        // with no trailing space, and the next one opens a new sentence.
        let mut text = String::new();
        append_message_chunk(&mut text, "I'll start with a todo list.");
        append_message_chunk(
            &mut text,
            "The three files are missing, so I'll create them.",
        );
        append_message_chunk(&mut text, "Done.");
        assert_eq!(
            text,
            "I'll start with a todo list.\n\nThe three files are missing, so I'll create them.\n\nDone."
        );
    }

    #[test]
    fn a_chunk_that_continues_the_sentence_joins_without_a_break() {
        let mut text = String::new();
        append_message_chunk(&mut text, "I'll read");
        append_message_chunk(&mut text, " the docs");
        // Lowercase after a full stop is Grok resuming a clause, not a burst.
        append_message_chunk(&mut text, " and then write.");
        append_message_chunk(&mut text, "then verify.");
        assert_eq!(text, "I'll read the docs and then write.then verify.");
    }

    #[test]
    fn grok_effort_caps_argmax_levels_at_the_native_maximum() {
        assert_eq!(grok_effort(ReasoningEffort::Low), "low");
        assert_eq!(grok_effort(ReasoningEffort::High), "high");
        assert_eq!(grok_effort(ReasoningEffort::Max), "xhigh");
        assert_eq!(grok_effort(ReasoningEffort::Ultra), "xhigh");
    }

    #[test]
    fn eligibility_includes_plan_but_excludes_forks() {
        let mut input = ProviderLaunchInput {
            provider: ProviderId::Grok,
            session_id: "s".into(),
            workspace_path: "/tmp".into(),
            prompt: "p".into(),
            model_label: "Grok 4.6".into(),
            model_id: "grok-4.6".into(),
            reasoning_effort: Some(ReasoningEffort::High),
            fast_mode: false,
            resume_conversation_id: None,
            resume_fork: false,
            permission_mode: PermissionMode::ProviderDefaults,
            agent_mode: AgentMode::Auto,
            cols: 80,
            rows: 24,
        };
        assert!(is_acp_eligible(&input));
        input.agent_mode = AgentMode::Plan;
        assert!(is_acp_eligible(&input));
        input.resume_fork = true;
        assert!(!is_acp_eligible(&input));
    }

    #[test]
    fn process_arguments_isolate_permission_policies() {
        assert_eq!(
            grok_process_arguments(GrokProcessMode::ProviderDefaults),
            ["agent", "stdio"]
        );
        assert_eq!(
            grok_process_arguments(GrokProcessMode::AskEachTime),
            ["--permission-mode", "default", "agent", "stdio"]
        );
        assert_eq!(
            grok_process_arguments(GrokProcessMode::AutoApprove),
            ["--permission-mode", "bypassPermissions", "agent", "stdio"]
        );
        assert_eq!(
            grok_process_arguments(GrokProcessMode::Plan),
            ["--permission-mode", "plan", "agent", "stdio"]
        );
    }

    #[test]
    fn grok_updates_use_the_existing_claude_stream_shape() {
        let mut translation = GrokTurnTranslation::default();
        let thought = translation.translate(
            &json!({"update": {"sessionUpdate": "agent_thought_chunk",
                "content": {"type": "text", "text": "Think"}}}),
            "g1",
        );
        assert_eq!(thought[0]["event"]["delta"]["type"], "thinking_delta");
        let message = translation.translate(
            &json!({"update": {"sessionUpdate": "agent_message_chunk",
                "content": {"type": "text", "text": "Done"}}}),
            "g1",
        );
        assert_eq!(message[0]["event"]["delta"]["text"], "Done");

        let completed = translation.translate(
            &json!({"update": {"sessionUpdate": "tool_call_update",
                "toolCallId": "call-1", "status": "completed",
                "rawOutput": {"output": "ok"}}}),
            "g1",
        );
        assert_eq!(
            completed[0]["message"]["content"][0]["tool_use_id"],
            "call-1"
        );
    }

    // Captured from Grok 1.0.24. The initial call already carries the
    // replacement pair, which is enough for the shared renderer to build the
    // diff even though the later ACP update also carries a `content` diff.
    #[test]
    fn grok_search_replace_keeps_the_file_and_replacement_pair() {
        let mut translation = GrokTurnTranslation::default();
        let started = translation.translate(
            &json!({"update": {
                "sessionUpdate": "tool_call",
                "toolCallId": "call-edit",
                "title": "search_replace",
                "rawInput": {
                    "file_path": "/repo/greet.ts",
                    "old_string": "return \"hello\";",
                    "new_string": "return \"hi there\";"
                }
            }}),
            "g1",
        );

        let tool = &started[0]["event"]["content_block"];
        assert_eq!(tool["name"], "search_replace");
        assert_eq!(tool["input"]["file_path"], "/repo/greet.ts");
        assert_eq!(tool["input"]["old_string"], "return \"hello\";");
        assert_eq!(tool["input"]["new_string"], "return \"hi there\";");
    }

    #[test]
    fn grok_success_result_finalizes_the_accumulated_answer() {
        use crate::providers::normalizer::{
            normalize_provider_event, NormalizerSessionContext, ProviderOutputEvent,
        };

        let mut translation = GrokTurnTranslation::default();
        translation.translate(
            &json!({"update": {"sessionUpdate": "agent_message_chunk",
                "content": {"type": "text", "text": "Final "}}}),
            "g1",
        );
        translation.translate(
            &json!({"update": {"sessionUpdate": "agent_message_chunk",
                "content": {"type": "text", "text": "answer"}}}),
            "g1",
        );
        let result = translation.success_result("g1");
        assert_eq!(result["result"], "Final answer");

        let normalized = normalize_provider_event(
            ProviderId::Grok,
            &ProviderOutputEvent {
                session_id: "argmax-1".to_string(),
                stream: ProviderOutputStream::Stdout,
                message: format!("{result}\n"),
                created_at: "2026-09-07T10:00:00.000Z".to_string(),
            },
            &mut NormalizerSessionContext::for_provider(ProviderId::Grok, "grok-4.6"),
        );
        assert_eq!(normalized.events.len(), 1);
        assert_eq!(normalized.events[0].r#type, "message.completed");
        assert_eq!(normalized.events[0].message, "Final answer");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn shutdown_does_not_wait_for_a_workspace_boot_lock() {
        let pool = Arc::new(GrokAcpSessions::new());
        let slot = Arc::new(GrokWorkspaceSlot::default());
        pool.workspaces.lock().await.insert(
            (
                PathBuf::from("/tmp/repo"),
                GrokProcessMode::ProviderDefaults,
            ),
            Arc::clone(&slot),
        );
        let _boot = slot.boot.lock().await;
        let shutdown_pool = Arc::clone(&pool);

        tokio::time::timeout(
            Duration::from_secs(1),
            tokio::task::spawn_blocking(move || shutdown_pool.kill_all_blocking()),
        )
        .await
        .expect("shutdown should not wait for an initialize handshake")
        .expect("shutdown task should finish");
    }

    #[test]
    fn grok_permission_summary_prefers_the_native_command() {
        assert_eq!(
            grok_permission_command(&json!({"toolCall": {"title": "Run command",
                "rawInput": {"command": "cargo test"}}})),
            "cargo test"
        );
    }
}
