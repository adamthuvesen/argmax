//! Minimal Agent Client Protocol (ACP) client — the subset Argmax needs to
//! drive `cursor-agent acp` as a warm, long-lived process.
//!
//! ACP is newline-delimited JSON-RPC 2.0 over the child's stdio
//! (https://agentclientprotocol.com/protocol/v1/transports). This client is
//! hand-rolled rather than pinning the `agent-client-protocol` crate: Argmax
//! uses six methods and one inbound request, and the crate's 2.0 rewrite is a
//! far larger surface than that.
//!
//! Inbound agent requests: `fs/*` and `terminal/*` never fire because
//! `initialize` declares those capabilities false (the spec forbids the agent
//! from calling undeclared capabilities). `session/request_permission` is
//! delegated to the provider runtime so it can apply the launch's permission
//! mode and, when required, wait for Argmax's native approval broker.

use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use std::process::Stdio;
use std::sync::{
    atomic::{AtomicBool, AtomicU64, Ordering},
    Arc, Mutex,
};
use std::time::Duration;

use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::sync::{mpsc, oneshot};

use crate::error::{ArgmaxError, ArgmaxResult};
use crate::util::sync::LockOrRecover;

/// Bound on setup calls (initialize, session/new, session/load, set_model).
/// `session/prompt` is exempt — a turn legitimately runs for minutes.
const SETUP_REQUEST_TIMEOUT: Duration = Duration::from_secs(60);

type PendingMap = Arc<Mutex<HashMap<u64, oneshot::Sender<ArgmaxResult<Value>>>>>;
/// Each entry carries the token of the subscription that installed it, so a
/// displaced turn cannot unsubscribe the turn that replaced it.
type UpdateSubscribers = Arc<Mutex<HashMap<String, (u64, mpsc::UnboundedSender<Value>)>>>;

pub struct AcpPermissionRequest {
    pub request_id: Value,
    pub params: Value,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AcpPermissionDecision {
    Allow,
    Reject,
    Cancelled,
}

pub type AcpPermissionFuture = Pin<Box<dyn Future<Output = AcpPermissionDecision> + Send>>;
pub type AcpPermissionHandler =
    Arc<dyn Fn(AcpPermissionRequest) -> AcpPermissionFuture + Send + Sync>;

pub struct AcpClient {
    writer_tx: mpsc::UnboundedSender<String>,
    pending: PendingMap,
    subscribers: UpdateSubscribers,
    permission_handler: Option<AcpPermissionHandler>,
    next_id: AtomicU64,
    next_subscription: AtomicU64,
    dead: Arc<AtomicBool>,
    child: Mutex<Option<tokio::process::Child>>,
}

impl AcpClient {
    /// Spawn `binary acp` in `cwd` with the provider environment and wire up
    /// the reader/writer tasks. Does not run the `initialize` handshake.
    pub fn spawn(
        binary_path: &str,
        arguments: &[&str],
        cwd: &std::path::Path,
        environment: impl IntoIterator<Item = (String, String)>,
        permission_handler: Option<AcpPermissionHandler>,
    ) -> ArgmaxResult<Arc<Self>> {
        let mut command = tokio::process::Command::new(binary_path);
        command
            .args(arguments)
            .current_dir(cwd)
            .env_clear()
            .envs(environment)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            // The acp server does not exit on stdin EOF (verified empirically),
            // so tie its lifetime to this handle: dropping the pool kills it.
            .kill_on_drop(true);
        // Its own process group, so teardown reaches what it spawned. The ACP
        // server starts the MCP servers named in `session/new`, and those
        // children outlive a signal aimed at the server alone — an `argmax mcp`
        // process would then survive the app that started it.
        #[cfg(unix)]
        command.process_group(0);
        let mut child = command.spawn().map_err(|error| {
            ArgmaxError::service(
                "ACP_SPAWN_FAILED",
                format!("could not spawn ACP server: {error}"),
            )
        })?;

        let stdin = child.stdin.take().ok_or_else(|| {
            ArgmaxError::service("ACP_SPAWN_FAILED", "ACP child had no stdin pipe")
        })?;
        let stdout = child.stdout.take().ok_or_else(|| {
            ArgmaxError::service("ACP_SPAWN_FAILED", "ACP child had no stdout pipe")
        })?;

        let (writer_tx, writer_rx) = mpsc::unbounded_channel::<String>();
        let client = Arc::new(Self {
            writer_tx,
            pending: Arc::new(Mutex::new(HashMap::new())),
            subscribers: Arc::new(Mutex::new(HashMap::new())),
            permission_handler,
            next_id: AtomicU64::new(0),
            next_subscription: AtomicU64::new(0),
            dead: Arc::new(AtomicBool::new(false)),
            child: Mutex::new(Some(child)),
        });
        client.start_io(stdin, stdout, writer_rx);
        Ok(client)
    }

