//! Warm-process Cursor launches over ACP (`cursor-agent acp`).
//!
//! One-shot `cursor-agent agent -p` pays ~5.5 s of client-side startup before
//! the API turn begins — on the first turn AND on every `--resume` follow-up.
//! This runtime keeps one `cursor-agent acp` process warm per workspace and
//! runs each Argmax turn as an ACP prompt on it: measured session creation on
//! a warm process is ~1.2–1.4 s, and follow-ups skip process boot entirely.
//!
//! The ACP update stream is translated into the same cursor stream-json lines
//! the normalizer already parses (`system/init`, cumulative `assistant` text,
//! `thinking` deltas, `tool_call` rows, `result/success`), so everything
//! downstream — flush queue, normalizer, chat cards, the
//! `complete_cursor_turn_after_result` turn lifecycle — is unchanged.
//!
//! Scope and trade-offs (see docs/providers.md):
//! - Every Cursor model routes here when ACP advertises the exact requested
//!   model, effort, and fast combination. A missing exact variant is an error,
//!   never a silent downgrade.
//! - Cursor's ACP stream never reports token usage, so ACP turns record no
//!   usage/cost row.
//! - The warm process is shared per workspace, so the per-session Argmax
//!   credential cannot ride in its environment. It rides in the `mcpServers`
//!   entry of `session/new` / `session/load` instead, which ACP scopes to the
//!   session being created or loaded.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
use std::time::Duration;

use serde_json::{json, Map, Value};
use tokio::sync::watch;

use super::acp::{AcpClient, AcpPermissionDecision, AcpPermissionHandler, AcpPermissionRequest};
use super::environment::build_provider_environment;
use super::normalizer::ProviderOutputStream;
use super::runtime::{
    BoxFuture, EventCallback, ProviderRuntimeEvent, ProviderRuntimeEventType, ProviderRuntimeHandle,
};
use super::{mcp_injection, AgentMode, PermissionMode, ProviderId, ProviderLaunchInput};
use crate::approvals::service::ApprovalService;
use crate::error::{ArgmaxError, ArgmaxResult};
use crate::persistence::time::now_iso;
use crate::session_control::SessionLaunchProcessConfig;
use crate::util::sync::LockOrRecover;

/// How long `terminate` waits for a cancelled prompt to resolve before giving
/// up. The warm process is never killed on turn termination.
const CANCEL_WAIT: Duration = Duration::from_secs(5);

/// Cursor's ACP mode ids, as listed in `session/new`'s
/// `modes.availableModes`: `agent` (the `currentModeId` a new session starts
/// on), `plan`, and `ask`. Argmax's agent modes map onto the first two.
fn acp_mode_id(agent_mode: AgentMode) -> &'static str {
    match agent_mode {
        AgentMode::Plan => "plan",
        AgentMode::Auto => "agent",
    }
}

pub fn is_acp_eligible(input: &ProviderLaunchInput) -> bool {
    input.provider == ProviderId::Cursor && !input.resume_fork
}

pub fn is_acp_model_id(model_id: &str) -> bool {
    !model_id.is_empty()
}

// ---------------------------------------------------------------------------
// Pool
// ---------------------------------------------------------------------------

#[derive(Default)]
pub struct CursorAcpSessions {
    workspaces: tokio::sync::Mutex<HashMap<(PathBuf, CursorProcessMode), Arc<WorkspaceSlot>>>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
enum CursorProcessMode {
    ProviderDefaults,
    AskEachTime,
    AutoApprove,
}

impl From<PermissionMode> for CursorProcessMode {
    fn from(mode: PermissionMode) -> Self {
        match mode {
            PermissionMode::ProviderDefaults => Self::ProviderDefaults,
            PermissionMode::AskEachTime => Self::AskEachTime,
            PermissionMode::AutoApprove => Self::AutoApprove,
        }
    }
}

/// The pool entry for one workspace. `boot` serializes spawn plus the
/// `initialize` handshake for this workspace alone, so a cold — or hung —
/// process boot in one worktree never blocks Cursor launches in another.
#[derive(Default)]
struct WorkspaceSlot {
    boot: tokio::sync::Mutex<()>,
    current: Mutex<Option<Arc<AcpWorkspace>>>,
}

struct AcpWorkspace {
    client: Arc<AcpClient>,
    /// ACP session ids created or loaded on this process during this app run.
    live_sessions: Mutex<HashSet<String>>,
    available_models: Mutex<Vec<Value>>,
    permission_contexts: PermissionContexts,
}

type PermissionContexts = Arc<Mutex<HashMap<String, CursorPermissionContext>>>;

#[derive(Clone)]
struct CursorPermissionContext {
    argmax_session_id: String,
    invocation_id: String,
    cwd: String,
    permission_mode: PermissionMode,
    approvals: Option<Arc<ApprovalService>>,
}

impl CursorAcpSessions {
    pub fn new() -> Self {
        Self::default()
    }

    /// Run one Argmax turn (fresh launch or follow-up) on the workspace's warm
    /// ACP process, spawning and initializing it first if needed. Any error
    /// here leaves the pool consistent and the caller falls back to the
    /// one-shot path.
    pub async fn launch_turn(
        &self,
        binary_path: &str,
        input: &ProviderLaunchInput,
        session_launch: Option<&SessionLaunchProcessConfig>,
        on_event: EventCallback,
    ) -> ArgmaxResult<Arc<dyn ProviderRuntimeHandle>> {
        self.launch_turn_with_approvals(binary_path, input, session_launch, None, on_event)
            .await
    }

