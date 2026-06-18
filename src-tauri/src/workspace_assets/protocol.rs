// Custom protocol handler for `argmax-asset://`.
//
// Mirrors `argmax-attachment://` (see `crate::attachments::protocol`) but
// serves images out of known project / workspace roots rather than the
// app-private attachment store. The renderer mints these URLs for relative
// `<img src>` references in previewed markdown (see
// `src/renderer/lib/markdownImageSrc.ts`); without a registered handler
// those images 404.

use std::path::{Path, PathBuf};

use tauri::Manager;
use tokio::fs;

use crate::attachments::protocol::{content_type_for_path, percent_decode};

/// URL scheme name. Mirrors `WORKSPACE_ASSET_PROTOCOL_SCHEME` in
/// `src/shared/assetProtocol.ts`; the renderer and this handler must agree on
/// the string. Must be registered with Tauri before the webview loads or
/// requests routed at it will 404.
pub const WORKSPACE_ASSET_PROTOCOL_SCHEME: &str = "argmax-asset";

/// Upper bound on roots pulled from the DB. A single-user desktop app never
/// has thousands of projects/workspaces, so this never truncates in practice;
/// it just keeps an unbounded query out of the protocol hot path.
const MAX_ROOTS: usize = 10_000;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AssetStatus {
    Ok,
    NotFound,
    Forbidden,
    BadRequest,
}

#[derive(Debug, Clone)]
pub struct AssetResponse {
    pub status: AssetStatus,
    pub content_type: Option<&'static str>,
    pub bytes: Vec<u8>,
}

impl AssetResponse {
    fn forbidden() -> Self {
        Self {
            status: AssetStatus::Forbidden,
            content_type: None,
            bytes: Vec::new(),
        }
    }
    fn not_found() -> Self {
        Self {
            status: AssetStatus::NotFound,
            content_type: None,
            bytes: Vec::new(),
        }
    }
    fn bad_request() -> Self {
        Self {
            status: AssetStatus::BadRequest,
            content_type: None,
            bytes: Vec::new(),
        }
    }

    /// HTTP status code Tauri's protocol handler should return for this result.
    pub fn http_status(&self) -> u16 {
        match self.status {
            AssetStatus::Ok => 200,
            AssetStatus::BadRequest => 400,
            AssetStatus::Forbidden => 403,
            AssetStatus::NotFound => 404,
        }
    }
}

/// Absolute paths the asset handler is allowed to serve from: every known
/// project repo root plus every workspace (worktree) root. Read from
/// `AppState` per request so newly-added projects/workspaces are picked up
/// without restart. Returns empty (serve nothing) before the DB is online.
pub fn known_roots(app: &tauri::AppHandle) -> Vec<PathBuf> {
    let state = app.state::<crate::state::AppState>();
    let Some(db) = state.db.get() else {
        return Vec::new();
    };
    let conn = db.connection();
    let mut roots = Vec::new();
    if let Ok(projects) = crate::persistence::projects::list_projects(&conn) {
        roots.extend(projects.into_iter().map(|p| PathBuf::from(p.repo_path)));
    }
    if let Ok(workspaces) = crate::persistence::workspaces::list_workspaces(&conn, None, MAX_ROOTS) {
        roots.extend(workspaces.into_iter().map(|w| PathBuf::from(w.path)));
    }
    roots
}

