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
use axum::http::{header, HeaderMap, HeaderValue, StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::Router;
use sha2::{Digest, Sha256};
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
        // Gzip the asset responses (~4:1 on JS/CSS). The layer skips the
        // WebSocket upgrade on its own: 101 responses carry no body.
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

async fn serve_asset(
    AxumState(bridge): AxumState<Arc<RemoteBridge>>,
    headers: HeaderMap,
    uri: Uri,
) -> Response {
    let Ok(path) = crate::attachments::protocol::percent_decode(uri.path()) else {
        return StatusCode::BAD_REQUEST.into_response();
    };
    let if_none_match = headers
        .get(header::IF_NONE_MATCH)
        .and_then(|value| value.to_str().ok());
    match &bridge.assets {
        AssetSource::Directory(root) => serve_from_directory(root, &path, if_none_match).await,
        AssetSource::Embedded => serve_embedded(&bridge.app, &path, if_none_match),
    }
}

fn serve_embedded(app: &AppHandle, path: &str, if_none_match: Option<&str>) -> Response {
    let resolver = app.asset_resolver();
    let requested = normalize_request_path(path);
    if let Some(asset) = resolver.get(requested.clone()) {
        return asset_response(
            &asset.mime_type,
            asset.bytes,
            cache_control_for(&requested),
            if_none_match,
        );
    }
    let Some(index) = resolver.get("/index.html".to_string()) else {
        return (StatusCode::NOT_FOUND, MISSING_ASSETS_HINT).into_response();
    };
    // SPA fallback, but only for client routes: a missing `.js`/`.css` must 404
    // rather than quietly return HTML the browser cannot parse.
    if Path::new(&requested).extension().is_some() {
        return StatusCode::NOT_FOUND.into_response();
    }
    // The fallback is the shell whatever path asked for it, so it is never
    // immutable even when the request looked like an asset.
    asset_response(
        &index.mime_type,
        index.bytes,
        REVALIDATE_CACHE_CONTROL,
        if_none_match,
    )
}

async fn serve_from_directory(root: &Path, path: &str, if_none_match: Option<&str>) -> Response {
    let requested = normalize_request_path(path);
    let relative = requested.trim_start_matches('/');
    if relative.is_empty() {
        return StatusCode::NOT_FOUND.into_response();
    }
    if let Some(response) =
        read_contained(root, relative, cache_control_for(&requested), if_none_match).await
    {
        return response;
    }
    if Path::new(relative).extension().is_some() {
        return StatusCode::NOT_FOUND.into_response();
    }
    read_contained(root, "index.html", REVALIDATE_CACHE_CONTROL, if_none_match)
        .await
        .unwrap_or_else(|| (StatusCode::NOT_FOUND, MISSING_ASSETS_HINT).into_response())
}

/// Read one file from inside `root`. Returns `None` when it does not exist so
/// the caller can decide whether the SPA fallback applies; traversal attempts
/// are refused loudly with 403 instead.
async fn read_contained(
    root: &Path,
    relative: &str,
    cache_control: &str,
    if_none_match: Option<&str>,
) -> Option<Response> {
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
    Some(asset_response(
        content_type_for_path(&resolved),
        bytes,
        cache_control,
        if_none_match,
    ))
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

/// Vite content-hashes every filename under `/assets/`, so the bytes behind one
/// of those URLs can never change — without this the phone re-downloads the
/// whole bundle on every reload, since a response with no `Cache-Control`,
/// `ETag`, or `Last-Modified` gives the browser nothing to cache or revalidate
/// against.
const IMMUTABLE_CACHE_CONTROL: &str = "public, max-age=31536000, immutable";
/// The shell keeps its URL across builds, so it has to revalidate or a new
/// build never reaches an already-paired phone.
const REVALIDATE_CACHE_CONTROL: &str = "no-cache";

/// Keyed on the requested path, never the resolved one: the SPA fallback serves
/// the shell's bytes under whatever path was asked for.
fn cache_control_for(requested: &str) -> &'static str {
    if requested.starts_with("/assets/") {
        IMMUTABLE_CACHE_CONTROL
    } else {
        REVALIDATE_CACHE_CONTROL
    }
}

/// Strong validator for a body, so `no-cache` can actually revalidate.
///
/// Content addressing rather than a timestamp: the bytes are embedded in the
/// binary (or rebuilt from source), so every `Last-Modified` this could report
/// moves on a rebuild that changed nothing.
fn entity_tag(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    // The leading 64 bits are plenty to tell one build of one file from
    // another, and they keep the header to 18 characters.
    let short = u64::from_be_bytes(
        digest[..8]
            .try_into()
            .expect("a SHA-256 digest is 32 bytes long"),
    );
    format!("\"{short:016x}\"")
}

/// RFC 9110 `If-None-Match`: `*`, or a comma-separated list of entity tags.
/// The comparison is weak, so a `W/` prefix on the candidate still matches —
/// these responses are whole, so there is no partial-content case to protect.
fn none_match(if_none_match: Option<&str>, etag: &str) -> bool {
    let Some(raw) = if_none_match else {
        return false;
    };
    let raw = raw.trim();
    if raw == "*" {
        return true;
    }
    raw.split(',').any(|candidate| {
        let candidate = candidate.trim();
        candidate.strip_prefix("W/").unwrap_or(candidate) == etag
    })
}

fn asset_response(
    content_type: &str,
    bytes: Vec<u8>,
    cache_control: &str,
    if_none_match: Option<&str>,
) -> Response {
    // Only a revalidating response needs a validator. An immutable asset is
    // never re-requested, so hashing one would spend a SHA-256 over every chunk
    // the phone downloads and buy nothing back.
    let etag = (cache_control == REVALIDATE_CACHE_CONTROL).then(|| entity_tag(&bytes));

    if let Some(etag) = etag
        .as_deref()
        .filter(|etag| none_match(if_none_match, etag))
    {
        // A 304 repeats the validators and drops the body.
        return (
            StatusCode::NOT_MODIFIED,
            [
                (header::CACHE_CONTROL, cache_control.to_string()),
                (header::ETAG, etag.to_string()),
            ],
        )
            .into_response();
    }

    let mut response = (
        [
            (header::CONTENT_TYPE, content_type.to_string()),
            (header::CACHE_CONTROL, cache_control.to_string()),
        ],
        Body::from(bytes),
    )
        .into_response();
    if let Some(etag) = etag.and_then(|etag| HeaderValue::try_from(etag).ok()) {
        response.headers_mut().insert(header::ETAG, etag);
    }
    response
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
        // Chrome ignores a manifest served as octet-stream, which silently
        // makes the mobile page non-installable in directory-asset mode.
        Some("webmanifest") => "application/manifest+json",
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
    fn pwa_manifest_keeps_its_own_media_type() {
        // Served as octet-stream, Chrome drops the manifest and the mobile
        // page stops being installable.
        assert_eq!(
            content_type_for_path(Path::new("/manifest.webmanifest")),
            "application/manifest+json"
        );
    }

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

        let escape = read_contained(&root_path, "../secret.txt", REVALIDATE_CACHE_CONTROL, None)
            .await
            .expect("traversal is answered, not skipped");
        assert_eq!(escape.status(), StatusCode::FORBIDDEN);

        assert!(
            read_contained(&root_path, "index.html", REVALIDATE_CACHE_CONTROL, None)
                .await
                .is_some()
        );
        assert!(
            read_contained(&root_path, "missing.html", REVALIDATE_CACHE_CONTROL, None)
                .await
                .is_none()
        );
    }

    #[tokio::test]
    async fn client_routes_fall_back_to_index_but_assets_do_not() {
        let root = tempdir().expect("root");
        let root_path = std::fs::canonicalize(root.path()).expect("canonical root");
        std::fs::write(root_path.join("index.html"), "<!doctype html>").expect("write index");

        let route = serve_from_directory(&root_path, "/sessions/abc", None).await;
        assert_eq!(route.status(), StatusCode::OK);

        let missing_asset = serve_from_directory(&root_path, "/assets/app.js", None).await;
        assert_eq!(missing_asset.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn hashed_assets_cache_forever_and_the_shell_revalidates() {
        let root = tempdir().expect("root");
        let root_path = std::fs::canonicalize(root.path()).expect("canonical root");
        std::fs::create_dir(root_path.join("assets")).expect("assets dir");
        std::fs::write(root_path.join("assets/app-a1b2c3.js"), "export {}").expect("write asset");
        std::fs::write(root_path.join("index.html"), "<!doctype html>").expect("write index");

        let cached = |response: &Response| {
            response
                .headers()
                .get(header::CACHE_CONTROL)
                .and_then(|value| value.to_str().ok())
                .map(str::to_owned)
        };

        let asset = serve_from_directory(&root_path, "/assets/app-a1b2c3.js", None).await;
        assert_eq!(cached(&asset).as_deref(), Some(IMMUTABLE_CACHE_CONTROL));

        let shell = serve_from_directory(&root_path, "/", None).await;
        assert_eq!(cached(&shell).as_deref(), Some(REVALIDATE_CACHE_CONTROL));

        // The SPA fallback answers with the shell's bytes, so it must not
        // inherit the immutable header from the path that asked for it.
        let fallback = serve_from_directory(&root_path, "/assets/unknown", None).await;
        assert_eq!(cached(&fallback).as_deref(), Some(REVALIDATE_CACHE_CONTROL));
    }

    #[tokio::test]
    async fn the_revalidating_shell_answers_304_to_its_own_etag() {
        let root = tempdir().expect("root");
        let root_path = std::fs::canonicalize(root.path()).expect("canonical root");
        std::fs::create_dir(root_path.join("assets")).expect("assets dir");
        std::fs::write(root_path.join("assets/app-a1b2c3.js"), "export {}").expect("write asset");
        std::fs::write(root_path.join("index.html"), "<!doctype html>").expect("write index");

        let etag_of = |response: &Response| {
            response
                .headers()
                .get(header::ETAG)
                .and_then(|value| value.to_str().ok())
                .map(str::to_owned)
        };

        // `no-cache` means "revalidate before reuse", which needs a validator to
        // revalidate against. Without one every reload refetches the whole shell.
        let shell = serve_from_directory(&root_path, "/", None).await;
        assert_eq!(shell.status(), StatusCode::OK);
        let etag = etag_of(&shell).expect("the shell carries a validator");

        let repeat = serve_from_directory(&root_path, "/", Some(&etag)).await;
        assert_eq!(repeat.status(), StatusCode::NOT_MODIFIED);
        assert_eq!(etag_of(&repeat).as_deref(), Some(etag.as_str()));

        // A stale tag from an earlier build must still get the new bytes.
        let changed = serve_from_directory(&root_path, "/", Some("\"0000000000000000\"")).await;
        assert_eq!(changed.status(), StatusCode::OK);

        // Immutable assets are never re-requested, so they skip the hash
        // entirely rather than paying SHA-256 over every chunk.
        let asset = serve_from_directory(&root_path, "/assets/app-a1b2c3.js", None).await;
        assert_eq!(etag_of(&asset), None);
    }

    #[test]
    fn if_none_match_follows_the_header_grammar() {
        assert!(none_match(Some("\"abc\""), "\"abc\""));
        assert!(none_match(Some("*"), "\"abc\""));
        // Comma-separated lists and weak tags both compare weakly.
        assert!(none_match(Some("\"other\", \"abc\""), "\"abc\""));
        assert!(none_match(Some("W/\"abc\""), "\"abc\""));

        assert!(!none_match(None, "\"abc\""));
        assert!(!none_match(Some("\"other\""), "\"abc\""));
        // Substrings must not match: the quotes are part of the tag.
        assert!(!none_match(Some("\"ab\""), "\"abc\""));
    }

    #[test]
    fn entity_tags_track_content_not_timestamps() {
        assert_eq!(
            entity_tag(b"<!doctype html>"),
            entity_tag(b"<!doctype html>")
        );
        assert_ne!(
            entity_tag(b"<!doctype html>"),
            entity_tag(b"<!doctype html> ")
        );
        // Quoted, so it is a syntactically valid entity-tag.
        let tag = entity_tag(b"payload");
        assert!(tag.starts_with('"') && tag.ends_with('"'), "{tag}");
        assert!(HeaderValue::try_from(tag).is_ok());
    }
}