    pub async fn launch_turn_with_approvals(
        &self,
        binary_path: &str,
        input: &ProviderLaunchInput,
        session_launch: Option<&SessionLaunchProcessConfig>,
        approvals: Option<Arc<ApprovalService>>,
        on_event: EventCallback,
    ) -> ArgmaxResult<Arc<dyn ProviderRuntimeHandle>> {
        let mcp_servers = mcp_injection::acp_mcp_servers(session_launch);
        let workspace = self.workspace_client(binary_path, input).await?;
        let client = Arc::clone(&workspace.client);

        let session_response = match input.resume_conversation_id.as_deref() {
            Some(resume_id) => {
                let known = workspace
                    .live_sessions
                    .lock_or_recover("acp live sessions")
                    .contains(resume_id);
                if !known {
                    // App restarted or process was replaced: reload the session.
                    // The agent replays the full history via session/update
                    // BEFORE answering session/load, so subscribe first and
                    // discard everything that arrived before the response.
                    let (replay_token, mut replay) = client.subscribe(resume_id);
                    let load = client
                        .request(
                            "session/load",
                            json!({
                                "sessionId": resume_id,
                                "cwd": input.workspace_path,
                                "mcpServers": mcp_servers,
                            }),
                        )
                        .await;
                    while replay.try_recv().is_ok() {}
                    client.unsubscribe(resume_id, replay_token);
                    let response = load?;
                    remember_available_models(&workspace, &response);
                    workspace
                        .live_sessions
                        .lock_or_recover("acp live sessions")
                        .insert(resume_id.to_string());
                }
                (resume_id.to_string(), None)
            }
            None => {
                let response = client
                    .request(
                        "session/new",
                        json!({ "cwd": input.workspace_path, "mcpServers": mcp_servers }),
                    )
                    .await?;
                let session_id = response
                    .get("sessionId")
                    .and_then(Value::as_str)
                    .ok_or_else(|| {
                        ArgmaxError::service("ACP_PROTOCOL", "session/new returned no sessionId")
                    })?
                    .to_string();
                remember_available_models(&workspace, &response);
                workspace
                    .live_sessions
                    .lock_or_recover("acp live sessions")
                    .insert(session_id.clone());
                (session_id, Some(response))
            }
        };
        let (acp_session_id, response) = session_response;
        let models = response
            .as_ref()
            .and_then(|value| value.pointer("/models/availableModels"))
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_else(|| {
                workspace
                    .available_models
                    .lock_or_recover("acp available models")
                    .clone()
            });
        ensure_cursor_model(&client, &acp_session_id, input, &models).await?;

        let invocation_id = uuid::Uuid::new_v4().to_string();
        workspace
            .permission_contexts
            .lock_or_recover("cursor ACP permission contexts")
            .insert(
                acp_session_id.clone(),
                CursorPermissionContext {
                    argmax_session_id: input.session_id.clone(),
                    invocation_id: invocation_id.clone(),
                    cwd: input.workspace_path.to_string_lossy().into_owned(),
                    permission_mode: input.permission_mode,
                    approvals,
                },
            );

        // Apply this turn's mode on every turn, fresh or resumed. The ACP
        // session keeps whatever mode the previous turn left it in, so setting
        // it only at session/new made Plan a one-way door and left a resumed
        // session ignoring the toggle entirely.
        client
            .request(
                "session/set_mode",
                json!({
                    "sessionId": acp_session_id,
                    "modeId": acp_mode_id(input.agent_mode),
                }),
            )
            .await?;

        Ok(spawn_turn(
            client,
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
    ) -> ArgmaxResult<Arc<AcpWorkspace>> {
        let slot = {
            let mut workspaces = self.workspaces.lock().await;
            let key = (
                input.workspace_path.clone(),
                CursorProcessMode::from(input.permission_mode),
            );
            Arc::clone(
                workspaces
                    .entry(key)
                    .or_insert_with(|| Arc::new(WorkspaceSlot::default())),
            )
        };
        // The map lock is released before the expensive work below, so only
        // this workspace's launches queue behind its boot.
        let _boot = slot.boot.lock().await;
        if let Some(existing) = slot.current.lock_or_recover("acp workspace").clone() {
            if !existing.client.is_dead() {
                return Ok(existing);
            }
        }
        let permission_contexts = Arc::new(Mutex::new(HashMap::new()));
        let arguments = match input.permission_mode {
            PermissionMode::AutoApprove => &["--force", "acp"][..],
            PermissionMode::AskEachTime | PermissionMode::ProviderDefaults => &["acp"][..],
        };
        let client = AcpClient::spawn(
            binary_path,
            arguments,
            &input.workspace_path,
            build_provider_environment([("NO_COLOR".to_string(), "1".to_string())]),
            Some(cursor_permission_handler(Arc::clone(&permission_contexts))),
        )?;
        let workspace = Arc::new(AcpWorkspace {
            client,
            live_sessions: Mutex::new(HashSet::new()),
            available_models: Mutex::new(Vec::new()),
            permission_contexts,
        });
        // Publish before the handshake so app shutdown can still kill a child
        // that is only half-initialized.
        *slot.current.lock_or_recover("acp workspace") = Some(Arc::clone(&workspace));
        let handshake = workspace
            .client
            .request(
                "initialize",
                json!({
                    "protocolVersion": 1,
                    "clientCapabilities": {
                        "fs": { "readTextFile": false, "writeTextFile": false }
                    },
                    "clientInfo": { "name": "argmax", "version": env!("CARGO_PKG_VERSION") },
                }),
            )
            .await;
        if let Err(error) = handshake {
            workspace.client.kill();
            slot.current.lock_or_recover("acp workspace").take();
            return Err(error);
        }
        Ok(workspace)
    }

    /// Drop the warm process for one workspace. The pool is otherwise only
    /// drained at app exit, so a workspace whose checkout is going away
    /// (archived worktree, removed project) would leave its child running with
    /// its cwd on a deleted directory for the rest of the app's lifetime.
    pub async fn evict(&self, workspace_path: &Path) {
        let slots: Vec<_> = {
            let mut workspaces = self.workspaces.lock().await;
            let keys: Vec<_> = workspaces
                .keys()
                .filter(|(path, _)| path == workspace_path)
                .cloned()
                .collect();
            keys.into_iter()
                .filter_map(|key| workspaces.remove(&key))
                .collect()
        };
        for slot in slots {
            let current = slot.current.lock_or_recover("acp workspace").take();
            if let Some(workspace) = current {
                workspace.client.kill();
            }
        }
    }

    /// Synchronous shutdown for Tauri's `RunEvent::Exit` callback, which runs
    /// on the macOS main thread (not a tokio worker, so blocking on the pool
    /// lock is safe there — nothing holds it across an await). Boot-time
    /// orphan recovery cannot match `cursor-agent acp` processes — their argv
    /// carries no session id — so a warm process must not outlive the app.
    pub fn kill_all_blocking(&self) {
        let mut workspaces = self.workspaces.blocking_lock();
        for (_, slot) in workspaces.drain() {
            if let Some(workspace) = slot.current.lock_or_recover("acp workspace").take() {
                workspace.client.kill();
            }
        }
    }
}

fn remember_available_models(workspace: &AcpWorkspace, response: &Value) {
    let Some(models) = response
        .pointer("/models/availableModels")
        .and_then(Value::as_array)
    else {
        return;
    };
    *workspace
        .available_models
        .lock_or_recover("acp available models") = models.clone();
}

/// Select the advertised configuration of the family the user asked for.
/// Cursor's ACP ids carry configuration in brackets
/// (`grok-4.6[effort=high,fast=true]`), but it advertises exactly one variant
/// per family, that variant does not follow the parameters saved in
/// `cli-config.json`, and `session/set_model` rejects any id it did not list.
/// The bracketed values are therefore Cursor's to pick, not ours to require:
/// insisting on them rejected most of the catalog, the default model included.
async fn ensure_cursor_model(
    client: &AcpClient,
    session_id: &str,
    input: &ProviderLaunchInput,
    available_models: &[Value],
) -> ArgmaxResult<()> {
    let listed = available_models
        .iter()
        .filter_map(|model| model.get("modelId").and_then(Value::as_str))
        .find(|id| cursor_model_matches(id, input))
        .ok_or_else(|| {
            ArgmaxError::service(
                "ACP_MODEL_UNAVAILABLE",
                format!(
                    "cursor ACP does not advertise the {} model family",
                    input.model_id
                ),
            )
        })?;
    client
        .request(
            "session/set_model",
            json!({ "sessionId": session_id, "modelId": listed }),
        )
        .await?;
    Ok(())
}

fn cursor_model_matches(advertised: &str, input: &ProviderLaunchInput) -> bool {
    cursor_acp_family(&input.model_id) == Some(model_family(advertised))
}

/// The catalog id a chat launches with, mapped to the family Cursor's ACP
/// advertises. `auto-smart` keeps its bracket: the whole id is the family
/// there, and Cursor advertises one `optimize_for` value regardless of which
/// one the catalog entry names.
fn cursor_acp_family(model_id: &str) -> Option<&str> {
    match model_id {
        "composer-2.5" => Some("composer-2.5"),
        "cursor-grok-4.6-medium" => Some("grok-4.6"),
        "cursor-grok-4.5-medium" => Some("grok-4.5"),
        "gemini-3.8-flash-medium" => Some("gemini-3.8-flash"),
        "gpt-5.6-sol-medium" => Some("gpt-5.6-sol"),
        "gpt-5.6-terra-medium" => Some("gpt-5.6-terra"),
        "gpt-5.6-luna-medium" => Some("gpt-5.6-luna"),
        "claude-opus-5-thinking-medium" => Some("claude-opus-5"),
        _ if model_id.starts_with("auto-smart[") => Some("auto-smart"),
        _ => None,
    }
}

fn model_family(model_id: &str) -> &str {
    model_id
        .split_once('[')
        .map_or(model_id, |(family, _)| family)
}

fn cursor_permission_handler(contexts: PermissionContexts) -> AcpPermissionHandler {
    Arc::new(move |request: AcpPermissionRequest| {
        let context = request
            .params
            .get("sessionId")
            .and_then(Value::as_str)
            .and_then(|session_id| {
                contexts
                    .lock_or_recover("cursor ACP permission contexts")
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
            let request_id = json_rpc_id(&request.request_id);
            let command = cursor_permission_command(&request.params);
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
                    "cursor",
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

fn json_rpc_id(id: &Value) -> String {
    id.to_string()
}

fn cursor_permission_command(params: &Value) -> String {
    params
        .pointer("/toolCall/rawInput/command")
        .and_then(Value::as_str)
        .or_else(|| params.pointer("/toolCall/title").and_then(Value::as_str))
        .unwrap_or("Cursor tool request")
        .to_string()
}

// ---------------------------------------------------------------------------
// Turn execution
// ---------------------------------------------------------------------------

fn spawn_turn(
    client: Arc<AcpClient>,
    acp_session_id: String,
    invocation_id: String,
    permission_contexts: PermissionContexts,
    input: &ProviderLaunchInput,
    on_event: EventCallback,
) -> Arc<dyn ProviderRuntimeHandle> {
    let (done_tx, done_rx) = watch::channel(false);
    let handle = Arc::new(AcpTurnHandle {
        client: Arc::clone(&client),
        acp_session_id: acp_session_id.clone(),
        disposed: AtomicBool::new(false),
        done_rx,
    });

    let session_id = input.session_id.clone();
    let prompt = input.prompt.clone();
    tokio::spawn(async move {
        run_turn(client, acp_session_id.clone(), session_id, prompt, on_event).await;
        let mut contexts = permission_contexts.lock_or_recover("cursor ACP permission contexts");
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
    let emit_line = |line: Value| {
        let line = with_acp_session_id(line, &acp_session_id);
        emit(ProviderRuntimeEventType::Output, format!("{line}\n"), None);
    };

    // Handshake is done: clear the Thinking bubble and record the ACP session
    // id as the provider conversation id, exactly like one-shot system/init.
    emit(ProviderRuntimeEventType::StreamStarted, String::new(), None);
    emit_line(json!({
        "type": "system",
        "subtype": "init",
        "session_id": acp_session_id,
        "transport": "acp",
    }));

    let (subscription, mut updates) = client.subscribe(&acp_session_id);
    let prompt_request = client.request(
        "session/prompt",
        json!({
            "sessionId": acp_session_id,
            "prompt": [{ "type": "text", "text": prompt }],
        }),
    );
    tokio::pin!(prompt_request);

    let mut translation = TurnTranslation::default();
    let outcome = loop {
        tokio::select! {
            update = updates.recv() => {
                match update {
                    Some(update) => {
                        for line in translation.translate(&update) {
                            emit_line(line);
                        }
                    }
                    // Subscriber channel closed: the ACP process died. (A turn
                    // displaced by a later one on the same session lands here
                    // too; its event is dropped as a stale invocation.)
                    None => break Err(ArgmaxError::service(
                        "ACP_CONNECTION_DEAD",
                        "cursor ACP server exited mid-turn",
                    )),
                }
            }
            response = &mut prompt_request => break response,
        }
    };
    // Drain updates that raced the prompt response.
    while let Ok(update) = updates.try_recv() {
        for line in translation.translate(&update) {
            emit_line(line);
        }
    }
    client.unsubscribe(&acp_session_id, subscription);

    match outcome {
        Ok(response) => {
            let stop_reason = response
                .get("stopReason")
                .and_then(Value::as_str)
                .unwrap_or("end_turn");
            match stop_reason {
                "end_turn" => {
                    // Drives the normalizer's session.completed and the
                    // service's complete_cursor_turn_after_result path. Cursor
                    // ACP reports no usage, so none is attached.
                    emit_line(json!({ "type": "result", "subtype": "success" }));
                    emit(
                        ProviderRuntimeEventType::Exit,
                        "cursor ACP turn completed.".to_string(),
                        Some(0),
                    );
                }
                "cancelled" => emit(
                    ProviderRuntimeEventType::Exit,
                    "cursor ACP turn cancelled.".to_string(),
                    Some(0),
                ),
                other => emit(
                    ProviderRuntimeEventType::Error,
                    format!("cursor ACP turn stopped: {other}."),
                    Some(1),
                ),
            }
        }
        Err(error) => emit(
            ProviderRuntimeEventType::Error,
            format!("cursor ACP turn failed: {error}"),
            Some(1),
        ),
    }
}

/// ACP updates do not repeat their parent session id. Cursor's stream
/// normalizer needs that native id on task completions to link a child agent
/// to its provider parent, so attach it at the shared output boundary.
fn with_acp_session_id(mut line: Value, acp_session_id: &str) -> Value {
    if let Some(payload) = line.as_object_mut() {
        payload.insert(
            "session_id".to_string(),
            Value::String(acp_session_id.to_string()),
        );
    }
    line
}

// ---------------------------------------------------------------------------
// ACP update → cursor stream-json translation
// ---------------------------------------------------------------------------

/// Per-turn translation state: cumulative assistant text (the one-shot CLI
/// emits cumulative deltas, and the normalizer diffs consecutive values) and
/// the tool metadata needed to shape completion rows.
#[derive(Default)]
struct TurnTranslation {
    assistant_text: String,
    /// Synthetic strictly-increasing stand-in for the one-shot stream's
    /// `timestamp_ms`, whose presence tells the normalizer the text is
    /// cumulative.
    sequence: u64,
    tools: HashMap<String, ToolInfo>,
}

struct ToolInfo {
    key: String,
    args: Value,
    /// Whether the `started` line has been emitted. An MCP call arrives
    /// nameless and is named by a later update, so its start waits for that.
    started: bool,
}

impl TurnTranslation {
    fn translate(&mut self, update_params: &Value) -> Vec<Value> {
        let Some(update) = update_params.get("update") else {
            return Vec::new();
        };
        let kind = update
            .get("sessionUpdate")
            .and_then(Value::as_str)
            .unwrap_or_default();
        match kind {
            "agent_thought_chunk" => content_text(update)
                .map(|text| vec![json!({ "type": "thinking", "subtype": "delta", "text": text })])
                .unwrap_or_default(),
            "agent_message_chunk" => {
                let Some(text) = content_text(update) else {
                    return Vec::new();
                };
                self.assistant_text.push_str(&text);
                self.sequence += 1;
                vec![json!({
                    "type": "assistant",
                    "message": self.assistant_text,
                    "timestamp_ms": self.sequence,
                })]
            }
            "tool_call" => {
                let Some(call_id) = update.get("toolCallId").and_then(Value::as_str) else {
                    return Vec::new();
                };
                let named = mcp_identity(update).is_some() || !is_placeholder(update);
                let (key, args) = match mcp_identity(update) {
                    Some(identity) => identity,
                    None => (
                        tool_key(update),
                        update
                            .get("rawInput")
                            .cloned()
                            .unwrap_or_else(|| title_args(update)),
                    ),
                };
                self.tools.insert(
                    call_id.to_string(),
                    ToolInfo {
                        key,
                        args,
                        started: false,
                    },
                );
                let mut lines = Vec::new();
                if named {
                    lines.extend(self.started_line(call_id));
                }
                // Some agents emit tool_call already terminal; close it out.
                if is_terminal_status(update) {
                    lines.extend(self.started_line(call_id));
                    lines.extend(self.completion_line(call_id, update));
                }
                lines
            }
            "tool_call_update" => {
                let Some(call_id) = update.get("toolCallId").and_then(Value::as_str) else {
                    return Vec::new();
                };
                // The identity of an MCP call arrives here, not on the
                // `tool_call` that opened it: Cursor sends a nameless
                // "MCP: tool" placeholder first, then an update carrying
                // `{providerIdentifier, toolName, args}`.
                if let Some((key, args)) = mcp_identity(update) {
                    if let Some(info) = self.tools.get_mut(call_id) {
                        if !info.started {
                            info.key = key;
                            info.args = args;
                        }
                    }
                }
                let mut lines = self.started_line(call_id);
                if is_terminal_status(update) {
                    lines.extend(self.completion_line(call_id, update));
                }
                lines
            }
            _ => Vec::new(),
        }
    }

    /// The `started` line, once. Called again for the same tool it yields
    /// nothing, so a nameless call can wait for its name without the row
    /// appearing twice.
    fn started_line(&mut self, call_id: &str) -> Vec<Value> {
        let Some(info) = self.tools.get_mut(call_id) else {
            return Vec::new();
        };
        if info.started {
            return Vec::new();
        }
        info.started = true;
        vec![json!({
            "type": "tool_call",
            "subtype": "started",
            "call_id": call_id,
            "tool_call": { info.key.clone(): { "args": info.args.clone() } },
        })]
    }

    fn completion_line(&mut self, call_id: &str, update: &Value) -> Vec<Value> {
        let Some(info) = self.tools.remove(call_id) else {
            return Vec::new();
        };
        let mut body = Map::new();
        body.insert("args".to_string(), info.args);
        if let Some(output) = update.get("rawOutput") {
            body.insert("result".to_string(), output.clone());
        }
        vec![json!({
            "type": "tool_call",
            "subtype": "completed",
            "call_id": call_id,
            "tool_call": { info.key: Value::Object(body) },
        })]
    }
}

fn content_text(update: &Value) -> Option<String> {
    update
        .pointer("/content/text")
        .and_then(Value::as_str)
        .map(str::to_string)
}

/// The one-shot stream wraps each tool in a kind-named object (`shell`,
/// `readToolCall`, …) that the normalizer uses as the display name. Map ACP's
/// `kind` onto the closest one-shot names so chat cards render the same.
///
/// `kind` is a coarse ACP bucket — everything outside read/edit/execute lands
/// in `other`, which is what a sub-agent launch reports. Cursor still names
/// the real tool in `rawInput._toolName` (`task` for a sub-agent), so prefer
/// that: it's what makes the chat row read "Started agent …" instead of a
/// nameless "other".
fn tool_key(update: &Value) -> String {
    if let Some(name) = update
        .pointer("/rawInput/_toolName")
        .and_then(Value::as_str)
        .filter(|name| !name.is_empty())
    {
        return name.to_string();
    }
    match update.get("kind").and_then(Value::as_str) {
        Some("execute") => "shell".to_string(),
        Some(kind) if !kind.is_empty() => kind.to_string(),
        _ => "tool_call".to_string(),
    }
}

/// An MCP call's real name and arguments. Cursor reports them as
/// `rawInput: {providerIdentifier, toolName, args}`; naming the row
/// `mcp__<server>__<tool>` matches what Claude's own stream shows.
fn mcp_identity(update: &Value) -> Option<(String, Value)> {
    let raw_input = update.get("rawInput")?;
    let server = raw_input
        .get("providerIdentifier")
        .and_then(Value::as_str)?;
    let tool = raw_input.get("toolName").and_then(Value::as_str)?;
    let args = raw_input.get("args").cloned().unwrap_or_else(|| json!({}));
    Some((format!("mcp__{server}__{tool}"), args))
}

/// A `tool_call` that names nothing: the bucket kind with no arguments, which
/// is how an MCP call opens before Cursor identifies it.
fn is_placeholder(update: &Value) -> bool {
    let bucket_kind = matches!(update.get("kind").and_then(Value::as_str), Some("other"));
    let empty_input = match update.get("rawInput") {
        None => true,
        Some(Value::Object(fields)) => fields.is_empty(),
        Some(_) => false,
    };
    bucket_kind && empty_input
}

fn title_args(update: &Value) -> Value {
    match update.get("title").and_then(Value::as_str) {
        Some(title) => json!({ "title": title }),
        None => json!({}),
    }
}

fn is_terminal_status(update: &Value) -> bool {
    matches!(
        update.get("status").and_then(Value::as_str),
        Some("completed" | "failed")
    )
}

// ---------------------------------------------------------------------------
// Turn handle
// ---------------------------------------------------------------------------

struct AcpTurnHandle {
    client: Arc<AcpClient>,
    acp_session_id: String,
    disposed: AtomicBool,
    done_rx: watch::Receiver<bool>,
}

impl ProviderRuntimeHandle for AcpTurnHandle {
    fn accepts_input(&self) -> bool {
        false
    }

    fn disposed(&self) -> bool {
        self.disposed.load(Ordering::SeqCst)
    }

    fn send_input(&self, _input: &str) {
        // Follow-ups relaunch through the pool (session/prompt on the warm
        // process); nothing streams over this handle.
    }

    fn resize(&self, _cols: u16, _rows: u16) {}

    fn terminate<'a>(&'a self) -> BoxFuture<'a, ArgmaxResult<()>> {
        Box::pin(async move {
            self.disposed.store(true, Ordering::SeqCst);
            let mut done_rx = self.done_rx.clone();
            if *done_rx.borrow() {
                return Ok(());
            }
            // Cancel the in-flight prompt; the agent answers it with
            // stopReason "cancelled". The warm process stays alive for the
            // next turn.
            self.client.notify(
                "session/cancel",
                json!({ "sessionId": self.acp_session_id }),
            );
            // A timeout here means the prompt is still running: the caller
            // (archive, "Send now") must not treat the turn as stopped and go
            // on to remove the worktree or issue a second prompt.
            if tokio::time::timeout(CANCEL_WAIT, done_rx.wait_for(|done| *done))
                .await
                .is_err()
            {
                return Err(ArgmaxError::service(
                    "ACP_CANCEL_TIMEOUT",
                    "Timed out waiting for the cancelled cursor ACP turn to stop.",
                ));
            }
            Ok(())
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::providers::normalizer::{
        normalize_provider_event, NormalizerSessionContext, ProviderOutputEvent,
    };

    fn update(value: Value) -> Value {
        json!({ "sessionId": "acp-1", "update": value })
    }

    #[test]
    fn approval_ids_preserve_json_rpc_type() {
        assert_ne!(json_rpc_id(&json!(42)), json_rpc_id(&json!("42")));
    }

    #[test]
    fn thought_chunks_become_thinking_deltas() {
        let mut translation = TurnTranslation::default();
        let lines = translation.translate(&update(json!({
            "sessionUpdate": "agent_thought_chunk",
            "content": { "type": "text", "text": "Consider the repo" },
        })));
        assert_eq!(
            lines,
            vec![json!({ "type": "thinking", "subtype": "delta", "text": "Consider the repo" })]
        );
    }

    #[test]
    fn message_chunks_accumulate_into_cumulative_assistant_text() {
        let mut translation = TurnTranslation::default();
        let first = translation.translate(&update(json!({
            "sessionUpdate": "agent_message_chunk",
            "content": { "type": "text", "text": "Hello" },
        })));
        let second = translation.translate(&update(json!({
            "sessionUpdate": "agent_message_chunk",
            "content": { "type": "text", "text": ", world" },
        })));
        assert_eq!(first[0]["message"], "Hello");
        assert_eq!(second[0]["message"], "Hello, world");
        // timestamp_ms marks the text as cumulative for the normalizer and
        // must strictly increase.
        assert!(second[0]["timestamp_ms"].as_u64() > first[0]["timestamp_ms"].as_u64());
    }

    #[test]
    fn execute_tool_calls_map_to_shell_rows() {
        let mut translation = TurnTranslation::default();
        let started = translation.translate(&update(json!({
            "sessionUpdate": "tool_call",
            "toolCallId": "tool-1",
            "title": "`echo hi`",
            "kind": "execute",
            "status": "pending",
            "rawInput": { "command": "echo hi" },
        })));
        assert_eq!(started[0]["subtype"], "started");
        assert_eq!(
            started[0]["tool_call"]["shell"]["args"]["command"],
            "echo hi"
        );

        let completed = translation.translate(&update(json!({
            "sessionUpdate": "tool_call_update",
            "toolCallId": "tool-1",
            "status": "completed",
            "rawOutput": { "output": "hi" },
        })));
        assert_eq!(completed[0]["subtype"], "completed");
        assert_eq!(
            completed[0]["tool_call"]["shell"]["args"]["command"],
            "echo hi"
        );
        assert_eq!(completed[0]["tool_call"]["shell"]["result"]["output"], "hi");
    }

    #[test]
    fn mcp_calls_are_named_by_the_update_that_identifies_them() {
        // Recorded from `cursor-agent acp`: the call opens as a nameless
        // "MCP: tool" placeholder and is identified by the next update.
        let mut translation = TurnTranslation::default();
        let placeholder = translation.translate(&update(json!({
            "sessionUpdate": "tool_call",
            "toolCallId": "tool-1",
            "title": "MCP: tool",
            "kind": "other",
            "status": "pending",
            "rawInput": {},
        })));
        assert!(
            placeholder.is_empty(),
            "a nameless row would read as an anonymous 'other' tool"
        );

        let named = translation.translate(&update(json!({
            "sessionUpdate": "tool_call_update",
            "toolCallId": "tool-1",
            "title": "argmax: session_list",
            "rawInput": {
                "providerIdentifier": "argmax",
                "toolName": "session_list",
                "args": { "all": true },
            },
        })));
        assert_eq!(named.len(), 1);
        assert_eq!(named[0]["subtype"], "started");
        assert_eq!(
            named[0]["tool_call"]["mcp__argmax__session_list"]["args"]["all"],
            json!(true)
        );

        // The in-progress update does not repeat the row.
        assert!(translation
            .translate(&update(json!({
                "sessionUpdate": "tool_call_update",
                "toolCallId": "tool-1",
                "status": "in_progress",
            })))
            .is_empty());

        let completed = translation.translate(&update(json!({
            "sessionUpdate": "tool_call_update",
            "toolCallId": "tool-1",
            "status": "completed",
            "rawOutput": { "success": true },
        })));
        assert_eq!(completed.len(), 1);
        assert_eq!(
            completed[0]["tool_call"]["mcp__argmax__session_list"]["result"]["success"],
            json!(true)
        );
    }

    #[test]
    fn a_nameless_tool_that_is_never_identified_still_reports_a_pair() {
        let mut translation = TurnTranslation::default();
        assert!(translation
            .translate(&update(json!({
                "sessionUpdate": "tool_call",
                "toolCallId": "tool-1",
                "kind": "other",
                "status": "pending",
                "rawInput": {},
            })))
            .is_empty());
        let lines = translation.translate(&update(json!({
            "sessionUpdate": "tool_call_update",
            "toolCallId": "tool-1",
            "status": "completed",
        })));
        assert_eq!(lines.len(), 2);
        assert_eq!(lines[0]["subtype"], "started");
        assert_eq!(lines[1]["subtype"], "completed");
    }

    #[test]
    fn subagent_launches_keep_their_tool_name_instead_of_the_other_kind() {
        let mut translation = TurnTranslation::default();
        let started = translation.translate(&update(json!({
            "sessionUpdate": "tool_call",
            "toolCallId": "tool-1",
            "kind": "other",
            "status": "pending",
            "rawInput": {
                "_toolName": "task",
                "description": "Sync docs with code changes",
                "prompt": "Review the docs",
                "subagentType": "general",
            },
        })));
        assert_eq!(
            started[0]["tool_call"]["task"]["args"]["description"],
            "Sync docs with code changes"
        );

        let completed = translation.translate(&update(json!({
            "sessionUpdate": "tool_call_update",
            "toolCallId": "tool-1",
            "status": "completed",
            "rawOutput": { "success": true },
        })));
        assert_eq!(
            completed[0]["tool_call"]["task"]["result"]["success"],
            json!(true)
        );
    }

    #[test]
    fn translated_acp_task_completion_normalizes_into_agent_lifecycle() {
        let mut translation = TurnTranslation::default();
        let started = translation.translate(&update(json!({
            "sessionUpdate": "tool_call",
            "toolCallId": "call-acp",
            "kind": "other",
            "status": "pending",
            "rawInput": {
                "_toolName": "task",
                "description": "Review ACP",
                "prompt": "Inspect the adapter",
            },
        })));
        let started = with_acp_session_id(started.into_iter().next().unwrap(), "native-parent");
        assert_eq!(started["session_id"], "native-parent");

        let completed = translation.translate(&update(json!({
            "sessionUpdate": "tool_call_update",
            "toolCallId": "call-acp",
            "status": "completed",
            "rawOutput": { "success": {
                "agentId": "native-child",
                "conversationSteps": [{
                    "assistantMessage": { "text": "Adapter reviewed" }
                }]
            }},
        })));
        let completed = with_acp_session_id(completed.into_iter().next().unwrap(), "native-parent");
        let mut context = NormalizerSessionContext::default();
        let output = ProviderOutputEvent {
            session_id: "argmax-session".to_string(),
            stream: ProviderOutputStream::Stdout,
            message: completed.to_string(),
            created_at: "2026-09-07T12:00:00.000Z".to_string(),
        };
        let normalized = normalize_provider_event(ProviderId::Cursor, &output, &mut context);

        let lifecycle = normalized
            .events
            .iter()
            .filter(|event| event.r#type.starts_with("agent."))
            .collect::<Vec<_>>();
        assert_eq!(lifecycle.len(), 2);
        assert_eq!(lifecycle[0].r#type, "agent.started");
        assert_eq!(
            lifecycle[0].payload["providerParentConversationId"],
            "native-parent"
        );
        assert_eq!(
            lifecycle[0].payload["providerChildSessionId"],
            "native-child"
        );
        assert_eq!(lifecycle[0].payload["agentRunId"], "call-acp");
        assert_eq!(lifecycle[1].r#type, "agent.completed");
        assert_eq!(lifecycle[1].message, "Adapter reviewed");
    }

    #[test]
    fn non_terminal_tool_updates_are_dropped() {
        let mut translation = TurnTranslation::default();
        translation.translate(&update(json!({
            "sessionUpdate": "tool_call",
            "toolCallId": "tool-1",
            "kind": "execute",
            "status": "pending",
            "rawInput": {},
        })));
        let in_progress = translation.translate(&update(json!({
            "sessionUpdate": "tool_call_update",
            "toolCallId": "tool-1",
            "status": "in_progress",
        })));
        assert!(in_progress.is_empty());
    }

    #[test]
    fn unknown_updates_translate_to_nothing() {
        let mut translation = TurnTranslation::default();
        for kind in [
            "user_message_chunk",
            "available_commands_update",
            "current_mode_update",
            "session_info_update",
            "plan",
        ] {
            assert!(translation
                .translate(&update(json!({ "sessionUpdate": kind })))
                .is_empty());
        }
    }

    #[test]
    fn eligibility_covers_all_cursor_models_except_forks() {
        let mut input = ProviderLaunchInput {
            provider: ProviderId::Cursor,
            session_id: "s".into(),
            workspace_path: "/tmp".into(),
            prompt: "p".into(),
            model_label: "Composer 2.5 (Cursor)".into(),
            model_id: "composer-2.5".into(),
            reasoning_effort: None,
            fast_mode: false,
            resume_conversation_id: None,
            resume_fork: false,
            permission_mode: super::super::PermissionMode::AutoApprove,
            agent_mode: AgentMode::Auto,
            cols: 80,
            rows: 24,
        };
        assert!(is_acp_eligible(&input));
        input.model_id = "gpt-5.6-sol-medium".into();
        assert!(is_acp_eligible(&input));
        input.resume_fork = true;
        assert!(!is_acp_eligible(&input));
        input.resume_fork = false;
        input.provider = ProviderId::Claude;
        assert!(!is_acp_eligible(&input));
    }

    #[test]
    fn agent_mode_maps_onto_cursors_acp_mode_ids() {
        assert_eq!(acp_mode_id(AgentMode::Plan), "plan");
        // Auto must name the default mode explicitly: a follow-up leaving Plan
        // has to set something, and omitting the call keeps the old mode.
        assert_eq!(acp_mode_id(AgentMode::Auto), "agent");
    }

    #[test]
    fn model_matching_ignores_the_configuration_cursor_advertises() {
        let mut input = ProviderLaunchInput {
            provider: ProviderId::Cursor,
            session_id: "s".into(),
            workspace_path: "/tmp".into(),
            prompt: "p".into(),
            model_label: "GPT-5.6 Sol (Cursor)".into(),
            model_id: "gpt-5.6-sol-medium".into(),
            reasoning_effort: None,
            fast_mode: false,
            resume_conversation_id: None,
            resume_fork: false,
            permission_mode: PermissionMode::AutoApprove,
            agent_mode: AgentMode::Auto,
            cols: 80,
            rows: 24,
        };
        // Whatever effort and serving speed Cursor names for the family, that
        // is the only variant it will accept, so all of these have to match.
        for advertised in [
            "gpt-5.6-sol[context=272k,reasoning=high,fast=false]",
            "gpt-5.6-sol[context=272k,reasoning=medium,fast=true]",
            "gpt-5.6-sol",
        ] {
            assert!(cursor_model_matches(advertised, &input), "{advertised}");
        }
        assert!(!cursor_model_matches(
            "gpt-5.6-luna[context=272k,reasoning=medium,fast=false]",
            &input
        ));
        input.model_id = "not-a-cursor-model".into();
        assert!(!cursor_model_matches("gpt-5.6-sol", &input));
    }

    #[test]
    fn model_matching_maps_cursor_aliases_to_advertised_families() {
        let mut input = ProviderLaunchInput {
            provider: ProviderId::Cursor,
            session_id: "s".into(),
            workspace_path: "/tmp".into(),
            prompt: "p".into(),
            model_label: "Grok 4.6 (Cursor)".into(),
            model_id: "cursor-grok-4.6-medium".into(),
            reasoning_effort: None,
            fast_mode: false,
            resume_conversation_id: None,
            resume_fork: false,
            permission_mode: PermissionMode::ProviderDefaults,
            agent_mode: AgentMode::Auto,
            cols: 80,
            rows: 24,
        };
        assert!(cursor_model_matches(
            "grok-4.6[effort=high,fast=true]",
            &input
        ));
        // Every `auto-smart` entry maps onto the one variant Cursor lists,
        // whichever `optimize_for` the catalog entry names.
        input.model_id = "auto-smart[optimize_for=cost]".into();
        assert!(cursor_model_matches(
            "auto-smart[optimize_for=balanced]",
            &input
        ));
    }
}
