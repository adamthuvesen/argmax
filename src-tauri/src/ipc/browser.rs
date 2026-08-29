//! In-app browser pane: one child webview (label `browser`) glued to a
//! renderer placeholder. The child is a plain WKWebView the user browses in;
//! nothing drives it programmatically except explicit toolbar actions.
//!
//! Uses Tauri's `unstable` multiwebview API (`Window::add_child`). The child
//! webview always paints above the main webview's DOM, so the renderer owns
//! visibility: it hides the pane (`browser:set-bounds` with `visible: false`)
//! whenever one of its own overlays would be covered.

use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::{
    AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, Url, Webview, WebviewUrl,
};
use tokio::process::Command;

use super::inputs::*;
use super::system::SystemOk;
use crate::error::{ArgmaxError, ArgmaxResult};

pub const BROWSER_WEBVIEW_LABEL: &str = "browser";

/// Event pushed to the main webview whenever the pane navigates or finishes
/// loading. `title` is only present on load-finish.
#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct BrowserStateEvent {
    pub url: String,
    pub title: Option<String>,
}

#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct BrowserFillResult {
    pub ok: bool,
    /// Title of the 1Password item that was filled.
    pub item_title: String,
}

/// External pages must not reach `window.open` popups (dead ends in a child
/// webview) — rewrite them and `target="_blank"` anchors to in-place
/// navigation.
const BROWSER_INIT_SCRIPT: &str = r#"
(function () {
  window.open = function (url) {
    if (url) window.location.href = url;
    return null;
  };
  document.addEventListener(
    "click",
    function (event) {
      var target = event.target;
      var anchor = target && target.closest ? target.closest('a[target="_blank"]') : null;
      if (anchor && anchor.href) {
        event.preventDefault();
        window.location.href = anchor.href;
      }
    },
    true
  );
})();
"#;

fn validated_browser_url(raw: &str) -> ArgmaxResult<Url> {
    let url = Url::parse(raw)
        .map_err(|error| ArgmaxError::service("BROWSER_URL_INVALID", error.to_string()))?;
    match url.scheme() {
        "http" | "https" => Ok(url),
        scheme => Err(ArgmaxError::service(
            "BROWSER_URL_SCHEME",
            format!("scheme '{scheme}' is not allowed; only http(s) URLs open in the browser pane"),
        )),
    }
}

fn browser_webview(app: &AppHandle) -> ArgmaxResult<Webview> {
    app.get_webview(BROWSER_WEBVIEW_LABEL)
        .ok_or_else(|| ArgmaxError::service("BROWSER_NOT_OPEN", "browser pane is not open"))
}

fn bounds_rect(bounds: &BrowserBounds) -> tauri::Rect {
    tauri::Rect {
        position: LogicalPosition::new(bounds.x, bounds.y).into(),
        size: LogicalSize::new(bounds.width.max(1.0), bounds.height.max(1.0)).into(),
    }
}

fn emit_state(app: &AppHandle, url: String, title: Option<String>) {
    let _ = app.emit_to("main", "browser:state", BrowserStateEvent { url, title });
}

#[tauri::command(rename = "browser:open")]
#[specta::specta]
pub fn browser_open(app: AppHandle, input: BrowserOpenInput) -> ArgmaxResult<SystemOk> {
    let url = validated_browser_url(&input.url)?;

    if let Ok(webview) = browser_webview(&app) {
        webview
            .set_bounds(bounds_rect(&input.bounds))
            .and_then(|_| webview.show())
            .and_then(|_| webview.navigate(url))
            .map_err(|error| ArgmaxError::service("BROWSER_NAVIGATE_FAILED", error.to_string()))?;
        return Ok(SystemOk { ok: true });
    }

    let window = app
        .get_window("main")
        .ok_or_else(|| ArgmaxError::service("BROWSER_NO_MAIN_WINDOW", "main window missing"))?;

    let nav_app = app.clone();
    let load_app = app.clone();
    let builder = tauri::webview::WebviewBuilder::new(
        BROWSER_WEBVIEW_LABEL,
        WebviewUrl::External(url),
    )
    .initialization_script(BROWSER_INIT_SCRIPT)
    .on_navigation(move |url| {
        let allowed = matches!(url.scheme(), "http" | "https" | "about");
        if allowed {
            emit_state(&nav_app, url.to_string(), None);
        }
        allowed
    })
    .on_page_load(move |webview, payload| {
        if payload.event() != tauri::webview::PageLoadEvent::Finished {
            return;
        }
        let url = payload.url().to_string();
        tracing::debug!(%url, "browser pane page loaded");
        let title_app = load_app.clone();
        let title_url = url.clone();
        let eval_result = webview.eval_with_callback("document.title", move |value| {
            let title = serde_json::from_str::<String>(&value).unwrap_or_default();
            emit_state(&title_app, title_url.clone(), Some(title));
        });
        if eval_result.is_err() {
            emit_state(&load_app, url, None);
        }
    });

    window
        .add_child(
            builder,
            LogicalPosition::new(input.bounds.x, input.bounds.y),
            LogicalSize::new(input.bounds.width.max(1.0), input.bounds.height.max(1.0)),
        )
        .map_err(|error| ArgmaxError::service("BROWSER_CREATE_FAILED", error.to_string()))?;
    tracing::info!("browser pane webview created");
    Ok(SystemOk { ok: true })
}

