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
    process::Stdio,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::Duration,
};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    sync::{mpsc, watch},
    task::JoinSet,
};

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
    let (write_tx, mut write_rx) = mpsc::unbounded_channel::<Value>();
    let writer = tokio::spawn(async move {
        while let Some(message) = write_rx.recv().await {
            stdin.write_all(format!("{message}\n").as_bytes()).await?;
            stdin.flush().await?;
        }
        Ok::<(), std::io::Error>(())
    });
    write_tx.send(json!({"type":"control_request", "request_id":"argmax-initialize", "request":{"subtype":"initialize","hooks":null}})).map_err(io_error)?;
    let (cancel, mut cancelled) = watch::channel(false);
    let (done_tx, done) = watch::channel(false);
    let disposed = Arc::new(AtomicBool::new(false));
    let handle = Arc::new(ControlHandle {
        cancel,
        done,
        disposed: disposed.clone(),
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
                            let _ = write_tx.send(json!({"type":"user","session_id":input.resume_conversation_id.as_deref().unwrap_or(&input.session_id),"message":{"role":"user","content":input.prompt},"parent_tool_use_id":null}));
                            emit_event(&emit,&input,ProviderRuntimeEventType::StreamStarted,String::new(),None);
                        }
                        Some("control_request") => {
                            let Some(id) = message.get("request_id").and_then(Value::as_str).map(str::to_string) else { continue; };
                            if message.pointer("/request/subtype").and_then(Value::as_str) != Some("can_use_tool") {
                                let _ = write_tx.send(json!({"type":"control_response","response":{"subtype":"error","request_id":id,"error":"Unsupported host request"}})); continue;
                            }
                            let broker = approvals.clone(); let request_input = input.clone(); let invocation = invocation.clone(); let writer = write_tx.clone(); let request_id = id.clone();
                            let task = requests.spawn(async move {
                                let tool_input = message.pointer("/request/input").cloned().unwrap_or(json!({}));
                                let command = tool_input.get("command").and_then(Value::as_str).map(str::to_string).unwrap_or_else(|| format!("{}\n{}", message.pointer("/request/tool_name").and_then(Value::as_str).unwrap_or("Tool request"), tool_input));
                                // Full access answers itself, the way both ACP
                                // providers do. Claude still prompts under
                                // `--dangerously-skip-permissions` when a settings
                                // `ask` rule forces it, and routing that to the
                                // broker parks a session the user was told would
                                // never stop. Plan mode keeps its gate.
                                if request_input.permission_mode == PermissionMode::AutoApprove
                                    && request_input.agent_mode == super::AgentMode::Auto
                                {
                                    let _ = writer.send(permission_response(&request_id, true, tool_input));
                                    return;
                                }
                                let allowed = broker.request_native(&request_input.session_id,&invocation,&request_id,&command,&request_input.workspace_path.to_string_lossy(),"claude").await;
                                let response = match allowed {
                                    Ok(allowed) => permission_response(&request_id, allowed, tool_input),
                                    Err(error) => json!({"type":"control_response","response":{"subtype":"error","request_id":request_id,"error":error.to_string()}}),
                                };
                                let _ = writer.send(response);
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
                            emit_event(&emit,&input,ProviderRuntimeEventType::Output,format!("{line}\n"),None);
                            if message.get("type").and_then(Value::as_str) == Some("result") { if message.get("is_error").and_then(Value::as_bool) == Some(true) { code=1; } break; }
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
}
impl ProviderRuntimeHandle for ControlHandle {
    fn accepts_input(&self) -> bool {
        false
    }
    fn disposed(&self) -> bool {
        self.disposed.load(Ordering::SeqCst)
    }
    fn send_input(&self, _: &str) {}
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
}