/// Serve a request URL like `argmax-asset://file/<absolute-path>`. The path is
/// percent-decoded, checked against the image whitelist, realpath'd, and
/// confirmed to live strictly inside one of `roots`; any escape returns 403,
/// a missing file returns 404.
pub async fn serve_workspace_asset(roots: &[PathBuf], url: &str) -> AssetResponse {
    let Some(path_component) = extract_url_path(url) else {
        return AssetResponse::bad_request();
    };
    let Ok(decoded) = percent_decode(&path_component) else {
        return AssetResponse::bad_request();
    };

    let candidate = PathBuf::from(decoded);
    if !candidate.is_absolute() {
        return AssetResponse::forbidden();
    }
    // Refuse non-image extensions before touching the filesystem.
    if !is_whitelisted_image(&candidate) {
        return AssetResponse::forbidden();
    }

    // canonicalize fails for missing files — honest 404. The containment
    // check below catches traversal escapes for files that DO exist.
    let canonical = match fs::canonicalize(&candidate).await {
        Ok(path) => path,
        Err(_) => return AssetResponse::not_found(),
    };
    if !is_inside_any_root(&canonical, roots).await {
        return AssetResponse::forbidden();
    }

    let bytes = match fs::read(&canonical).await {
        Ok(bytes) => bytes,
        Err(_) => return AssetResponse::not_found(),
    };
    let content_type = content_type_for_path(&canonical);
    AssetResponse {
        status: AssetStatus::Ok,
        content_type: Some(content_type),
        bytes,
    }
}

/// True if `canonical` lives strictly inside one of the canonicalized roots
/// (not at a root itself). Roots that can't be realpath'd are skipped.
async fn is_inside_any_root(canonical: &Path, roots: &[PathBuf]) -> bool {
    for root in roots {
        let Ok(root_real) = fs::canonicalize(root).await else {
            continue;
        };
        if *canonical != root_real && canonical.starts_with(&root_real) {
            return true;
        }
    }
    false
}

fn is_whitelisted_image(path: &Path) -> bool {
    matches!(
        path.extension()
            .and_then(|ext| ext.to_str())
            .map(|ext| ext.to_ascii_lowercase())
            .as_deref(),
        Some("png" | "jpg" | "jpeg" | "gif" | "webp")
    )
}

