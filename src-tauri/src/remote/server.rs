// HTTP surface for the remote bridge: `/api/ws`, `/api/transcript`, and the
// authenticated attachment and workspace-asset reads the iPhone app makes.

use std::net::{Ipv4Addr, SocketAddr};
use std::sync::Arc;

use axum::body::{Body, Bytes};
use axum::extract::{DefaultBodyLimit, State as AxumState};
use axum::http::{header, HeaderMap, StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::Value;
use tauri::{AppHandle, Manager};
use tokio::sync::Semaphore;

use super::RemoteConfig;

pub struct RemoteBridge {
    pub app: AppHandle,
    pub token: String,
    transcript_slots: Semaphore,
}

pub async fn serve(app: AppHandle, config: RemoteConfig) {
    let bridge = Arc::new(RemoteBridge {
        token: config.token,
        transcript_slots: Semaphore::new(16),
        app,
    });
    let router = Router::new()
        .route("/api/ws", get(super::ws::upgrade))
        .route(
            "/api/transcript",
            post(serve_transcript).layer(DefaultBodyLimit::max(64 * 1024)),
        )
        .fallback(serve_api_file)
        // Gzip the HTTP responses. The layer skips the WebSocket upgrade on
        // its own: 101 responses carry no body.
        .layer(tower_http::compression::CompressionLayer::new())
        .with_state(bridge);

    // Loopback only. Tailscale Serve owns tailnet exposure; binding a routable
    // address here would put an unproxied token gate on the network.
    let address = SocketAddr::from((Ipv4Addr::LOCALHOST, config.port));
    let listener = match tokio::net::TcpListener::bind(address).await {
        Ok(listener) => listener,
        Err(error) => {
            tracing::warn!(?error, %address, "remote bridge failed to bind");
            return;
        }
    };
    tracing::info!(%address, "remote bridge listening");
    if let Err(error) = axum::serve(listener, router).await {
        tracing::warn!(?error, "remote bridge stopped");
    }
}

/// Only transcript reads may bypass the WebSocket message ceiling. Re-reading
/// the same cursors is safe because the rejected WS reply was never applied.
pub(super) fn is_transcript_channel(channel: &str) -> bool {
    matches!(
        channel,
        "session:events-since"
            | "session:agent-events"
            | "visualization:read"
            | "visualization:export"
    )
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct TranscriptRequest {
    channel: String,
    input: Value,
}

fn transcript_request(
    token: &str,
    headers: &HeaderMap,
    uri: &Uri,
    body: &[u8],
) -> Result<TranscriptRequest, StatusCode> {
    if !authenticate_token(token, headers, uri) {
        return Err(StatusCode::UNAUTHORIZED);
    }
    let request: TranscriptRequest =
        serde_json::from_slice(body).map_err(|_| StatusCode::BAD_REQUEST)?;
    if !is_transcript_channel(&request.channel) {
        return Err(StatusCode::FORBIDDEN);
    }
    Ok(request)
}

async fn serve_transcript(
    AxumState(bridge): AxumState<Arc<RemoteBridge>>,
    headers: HeaderMap,
    uri: Uri,
    body: Bytes,
) -> Response {
    let request = match transcript_request(&bridge.token, &headers, &uri, &body) {
        Ok(request) => request,
        Err(status) => return status.into_response(),
    };
    let Ok(_slot) = bridge.transcript_slots.try_acquire() else {
        return StatusCode::TOO_MANY_REQUESTS.into_response();
    };
    let state = bridge.app.state::<crate::state::AppState>();
    let result = super::dispatch::dispatch(&state, &request.channel, request.input).await;
    (
        [(header::CACHE_CONTROL, "no-store")],
        Json(super::operations::outcome(result)),
    )
        .into_response()
}

async fn serve_api_file(
    AxumState(bridge): AxumState<Arc<RemoteBridge>>,
    headers: HeaderMap,
    uri: Uri,
) -> Response {
    if uri.path().starts_with("/api/attachments") {
        return serve_remote_attachment(&bridge, &headers, &uri).await;
    }
    if uri.path().starts_with("/api/workspace-assets") {
        return serve_remote_workspace_asset(&bridge, &headers, &uri).await;
    }
    StatusCode::NOT_FOUND.into_response()
}

fn authenticate_token(expected_token: &str, headers: &HeaderMap, uri: &Uri) -> bool {
    if let Some(auth_header) = headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
    {
        if let Some(token) = auth_header.strip_prefix("Bearer ") {
            if super::ws::tokens_match(token.trim(), expected_token) {
                return true;
            }
        }
    }
    if let Some(query) = uri.query() {
        for pair in query.split('&') {
            if let Some(token) = pair.strip_prefix("token=") {
                let decoded = crate::attachments::protocol::percent_decode(token)
                    .unwrap_or_else(|_| token.to_string());
                if super::ws::tokens_match(&decoded, expected_token) {
                    return true;
                }
            }
        }
    }
    false
}

async fn serve_remote_attachment(
    bridge: &RemoteBridge,
    headers: &HeaderMap,
    uri: &Uri,
) -> Response {
    if !authenticate_token(&bridge.token, headers, uri) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    let Some(raw_path) = uri.path().strip_prefix("/api/attachments") else {
        return StatusCode::BAD_REQUEST.into_response();
    };
    if raw_path.is_empty() || !raw_path.starts_with('/') {
        return StatusCode::BAD_REQUEST.into_response();
    }
    let Ok(decoded_path) = crate::attachments::protocol::percent_decode(raw_path) else {
        return StatusCode::BAD_REQUEST.into_response();
    };
    let app_data = match crate::util::data_dir::app_data_dir(&bridge.app) {
        Ok(dir) => dir,
        Err(error) => {
            tracing::warn!(?error, "remote attachment: app_data_dir unavailable");
            return StatusCode::INTERNAL_SERVER_ERROR.into_response();
        }
    };
    let base_dir = app_data.join("local-state").join("attachments");
    let response =
        crate::attachments::protocol::serve_attachment_path(&base_dir, &decoded_path).await;
    let mut builder = Response::builder().status(response.http_status());
    if let Some(content_type) = response.content_type {
        builder = builder.header(header::CONTENT_TYPE, content_type);
    }
    if response.http_status() == 200 {
        builder = builder.header(header::CACHE_CONTROL, "private, max-age=3600");
    }
    match builder.body(Body::from(response.bytes)) {
        Ok(resp) => resp,
        Err(_) => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    }
}

async fn serve_remote_workspace_asset(
    bridge: &RemoteBridge,
    headers: &HeaderMap,
    uri: &Uri,
) -> Response {
    if !authenticate_token(&bridge.token, headers, uri) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    let Some(raw_path) = uri.path().strip_prefix("/api/workspace-assets") else {
        return StatusCode::BAD_REQUEST.into_response();
    };
    if raw_path.is_empty() || !raw_path.starts_with('/') {
        return StatusCode::BAD_REQUEST.into_response();
    }
    let Ok(decoded_path) = crate::attachments::protocol::percent_decode(raw_path) else {
        return StatusCode::BAD_REQUEST.into_response();
    };
    let roots = crate::workspace_assets::protocol::known_roots(&bridge.app);
    let response =
        crate::workspace_assets::protocol::serve_workspace_asset_path(&roots, &decoded_path).await;
    let mut builder = Response::builder().status(response.http_status());
    if let Some(content_type) = response.content_type {
        builder = builder.header(header::CONTENT_TYPE, content_type);
    }
    if response.http_status() == 200 {
        builder = builder.header(header::CACHE_CONTROL, "private, max-age=3600");
    }
    match builder.body(Body::from(response.bytes)) {
        Ok(resp) => resp,
        Err(_) => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::HeaderValue;

    #[test]
    fn transcript_http_requires_authentication_before_reading_the_request() {
        let uri = Uri::from_static("/api/transcript");
        assert!(matches!(
            transcript_request("secret", &HeaderMap::new(), &uri, b"invalid json"),
            Err(StatusCode::UNAUTHORIZED)
        ));
        let mut headers = HeaderMap::new();
        headers.insert(
            header::AUTHORIZATION,
            HeaderValue::from_static("Bearer wrong"),
        );
        assert!(matches!(
            transcript_request(
                "secret",
                &headers,
                &uri,
                br#"{"channel":"session:events-since","input":{}}"#
            ),
            Err(StatusCode::UNAUTHORIZED)
        ));
    }

    #[test]
    fn transcript_http_preserves_read_cursors_and_rejects_other_channels() {
        let uri = Uri::from_static("/api/transcript");
        let mut headers = HeaderMap::new();
        headers.insert(
            header::AUTHORIZATION,
            HeaderValue::from_static("Bearer secret"),
        );
        for channel in [
            "session:events-since",
            "session:agent-events",
            "visualization:read",
            "visualization:export",
        ] {
            let input =
                serde_json::json!({"sessionId": "s1", "changeCursor": 37, "eventCursor": 8});
            let body = serde_json::json!({"channel": channel, "input": input}).to_string();
            let request = transcript_request("secret", &headers, &uri, body.as_bytes()).unwrap();
            assert_eq!(request.channel, channel);
            assert_eq!(request.input, input);
        }
        for channel in [
            "providers:launch",
            "session:stop",
            "visualization:publish",
            "visualization:import",
            "visualization:set-state",
            "dashboard:list",
            "unknown",
        ] {
            let body = serde_json::json!({"channel": channel, "input": {}}).to_string();
            assert!(matches!(
                transcript_request("secret", &headers, &uri, body.as_bytes()),
                Err(StatusCode::FORBIDDEN)
            ));
        }
        for body in [
            b"invalid".as_slice(),
            br#"{"channel":"session:events-since"}"#,
            br#"{"channel":"session:events-since","input":{},"operation":{}}"#,
        ] {
            assert!(matches!(
                transcript_request("secret", &headers, &uri, body),
                Err(StatusCode::BAD_REQUEST)
            ));
        }
    }

    #[test]
    fn authenticate_token_accepts_bearer_and_query_param() {
        let expected_token = "0123456789abcdef0123456789abcdef";

        let headers = HeaderMap::new();
        let uri = "/api/attachments/some/file.png".parse::<Uri>().unwrap();
        assert!(!authenticate_token(expected_token, &headers, &uri));

        let mut bearer_headers = HeaderMap::new();
        bearer_headers.insert(
            header::AUTHORIZATION,
            HeaderValue::from_static("Bearer 0123456789abcdef0123456789abcdef"),
        );
        assert!(authenticate_token(expected_token, &bearer_headers, &uri));

        let mut wrong_bearer = HeaderMap::new();
        wrong_bearer.insert(
            header::AUTHORIZATION,
            HeaderValue::from_static("Bearer wrong_token_000000000000000000"),
        );
        assert!(!authenticate_token(expected_token, &wrong_bearer, &uri));

        let uri_with_token =
            "/api/attachments/some/file.png?token=0123456789abcdef0123456789abcdef"
                .parse::<Uri>()
                .unwrap();
        assert!(authenticate_token(
            expected_token,
            &headers,
            &uri_with_token
        ));

        let uri_with_wrong = "/api/attachments/some/file.png?token=wrong_token_000000000000000000"
            .parse::<Uri>()
            .unwrap();
        assert!(!authenticate_token(
            expected_token,
            &headers,
            &uri_with_wrong
        ));
    }
}
