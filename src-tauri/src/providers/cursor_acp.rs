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
//! - Only `composer-2.5` routes here. Other Cursor models encode reasoning
//!   effort / fast serving in the one-shot `--model` id; ACP's `session/set_model`
//!   accepts only the ids Cursor lists, so routing them here would silently
//!   drop the chosen variant. Ineligible or failed launches fall back to the
//!   one-shot PTY path.
//! - Cursor's ACP stream never reports token usage, so ACP turns record no
//!   usage/cost row.
//! - Hosted-agent session-launch credentials are per-process env vars, which a
//!   shared warm process cannot carry; ACP turns skip that injection.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
use std::time::Duration;

use serde_json::{json, Map, Value};
use tokio::sync::watch;

use super::acp::AcpClient;
use super::environment::build_provider_environment;
use super::normalizer::ProviderOutputStream;
use super::runtime::{
    BoxFuture, EventCallback, ProviderRuntimeEvent, ProviderRuntimeEventType, ProviderRuntimeHandle,
};
use super::{AgentMode, ProviderId, ProviderLaunchInput};
use crate::error::{ArgmaxError, ArgmaxResult};
use crate::persistence::time::now_iso;
use crate::util::sync::LockOrRecover;

/// The only model family routed through ACP today. Composer has no reasoning
/// effort dimension, so the id Cursor lists for it is not a silent downgrade
/// of anything the user picked.
const ACP_MODEL_FAMILY: &str = "composer-2.5";

/// How long `terminate` waits for a cancelled prompt to resolve before giving
/// up. The warm process is never killed on turn termination.
const CANCEL_WAIT: Duration = Duration::from_secs(5);

pub fn is_acp_eligible(input: &ProviderLaunchInput) -> bool {
    input.provider == ProviderId::Cursor && input.model_id == ACP_MODEL_FAMILY
}

// ---------------------------------------------------------------------------
// Pool
// ---------------------------------------------------------------------------

#[derive(Default)]
pub struct CursorAcpSessions {
    workspaces: tokio::sync::Mutex<HashMap<PathBuf, Arc<WorkspaceSlot>>>,
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
        on_event: EventCallback,
    ) -> ArgmaxResult<Arc<dyn ProviderRuntimeHandle>> {
        let workspace = self.workspace_client(binary_path, input).await?;
        let client = Arc::clone(&workspace.client);

        let acp_session_id = match input.resume_conversation_id.as_deref() {
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
                                "mcpServers": [],
                            }),
                        )
                        .await;
                    while replay.try_recv().is_ok() {}
                    client.unsubscribe(resume_id, replay_token);
                    load?;
                    workspace
                        .live_sessions
                        .lock_or_recover("acp live sessions")
                        .insert(resume_id.to_string());
                }
                resume_id.to_string()
            }
            None => {
                let response = client
                    .request(
                        "session/new",
                        json!({ "cwd": input.workspace_path, "mcpServers": [] }),
                    )
                    .await?;
                let session_id = response
                    .get("sessionId")
                    .and_then(Value::as_str)
                    .ok_or_else(|| {
                        ArgmaxError::service("ACP_PROTOCOL", "session/new returned no sessionId")
                    })?
                    .to_string();
                ensure_composer_model(&client, &session_id, &response).await?;
                if input.agent_mode == AgentMode::Plan {
                    client
                        .request(
                            "session/set_mode",
                            json!({ "sessionId": session_id, "modeId": "plan" }),
                        )
                        .await?;
                }
                workspace
                    .live_sessions
                    .lock_or_recover("acp live sessions")
                    .insert(session_id.clone());
                session_id
            }
        };

        Ok(spawn_turn(client, acp_session_id, input, on_event))
    }

    async fn workspace_client(
        &self,
        binary_path: &str,
        input: &ProviderLaunchInput,
    ) -> ArgmaxResult<Arc<AcpWorkspace>> {
        let slot = {
            let mut workspaces = self.workspaces.lock().await;
            Arc::clone(
                workspaces
                    .entry(input.workspace_path.clone())
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
        let client = AcpClient::spawn(
            binary_path,
            &input.workspace_path,
            build_provider_environment([("NO_COLOR".to_string(), "1".to_string())]),
        )?;
        let workspace = Arc::new(AcpWorkspace {
            client,
            live_sessions: Mutex::new(HashSet::new()),
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
        let slot = self.workspaces.lock().await.remove(workspace_path);
        let Some(slot) = slot else {
            return;
        };
        // Bound before the `if let` so the guard drops before `slot` does.
        let current = slot.current.lock_or_recover("acp workspace").take();
        if let Some(workspace) = current {
            workspace.client.kill();
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

/// Verify the session runs composer, switching to Cursor's listed composer id
/// when another model is current. `session/set_model` only accepts ids exactly
/// as listed in `availableModels`, so an absent composer entry is a hard error
/// (the caller falls back to the one-shot path, which passes `--model` freely).
async fn ensure_composer_model(
    client: &AcpClient,
    session_id: &str,
    new_session_response: &Value,
) -> ArgmaxResult<()> {
    let models = new_session_response.get("models").unwrap_or(&Value::Null);
    let current = models
        .get("currentModelId")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if model_family(current) == ACP_MODEL_FAMILY {
        return Ok(());
    }
    let listed = models
        .get("availableModels")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|model| model.get("modelId").and_then(Value::as_str))
        .find(|id| model_family(id) == ACP_MODEL_FAMILY)
        .ok_or_else(|| {
            ArgmaxError::service(
                "ACP_MODEL_UNAVAILABLE",
                "cursor ACP does not list a composer-2.5 model",
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

/// `composer-2.5[fast=true]` → `composer-2.5`.
fn model_family(model_id: &str) -> &str {
    model_id.split('[').next().unwrap_or(model_id)
}

// ---------------------------------------------------------------------------
// Turn execution
// ---------------------------------------------------------------------------

fn spawn_turn(
    client: Arc<AcpClient>,
    acp_session_id: String,
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
        run_turn(client, acp_session_id, session_id, prompt, on_event).await;
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
                let key = tool_key(update);
                let args = update
                    .get("rawInput")
                    .cloned()
                    .unwrap_or_else(|| title_args(update));
                let started = json!({
                    "type": "tool_call",
                    "subtype": "started",
                    "call_id": call_id,
                    "tool_call": { key.clone(): { "args": args.clone() } },
                });
                self.tools
                    .insert(call_id.to_string(), ToolInfo { key, args });
                let mut lines = vec![started];
                // Some agents emit tool_call already terminal; close it out.
                if is_terminal_status(update) {
                    lines.extend(self.completion_line(call_id, update));
                }
                lines
            }
            "tool_call_update" => {
                let Some(call_id) = update.get("toolCallId").and_then(Value::as_str) else {
                    return Vec::new();
                };
                if !is_terminal_status(update) {
                    return Vec::new();
                }
                self.completion_line(call_id, update)
            }
            _ => Vec::new(),
        }
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

    fn update(value: Value) -> Value {
        json!({ "sessionId": "acp-1", "update": value })
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
    fn eligibility_is_cursor_composer_only() {
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
        assert!(!is_acp_eligible(&input));
        input.model_id = "composer-2.5".into();
        input.provider = ProviderId::Claude;
        assert!(!is_acp_eligible(&input));
    }

    #[test]
    fn model_family_strips_bracket_parameters() {
        assert_eq!(model_family("composer-2.5[fast=true]"), "composer-2.5");
        assert_eq!(model_family("composer-2.5"), "composer-2.5");
    }
}