fn extract_url_path(url: &str) -> Option<String> {
    // Accept both `scheme://host/path` and `scheme:/path` forms; the Tauri
    // protocol surface usually passes the former (host is typically "file").
    let prefix = format!("{WORKSPACE_ASSET_PROTOCOL_SCHEME}://");
    if let Some(rest) = url.strip_prefix(&prefix) {
        let after_host = rest.split_once('/').map(|(_, path)| path).unwrap_or(rest);
        let path_only = after_host.split(['?', '#']).next()?;
        return Some(format!("/{path_only}"));
    }
    let prefix = format!("{WORKSPACE_ASSET_PROTOCOL_SCHEME}:");
    if let Some(rest) = url.strip_prefix(&prefix) {
        return Some(rest.to_string());
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;
    use tempfile::TempDir;

    fn url_for(path: &Path) -> String {
        format!(
            "{WORKSPACE_ASSET_PROTOCOL_SCHEME}://file{}",
            path.to_string_lossy()
        )
    }

    #[tokio::test]
    async fn serves_image_under_a_known_root() {
        let root = TempDir::new().unwrap();
        let file = root.path().join("logo.png");
        std::fs::write(&file, b"PNGDATA").unwrap();
        let canonical = std::fs::canonicalize(&file).unwrap();
        let roots = vec![root.path().to_path_buf()];
        let response = serve_workspace_asset(&roots, &url_for(&canonical)).await;
        assert_eq!(response.status, AssetStatus::Ok);
        assert_eq!(response.content_type, Some("image/png"));
        assert_eq!(response.bytes, b"PNGDATA");
    }

    #[tokio::test]
    async fn serves_image_in_nested_subdir() {
        let root = TempDir::new().unwrap();
        let nested = root.path().join("docs").join("assets");
        std::fs::create_dir_all(&nested).unwrap();
        let file = nested.join("diagram.webp");
        std::fs::write(&file, b"WEBP").unwrap();
        let canonical = std::fs::canonicalize(&file).unwrap();
        let roots = vec![root.path().to_path_buf()];
        let response = serve_workspace_asset(&roots, &url_for(&canonical)).await;
        assert_eq!(response.status, AssetStatus::Ok);
        assert_eq!(response.content_type, Some("image/webp"));
    }

    #[tokio::test]
    async fn rejects_path_outside_every_root() {
        let root = TempDir::new().unwrap();
        let outside = TempDir::new().unwrap();
        let escape = outside.path().join("steal.png");
        std::fs::write(&escape, b"X").unwrap();
        let canonical = std::fs::canonicalize(&escape).unwrap();
        let roots = vec![root.path().to_path_buf()];
        let response = serve_workspace_asset(&roots, &url_for(&canonical)).await;
        assert_eq!(response.status, AssetStatus::Forbidden);
    }

    #[tokio::test]
    async fn rejects_traversal_escape_via_symlink_target() {
        // A `..`-laden path that resolves outside the root must be refused.
        let root = TempDir::new().unwrap();
        let outside = TempDir::new().unwrap();
        let secret = outside.path().join("secret.png");
        std::fs::write(&secret, b"X").unwrap();
        let traversal = root
            .path()
            .join("..")
            .join(outside.path().file_name().unwrap())
            .join("secret.png");
        let roots = vec![root.path().to_path_buf()];
        let response = serve_workspace_asset(&roots, &url_for(&traversal)).await;
        assert_eq!(response.status, AssetStatus::Forbidden);
    }

    #[tokio::test]
    async fn rejects_non_image_extension() {
        let root = TempDir::new().unwrap();
        let file = root.path().join("secrets.env");
        std::fs::write(&file, b"TOKEN=1").unwrap();
        let canonical = std::fs::canonicalize(&file).unwrap();
        let roots = vec![root.path().to_path_buf()];
        let response = serve_workspace_asset(&roots, &url_for(&canonical)).await;
        assert_eq!(response.status, AssetStatus::Forbidden);
    }

    #[tokio::test]
    async fn rejects_the_root_directory_itself() {
        let root = TempDir::new().unwrap();
        // A directory has no image extension, so this is refused before the
        // containment check — but assert the security outcome regardless.
        let canonical = std::fs::canonicalize(root.path()).unwrap();
        let roots = vec![root.path().to_path_buf()];
        let response = serve_workspace_asset(&roots, &url_for(&canonical)).await;
        assert_ne!(response.status, AssetStatus::Ok);
    }

    #[tokio::test]
    async fn empty_roots_serve_nothing() {
        let root = TempDir::new().unwrap();
        let file = root.path().join("logo.png");
        std::fs::write(&file, b"X").unwrap();
        let canonical = std::fs::canonicalize(&file).unwrap();
        let response = serve_workspace_asset(&[], &url_for(&canonical)).await;
        assert_eq!(response.status, AssetStatus::Forbidden);
    }

    #[tokio::test]
    async fn missing_file_returns_not_found() {
        let root = TempDir::new().unwrap();
        let ghost = root.path().join("ghost.png");
        let roots = vec![root.path().to_path_buf()];
        let response = serve_workspace_asset(&roots, &url_for(&ghost)).await;
        assert_eq!(response.status, AssetStatus::NotFound);
    }

    #[tokio::test]
    async fn percent_encoded_spaces_decode() {
        let root = TempDir::new().unwrap();
        let file = root.path().join("my logo.png");
        std::fs::write(&file, b"data").unwrap();
        let canonical = std::fs::canonicalize(&file).unwrap();
        let url = format!(
            "{WORKSPACE_ASSET_PROTOCOL_SCHEME}://file{}",
            canonical.to_string_lossy().replace(' ', "%20")
        );
        let roots = vec![root.path().to_path_buf()];
        let response = serve_workspace_asset(&roots, &url).await;
        assert_eq!(response.status, AssetStatus::Ok);
    }

    #[tokio::test]
    async fn non_matching_scheme_is_bad_request() {
        let response = serve_workspace_asset(&[], "https://example.com/x.png").await;
        assert_eq!(response.status, AssetStatus::BadRequest);
    }

    #[test]
    fn http_status_maps_each_variant() {
        assert_eq!(AssetResponse::not_found().http_status(), 404);
        assert_eq!(AssetResponse::forbidden().http_status(), 403);
        assert_eq!(AssetResponse::bad_request().http_status(), 400);
        let ok = AssetResponse {
            status: AssetStatus::Ok,
            content_type: Some("image/png"),
            bytes: Vec::new(),
        };
        assert_eq!(ok.http_status(), 200);
    }

    /// Recurrence guard for the original bug: the renderer minted
    /// `argmax-asset://` URLs but no Rust handler was registered, so the
    /// images silently 404'd. Assert every scheme constant the renderer
    /// defines is actually wired into a `register_*_uri_scheme_protocol` call
    /// in `lib.rs`. If someone adds a new renderer scheme without a handler,
    /// this fails.
    #[test]
    fn every_renderer_scheme_has_a_registered_protocol() {
        // Map each scheme constant's name to the value the Rust side serves.
        // The const VALUES are the source of truth, pulled straight from the
        // modules, so they can't drift from what the handlers actually match.
        let rust_consts: HashMap<&str, &str> = HashMap::from([
            (
                "ATTACHMENT_PROTOCOL_SCHEME",
                crate::attachments::protocol::ATTACHMENT_PROTOCOL_SCHEME,
            ),
            (
                "WORKSPACE_ASSET_PROTOCOL_SCHEME",
                WORKSPACE_ASSET_PROTOCOL_SCHEME,
            ),
        ]);

        // 1. Extract which constants `lib.rs` actually registers.
        let lib_src =
            std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/src/lib.rs")).unwrap();
        let registered_values: Vec<&str> = lib_src
            .match_indices("register_asynchronous_uri_scheme_protocol(")
            .filter_map(|(idx, marker)| {
                let after = &lib_src[idx + marker.len()..];
                // First non-whitespace token is the scheme argument, e.g.
                // `attachments::protocol::ATTACHMENT_PROTOCOL_SCHEME`.
                let token: String = after
                    .trim_start()
                    .chars()
                    .take_while(|c| c.is_alphanumeric() || *c == '_' || *c == ':')
                    .collect();
                let const_name = token.rsplit("::").next().unwrap_or(&token).to_string();
                rust_consts.get(const_name.as_str()).copied()
            })
            .collect();

        // Sanity: lib.rs registers both known schemes (guards the map itself).
        assert!(
            registered_values.contains(&crate::attachments::protocol::ATTACHMENT_PROTOCOL_SCHEME),
            "lib.rs no longer registers the attachment scheme"
        );
        assert!(
            registered_values.contains(&WORKSPACE_ASSET_PROTOCOL_SCHEME),
            "lib.rs does not register the argmax-asset scheme"
        );

        // 2. Every scheme constant the renderer mints must be registered.
        let shared_dir = concat!(env!("CARGO_MANIFEST_DIR"), "/../src/shared");
        let scheme_assignment = regex::Regex::new(r#"PROTOCOL_SCHEME\s*=\s*"([^"]+)""#).unwrap();
        let mut renderer_schemes = Vec::new();
        for entry in std::fs::read_dir(shared_dir).unwrap() {
            let path = entry.unwrap().path();
            if path.extension().and_then(|e| e.to_str()) != Some("ts") {
                continue;
            }
            let src = std::fs::read_to_string(&path).unwrap();
            for caps in scheme_assignment.captures_iter(&src) {
                renderer_schemes.push(caps[1].to_string());
            }
        }
        assert!(
            renderer_schemes
                .iter()
                .any(|s| s == WORKSPACE_ASSET_PROTOCOL_SCHEME),
            "test wired wrong: did not find the argmax-asset scheme in src/shared"
        );

        for scheme in &renderer_schemes {
            assert!(
                registered_values.contains(&scheme.as_str()),
                "renderer mints `{scheme}://` but no register_*_uri_scheme_protocol call serves it"
            );
        }
    }
}