#[tauri::command(rename = "browser:navigate")]
#[specta::specta]
pub fn browser_navigate(app: AppHandle, input: BrowserNavigateInput) -> ArgmaxResult<SystemOk> {
    let url = validated_browser_url(&input.url)?;
    browser_webview(&app)?
        .navigate(url)
        .map_err(|error| ArgmaxError::service("BROWSER_NAVIGATE_FAILED", error.to_string()))?;
    Ok(SystemOk { ok: true })
}

#[tauri::command(rename = "browser:back")]
#[specta::specta]
pub fn browser_back(app: AppHandle, _input: BrowserBackInput) -> ArgmaxResult<SystemOk> {
    eval_in_browser(&app, "history.back()")
}

#[tauri::command(rename = "browser:forward")]
#[specta::specta]
pub fn browser_forward(app: AppHandle, _input: BrowserForwardInput) -> ArgmaxResult<SystemOk> {
    eval_in_browser(&app, "history.forward()")
}

#[tauri::command(rename = "browser:reload")]
#[specta::specta]
pub fn browser_reload(app: AppHandle, _input: BrowserReloadInput) -> ArgmaxResult<SystemOk> {
    eval_in_browser(&app, "location.reload()")
}

fn eval_in_browser(app: &AppHandle, js: &str) -> ArgmaxResult<SystemOk> {
    browser_webview(app)?
        .eval(js)
        .map_err(|error| ArgmaxError::service("BROWSER_EVAL_FAILED", error.to_string()))?;
    Ok(SystemOk { ok: true })
}

#[tauri::command(rename = "browser:set-bounds")]
#[specta::specta]
pub fn browser_set_bounds(app: AppHandle, input: BrowserSetBoundsInput) -> ArgmaxResult<SystemOk> {
    let webview = browser_webview(&app)?;
    if input.visible {
        webview
            .set_bounds(bounds_rect(&input.bounds))
            .and_then(|_| webview.show())
    } else {
        webview.hide()
    }
    .map_err(|error| ArgmaxError::service("BROWSER_BOUNDS_FAILED", error.to_string()))?;
    Ok(SystemOk { ok: true })
}

#[tauri::command(rename = "browser:close")]
#[specta::specta]
pub fn browser_close(app: AppHandle, _input: BrowserCloseInput) -> ArgmaxResult<SystemOk> {
    // Closing destroys history; the pane hides instead so reopening restores
    // the session. `close` stays for a real teardown if we ever need it.
    browser_webview(&app)?
        .hide()
        .map_err(|error| ArgmaxError::service("BROWSER_HIDE_FAILED", error.to_string()))?;
    Ok(SystemOk { ok: true })
}

// --- 1Password fill ---------------------------------------------------------

#[derive(Debug, Deserialize)]
struct OpListItem {
    id: String,
    title: String,
    #[serde(default)]
    urls: Vec<OpItemUrl>,
}

#[derive(Debug, Deserialize)]
struct OpItemUrl {
    href: String,
}

#[derive(Debug, Deserialize)]
struct OpField {
    #[serde(default)]
    id: String,
    #[serde(default)]
    value: Option<String>,
}

/// True when the login item's host and the page host belong together: exact
/// match or a dot-boundary subdomain either way. The dot boundary is what
/// keeps `evilgithub.com` from matching a `github.com` item.
fn hosts_match(item_host: &str, page_host: &str) -> bool {
    let item = item_host.trim_start_matches("www.");
    let page = page_host.trim_start_matches("www.");
    item == page
        || item.ends_with(&format!(".{page}"))
        || page.ends_with(&format!(".{item}"))
}

fn item_matches_host(item: &OpListItem, page_host: &str) -> bool {
    item.urls.iter().any(|url| {
        Url::parse(&url.href)
            .ok()
            .and_then(|parsed| parsed.host_str().map(|host| hosts_match(host, page_host)))
            .unwrap_or(false)
    })
}

/// Sets username/password through the native value setter so React-style
/// controlled forms observe the change. Values arrive as JSON string literals
/// baked into the script; they never pass through the renderer webview.
fn fill_script(username: &str, password: &str) -> String {
    let username_js = serde_json::to_string(username).unwrap_or_else(|_| "\"\"".to_string());
    let password_js = serde_json::to_string(password).unwrap_or_else(|_| "\"\"".to_string());
    format!(
        r#"
(function () {{
  var setValue = function (input, value) {{
    if (!input) return;
    var setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
    setter.call(input, value);
    input.dispatchEvent(new Event("input", {{ bubbles: true }}));
    input.dispatchEvent(new Event("change", {{ bubbles: true }}));
  }};
  var passwordInput = document.querySelector('input[type="password"]');
  var scope = (passwordInput && passwordInput.form) || document;
  var usernameInput =
    scope.querySelector('input[autocomplete="username"]') ||
    scope.querySelector('input[type="email"]') ||
    scope.querySelector('input[name*="user" i], input[name*="login" i], input[name*="email" i]') ||
    scope.querySelector('input[type="text"]');
  setValue(usernameInput, {username_js});
  setValue(passwordInput, {password_js});
}})();
"#
    )
}