    fn start_io(
        self: &Arc<Self>,
        mut stdin: tokio::process::ChildStdin,
        stdout: tokio::process::ChildStdout,
        mut writer_rx: mpsc::UnboundedReceiver<String>,
    ) {
        tokio::spawn(async move {
            while let Some(line) = writer_rx.recv().await {
                if stdin.write_all(line.as_bytes()).await.is_err() {
                    break;
                }
                if stdin.write_all(b"\n").await.is_err() {
                    break;
                }
                let _ = stdin.flush().await;
            }
        });

        let reader_client = Arc::clone(self);
        tokio::spawn(async move {
            let mut lines = BufReader::new(stdout).lines();
            loop {
                match lines.next_line().await {
                    Ok(Some(line)) => reader_client.handle_line(&line),
                    Ok(None) => break,
                    Err(error) => {
                        tracing::warn!(?error, "ACP stdout read failed");
                        break;
                    }
                }
            }
            reader_client.mark_dead();
        });
    }

    fn handle_line(self: &Arc<Self>, line: &str) {
        let line = line.trim();
        if line.is_empty() {
            return;
        }
        let Ok(message) = serde_json::from_str::<Value>(line) else {
            tracing::debug!(line = %&line[..line.len().min(200)], "ACP non-JSON line ignored");
            return;
        };
        let id = message.get("id").cloned();
        let method = message.get("method").and_then(Value::as_str);
        match (id, method) {
            // Response to one of our requests.
            (Some(Value::Number(id)), None) => {
                let Some(id) = id.as_u64() else {
                    return;
                };
                let sender = self.pending.lock_or_recover("acp pending").remove(&id);
                if let Some(sender) = sender {
                    let result = if let Some(error) = message.get("error") {
                        Err(ArgmaxError::service(
                            "ACP_REQUEST_FAILED",
                            error.to_string(),
                        ))
                    } else {
                        Ok(message.get("result").cloned().unwrap_or(Value::Null))
                    };
                    let _ = sender.send(result);
                }
            }
            // Agent-initiated request — answer inline.
            (Some(id @ (Value::String(_) | Value::Number(_))), Some(method)) => {
                let client = Arc::clone(self);
                let method = method.to_string();
                let params = message.get("params").cloned().unwrap_or(Value::Null);
                tokio::spawn(async move {
                    client.answer_agent_request(id, &method, params).await;
                });
            }
            // Notification.
            (None, Some("session/update")) => {
                let Some(params) = message.get("params") else {
                    return;
                };
                let Some(session_id) = params.get("sessionId").and_then(Value::as_str) else {
                    return;
                };
                let subscribers = self.subscribers.lock_or_recover("acp subscribers");
                if let Some((_, sender)) = subscribers.get(session_id) {
                    let _ = sender.send(params.clone());
                }
            }
            (Some(_), Some(method)) => {
                tracing::warn!(method, "ACP request carried an invalid JSON-RPC id");
                let _ = self.writer_tx.send(
                    json!({
                        "jsonrpc": "2.0",
                        "id": Value::Null,
                        "error": { "code": -32600, "message": "Invalid request id" }
                    })
                    .to_string(),
                );
            }
            _ => {}
        }
    }

