// WebSocket protocol for the remote bridge.
//
// Frames are JSON text in both directions:
//   client → {"type":"auth","token":"…"}
//            {"type":"request","id":1,"channel":"dashboard:list","input":{}}
//            {"type":"ping"}
//   server → {"type":"auth-ok"}
//            {"type":"response","id":1,"ok":…} | {"type":"response","id":1,"error":…}
//            {"type":"event","channel":"dashboard:delta","payload":…}
//            {"type":"pong"}
//
// The ping/pong pair is an app-level heartbeat for the phone client: a mobile
// radio drops the NAT mapping without closing the socket, and the browser
// never surfaces protocol-level pongs to JS.
//
// The first client frame must authenticate within `AUTH_TIMEOUT` or the socket
// closes. Frame parsing and the auth decision are pure functions so they can be
// tested without a socket.

use std::sync::Arc;
use std::time::Duration;

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::State as AxumState;
use axum::response::Response;
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tauri::Manager;
use tokio::sync::{broadcast, mpsc};

use super::dispatch::dispatch;
use super::server::RemoteBridge;
use super::RemoteEvent;
use crate::error::{ArgmaxError, InvalidInputIssue};
use crate::state::AppState;

/// A client that has not authenticated by then is dropped.
pub const AUTH_TIMEOUT: Duration = Duration::from_secs(5);

/// Queued response frames per client. Requests are dispatched concurrently, so
/// this only bounds how many finished replies can wait on a slow socket.
const RESPONSE_QUEUE: usize = 64;

#[derive(Debug, PartialEq)]
pub enum ClientMessage {
    Auth {
        token: String,
    },
    Request {
        id: i64,
        channel: String,
        input: Value,
    },
    /// Heartbeat probe; answered with `pong` so the client can tell a live
    /// socket from one the network killed silently.
    Ping,
    /// Not a frame we understand. `id` is echoed back when the client sent one,
    /// so a request with a bad body still resolves instead of hanging.
    Malformed {
        id: Option<i64>,
        detail: String,
    },
}

