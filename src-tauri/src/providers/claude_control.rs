//! Claude's stream-json SDK control channel. Permissions remain provider-owned.
//! Wire reference: anthropics/claude-agent-sdk-python, _internal/query.py.
use super::{
    adapters::get_provider_definition,
    environment::build_provider_environment,
    normalizer::ProviderOutputStream,
    runtime::{
        BoxFuture, EventCallback, ProviderRuntimeEvent, ProviderRuntimeEventType,
        ProviderRuntimeHandle,
    },
    PermissionMode, ProviderId, ProviderLaunchInput,
};
use crate::{
    approvals::service::ApprovalService,
    error::{ArgmaxError, ArgmaxResult},
    persistence::time::now_iso,
    session_control::SessionLaunchProcessConfig,
};
use serde_json::{json, Value};
use std::{
    collections::VecDeque,
    process::Stdio,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::Duration,
};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    sync::{mpsc, oneshot, watch},
    task::JoinSet,
};

/// How long the initial prompt may take to reach Claude before a steer gives up
/// waiting for its turn to start, and how long a single stdin write may block.
/// Neither bound covers the model's own pace: Claude replays a steered message
/// only once the tool call it is inside returns, which is routinely minutes.
const STEER_WRITE_TIMEOUT: Duration = Duration::from_secs(20);

enum UserEcho {
    Initial,
    Steer,
}

struct PendingUserEcho {
    prompt: String,
    acknowledgement: UserEcho,
}

struct WriteRequest {
    message: Value,
    user_echo: Option<PendingUserEcho>,
    written: Option<oneshot::Sender<()>>,
}

impl WriteRequest {
    fn control(message: Value) -> Self {
        Self {
            message,
            user_echo: None,
            written: None,
        }
    }

    fn user(session_id: &str, prompt: &str, acknowledgement: UserEcho) -> Self {
        Self {
            message: user_message(session_id, prompt),
            user_echo: Some(PendingUserEcho {
                prompt: prompt.to_string(),
                acknowledgement,
            }),
            written: None,
        }
    }

    fn acknowledged(mut self) -> (Self, oneshot::Receiver<()>) {
        let (sender, receiver) = oneshot::channel();
        self.written = Some(sender);
        (self, receiver)
    }
}

fn user_message(session_id: &str, prompt: &str) -> Value {
    json!({
        "type": "user",
        "session_id": session_id,
        "message": { "role": "user", "content": prompt },
        "parent_tool_use_id": null,
    })
}

fn replayed_user_prompt(message: &Value) -> Option<&str> {
    (message.get("type").and_then(Value::as_str) == Some("user")
        && message.get("parent_tool_use_id").is_none_or(Value::is_null))
    .then(|| message.pointer("/message/content").and_then(Value::as_str))
    .flatten()
}

fn user_echo_matches(message: &Value, echoed: &str, prompt: &str) -> bool {
    if echoed == prompt {
        return true;
    }
    // Claude expands slash commands before replaying them. Match the complete
    // envelope so the pending FIFO cannot be consumed by unrelated user rows.
    if message.get("isReplay").and_then(Value::as_bool) != Some(true) {
        return false;
    }
    let Some(command) = prompt.strip_prefix('/') else {
        return false;
    };
    let (name, args) = command
        .split_once(char::is_whitespace)
        .unwrap_or((command, ""));
    let envelope =
        format!("<command-message>{name}</command-message>\n<command-name>/{name}</command-name>");
    if args.is_empty() && echoed == envelope {
        return true;
    }
    echoed == format!("{envelope}\n<command-args>{args}</command-args>")
}

fn task_lifecycle<'a>(message: &'a Value, subtype: &str) -> Option<&'a str> {
    (message.get("type").and_then(Value::as_str) == Some("system")
        && message.get("subtype").and_then(Value::as_str) == Some(subtype))
    .then(|| message.get("task_id").and_then(Value::as_str))
    .flatten()
}

/// An agent the model dispatched with `run_in_background`. Its `Agent` call
/// returns at once, so the model can answer while the agent is still working;
/// the agent's completion comes back later as a `task_notification` that
/// starts another model turn. A foreground agent blocks its call instead and
/// is finished before any answer.
fn backgrounded_agent_task_id(message: &Value) -> Option<&str> {
    let task_id = task_lifecycle(message, "task_started")?;
    (message.get("task_type").and_then(Value::as_str) == Some("local_agent")
        && message.get("is_backgrounded").and_then(Value::as_bool) == Some(true))
    .then_some(task_id)
}

fn finished_task_id(message: &Value) -> Option<&str> {
    task_lifecycle(message, "task_notification")
}