async fn run_op(args: &[&str]) -> ArgmaxResult<Vec<u8>> {
    let output = Command::new("op")
        .args(args)
        .output()
        .await
        .map_err(|error| {
            ArgmaxError::service(
                "OP_CLI_UNAVAILABLE",
                format!("could not run the 1Password CLI (`op`): {error}"),
            )
        })?;
    if !output.status.success() {
        // op writes auth/permission problems to stderr; values never appear there.
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(ArgmaxError::service(
            "OP_CLI_FAILED",
            format!("1Password CLI failed: {}", stderr.trim()),
        ));
    }
    Ok(output.stdout)
}

#[tauri::command(rename = "browser:fill-credentials")]
#[specta::specta]
pub async fn browser_fill_credentials(
    app: AppHandle,
    _input: BrowserFillCredentialsInput,
) -> ArgmaxResult<BrowserFillResult> {
    let webview = browser_webview(&app)?;
    let page_url = webview
        .url()
        .map_err(|error| ArgmaxError::service("BROWSER_URL_FAILED", error.to_string()))?;
    let page_host = page_url
        .host_str()
        .ok_or_else(|| ArgmaxError::service("BROWSER_NO_HOST", "current page has no host"))?
        .to_string();

    let list_output = run_op(&["item", "list", "--categories", "Login", "--format", "json"]).await?;
    let items: Vec<OpListItem> = serde_json::from_slice(&list_output)
        .map_err(|error| ArgmaxError::service("OP_LIST_PARSE", error.to_string()))?;
    let item = items
        .into_iter()
        .find(|item| item_matches_host(item, &page_host))
        .ok_or_else(|| {
            ArgmaxError::service(
                "OP_NO_MATCHING_LOGIN",
                format!("no 1Password login matches {page_host}"),
            )
        })?;

    let fields_output = run_op(&[
        "item",
        "get",
        &item.id,
        "--fields",
        "label=username,label=password",
        "--reveal",
        "--format",
        "json",
    ])
    .await?;
    let fields: Vec<OpField> = serde_json::from_slice(&fields_output)
        .map_err(|error| ArgmaxError::service("OP_ITEM_PARSE", error.to_string()))?;
    let field_value = |name: &str| {
        fields
            .iter()
            .find(|field| field.id == name)
            .and_then(|field| field.value.clone())
            .unwrap_or_default()
    };
    let username = field_value("username");
    let password = field_value("password");
    if password.is_empty() {
        return Err(ArgmaxError::service(
            "OP_NO_PASSWORD",
            format!("1Password item '{}' has no password", item.title),
        ));
    }

    // Re-check the page host: the user may have navigated while `op` waited
    // for Touch ID. Filling on a different origin than the match is a
    // credential leak, not a convenience.
    let current_url = webview
        .url()
        .map_err(|error| ArgmaxError::service("BROWSER_URL_FAILED", error.to_string()))?;
    if current_url.host_str() != Some(page_host.as_str()) {
        return Err(ArgmaxError::service(
            "OP_PAGE_CHANGED",
            "page changed while 1Password was unlocking; fill again",
        ));
    }

    webview
        .eval(fill_script(&username, &password))
        .map_err(|error| ArgmaxError::service("BROWSER_EVAL_FAILED", error.to_string()))?;

    Ok(BrowserFillResult {
        ok: true,
        item_title: item.title,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validated_browser_url_accepts_http_and_https_only() {
        assert!(validated_browser_url("https://github.com").is_ok());
        assert!(validated_browser_url("http://localhost:3000").is_ok());
        assert!(validated_browser_url("file:///etc/passwd").is_err());
        assert!(validated_browser_url("javascript:alert(1)").is_err());
        assert!(validated_browser_url("not a url").is_err());
    }

    #[test]
    fn hosts_match_requires_dot_boundary() {
        assert!(hosts_match("github.com", "github.com"));
        assert!(hosts_match("github.com", "gist.github.com"));
        assert!(hosts_match("accounts.github.com", "github.com"));
        assert!(hosts_match("www.github.com", "github.com"));
        assert!(!hosts_match("evilgithub.com", "github.com"));
        assert!(!hosts_match("github.com.evil.com", "github.com"));
    }

    #[test]
    fn fill_script_escapes_values_as_json_literals() {
        let script = fill_script("user\"name", "pa'ss\\word</script>");
        assert!(script.contains(r#""user\"name""#));
        assert!(script.contains(r#""pa'ss\\word</script>""#));
    }

    #[test]
    fn item_matches_host_ignores_unparseable_urls() {
        let item = OpListItem {
            id: "x".into(),
            title: "GitHub".into(),
            urls: vec![
                OpItemUrl { href: "not a url".into() },
                OpItemUrl { href: "https://github.com/login".into() },
            ],
        };
        assert!(item_matches_host(&item, "github.com"));
        assert!(!item_matches_host(&item, "gitlab.com"));
    }
}
