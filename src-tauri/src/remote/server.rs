// HTTP surface for the remote bridge: `/api/ws` plus the renderer bundle.
//
// Assets come from Tauri's embedded resolver so a packaged build serves the
// same bundle the webview loads. Dev builds point `frontendDist` at the Vite
// dev server, so the resolver is empty there — `ARGMAX_REMOTE_ASSETS=<dir>`
// serves a built `dist/` from disk instead.

use std::net::{Ipv4Addr, SocketAddr};
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;

use axum::body::Body;
use axum::extract::State as AxumState;
use axum::http::{header, StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::Router;
use tauri::AppHandle;

use super::RemoteConfig;

/// Env var pointing at a built renderer bundle. Only useful for dev builds,
/// where nothing is embedded in the binary.
const ASSET_DIR_ENV: &str = "ARGMAX_REMOTE_ASSETS";

const MISSING_ASSETS_HINT: &str = concat!(
    "remote assets are unavailable: this build has no embedded frontend. ",
    "Use a packaged build, or set ARGMAX_REMOTE_ASSETS to a built renderer directory."
);

pub struct RemoteBridge {
    pub app: AppHandle,
    pub token: String,
    assets: AssetSource,
}

enum AssetSource {
    /// `ARGMAX_REMOTE_ASSETS=<dir>`: serve from disk, confined to that root.
    Directory(PathBuf),
    /// Packaged builds: the frontend bundle Tauri embedded in the binary.
    Embedded,
}

impl AssetSource {
    fn from_env() -> Self {
        let Some(raw) = std::env::var_os(ASSET_DIR_ENV) else {
            return Self::Embedded;
        };
        match std::fs::canonicalize(&raw) {
            Ok(root) if root.is_dir() => Self::Directory(root),
            Ok(root) => {
                tracing::warn!(path = %root.display(), "{ASSET_DIR_ENV} is not a directory; using embedded assets");
                Self::Embedded
            }
            Err(error) => {
                tracing::warn!(
                    ?error,
                    "{ASSET_DIR_ENV} could not be resolved; using embedded assets"
                );
                Self::Embedded
            }
        }
    }
}

pub async fn serve(app: AppHandle, config: RemoteConfig) {
    let bridge = Arc::new(RemoteBridge {
        token: config.token,
        assets: AssetSource::from_env(),
        app,
    });
    let router = Router::new()
        .route("/api/ws", get(super::ws::upgrade))
        .fallback(serve_asset)
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

async fn serve_asset(AxumState(bridge): AxumState<Arc<RemoteBridge>>, uri: Uri) -> Response {
    let Ok(path) = crate::attachments::protocol::percent_decode(uri.path()) else {
        return StatusCode::BAD_REQUEST.into_response();
    };
    match &bridge.assets {
        AssetSource::Directory(root) => serve_from_directory(root, &path).await,
        AssetSource::Embedded => serve_embedded(&bridge.app, &path),
    }
}

fn serve_embedded(app: &AppHandle, path: &str) -> Response {
    let resolver = app.asset_resolver();
    let requested = normalize_request_path(path);
    if let Some(asset) = resolver.get(requested.clone()) {
        return asset_response(&asset.mime_type, asset.bytes);
    }
    let Some(index) = resolver.get("/index.html".to_string()) else {
        return (StatusCode::NOT_FOUND, MISSING_ASSETS_HINT).into_response();
    };
    // SPA fallback, but only for client routes: a missing `.js`/`.css` must 404
    // rather than quietly return HTML the browser cannot parse.
    if Path::new(&requested).extension().is_some() {
        return StatusCode::NOT_FOUND.into_response();
    }
    asset_response(&index.mime_type, index.bytes)
}

async fn serve_from_directory(root: &Path, path: &str) -> Response {
    let requested = normalize_request_path(path);
    let relative = requested.trim_start_matches('/');
    if relative.is_empty() {
        return StatusCode::NOT_FOUND.into_response();
    }
    if let Some(response) = read_contained(root, relative).await {
        return response;
    }
    if Path::new(relative).extension().is_some() {
        return StatusCode::NOT_FOUND.into_response();
    }
    read_contained(root, "index.html")
        .await
        .unwrap_or_else(|| (StatusCode::NOT_FOUND, MISSING_ASSETS_HINT).into_response())
}

/// Read one file from inside `root`. Returns `None` when it does not exist so
/// the caller can decide whether the SPA fallback applies; traversal attempts
/// are refused loudly with 403 instead.
async fn read_contained(root: &Path, relative: &str) -> Option<Response> {
    let candidate = Path::new(relative);
    if candidate.is_absolute()
        || candidate
            .components()
            .any(|component| matches!(component, Component::ParentDir | Component::Prefix(_)))
    {
        tracing::warn!(
            path = relative,
            "remote asset request escapes the asset root"
        );
        return Some(StatusCode::FORBIDDEN.into_response());
    }

    // canonicalize resolves symlinks, so the containment check below catches
    // links that point outside the root as well as `..` that slipped through.
    let resolved = tokio::fs::canonicalize(root.join(candidate)).await.ok()?;
    if !resolved.starts_with(root) {
        tracing::warn!(path = %resolved.display(), "remote asset request escapes the asset root");
        return Some(StatusCode::FORBIDDEN.into_response());
    }
    let bytes = tokio::fs::read(&resolved).await.ok()?;
    Some(asset_response(content_type_for_path(&resolved), bytes))
}

/// "" and "/" mean the app shell; everything else keeps its leading slash so it
/// matches the keys Tauri's asset resolver uses.
fn normalize_request_path(path: &str) -> String {
    if path.is_empty() || path == "/" {
        "/index.html".to_string()
    } else if path.starts_with('/') {
        path.to_string()
    } else {
        format!("/{path}")
    }
}

fn asset_response(content_type: &str, bytes: Vec<u8>) -> Response {
    (
        [(header::CONTENT_TYPE, content_type.to_string())],
        Body::from(bytes),
    )
        .into_response()
}

fn content_type_for_path(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|extension| extension.to_str())
        .map(|extension| extension.to_ascii_lowercase())
        .as_deref()
    {
        Some("html") => "text/html; charset=utf-8",
        Some("js") | Some("mjs") => "text/javascript; charset=utf-8",
        Some("css") => "text/css; charset=utf-8",
        Some("json") => "application/json",
        Some("svg") => "image/svg+xml",
        Some("png") => "image/png",
        Some("jpg") | Some("jpeg") => "image/jpeg",
        Some("gif") => "image/gif",
        Some("webp") => "image/webp",
        Some("ico") => "image/x-icon",
        Some("woff2") => "font/woff2",
        Some("woff") => "font/woff",
        Some("map") => "application/json",
        _ => "application/octet-stream",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn root_requests_resolve_to_the_app_shell() {
        assert_eq!(normalize_request_path(""), "/index.html");
        assert_eq!(normalize_request_path("/"), "/index.html");
        assert_eq!(normalize_request_path("/assets/app.js"), "/assets/app.js");
    }

    #[tokio::test]
    async fn directory_assets_are_confined_to_their_root() {
        let root = tempdir().expect("root");
        let root_path = std::fs::canonicalize(root.path()).expect("canonical root");
        std::fs::write(root_path.join("index.html"), "<!doctype html>").expect("write index");
        let outside = tempdir().expect("outside");
        std::fs::write(outside.path().join("secret.txt"), "nope").expect("write secret");

        let escape = read_contained(&root_path, "../secret.txt")
            .await
            .expect("traversal is answered, not skipped");
        assert_eq!(escape.status(), StatusCode::FORBIDDEN);

        assert!(read_contained(&root_path, "index.html").await.is_some());
        assert!(read_contained(&root_path, "missing.html").await.is_none());
    }

    #[tokio::test]
    async fn client_routes_fall_back_to_index_but_assets_do_not() {
        let root = tempdir().expect("root");
        let root_path = std::fs::canonicalize(root.path()).expect("canonical root");
        std::fs::write(root_path.join("index.html"), "<!doctype html>").expect("write index");

        let route = serve_from_directory(&root_path, "/sessions/abc").await;
        assert_eq!(route.status(), StatusCode::OK);

        let missing_asset = serve_from_directory(&root_path, "/assets/app.js").await;
        assert_eq!(missing_asset.status(), StatusCode::NOT_FOUND);
    }
}