    async fn answer_agent_request(&self, id: Value, method: &str, params: Value) {
        if method != "session/request_permission" {
            tracing::warn!(method, "unexpected ACP agent request rejected");
            let _ = self.writer_tx.send(
                json!({
                    "jsonrpc": "2.0",
                    "id": id,
                    "error": { "code": -32601, "message": "Method not supported by this client" }
                })
                .to_string(),
            );
            return;
        }

        let options = params
            .get("options")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let structurally_valid = params.get("sessionId").and_then(Value::as_str).is_some()
            && params.get("toolCall").is_some_and(Value::is_object)
            && !options.is_empty();
        let decision = if structurally_valid {
            match self.permission_handler.as_ref() {
                Some(handler) => {
                    handler(AcpPermissionRequest {
                        request_id: id.clone(),
                        params: params.clone(),
                    })
                    .await
                }
                None => AcpPermissionDecision::Cancelled,
            }
        } else {
            AcpPermissionDecision::Cancelled
        };
        let wanted_kind = match decision {
            AcpPermissionDecision::Allow => Some("allow_once"),
            AcpPermissionDecision::Reject => Some("reject_once"),
            AcpPermissionDecision::Cancelled => None,
        };
        let option_id = wanted_kind.and_then(|wanted_kind| {
            options.iter().find_map(|option| {
                (option.get("kind").and_then(Value::as_str) == Some(wanted_kind))
                    .then(|| option.get("optionId").cloned())
                    .flatten()
            })
        });
        let result = match option_id {
            Some(option_id) => {
                json!({ "outcome": { "outcome": "selected", "optionId": option_id } })
            }
            None => json!({ "outcome": { "outcome": "cancelled" } }),
        };
        let _ = self
            .writer_tx
            .send(json!({ "jsonrpc": "2.0", "id": id, "result": result }).to_string());
    }

    fn mark_dead(&self) {
        self.dead.store(true, Ordering::SeqCst);
        let pending: Vec<_> = self
            .pending
            .lock_or_recover("acp pending")
            .drain()
            .collect();
        for (_, sender) in pending {
            let _ = sender.send(Err(ArgmaxError::service(
                "ACP_CONNECTION_DEAD",
                "ACP server exited",
            )));
        }
        // Dropping the senders closes every subscriber channel, so in-flight
        // turn tasks observe the death as end-of-stream.
        self.subscribers.lock_or_recover("acp subscribers").clear();
    }

    pub fn is_dead(&self) -> bool {
        self.dead.load(Ordering::SeqCst)
    }

    /// Subscribe to `session/update` notifications for one ACP session. The
    /// returned token identifies this subscription: a later subscribe on the
    /// same session displaces it, and `unsubscribe` only tears down the entry
    /// that still matches its token.
    pub fn subscribe(&self, acp_session_id: &str) -> (u64, mpsc::UnboundedReceiver<Value>) {
        let token = self.next_subscription.fetch_add(1, Ordering::SeqCst) + 1;
        let (tx, rx) = mpsc::unbounded_channel();
        self.subscribers
            .lock_or_recover("acp subscribers")
            .insert(acp_session_id.to_string(), (token, tx));
        (token, rx)
    }

    pub fn unsubscribe(&self, acp_session_id: &str, token: u64) {
        let mut subscribers = self.subscribers.lock_or_recover("acp subscribers");
        if subscribers
            .get(acp_session_id)
            .is_some_and(|(current, _)| *current == token)
        {
            subscribers.remove(acp_session_id);
        }
    }

    pub async fn request(&self, method: &str, params: Value) -> ArgmaxResult<Value> {
        let future = self.request_future(method, params)?;
        if method == "session/prompt" {
            return future.await;
        }
        tokio::time::timeout(SETUP_REQUEST_TIMEOUT, future)
            .await
            .map_err(|_| {
                ArgmaxError::service(
                    "ACP_REQUEST_TIMEOUT",
                    format!("ACP {method} timed out after {SETUP_REQUEST_TIMEOUT:?}"),
                )
            })?
    }

