use serde::Deserialize;
use serde_json::Value;
use std::sync::LazyLock;

#[derive(Deserialize)]
struct Runtime {
    version: u32,
    csp: String,
    css: String,
    script: String,
}

static RUNTIME: LazyLock<Runtime> = LazyLock::new(|| {
    serde_json::from_str(include_str!("../../../assets/visualization-runtime.json"))
        .expect("generated visualization runtime must be valid JSON")
});

pub fn runtime_version() -> u32 {
    RUNTIME.version
}

pub fn build_document(source: &str, config: &Value) -> String {
    // The CSP precedes all source markup. JSON escaping prevents config from
    // closing its script element, even when it contains untrusted saved state.
    let config = config
        .to_string()
        .replace('<', "\\u003c")
        .replace('\u{2028}', "\\u2028")
        .replace('\u{2029}', "\\u2029");
    format!(
        "<!doctype html><html><head><meta http-equiv=\"Content-Security-Policy\" content=\"{}\"><meta name=\"referrer\" content=\"no-referrer\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><style>{}</style><script>window.__argmaxVisualizationConfig={};</script><script>{}</script></head><body>{}</body></html>",
        RUNTIME.csp, RUNTIME.css, config, RUNTIME.script, source
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn places_policy_and_runtime_before_source_and_escapes_saved_state() {
        let source = "<div>Chart</div><script>window.sourceRuns=true;</script>";
        let document = build_document(
            source,
            &json!({ "instanceId": "test", "state": { "modelContent": "</script><script>unexpected()</script>" } }),
        );
        assert!(
            document.find("Content-Security-Policy").unwrap()
                < document.find("window.__argmaxVisualizationConfig").unwrap()
        );
        assert!(
            document.find("argmax:visualization-height").unwrap()
                < document.find("window.sourceRuns").unwrap()
        );
        assert!(document.contains("\\u003c/script>\\u003cscript>unexpected()"));
        assert!(document.contains("connect-src 'none'"));
        assert!(document.contains("base-uri 'none'"));
        assert!(!document.contains("unsafe-eval"));
        assert!(document.contains(source));
        assert_eq!(runtime_version(), 1);
    }
}