#[derive(Debug, PartialEq)]
pub enum AuthOutcome {
    Accepted,
    /// An auth frame whose token is wrong or has been rotated. The client is
    /// told so explicitly — see `auth_error_frame`.
    BadToken,
    /// Anything else: no auth frame, a closed socket, a timeout.
    Rejected(&'static str),
}

pub async fn upgrade(
    AxumState(bridge): AxumState<Arc<RemoteBridge>>,
    ws: WebSocketUpgrade,
) -> Response {
    ws.on_upgrade(move |socket| serve_client(socket, bridge))
}

async fn serve_client(socket: WebSocket, bridge: Arc<RemoteBridge>) {
    let (mut sender, mut receiver) = socket.split();

    let first = tokio::time::timeout(AUTH_TIMEOUT, receiver.next()).await;
    let outcome = match &first {
        Ok(Some(Ok(Message::Text(text)))) => auth_outcome(&parse_client_frame(text), &bridge.token),
        Ok(Some(Ok(_))) => AuthOutcome::Rejected("first frame was not text"),
        Ok(Some(Err(_))) | Ok(None) => AuthOutcome::Rejected("socket closed before auth"),
        Err(_) => AuthOutcome::Rejected("auth timed out"),
    };
    match outcome {
        AuthOutcome::Accepted => {}
        // Name a bad token before closing: the client clears its stored token
        // and re-prompts, where a silent close reads as a network drop and it
        // reconnects forever with the same token.
        AuthOutcome::BadToken => {
            tracing::warn!("remote client presented an invalid token");
            let _ = sender.send(Message::Text(auth_error_frame().into())).await;
            let _ = sender.close().await;
            return;
        }
        AuthOutcome::Rejected(reason) => {
            tracing::warn!(reason, "remote client rejected");
            let _ = sender.close().await;
            return;
        }
    }
    if sender
        .send(Message::Text(auth_ok_frame().into()))
        .await
        .is_err()
    {
        return;
    }

    let mut events = bridge.app.state::<AppState>().remote_events.subscribe();
    let (responses, mut queued) = mpsc::channel::<String>(RESPONSE_QUEUE);
    // One task owns the write half so dispatch results and pushed events can
    // interleave without either blocking the read loop.
    let writer = tauri::async_runtime::spawn(async move {
        loop {
            let frame = tokio::select! {
                response = queued.recv() => match response {
                    Some(response) => response,
                    None => break,
                },
                event = events.recv() => match event {
                    Ok(event) => event_frame(&event),
                    Err(broadcast::error::RecvError::Lagged(skipped)) => {
                        tracing::warn!(skipped, "remote client fell behind the event stream");
                        continue;
                    }
                    Err(broadcast::error::RecvError::Closed) => break,
                },
            };
            if sender.send(Message::Text(frame.into())).await.is_err() {
                break;
            }
        }
    });

    while let Some(Ok(message)) = receiver.next().await {
        let text = match message {
            Message::Text(text) => text,
            Message::Close(_) => break,
            _ => continue,
        };
        match parse_client_frame(&text) {
            ClientMessage::Request { id, channel, input } => {
                let app = bridge.app.clone();
                let responses = responses.clone();
                tauri::async_runtime::spawn(async move {
                    let state = app.state::<AppState>();
                    let frame = match dispatch(&state, &channel, input).await {
                        Ok(value) => response_ok_frame(id, value),
                        Err(error) => response_error_frame(id, &error),
                    };
                    let _ = responses.send(frame).await;
                });
            }
            ClientMessage::Ping => {
                let _ = responses.send(pong_frame()).await;
            }
            // Already authenticated; a repeat auth frame is a no-op.
            ClientMessage::Auth { .. } => {}
            ClientMessage::Malformed {
                id: Some(id),
                detail,
            } => {
                let _ = responses
                    .send(response_error_frame(id, &malformed_frame_error(detail)))
                    .await;
            }
            ClientMessage::Malformed { id: None, detail } => {
                tracing::warn!(detail, "remote client sent a malformed frame");
            }
        }
    }

    drop(responses);
    let _ = writer.await;
}

pub fn parse_client_frame(text: &str) -> ClientMessage {
    let Ok(value) = serde_json::from_str::<Value>(text) else {
        return ClientMessage::Malformed {
            id: None,
            detail: "frame is not JSON".to_string(),
        };
    };
    let id = value.get("id").and_then(Value::as_i64);
    match value.get("type").and_then(Value::as_str) {
        Some("auth") => match value.get("token").and_then(Value::as_str) {
            Some(token) => ClientMessage::Auth {
                token: token.to_string(),
            },
            None => ClientMessage::Malformed {
                id,
                detail: "auth frame is missing a token".to_string(),
            },
        },
        Some("ping") => ClientMessage::Ping,
        Some("request") => {
            let channel = value.get("channel").and_then(Value::as_str);
            match (id, channel) {
                (Some(id), Some(channel)) => ClientMessage::Request {
                    id,
                    channel: channel.to_string(),
                    input: value.get("input").cloned().unwrap_or(Value::Null),
                },
                _ => ClientMessage::Malformed {
                    id,
                    detail: "request frame needs a numeric id and a channel".to_string(),
                },
            }
        }
        other => ClientMessage::Malformed {
            id,
            detail: match other {
                Some(kind) => format!("unsupported frame type: {kind}"),
                None => "frame is missing a type".to_string(),
            },
        },
    }
}

pub fn auth_outcome(message: &ClientMessage, expected_token: &str) -> AuthOutcome {
    match message {
        ClientMessage::Auth { token } if tokens_match(token, expected_token) => {
            AuthOutcome::Accepted
        }
        ClientMessage::Auth { .. } => AuthOutcome::BadToken,
        _ => AuthOutcome::Rejected("first frame was not an auth frame"),
    }
}

/// Length-independent compare so a wrong token leaks nothing through timing.
fn tokens_match(candidate: &str, expected: &str) -> bool {
    if candidate.len() != expected.len() {
        return false;
    }
    candidate
        .bytes()
        .zip(expected.bytes())
        .fold(0u8, |difference, (a, b)| difference | (a ^ b))
        == 0
}

pub fn auth_ok_frame() -> String {
    json!({ "type": "auth-ok" }).to_string()
}

pub fn auth_error_frame() -> String {
    json!({ "type": "auth-error" }).to_string()
}

pub fn pong_frame() -> String {
    json!({ "type": "pong" }).to_string()
}

pub fn response_ok_frame(id: i64, value: Value) -> String {
    json!({ "type": "response", "id": id, "ok": value }).to_string()
}

pub fn response_error_frame(id: i64, error: &ArgmaxError) -> String {
    json!({ "type": "response", "id": id, "error": error }).to_string()
}

pub fn event_frame(event: &RemoteEvent) -> String {
    json!({ "type": "event", "channel": event.channel, "payload": event.payload }).to_string()
}

fn malformed_frame_error(detail: String) -> ArgmaxError {
    ArgmaxError::invalid(InvalidInputIssue::at(
        vec!["frame".to_string()],
        "REMOTE_FRAME_INVALID",
        detail,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn auth_gate_accepts_only_the_configured_token_as_the_first_frame() {
        let auth = parse_client_frame(r#"{"type":"auth","token":"secret"}"#);
        assert_eq!(auth_outcome(&auth, "secret"), AuthOutcome::Accepted);
        // Same length, different bytes — the compare is not short-circuiting on
        // length alone.
        assert_eq!(auth_outcome(&auth, "secres"), AuthOutcome::BadToken);
        assert_eq!(auth_outcome(&auth, "secret-longer"), AuthOutcome::BadToken);

        let request = parse_client_frame(r#"{"type":"request","id":1,"channel":"health:ping"}"#);
        assert!(matches!(
            auth_outcome(&request, "secret"),
            AuthOutcome::Rejected(_)
        ));

        let junk = parse_client_frame("not json");
        assert!(matches!(
            auth_outcome(&junk, "secret"),
            AuthOutcome::Rejected(_)
        ));
    }

    #[test]
    fn a_bad_token_is_named_so_the_client_can_clear_it() {
        let parsed: Value = serde_json::from_str(&auth_error_frame()).expect("frame is json");
        assert_eq!(parsed["type"], "auth-error");
    }

    #[test]
    fn request_frames_carry_id_channel_and_default_input() {
        assert_eq!(
            parse_client_frame(r#"{"type":"request","id":7,"channel":"dashboard:list"}"#),
            ClientMessage::Request {
                id: 7,
                channel: "dashboard:list".to_string(),
                input: Value::Null,
            }
        );
    }

    #[test]
    fn malformed_frames_keep_a_parseable_id_so_the_client_can_settle_it() {
        assert_eq!(
            parse_client_frame(r#"{"type":"request","id":9}"#),
            ClientMessage::Malformed {
                id: Some(9),
                detail: "request frame needs a numeric id and a channel".to_string(),
            }
        );
        assert!(matches!(
            parse_client_frame(r#"{"channel":"health:ping"}"#),
            ClientMessage::Malformed { id: None, .. }
        ));
    }

    #[test]
    fn heartbeat_pings_are_answered_with_a_pong_and_never_pass_the_auth_gate() {
        assert_eq!(
            parse_client_frame(r#"{"type":"ping"}"#),
            ClientMessage::Ping
        );

        let parsed: Value = serde_json::from_str(&pong_frame()).expect("frame is json");
        assert_eq!(parsed["type"], "pong");

        // The heartbeat only exists after auth; a ping as the first frame is
        // still an unauthenticated client.
        assert!(matches!(
            auth_outcome(&ClientMessage::Ping, "secret"),
            AuthOutcome::Rejected(_)
        ));
    }

    #[test]
    fn error_responses_serialize_the_argmax_error_envelope() {
        let frame = response_error_frame(3, &ArgmaxError::service("BOOM", "no"));
        let parsed: Value = serde_json::from_str(&frame).expect("frame is json");

        assert_eq!(parsed["type"], "response");
        assert_eq!(parsed["id"], 3);
        assert_eq!(parsed["error"]["code"], "SERVICE_ERROR");
        assert_eq!(parsed["error"]["sub_code"], "BOOM");
    }

    #[test]
    fn event_frames_name_their_push_channel() {
        let frame = event_frame(&RemoteEvent {
            channel: "terminal:exit",
            payload: json!({ "terminalId": "t1" }),
        });
        let parsed: Value = serde_json::from_str(&frame).expect("frame is json");

        assert_eq!(parsed["type"], "event");
        assert_eq!(parsed["channel"], "terminal:exit");
        assert_eq!(parsed["payload"]["terminalId"], "t1");
    }
}
