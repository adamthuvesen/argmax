//! Shared URL→path parsing for the app's custom Tauri asset protocols
//! (`argmax-attachment://`, `argmax-asset://`). Both schemes carry a filesystem
//! path the same way, so the extraction lives here rather than being copied.

/// Extract the filesystem path from a `scheme://host/path` or `scheme:/path`
/// URL. Drops the host segment (Tauri uses "localhost"/"file") and any `?`/`#`
/// metadata. Returns `None` when the url doesn't carry `scheme`.
pub fn extract_scheme_url_path(scheme: &str, url: &str) -> Option<String> {
    if let Some(rest) = url.strip_prefix(&format!("{scheme}://")) {
        let after_host = rest.split_once('/').map(|(_, path)| path).unwrap_or(rest);
        let path_only = after_host.split(['?', '#']).next()?;
        return Some(format!("/{path_only}"));
    }
    if let Some(rest) = url.strip_prefix(&format!("{scheme}:")) {
        return Some(rest.to_string());
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_host_form_and_drops_query() {
        assert_eq!(
            extract_scheme_url_path("argmax-asset", "argmax-asset://localhost/a/b.png?v=1"),
            Some("/a/b.png".to_string())
        );
    }

    #[test]
    fn parses_schemeless_slash_form() {
        assert_eq!(
            extract_scheme_url_path("argmax-attachment", "argmax-attachment:/tmp/x.png"),
            Some("/tmp/x.png".to_string())
        );
    }

    #[test]
    fn rejects_other_schemes() {
        assert_eq!(
            extract_scheme_url_path("argmax-asset", "https://example.com/x"),
            None
        );
    }
}