pub async fn launch_turn(
    binary: &str,
    input: &ProviderLaunchInput,
    config: Option<&SessionLaunchProcessConfig>,
    approvals: Arc<ApprovalService>,
    emit: EventCallback,
) -> ArgmaxResult<Arc<dyn ProviderRuntimeHandle>> {
    let definition = get_provider_definition(ProviderId::Claude);
    let mut args = match input.resume_conversation_id.as_deref() {
        Some(id) => (definition.structured_resume_args)(input, id, config),
        None => (definition.structured_args)(input, config),
    };
    let delimiter = args
        .iter()
        .position(|arg| arg == "--")
        .ok_or_else(|| ArgmaxError::service("CLAUDE_CONTROL_ARGS", "Missing prompt delimiter"))?;
    args.truncate(delimiter);
    args.extend(
        [
            "--input-format",
            "stream-json",
            "--replay-user-messages",
            "--permission-prompt-tool",
            "stdio",
        ]
        .map(str::to_string),
    );
    if input.permission_mode == PermissionMode::AskEachTime
        && input.agent_mode != super::AgentMode::Plan
    {
        args.extend(["--permission-mode", "manual"].map(str::to_string));
    }
    let mut overrides = vec![
        ("NO_COLOR".to_string(), "1".to_string()),
        (
            "CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS".to_string(),
            "0".to_string(),
        ),
    ];
    if let Some(config) = config {
        overrides.extend(config.env_pairs());
    }
    let mut command = tokio::process::Command::new(binary);
    command
        .args(args)
        .current_dir(&input.workspace_path)
        .env_clear()
        .envs(build_provider_environment(overrides))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(unix)]
    command.process_group(0);
    let mut child = command.spawn().map_err(io_error)?;
    let mut stdin = child
        .stdin
        .take()
        .ok_or_else(|| io_error("Missing Claude stdin"))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| io_error("Missing Claude stdout"))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| io_error("Missing Claude stderr"))?;
    let pending_user_echoes = Arc::new(tokio::sync::Mutex::new(VecDeque::new()));
    let writer_pending_user_echoes = Arc::clone(&pending_user_echoes);
    let (write_tx, mut write_rx) = mpsc::unbounded_channel::<WriteRequest>();
    let writer = tokio::spawn(async move {
        while let Some(request) = write_rx.recv().await {
            if let Some(user_echo) = request.user_echo {
                writer_pending_user_echoes.lock().await.push_back(user_echo);
            }
            stdin
                .write_all(format!("{}\n", request.message).as_bytes())
                .await?;
            stdin.flush().await?;
            if let Some(written) = request.written {
                let _ = written.send(());
            }
        }
        Ok::<(), std::io::Error>(())
    });
    write_tx
        .send(WriteRequest::control(json!({"type":"control_request", "request_id":"argmax-initialize", "request":{"subtype":"initialize","hooks":null}})))
        .map_err(io_error)?;
    let (cancel, mut cancelled) = watch::channel(false);
    let (done_tx, done) = watch::channel(false);
    let (ready_tx, ready) = watch::channel(false);
    let disposed = Arc::new(AtomicBool::new(false));
    let provider_session_id = input
        .resume_conversation_id
        .as_deref()
        .unwrap_or(&input.session_id)
        .to_string();
    let handle = Arc::new(ControlHandle {
        cancel,
        done,
        disposed: disposed.clone(),
        writer: write_tx.clone(),
        ready,
        provider_session_id: provider_session_id.clone(),
    });
    let input = input.clone();
    tokio::spawn(async move {
        let invocation = uuid::Uuid::new_v4().to_string();
        let mut lines = BufReader::new(stdout).lines();
        let mut errors = BufReader::new(stderr).lines();
        let mut stderr_open = true;
        let mut initialized = false;
        let deadline = tokio::time::sleep(Duration::from_secs(60));
        tokio::pin!(deadline);
        let mut requests = JoinSet::new();
        let mut request_tasks = std::collections::HashMap::new();
        let mut background_agents = std::collections::HashSet::new();
        let mut code = 0;
        loop {
            tokio::select! {
                _ = cancelled.changed() => { break; }
                _ = &mut deadline, if !initialized => { emit_event(&emit, &input, ProviderRuntimeEventType::Error, "Claude control initialization timed out".into(), None); code = 1; break; }
                line = errors.next_line(), if stderr_open => {
                    match line { Ok(Some(line)) => emit(ProviderRuntimeEvent {session_id:input.session_id.clone(), r#type:ProviderRuntimeEventType::Output, stream:ProviderOutputStream::Stderr,message:format!("{line}\n"),exit_code:None,created_at:now_iso()}), _ => stderr_open = false }
                }
                line = lines.next_line() => {
                    let line = match line { Ok(Some(line)) => line, Ok(None) => { code = 1; break; }, Err(error) => { emit_event(&emit,&input,ProviderRuntimeEventType::Error,error.to_string(),None);code=1;break; } };
                    let Ok(message) = serde_json::from_str::<Value>(&line) else { continue; };
                    match message.get("type").and_then(Value::as_str) {
                        Some("control_response") if message.pointer("/response/request_id").and_then(Value::as_str) == Some("argmax-initialize") => {
                            if message.pointer("/response/subtype").and_then(Value::as_str) != Some("success") { emit_event(&emit,&input,ProviderRuntimeEventType::Error,message.to_string(),None);code=1;break; }
                            initialized = true;
                            let _ = write_tx.send(WriteRequest::user(
                                &provider_session_id,
                                &input.prompt,
                                UserEcho::Initial,
                            ));
                            emit_event(&emit,&input,ProviderRuntimeEventType::StreamStarted,String::new(),None);
                        }
                        Some("control_request") => {
                            let Some(id) = message.get("request_id").and_then(Value::as_str).map(str::to_string) else { continue; };
                            if message.pointer("/request/subtype").and_then(Value::as_str) != Some("can_use_tool") {
                                let _ = write_tx.send(WriteRequest::control(json!({"type":"control_response","response":{"subtype":"error","request_id":id,"error":"Unsupported host request"}}))); continue;
                            }
                            let broker = approvals.clone(); let request_input = input.clone(); let invocation = invocation.clone(); let writer = write_tx.clone(); let request_id = id.clone();
                            let task = requests.spawn(async move {
                                let tool_input = message.pointer("/request/input").cloned().unwrap_or(json!({}));
                                let command = tool_input.get("command").and_then(Value::as_str).map(str::to_string).unwrap_or_else(|| format!("{}\n{}", message.pointer("/request/tool_name").and_then(Value::as_str).unwrap_or("Tool request"), tool_input));
                                if answers_itself(
                                    &request_input,
                                    message.pointer("/request/tool_name").and_then(Value::as_str),
                                ) {
                                    let _ = writer.send(WriteRequest::control(permission_response(&request_id, true, tool_input)));
                                    return;
                                }
                                let allowed = broker.request_native(&request_input.session_id,&invocation,&request_id,&command,&request_input.workspace_path.to_string_lossy(),"claude").await;
                                let response = match allowed {
                                    Ok(allowed) => permission_response(&request_id, allowed, tool_input),
                                    Err(error) => json!({"type":"control_response","response":{"subtype":"error","request_id":request_id,"error":error.to_string()}}),
                                };
                                let _ = writer.send(WriteRequest::control(response));
                            });
                            request_tasks.insert(id, task);
                        }
                        Some("control_cancel_request") => {
                            if let Some(id) = message.get("request_id").and_then(Value::as_str) {
                                if let Some(task) = request_tasks.remove(id) { task.abort(); }
                                let _ = approvals.cancel_native_request(&input.session_id, &invocation, id);
                            }
                        }
                        _ => {
                            if message.get("type").and_then(Value::as_str) == Some("user") {
                                let acknowledgement = if let Some(prompt) = replayed_user_prompt(&message) {
                                    let acknowledgement = {
                                        let mut pending = pending_user_echoes.lock().await;
                                        if pending.front().is_some_and(|pending| user_echo_matches(&message, prompt, &pending.prompt)) {
                                            pending.pop_front().map(|pending| pending.acknowledgement)
                                        } else {
                                            None
                                        }
                                    };
                                    acknowledgement
                                } else {
                                    None
                                };
                                match acknowledgement {
                                    Some(UserEcho::Initial) => {
                                        let _ = ready_tx.send(true);
                                        continue;
                                    }
                                    Some(UserEcho::Steer) => {
                                        continue;
                                    }
                                    None => {}
                                }
                            }
                            if let Some(task_id) = backgrounded_agent_task_id(&message) {
                                background_agents.insert(task_id.to_string());
                            } else if let Some(task_id) = finished_task_id(&message) {
                                background_agents.remove(task_id);
                            }
                            if message.get("type").and_then(Value::as_str) == Some("result") {
                                if !pending_user_echoes.lock().await.is_empty() {
                                    continue;
                                }
                                if message.get("is_error").and_then(Value::as_bool) == Some(true) { code=1; }
                                emit_event(&emit,&input,ProviderRuntimeEventType::Output,format!("{line}\n"),None);
                                // The answer is a checkpoint, not the end, while
                                // background agents are still working: killing
                                // the CLI here takes them down mid-edit. Stdin
                                // stays open so the CLI never winds down on its
                                // own; it delivers each completion to the model
                                // and answers again, and the last of those
                                // answers ends the turn.
                                if background_agents.is_empty() {
                                    break;
                                }
                                continue;
                            }
                            emit_event(&emit,&input,ProviderRuntimeEventType::Output,format!("{line}\n"),None);
                        }
                    }
                }
            }
        }
        requests.abort_all();
        let _ = approvals.cancel_session_pending(&input.session_id);
        writer.abort();
        let _ =
            crate::util::process_control::terminate_process_group_with_escalation(&mut child).await;
        disposed.store(true, Ordering::SeqCst);
        emit_event(
            &emit,
            &input,
            ProviderRuntimeEventType::Exit,
            String::new(),
            Some(code),
        );
        let _ = done_tx.send(true);
    });
    Ok(handle)
}

/// Whether the runtime answers this request itself instead of asking the user.
///
/// Two reasons to. A call the chat draws as an interactive card is already in
/// front of the user with its own button, and the tool result is thrown away
/// when they press it, so gating it asks permission to show a question they
/// are looking at. And Full access promised no gates: Claude still raises one
/// under `--dangerously-skip-permissions` when a settings `ask` rule forces
/// it, and sending that to the broker parks a chat nobody is watching. Plan
/// mode keeps its gate.
fn answers_itself(input: &ProviderLaunchInput, tool_name: Option<&str>) -> bool {
    if tool_name.is_some_and(super::renders_as_interactive_card) {
        return true;
    }
    input.permission_mode == PermissionMode::AutoApprove
        && input.agent_mode == super::AgentMode::Auto
}

fn permission_response(id: &str, allowed: bool, input: Value) -> Value {
    let response = if allowed {
        json!({"behavior":"allow","updatedInput":input})
    } else {
        json!({"behavior":"deny","message":"User denied this action"})
    };
    json!({"type":"control_response","response":{"subtype":"success","request_id":id,"response":response}})
}
fn io_error(error: impl std::fmt::Display) -> ArgmaxError {
    ArgmaxError::service("CLAUDE_CONTROL", error.to_string())
}
fn emit_event(
    emit: &EventCallback,
    input: &ProviderLaunchInput,
    kind: ProviderRuntimeEventType,
    message: String,
    code: Option<i32>,
) {
    emit(ProviderRuntimeEvent {
        session_id: input.session_id.clone(),
        r#type: kind,
        stream: ProviderOutputStream::Stdout,
        message,
        exit_code: code,
        created_at: now_iso(),
    });
}
struct ControlHandle {
    cancel: watch::Sender<bool>,
    done: watch::Receiver<bool>,
    disposed: Arc<AtomicBool>,
    writer: mpsc::UnboundedSender<WriteRequest>,
    ready: watch::Receiver<bool>,
    provider_session_id: String,
}
impl ProviderRuntimeHandle for ControlHandle {
    fn accepts_input(&self) -> bool {
        false
    }
    fn supports_steering(&self) -> bool {
        true
    }
    fn disposed(&self) -> bool {
        self.disposed.load(Ordering::SeqCst)
    }
    fn send_input(&self, _: &str) {}
    fn steer<'a>(&'a self, prompt: &'a str) -> BoxFuture<'a, ArgmaxResult<()>> {
        Box::pin(async move {
            if self.disposed() || *self.done.borrow() {
                return Err(ArgmaxError::service(
                    "STEER_NOT_RUNNING",
                    "The Claude turn is no longer running",
                ));
            }

            // Nothing has been written yet, so every way out of the readiness
            // gate leaves the follow-up unsent rather than uncertain.
            let mut ready = self.ready.clone();
            if !*ready.borrow() {
                let mut done = self.done.clone();
                tokio::time::timeout(STEER_WRITE_TIMEOUT, async {
                    tokio::select! {
                        result = ready.wait_for(|ready| *ready) => result.map(|_| ()),
                        result = done.wait_for(|done| *done) => result.map(|_| ()),
                    }
                })
                .await
                .map_err(|_| {
                    ArgmaxError::service(
                        "STEER_NOT_READY",
                        "Claude has not taken up this turn's first message yet. The follow-up is still queued.",
                    )
                })?
                .map_err(|_| {
                    ArgmaxError::service(
                        "STEER_NOT_RUNNING",
                        "The Claude turn closed before steering",
                    )
                })?;
                if !*ready.borrow() {
                    return Err(ArgmaxError::service(
                        "STEER_NOT_RUNNING",
                        "The Claude turn completed before steering",
                    ));
                }
            }

            // Delivery is the write, not the replay. Claude echoes a steered
            // message back only when it picks it up, which waits on whatever
            // tool call the turn is inside — a long test run or a subagent
            // holds it for minutes. The bytes on stdin are what decides
            // whether Claude has the guidance; treating the echo as the
            // acknowledgement reported a delivered follow-up as uncertain
            // every time the current tool outlived the timeout. The echo is
            // still tracked, so the reader keeps the turn open until Claude
            // consumes it.
            let (request, written) =
                WriteRequest::user(&self.provider_session_id, prompt, UserEcho::Steer)
                    .acknowledged();
            self.writer.send(request).map_err(|_| {
                ArgmaxError::service(
                    "STEER_NOT_RUNNING",
                    "The Claude turn closed before steering could be sent",
                )
            })?;

            let mut done = self.done.clone();
            tokio::select! {
                result = tokio::time::timeout(STEER_WRITE_TIMEOUT, written) => match result {
                    Ok(Ok(())) => Ok(()),
                    // The writer stopped without flushing this line, so Claude
                    // never saw a complete message.
                    Ok(Err(_)) => Err(ArgmaxError::service(
                        "STEER_NOT_RUNNING",
                        "The Claude turn closed before steering could be sent",
                    )),
                    Err(_) => Err(ArgmaxError::service(
                        "STEER_DELIVERY_UNKNOWN",
                        "Claude stopped reading its input while the guidance was being written",
                    )),
                },
                _ = done.wait_for(|done| *done) => Err(ArgmaxError::service(
                    "STEER_DELIVERY_UNKNOWN",
                    "The Claude turn ended while the guidance was being delivered",
                )),
            }
        })
    }
    fn resize(&self, _: u16, _: u16) {}
    fn terminate(&self) -> BoxFuture<'_, ArgmaxResult<()>> {
        Box::pin(async move {
            let _ = self.cancel.send(true);
            let mut done = self.done.clone();
            if !*done.borrow() {
                tokio::time::timeout(Duration::from_secs(5), done.changed())
                    .await
                    .map_err(io_error)?
                    .map_err(io_error)?;
            }
            Ok(())
        })
    }
}
impl Drop for ControlHandle {
    fn drop(&mut self) {
        let _ = self.cancel.send(true);
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use crate::persistence::database::Database;
    fn launch_input(
        permission_mode: PermissionMode,
        agent_mode: super::super::AgentMode,
    ) -> ProviderLaunchInput {
        ProviderLaunchInput {
            provider: ProviderId::Claude,
            session_id: "s".into(),
            workspace_path: "/tmp".into(),
            prompt: "p".into(),
            model_label: "Opus 5".into(),
            model_id: "claude-opus-5".into(),
            reasoning_effort: None,
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
    fn card_tools_and_full_access_answer_themselves_but_plan_mode_still_asks() {
        use super::super::AgentMode;
        let ask = launch_input(PermissionMode::AskEachTime, AgentMode::Auto);
        assert!(answers_itself(&ask, Some("AskUserQuestion")));
        assert!(answers_itself(&ask, Some("ExitPlanMode")));
        assert!(!answers_itself(&ask, Some("Bash")));
        assert!(!answers_itself(&ask, None));

        let full = launch_input(PermissionMode::AutoApprove, AgentMode::Auto);
        assert!(answers_itself(&full, Some("Bash")));

        // A plan-mode chat is gated on purpose, but its own card is not.
        let plan = launch_input(PermissionMode::AutoApprove, AgentMode::Plan);
        assert!(!answers_itself(&plan, Some("Bash")));
        assert!(answers_itself(&plan, Some("AskUserQuestion")));
    }

    #[test]
    fn native_decisions_preserve_request_and_input() {
        let input = json!({"command":"printf hello"});
        let yes = permission_response("request-42", true, input.clone());
        assert_eq!(yes["response"]["request_id"], "request-42");
        assert_eq!(
            yes["response"]["response"],
            json!({"behavior":"allow","updatedInput":input})
        );
        assert_eq!(
            permission_response("request-43", false, json!({}))["response"]["response"]["behavior"],
            "deny"
        );
    }

    #[test]
    fn user_messages_have_the_sdk_envelope_and_echo_text_is_recoverable() {
        let message = user_message("provider-session", "steer-token");
        assert_eq!(message["type"], "user");
        assert_eq!(message["session_id"], "provider-session");
        assert_eq!(message["message"]["role"], "user");
        assert_eq!(replayed_user_prompt(&message), Some("steer-token"));
    }

    #[test]
    fn slash_command_echo_requires_matching_arguments_and_top_level_replay() {
        let mut message = user_message("provider-session", "<command-message>review</command-message>\n<command-name>/review</command-name>\n<command-args>PR 1\n\nCheck data</command-args>");
        message["isReplay"] = json!(true);
        let echoed = replayed_user_prompt(&message).unwrap();
        assert!(user_echo_matches(
            &message,
            echoed,
            "/review PR 1\n\nCheck data"
        ));
        for mismatch in [
            "/review PR 2\n\nCheck data",
            "/snow PR 1\n\nCheck data",
            "/review PR 1\n\nCheck data ",
        ] {
            assert!(!user_echo_matches(&message, echoed, mismatch));
        }
        message["isReplay"] = json!(false);
        assert!(!user_echo_matches(
            &message,
            replayed_user_prompt(&message).unwrap(),
            "/review PR 1\n\nCheck data"
        ));
        message["parent_tool_use_id"] = json!("child-tool");
        assert!(replayed_user_prompt(&message).is_none());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn slash_command_replay_completes_the_turn() {
        use std::{fs, os::unix::fs::PermissionsExt, sync::Mutex};

        let temp = tempfile::tempdir().unwrap();
        let server = temp.path().join("fake-claude");
        fs::write(&server, r#"#!/bin/sh
while IFS= read -r line; do
  case "$line" in
    *'"subtype":"initialize"'*)
      printf '%s\n' '{"type":"control_response","response":{"subtype":"success","request_id":"argmax-initialize","response":{}}}'
      ;;
    *'"type":"user"'*)
      printf '%s\n' '{"type":"user","isReplay":true,"parent_tool_use_id":null,"message":{"role":"user","content":"<command-message>review</command-message>\n<command-name>/review</command-name>\n<command-args>https://example.test/pr/1\n\nUse /snow to verify things</command-args>"}}'
      printf '%s\n' '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"review complete"}]}}'
      printf '%s\n' '{"type":"result","subtype":"success","is_error":false,"result":"review complete"}'
      ;;
  esac
done
"#).unwrap();
        fs::set_permissions(&server, fs::Permissions::from_mode(0o755)).unwrap();
        let approvals = ApprovalService::new(Arc::new(Database::open_in_memory().unwrap()));
        let events = Arc::new(Mutex::new(Vec::new()));
        let captured = Arc::clone(&events);
        let callback: EventCallback = Arc::new(move |event| captured.lock().unwrap().push(event));
        let mut input = launch_input(
            PermissionMode::ProviderDefaults,
            super::super::AgentMode::Auto,
        );
        input.workspace_path = temp.path().to_path_buf();
        input.prompt = "/review https://example.test/pr/1\n\nUse /snow to verify things".into();
        let handle = launch_turn(server.to_str().unwrap(), &input, None, approvals, callback)
            .await
            .unwrap();
        let completed = tokio::time::timeout(Duration::from_secs(2), async {
            while !handle.disposed() {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await;
        if completed.is_err() {
            handle.terminate().await.unwrap();
            panic!("slash command turn did not complete");
        }
        let events = events.lock().unwrap();
        assert!(events
            .iter()
            .any(|event| event.message.contains("\"type\":\"result\"")));
        assert!(!events
            .iter()
            .any(|event| event.message.contains("command-name")));
        assert_eq!(
            events
                .iter()
                .filter(|event| event.r#type == ProviderRuntimeEventType::Exit)
                .count(),
            1
        );
        assert_eq!(events.last().and_then(|event| event.exit_code), Some(0));
    }

    // Claude replays a steered message only when it picks it up, and a turn
    // deep in a long tool call holds that for minutes. Delivery is decided by
    // the write, so a silent reader must not turn a delivered follow-up into
    // "Delivery uncertain".
    #[cfg(unix)]
    #[tokio::test]
    async fn steering_is_delivered_while_the_running_turn_withholds_its_echo() {
        use std::fs;
        use std::os::unix::fs::PermissionsExt;

        let temp = tempfile::tempdir().unwrap();
        let server = temp.path().join("fake-claude");
        fs::write(
            &server,
            r#"#!/bin/sh
user_count=0
while IFS= read -r line; do
  case "$line" in
    *'"subtype":"initialize"'*)
      printf '%s\n' '{"type":"control_response","response":{"subtype":"success","request_id":"argmax-initialize","response":{}}}'
      ;;
    *'"type":"user"'*)
      user_count=$((user_count + 1))
      if [ "$user_count" -eq 1 ]; then
        printf '%s\n' "$line"
      fi
      ;;
  esac
done
"#,
        )
        .unwrap();
        fs::set_permissions(&server, fs::Permissions::from_mode(0o755)).unwrap();

        let database = Arc::new(Database::open_in_memory().unwrap());
        let approvals = ApprovalService::new(database);
        let callback: EventCallback = Arc::new(move |_| {});
        let mut input = launch_input(
            PermissionMode::ProviderDefaults,
            super::super::AgentMode::Auto,
        );
        input.workspace_path = temp.path().to_path_buf();
        input.prompt = "original task".into();

        let handle = launch_turn(server.to_str().unwrap(), &input, None, approvals, callback)
            .await
            .unwrap();
        tokio::time::timeout(Duration::from_secs(2), handle.steer("steer-token"))
            .await
            .expect("steering does not wait on the model's own pace")
            .expect("a written follow-up is delivered");
        handle.terminate().await.unwrap();
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn fake_stream_json_process_acknowledges_steering_without_ending_the_turn() {
        use std::fs;
        use std::os::unix::fs::PermissionsExt;
        use std::sync::Mutex;

        let temp = tempfile::tempdir().unwrap();
        let server = temp.path().join("fake-claude");
        fs::write(
            &server,
            r#"#!/bin/sh
user_count=0
while IFS= read -r line; do
  case "$line" in
    *'"subtype":"initialize"'*)
      printf '%s\n' '{"type":"control_response","response":{"subtype":"success","request_id":"argmax-initialize","response":{}}}'
      ;;
    *'"type":"user"'*)
      user_count=$((user_count + 1))
      if [ "$user_count" -eq 1 ]; then
        printf '%s\n' "$line"
      else
        printf '%s\n' '{"type":"result","subtype":"success","is_error":false,"result":"original task checkpoint"}'
        printf '%s\n' "$line"
        printf '%s\n' '{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"tool-1","content":"tool completed"}]}}'
        printf '%s\n' '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"original complete with steer-token"}]}}'
        printf '%s\n' '{"type":"result","subtype":"success","is_error":false,"result":"original complete with steer-token"}'
        exit 0
      fi
      ;;
  esac
done
"#,
        )
        .unwrap();
        fs::set_permissions(&server, fs::Permissions::from_mode(0o755)).unwrap();

        let database = Arc::new(Database::open_in_memory().unwrap());
        let approvals = ApprovalService::new(database);
        let events = Arc::new(Mutex::new(Vec::new()));
        let captured = Arc::clone(&events);
        let callback: EventCallback = Arc::new(move |event| {
            captured.lock().unwrap().push(event);
        });
        let mut input = launch_input(
            PermissionMode::ProviderDefaults,
            super::super::AgentMode::Auto,
        );
        input.workspace_path = temp.path().to_path_buf();
        input.prompt = "original task".into();

        let handle = launch_turn(server.to_str().unwrap(), &input, None, approvals, callback)
            .await
            .unwrap();
        assert!(handle.supports_steering());
        handle.steer("steer-token").await.unwrap();

        tokio::time::timeout(Duration::from_secs(2), async {
            while !handle.disposed() {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("fake Claude turn completed");

        let events = events.lock().unwrap();
        assert!(events
            .iter()
            .any(|event| event.message.contains("original complete with steer-token")));
        assert!(!events
            .iter()
            .any(|event| event.message.contains("original task checkpoint")));
        assert!(events
            .iter()
            .any(|event| event.message.contains("\"type\":\"tool_result\"")));
        assert!(!events.iter().any(|event| {
            serde_json::from_str::<Value>(&event.message)
                .ok()
                .and_then(|message| replayed_user_prompt(&message).map(str::to_string))
                .is_some_and(|prompt| prompt == "original task" || prompt == "steer-token")
        }));
        assert_eq!(
            events
                .iter()
                .filter(|event| event.r#type == ProviderRuntimeEventType::Exit)
                .count(),
            1
        );
        assert_eq!(events.last().and_then(|event| event.exit_code), Some(0));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn answer_with_background_agent_running_holds_the_turn_until_it_reports() {
        use std::fs;
        use std::os::unix::fs::PermissionsExt;
        use std::sync::Mutex;

        let temp = tempfile::tempdir().unwrap();
        let server = temp.path().join("fake-claude");
        // Never exits on its own: the turn ends only when Argmax decides the
        // last answer was final and terminates the process group.
        fs::write(
            &server,
            r#"#!/bin/sh
while IFS= read -r line; do
  case "$line" in
    *'"subtype":"initialize"'*)
      printf '%s\n' '{"type":"control_response","response":{"subtype":"success","request_id":"argmax-initialize","response":{}}}'
      ;;
    *'"type":"user"'*)
      printf '%s\n' "$line"
      printf '%s\n' '{"type":"system","subtype":"task_started","task_id":"agent-1","tool_use_id":"toolu_agent","task_type":"local_agent","is_backgrounded":true,"description":"implement"}'
      printf '%s\n' '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"dispatched, waiting"}]}}'
      printf '%s\n' '{"type":"result","subtype":"success","is_error":false,"result":"dispatched, waiting"}'
      sleep 0.3
      printf '%s\n' '{"type":"system","subtype":"task_notification","task_id":"agent-1","tool_use_id":"toolu_agent","status":"completed","summary":"implement"}'
      printf '%s\n' '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"integrated the agent work"}]}}'
      printf '%s\n' '{"type":"result","subtype":"success","is_error":false,"result":"integrated the agent work"}'
      ;;
  esac
done
"#,
        )
        .unwrap();
        fs::set_permissions(&server, fs::Permissions::from_mode(0o755)).unwrap();

        let database = Arc::new(Database::open_in_memory().unwrap());
        let approvals = ApprovalService::new(database);
        let events = Arc::new(Mutex::new(Vec::new()));
        let captured = Arc::clone(&events);
        let callback: EventCallback = Arc::new(move |event| {
            captured.lock().unwrap().push(event);
        });
        let mut input = launch_input(
            PermissionMode::ProviderDefaults,
            super::super::AgentMode::Auto,
        );
        input.workspace_path = temp.path().to_path_buf();
        input.prompt = "implement with a background agent".into();

        let handle = launch_turn(server.to_str().unwrap(), &input, None, approvals, callback)
            .await
            .unwrap();
        tokio::time::timeout(Duration::from_secs(5), async {
            while !handle.disposed() {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("the turn ends once the agent has reported and the model answered again");

        let events = events.lock().unwrap();
        let position = |needle: &str| {
            events
                .iter()
                .position(|event| event.message.contains(needle))
                .unwrap_or_else(|| panic!("no event containing {needle:?}"))
        };
        let exit = events
            .iter()
            .position(|event| event.r#type == ProviderRuntimeEventType::Exit)
            .expect("one exit event");
        assert!(position("dispatched, waiting") < position("\"subtype\":\"task_notification\""));
        assert!(position("integrated the agent work") < exit);
        assert_eq!(events.last().and_then(|event| event.exit_code), Some(0));
    }

    #[ignore = "uses the installed Claude CLI and the developer account"]
    #[tokio::test]
    async fn live_claude_turn_consumes_steering_without_cancellation() {
        use std::sync::Mutex;

        let binary = std::env::var("ARGMAX_LIVE_CLAUDE_BIN")
            .expect("set ARGMAX_LIVE_CLAUDE_BIN to the installed Claude CLI");
        let temp = tempfile::tempdir().unwrap();
        let status = std::process::Command::new("git")
            .arg("init")
            .arg("--quiet")
            .arg(temp.path())
            .status()
            .unwrap();
        assert!(status.success());

        let original_token = format!("ORIGINAL-{}", uuid::Uuid::new_v4());
        let steer_token = format!("STEER-{}", uuid::Uuid::new_v4());
        let database = Arc::new(Database::open_in_memory().unwrap());
        let approvals = ApprovalService::new(database);
        let events = Arc::new(Mutex::new(Vec::new()));
        let captured = Arc::clone(&events);
        let callback: EventCallback = Arc::new(move |event| {
            captured.lock().unwrap().push(event);
        });
        let mut input = launch_input(PermissionMode::AutoApprove, super::super::AgentMode::Auto);
        input.session_id = uuid::Uuid::new_v4().to_string();
        input.workspace_path = temp.path().to_path_buf();
        input.model_label = "Haiku 4.5".into();
        input.model_id = "claude-haiku-4-5".into();
        input.prompt = format!(
            "Use the Bash tool to run sleep 5, then finish the original task by including this exact token in your final response: {original_token}"
        );
        let handle = launch_turn(&binary, &input, None, approvals, callback)
            .await
            .unwrap();
        let steer_prompt =
            format!("Also include this exact token in the same final response: {steer_token}");
        handle.steer(&steer_prompt).await.unwrap();

        tokio::time::timeout(Duration::from_secs(90), async {
            loop {
                if events.lock().unwrap().iter().any(|event| {
                    matches!(
                        event.r#type,
                        ProviderRuntimeEventType::Exit | ProviderRuntimeEventType::Error
                    )
                }) {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
        })
        .await
        .expect("live Claude steering probe completed");

        let events = events.lock().unwrap();
        let output = events
            .iter()
            .map(|event| event.message.as_str())
            .collect::<String>();
        assert!(
            output.contains(&original_token),
            "missing original token: {output}"
        );
        assert!(
            output.contains(&steer_token),
            "missing steering token: {output}"
        );
        assert!(!events.iter().any(|event| {
            serde_json::from_str::<Value>(&event.message)
                .ok()
                .and_then(|message| replayed_user_prompt(&message).map(str::to_string))
                .is_some_and(|prompt| prompt == input.prompt || prompt == steer_prompt)
        }));
        assert!(events.iter().any(|event| {
            serde_json::from_str::<Value>(&event.message)
                .ok()
                .and_then(|message| {
                    message
                        .pointer("/message/content")
                        .and_then(Value::as_array)
                        .map(|content| {
                            content.iter().any(|block| {
                                block.get("type").and_then(Value::as_str) == Some("tool_result")
                            })
                        })
                })
                == Some(true)
        }));
        assert!(events.iter().any(|event| {
            event.r#type == ProviderRuntimeEventType::Exit && event.exit_code == Some(0)
        }));
    }
}