    fn request_future(
        &self,
        method: &str,
        params: Value,
    ) -> ArgmaxResult<impl std::future::Future<Output = ArgmaxResult<Value>>> {
        if self.is_dead() {
            return Err(ArgmaxError::service(
                "ACP_CONNECTION_DEAD",
                "ACP server exited",
            ));
        }
        let id = self.next_id.fetch_add(1, Ordering::SeqCst) + 1;
        let (tx, rx) = oneshot::channel();
        self.pending.lock_or_recover("acp pending").insert(id, tx);
        let line =
            json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params }).to_string();
        if self.writer_tx.send(line).is_err() {
            self.pending.lock_or_recover("acp pending").remove(&id);
            return Err(ArgmaxError::service(
                "ACP_CONNECTION_DEAD",
                "ACP writer closed",
            ));
        }
        Ok(async move {
            rx.await.unwrap_or_else(|_| {
                Err(ArgmaxError::service(
                    "ACP_CONNECTION_DEAD",
                    "ACP request dropped without a response",
                ))
            })
        })
    }

    pub fn notify(&self, method: &str, params: Value) {
        let _ = self
            .writer_tx
            .send(json!({ "jsonrpc": "2.0", "method": method, "params": params }).to_string());
    }

    /// Kill the child process and everything it spawned. Used on pool eviction
    /// and at app exit; `kill_on_drop` covers only the server itself, so the
    /// signal goes to its process group first.
    pub fn kill(&self) {
        if let Some(child) = self.child.lock_or_recover("acp child").as_mut() {
            #[cfg(unix)]
            if let Some(pid) = child.id() {
                crate::util::process_control::signal_target_term_and_kill_blocking(
                    crate::util::process_control::SignalTarget::ProcessGroup(pid),
                    None,
                );
            }
            let _ = child.start_kill();
        }
        self.mark_dead();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_client() -> (Arc<AcpClient>, mpsc::UnboundedReceiver<String>) {
        test_client_with_permission_handler(None)
    }

    fn test_client_with_permission_handler(
        permission_handler: Option<AcpPermissionHandler>,
    ) -> (Arc<AcpClient>, mpsc::UnboundedReceiver<String>) {
        let (writer_tx, writer_rx) = mpsc::unbounded_channel::<String>();
        let client = Arc::new(AcpClient {
            writer_tx,
            pending: Arc::new(Mutex::new(HashMap::new())),
            subscribers: Arc::new(Mutex::new(HashMap::new())),
            permission_handler,
            next_id: AtomicU64::new(0),
            next_subscription: AtomicU64::new(0),
            dead: Arc::new(AtomicBool::new(false)),
            child: Mutex::new(None),
        });
        (client, writer_rx)
    }

    #[tokio::test]
    async fn request_resolves_on_matching_response() {
        let (client, mut writer_rx) = test_client();
        let future = client
            .request_future("session/new", json!({"cwd": "/tmp"}))
            .unwrap();
        let sent: Value = serde_json::from_str(&writer_rx.recv().await.unwrap()).unwrap();
        assert_eq!(sent["method"], "session/new");
        let id = sent["id"].as_u64().unwrap();
        client.handle_line(
            &json!({"jsonrpc": "2.0", "id": id, "result": {"sessionId": "s1"}}).to_string(),
        );
        let result = future.await.unwrap();
        assert_eq!(result["sessionId"], "s1");
    }

    #[tokio::test]
    async fn error_response_becomes_err() {
        let (client, mut writer_rx) = test_client();
        let future = client
            .request_future("session/set_model", json!({}))
            .unwrap();
        let sent: Value = serde_json::from_str(&writer_rx.recv().await.unwrap()).unwrap();
        client.handle_line(
            &json!({"jsonrpc": "2.0", "id": sent["id"], "error": {"code": -32602, "message": "Invalid params"}})
                .to_string(),
        );
        assert!(future.await.is_err());
    }

    #[tokio::test]
    async fn updates_route_to_session_subscriber() {
        let (client, _writer_rx) = test_client();
        let (_token, mut updates) = client.subscribe("s1");
        client.handle_line(
            &json!({"jsonrpc": "2.0", "method": "session/update",
                    "params": {"sessionId": "s1", "update": {"sessionUpdate": "agent_message_chunk"}}})
            .to_string(),
        );
        client.handle_line(
            &json!({"jsonrpc": "2.0", "method": "session/update",
                    "params": {"sessionId": "other", "update": {"sessionUpdate": "agent_message_chunk"}}})
            .to_string(),
        );
        let update = updates.recv().await.unwrap();
        assert_eq!(update["sessionId"], "s1");
        assert!(updates.try_recv().is_err());
    }

    #[tokio::test]
    async fn permission_request_waits_and_echoes_opaque_id_before_allowing_once() {
        let (decision_tx, decision_rx) = oneshot::channel();
        let decision_rx = Arc::new(Mutex::new(Some(decision_rx)));
        let handler: AcpPermissionHandler = Arc::new(move |_| {
            let receiver = decision_rx
                .lock_or_recover("test permission")
                .take()
                .expect("called once");
            Box::pin(async move {
                if receiver.await.unwrap() {
                    AcpPermissionDecision::Allow
                } else {
                    AcpPermissionDecision::Reject
                }
            })
        });
        let (client, mut writer_rx) = test_client_with_permission_handler(Some(handler));
        client.handle_line(
            &json!({"jsonrpc": "2.0", "id": "permission-7", "method": "session/request_permission",
            "params": {"sessionId": "s1", "toolCall": {"toolCallId": "tool-1", "title": "Run"}, "options": [
                {"optionId": "reject", "kind": "reject_once"},
                {"optionId": "allow", "kind": "allow_once"}
            ]}})
            .to_string(),
        );
        assert!(
            writer_rx.try_recv().is_err(),
            "response must wait for the decision"
        );
        decision_tx.send(true).unwrap();
        let sent: Value = serde_json::from_str(&writer_rx.recv().await.unwrap()).unwrap();
        assert_eq!(sent["id"], "permission-7");
        assert_eq!(sent["result"]["outcome"]["outcome"], "selected");
        assert_eq!(sent["result"]["outcome"]["optionId"], "allow");
    }

    #[tokio::test]
    async fn denied_and_malformed_permission_requests_fail_closed() {
        let handler: AcpPermissionHandler =
            Arc::new(|_| Box::pin(async { AcpPermissionDecision::Reject }));
        let (client, mut writer_rx) = test_client_with_permission_handler(Some(handler));
        client.handle_line(
            &json!({"jsonrpc": "2.0", "id": 8, "method": "session/request_permission",
            "params": {"sessionId": "s1", "toolCall": {"toolCallId": "tool-1", "title": "Run"}, "options": [
                {"optionId": "always", "kind": "allow_always"},
                {"optionId": "reject", "kind": "reject_once"}
            ]}})
            .to_string(),
        );
        let denied: Value = serde_json::from_str(&writer_rx.recv().await.unwrap()).unwrap();
        assert_eq!(denied["result"]["outcome"]["optionId"], "reject");

        client.handle_line(
            &json!({"jsonrpc": "2.0", "id": "bad", "method": "session/request_permission",
                "params": {"options": [{"optionId": "allow", "kind": "allow_once"}]}})
            .to_string(),
        );
        let malformed: Value = serde_json::from_str(&writer_rx.recv().await.unwrap()).unwrap();
        assert_eq!(malformed["result"]["outcome"]["outcome"], "cancelled");
    }

    #[tokio::test]
    async fn unknown_agent_requests_return_method_not_found() {
        let (client, mut writer_rx) = test_client();
        client.handle_line(
            &json!({"jsonrpc": "2.0", "id": "fs-1", "method": "fs/read_text_file",
                "params": {"path": "/tmp/nope"}})
            .to_string(),
        );
        let response: Value = serde_json::from_str(&writer_rx.recv().await.unwrap()).unwrap();
        assert_eq!(response["id"], "fs-1");
        assert_eq!(response["error"]["code"], -32601);
    }

    #[tokio::test]
    async fn death_fails_pending_and_closes_subscribers() {
        let (client, _writer_rx) = test_client();
        let future = client.request_future("session/prompt", json!({})).unwrap();
        let (_token, mut updates) = client.subscribe("s1");
        client.mark_dead();
        assert!(future.await.is_err());
        assert!(updates.recv().await.is_none());
        assert!(client.request_future("session/new", json!({})).is_err());
    }

    #[tokio::test]
    async fn a_displaced_subscriber_cannot_unsubscribe_its_replacement() {
        let (client, _writer_rx) = test_client();
        let (first_token, mut first) = client.subscribe("s1");
        let (_second_token, mut second) = client.subscribe("s1");
        // The replaced turn observes end-of-stream and tears down its own
        // subscription; the replacement's must survive.
        assert!(first.recv().await.is_none());
        client.unsubscribe("s1", first_token);
        client.handle_line(
            &json!({"jsonrpc": "2.0", "method": "session/update",
                    "params": {"sessionId": "s1", "update": {"sessionUpdate": "agent_message_chunk"}}})
            .to_string(),
        );
        assert_eq!(second.recv().await.unwrap()["sessionId"], "s1");
    }
}
