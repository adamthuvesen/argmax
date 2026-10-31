//! In-app browser pane: one child webview per tab (label `browser-<tabId>`)
//! glued to a renderer placeholder. Each visible browser scope shows its active
//! tab. The others stay hidden but alive, so each keeps its history,
//! scroll position, and session.
//!
//! The tab *list* lives in `browser::registry`, not in the renderer: a session
//! can open a tab with no pane on screen to ask. Every command here folds its
//! change into that registry and pushes `browser:tabs`, and the strip mirrors
//! it. The agent-facing verbs (snapshot, click, type) are thin wrappers over
//! `browser::automation`, which the MCP layer calls directly.
//!
//! Uses Tauri's `unstable` multiwebview API (`Window::add_child`). A child
//! webview always paints above the main webview's DOM, so the renderer owns
//! visibility: it hides the pane (`browser:set-bounds` with `visible: false`)
//! whenever one of its own overlays would be covered.

use std::time::Duration;

use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::{AppHandle, Manager, Url};
use tokio::process::Command;

use super::inputs::*;
use super::system::SystemOk;
use crate::browser::automation::{
    self, ActionOutcome, PageExtraction, PageFindResult, PageSnapshot, PageText, TabTarget,
};
use crate::browser::registry::BrowserTabsEvent;
use crate::browser::tabs::*;
pub use crate::browser::tabs::{BrowserNewTabEvent, BrowserPageCommandEvent, BrowserStateEvent};
use crate::browser::{encode_base64, eval, snapshot_image, CaptureRect};
use crate::error::{ArgmaxError, ArgmaxResult};
use crate::state::AppState;

#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct BrowserFillResult {
    pub ok: bool,
    /// Title of the 1Password item that was filled.
    pub item_title: String,
}

#[tauri::command(rename = "browser:open")]
#[specta::specta]
pub async fn browser_open(app: AppHandle, input: BrowserOpenInput) -> ArgmaxResult<SystemOk> {
    validated_browser_url(&input.url)?;
    tab_label(&input.tab_id)?;
    let tab_id = input.tab_id.clone();
    let generation = app
        .state::<AppState>()
        .pending_browser_opens
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .begin(input.clone());

    // Compile once before constructing a user webview, so even its first
    // request goes through the native rules. Agent tabs remain unfiltered.
    let state = app.state::<AppState>();
    let mut blocking = state.browser_content_blocking.lock().await;
    let owned = input.owner_session_id.is_some()
        || tab_registry(&app)
            .get(&input.tab_id)
            .is_some_and(|tab| tab.owner_session_id.is_some());
    let identifier = if owned {
        None
    } else {
        match crate::browser::content_blocking::ensure(&app, &mut blocking).await {
            Ok(identifier) => identifier,
            Err(error) => {
                state
                    .pending_browser_opens
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner())
                    .cancel_generation(&tab_id, generation);
                return Err(error);
            }
        }
    };
    let open_tab_id = tab_id.clone();
    let opened = crate::browser::content_blocking::on_main(&app, move |app| {
        let pending = app
            .state::<AppState>()
            .pending_browser_opens
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .take_generation(&open_tab_id, generation);
        let Some(pending) = pending else {
            return Ok(());
        };
        let (url, raw_url) = if pending.stopped {
            let raw_url = "about:blank".to_string();
            (
                Url::parse(&raw_url).expect("valid internal blank browser URL"),
                raw_url,
            )
        } else {
            let raw_url = pending.input.url;
            (validated_browser_url(&raw_url)?, raw_url)
        };
        open_tab_with_url(
            app,
            &pending.input.tab_id,
            url,
            &raw_url,
            pending.input.bounds,
            pending.visible,
            pending.input.owner_session_id,
            identifier,
        )
    })
    .await;
    if opened.is_err() {
        app.state::<AppState>()
            .pending_browser_opens
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .cancel_generation(&tab_id, generation);
    }
    opened?;
    Ok(SystemOk { ok: true })
}

#[tauri::command(rename = "browser:content-blocking")]
#[specta::specta]
pub async fn browser_content_blocking(
    app: AppHandle,
) -> ArgmaxResult<crate::browser::content_blocking::BrowserContentBlocking> {
    let state = app.state::<AppState>();
    let mut blocking = state.browser_content_blocking.lock().await;
    crate::browser::content_blocking::status(&app, &mut blocking).await
}

#[tauri::command(rename = "browser:set-site-blocking")]
#[specta::specta]
pub async fn browser_set_site_blocking(
    app: AppHandle,
    input: crate::browser::content_blocking::BrowserSetSiteBlockingInput,
) -> ArgmaxResult<crate::browser::content_blocking::BrowserContentBlocking> {
    let state = app.state::<AppState>();
    let mut blocking = state.browser_content_blocking.lock().await;
    crate::browser::content_blocking::set_site(&app, &mut blocking, input).await
}

#[tauri::command(rename = "browser:navigate")]
#[specta::specta]
pub fn browser_navigate(app: AppHandle, input: BrowserNavigateInput) -> ArgmaxResult<SystemOk> {
    validated_browser_url(&input.url)?;
    tab_label(&input.tab_id)?;
    let updated_pending = app
        .state::<AppState>()
        .pending_browser_opens
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .update_navigation(&input.tab_id, input.url.clone());
    if app.get_webview(&tab_label(&input.tab_id)?).is_some() || !updated_pending {
        navigate_tab(&app, &input.tab_id, &input.url)?;
    }
    Ok(SystemOk { ok: true })
}

#[tauri::command(rename = "browser:back")]
#[specta::specta]
pub fn browser_back(app: AppHandle, input: BrowserBackInput) -> ArgmaxResult<SystemOk> {
    eval_in_browser_or_pending(&app, &input.tab_id, "history.back()")
}

#[tauri::command(rename = "browser:forward")]
#[specta::specta]
pub fn browser_forward(app: AppHandle, input: BrowserForwardInput) -> ArgmaxResult<SystemOk> {
    eval_in_browser_or_pending(&app, &input.tab_id, "history.forward()")
}

#[tauri::command(rename = "browser:reload")]
#[specta::specta]
pub fn browser_reload(app: AppHandle, input: BrowserReloadInput) -> ArgmaxResult<SystemOk> {
    eval_in_browser_or_pending(&app, &input.tab_id, "location.reload()")
}

#[tauri::command(rename = "browser:stop")]
#[specta::specta]
pub fn browser_stop(app: AppHandle, input: BrowserStopInput) -> ArgmaxResult<SystemOk> {
    tab_label(&input.tab_id)?;
    let stopped_pending = app
        .state::<AppState>()
        .pending_browser_opens
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .stop(&input.tab_id);
    if app.get_webview(&tab_label(&input.tab_id)?).is_some() || !stopped_pending {
        eval_in_browser(&app, &input.tab_id, "window.stop()")
    } else {
        Ok(SystemOk { ok: true })
    }
}

fn eval_in_browser(app: &AppHandle, tab_id: &str, js: &str) -> ArgmaxResult<SystemOk> {
    browser_webview(app, tab_id)?
        .eval(js)
        .map_err(|error| ArgmaxError::service("BROWSER_EVAL_FAILED", error.to_string()))?;
    Ok(SystemOk { ok: true })
}

fn eval_in_browser_or_pending(app: &AppHandle, tab_id: &str, js: &str) -> ArgmaxResult<SystemOk> {
    tab_label(tab_id)?;
    let pending = app
        .state::<AppState>()
        .pending_browser_opens
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .contains(tab_id);
    if app.get_webview(&tab_label(tab_id)?).is_some() || !pending {
        eval_in_browser(app, tab_id, js)
    } else {
        Ok(SystemOk { ok: true })
    }
}

#[tauri::command(rename = "browser:set-bounds")]
#[specta::specta]
pub fn browser_set_bounds(app: AppHandle, input: BrowserSetBoundsInput) -> ArgmaxResult<SystemOk> {
    tab_label(&input.tab_id)?;
    let updated_pending = app
        .state::<AppState>()
        .pending_browser_opens
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .update_bounds(&input.tab_id, input.bounds.clone(), input.visible);
    let Some(webview) = app.get_webview(&tab_label(&input.tab_id)?) else {
        if updated_pending {
            return Ok(SystemOk { ok: true });
        }
        return Err(ArgmaxError::service(
            "BROWSER_NOT_OPEN",
            "browser tab is not open",
        ));
    };
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

/// Hands the window's keyboard focus to a tab's page, the way clicking into it
/// would. Called when the user activates a tab: without it the first responder
/// stays on the app's own webview, so scrolling keys and `⌘F` are the app's
/// rather than the page's. A tab whose webview is still being created is
/// skipped — it takes focus when it opens.
#[tauri::command(rename = "browser:focus")]
#[specta::specta]
pub fn browser_focus(app: AppHandle, input: BrowserFocusInput) -> ArgmaxResult<SystemOk> {
    let label = tab_label(&input.tab_id)?;
    if let Some(webview) = app.get_webview(&label) {
        webview
            .set_focus()
            .map_err(|error| ArgmaxError::service("BROWSER_FOCUS_FAILED", error.to_string()))?;
    }
    Ok(SystemOk { ok: true })
}

#[tauri::command(rename = "browser:set-theme")]
#[specta::specta]
pub fn browser_set_theme(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
    input: BrowserSetThemeInput,
) -> ArgmaxResult<SystemOk> {
    *state
        .browser_theme
        .lock()
        .unwrap_or_else(|error| error.into_inner()) = input.mode;
    crate::browser::theme::observe_system_changes(&app);
    crate::browser::theme::apply_all(&app, input.mode)?;
    Ok(SystemOk { ok: true })
}

#[tauri::command(rename = "browser:close")]
#[specta::specta]
pub fn browser_close(app: AppHandle, input: BrowserCloseInput) -> ArgmaxResult<SystemOk> {
    let label = tab_label(&input.tab_id)?;
    let canceled_pending = app
        .state::<AppState>()
        .pending_browser_opens
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .cancel(&input.tab_id);
    if app.get_webview(&label).is_some() {
        close_tab(&app, &input.tab_id)?;
    } else if !canceled_pending {
        return Err(ArgmaxError::service(
            "BROWSER_NOT_OPEN",
            "browser tab is not open",
        ));
    }
    Ok(SystemOk { ok: true })
}

/// PNG of one tab, base64 so it can ride the JSON IPC envelope. `width` and
/// `height` are device pixels: on a retina display they are twice the CSS
/// size of what was captured.
#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct BrowserScreenshot {
    pub png_base64: String,
    pub width: u32,
    pub height: u32,
}

/// WebKit's JSON encoding of the script's value. Empty when the script
/// produced `undefined` — or threw, which WebKit's completion handler does not
/// distinguish. Catch inside the page when the difference matters.
#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct BrowserEvaluateResult {
    pub result_json: String,
}

/// A capture that has not landed in five seconds is a stuck compositor, not a
/// slow page — WebKit rasterises from layers that are already there.
const SCREENSHOT_TIMEOUT: Duration = Duration::from_secs(5);
const EVAL_TIMEOUT_DEFAULT_MS: u32 = 5_000;
const EVAL_TIMEOUT_MAX_MS: u32 = 60_000;

#[tauri::command(rename = "browser:screenshot")]
#[specta::specta]
pub async fn browser_screenshot(
    app: AppHandle,
    input: BrowserScreenshotInput,
) -> ArgmaxResult<BrowserScreenshot> {
    // A ref crops to one element and needs the page's help to locate it, so
    // that path goes through automation; an explicit rect (or none) does not.
    let captured = match input.element_ref {
        Some(element_ref) => {
            let target = TabTarget::from_inputs(input.tab_id, input.session_id)?;
            automation::screenshot(&app, &target, Some(&element_ref), None).await?
        }
        None => {
            let target = TabTarget::from_inputs(input.tab_id, input.session_id)?;
            let tab_id = automation::resolve_tab(&app, &target)?;
            let webview = browser_webview(&app, &tab_id)?;
            let rect = input.rect.map(|rect| CaptureRect {
                x: rect.x,
                y: rect.y,
                width: rect.width,
                height: rect.height,
            });
            snapshot_image::capture(&webview, rect, None, SCREENSHOT_TIMEOUT).await?
        }
    };
    Ok(BrowserScreenshot {
        png_base64: encode_base64(&captured.png),
        width: captured.width,
        height: captured.height,
    })
}

// The agent-automation channels below run through `browser::automation` so the
// renderer and the verification harness reach the same code an agent's MCP
// tools will, rather than a parallel implementation that drifts.

/// A tab a session opened. The renderer learns about it through
/// `browser:agent-open` and `browser:tabs`, not from this reply.
#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct BrowserOpenedTab {
    pub tab_id: String,
}

#[tauri::command(rename = "browser:list-tabs")]
#[specta::specta]
pub fn browser_list_tabs(
    app: AppHandle,
    input: BrowserListTabsInput,
) -> ArgmaxResult<BrowserTabsEvent> {
    Ok(BrowserTabsEvent {
        tabs: automation::tabs(&app, input.session_id.as_deref()),
    })
}

#[tauri::command(rename = "browser:open-for-session")]
#[specta::specta]
pub fn browser_open_for_session(
    app: AppHandle,
    input: BrowserOpenForSessionInput,
) -> ArgmaxResult<BrowserOpenedTab> {
    let tab_id = automation::open(&app, Some(&input.session_id), &input.url)?;
    Ok(BrowserOpenedTab { tab_id })
}

#[tauri::command(rename = "browser:snapshot")]
#[specta::specta]
pub async fn browser_snapshot(
    app: AppHandle,
    input: BrowserSnapshotInput,
) -> ArgmaxResult<PageSnapshot> {
    let target = TabTarget::from_inputs(input.tab_id, input.session_id)?;
    automation::snapshot(&app, &target, input.interactive_only.unwrap_or(false)).await
}

#[tauri::command(rename = "browser:find")]
#[specta::specta]
pub async fn browser_find(app: AppHandle, input: BrowserFindInput) -> ArgmaxResult<PageFindResult> {
    let target = TabTarget::from_inputs(input.tab_id, input.session_id)?;
    automation::find(&app, &target, &input.query).await
}

#[tauri::command(rename = "browser:get-text")]
#[specta::specta]
pub async fn browser_get_text(
    app: AppHandle,
    input: BrowserGetTextInput,
) -> ArgmaxResult<PageText> {
    let target = TabTarget::from_inputs(input.tab_id, input.session_id)?;
    automation::get_text(&app, &target, input.max_chars).await
}

#[tauri::command(rename = "browser:extract")]
#[specta::specta]
pub async fn browser_extract(
    app: AppHandle,
    input: BrowserExtractInput,
) -> ArgmaxResult<PageExtraction> {
    let target = TabTarget::from_inputs(input.tab_id, input.session_id)?;
    automation::extract(&app, &target, input.max_chars).await
}

#[tauri::command(rename = "browser:act")]
#[specta::specta]
pub async fn browser_act(app: AppHandle, input: BrowserActInput) -> ArgmaxResult<ActionOutcome> {
    let target = TabTarget::from_inputs(input.tab_id, input.session_id)?;
    automation::act(&app, &target, &input.action).await
}

#[tauri::command(rename = "browser:evaluate")]
#[specta::specta]
pub async fn browser_evaluate(
    app: AppHandle,
    input: BrowserEvaluateInput,
) -> ArgmaxResult<BrowserEvaluateResult> {
    let webview = browser_webview(&app, &input.tab_id)?;
    let timeout = Duration::from_millis(
        input
            .timeout_ms
            .unwrap_or(EVAL_TIMEOUT_DEFAULT_MS)
            .clamp(1, EVAL_TIMEOUT_MAX_MS)
            .into(),
    );
    let result_json = eval::eval_json(&webview, &input.script, timeout).await?;
    Ok(BrowserEvaluateResult { result_json })
}

#[derive(Debug, Deserialize)]
struct OpAccount {
    /// Sign-in address (e.g. `my.1password.com`) — the documented, stable
    /// form for `op --account`.
    url: String,
}

/// Personal accounts live on `my.1password.com`; business accounts get their
/// own subdomain. Search personal accounts first, so a site saved in both a
/// personal and a work vault fills with the personal login.
fn personal_accounts_first(accounts: &mut [OpAccount]) {
    accounts.sort_by_key(|account| !account.url.contains("my.1password.com"));
}

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

/// Hosting platforms where sibling subdomains belong to unrelated users —
/// a login saved for `me.github.io` must never match `evil.github.io`.
const SHARED_HOST_SUFFIXES: [&str; 8] = [
    "github.io",
    "gitlab.io",
    "pages.dev",
    "vercel.app",
    "netlify.app",
    "herokuapp.com",
    "web.app",
    "firebaseapp.com",
];

fn is_shared_host(host: &str) -> bool {
    SHARED_HOST_SUFFIXES.contains(&host)
}

/// True when the login item's host and the page host belong together: exact
/// match or a dot-boundary subdomain either way. The dot boundary is what
/// keeps `evilgithub.com` from matching a `github.com` item, and subdomain
/// matching is refused across shared-hosting parents.
fn hosts_match(item_host: &str, page_host: &str) -> bool {
    let item = item_host.trim_start_matches("www.");
    let page = page_host.trim_start_matches("www.");
    item == page
        || (item.ends_with(&format!(".{page}")) && !is_shared_host(page))
        || (page.ends_with(&format!(".{item}")) && !is_shared_host(item))
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
    if (!input || !value) return;
    var setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
    setter.call(input, value);
    input.dispatchEvent(new Event("input", {{ bubbles: true }}));
    input.dispatchEvent(new Event("change", {{ bubbles: true }}));
  }};
  var passwordInput = document.querySelector('input[type="password"]');
  // No password field in the main frame (login in a cross-origin iframe):
  // do nothing rather than scatter the username into an arbitrary input.
  if (!passwordInput) return;
  var scope = passwordInput.form || document;
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

fn op_command(args: &[&str]) -> Command {
    let mut command = Command::new("op");
    command.args(args);
    #[cfg(unix)]
    {
        command.env("PATH", crate::util::login_shell::path());
        command.envs(op_environment(crate::util::login_shell::environment()));
    }
    command
}

/// Environment for an `op` spawn: the user's own `OP_*` exports, with the
/// desktop-app integration on unless they said otherwise.
///
/// `op` normally decides whether to use the 1Password app by reading the app's
/// settings file. When that read fails, or the toggle is off, `op account list`
/// succeeds with `[]` instead of erroring, which the fill reports as "no
/// accounts". Asking for the integration explicitly skips that decision.
/// Argmax has no terminal for `op signin`, so the app integration (and its
/// Touch ID prompt) is the only sign-in path a fill can use anyway.
fn op_environment(login_shell: Vec<(String, String)>) -> Vec<(String, String)> {
    const APP_INTEGRATION: &str = crate::util::login_shell::OP_APP_INTEGRATION_ENV;
    let mut vars: Vec<(String, String)> = login_shell
        .into_iter()
        .filter(|(key, _)| key.starts_with("OP_"))
        .collect();
    if !vars.iter().any(|(key, _)| key == APP_INTEGRATION) {
        vars.push((APP_INTEGRATION.to_string(), "true".to_string()));
    }
    vars
}

async fn run_op(args: &[&str]) -> ArgmaxResult<Vec<u8>> {
    let output = op_command(args).output().await.map_err(|error| {
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
    input: BrowserFillCredentialsInput,
) -> ArgmaxResult<BrowserFillResult> {
    let webview = browser_webview(&app, &input.tab_id)?;
    let page_url = webview
        .url()
        .map_err(|error| ArgmaxError::service("BROWSER_URL_FAILED", error.to_string()))?;
    let page_host = page_url
        .host_str()
        .ok_or_else(|| ArgmaxError::service("BROWSER_NO_HOST", "current page has no host"))?
        .to_string();
    // Passwords never go into plaintext pages. Loopback is the one
    // exception, for local dev servers.
    let loopback = matches!(page_host.as_str(), "localhost" | "127.0.0.1");
    if page_url.scheme() != "https" && !loopback {
        return Err(ArgmaxError::service(
            "OP_INSECURE_PAGE",
            "refusing to fill credentials into a non-https page",
        ));
    }
    // Full origin (scheme + host + port), for the post-unlock re-check.
    let page_origin = page_url.origin();

    // A login can live in any of the user's 1Password accounts, and `op`
    // only searches one per call. Walk them personal-first and take the
    // first account with a matching item.
    let accounts_output = run_op(&["account", "list", "--format", "json"]).await?;
    let mut accounts: Vec<OpAccount> = serde_json::from_slice(&accounts_output)
        .map_err(|error| ArgmaxError::service("OP_ACCOUNT_PARSE", error.to_string()))?;
    if accounts.is_empty() {
        return Err(ArgmaxError::service(
            "OP_NO_ACCOUNTS",
            "the 1Password CLI lists no accounts; in the 1Password app turn on \
             Settings → Developer → Integrate with 1Password CLI, then try again",
        ));
    }
    personal_accounts_first(&mut accounts);

    let mut matched: Option<(String, OpListItem)> = None;
    for account in &accounts {
        // An account op cannot list (signed out, revoked) should not sink
        // the fill — the login may live in the next one.
        let Ok(list_output) = run_op(&[
            "item",
            "list",
            "--categories",
            "Login",
            "--account",
            &account.url,
            "--format",
            "json",
        ])
        .await
        else {
            continue;
        };
        let Ok(items) = serde_json::from_slice::<Vec<OpListItem>>(&list_output) else {
            continue;
        };
        if let Some(item) = items
            .into_iter()
            .find(|item| item_matches_host(item, &page_host))
        {
            matched = Some((account.url.clone(), item));
            break;
        }
    }
    let (account_url, item) = matched.ok_or_else(|| {
        ArgmaxError::service(
            "OP_NO_MATCHING_LOGIN",
            format!("no 1Password login matches {page_host}"),
        )
    })?;

    let fields_output = run_op(&[
        "item",
        "get",
        &item.id,
        "--account",
        &account_url,
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

    // Re-check the full origin: the user may have navigated (or been
    // redirected — scheme and port included) while `op` waited for Touch ID.
    // Filling on a different origin than the match is a credential leak.
    let current_url = webview
        .url()
        .map_err(|error| ArgmaxError::service("BROWSER_URL_FAILED", error.to_string()))?;
    if current_url.origin() != page_origin {
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
    use crate::browser::user_scripts::ScriptWorld;

    fn pending_input(tab_id: &str, url: &str) -> BrowserOpenInput {
        BrowserOpenInput {
            url: url.to_string(),
            bounds: BrowserBounds {
                x: 1.0,
                y: 2.0,
                width: 800.0,
                height: 600.0,
            },
            tab_id: tab_id.to_string(),
            owner_session_id: None,
        }
    }

    // The renderer measures the panel in CSS px. At 80% zoom the same surface
    // is 0.8 window points per CSS px, and a webview placed at face value
    // overhangs the window by a quarter of its size.
    #[test]
    fn bounds_are_scaled_from_css_px_to_window_points() {
        let bounds = BrowserBounds {
            x: 100.0,
            y: 50.0,
            width: 800.0,
            height: 600.0,
        };
        assert_eq!(scale_bounds(&bounds, 0.8), (80.0, 40.0, 640.0, 480.0));
        assert_eq!(scale_bounds(&bounds, 1.0), (100.0, 50.0, 800.0, 600.0));
    }

    // A hidden or collapsed panel measures zero; the webview still needs a size.
    #[test]
    fn a_collapsed_surface_keeps_one_point_of_webview() {
        let bounds = BrowserBounds {
            x: 0.0,
            y: 0.0,
            width: 0.0,
            height: 0.0,
        };
        assert_eq!(scale_bounds(&bounds, 0.5), (0.0, 0.0, 1.0, 1.0));
    }

    #[test]
    fn pending_open_cancellation_prevents_late_creation() {
        let mut pending = PendingBrowserOpens::default();
        let generation = pending.begin(pending_input("tab-1", "https://example.com/first"));

        assert!(pending.cancel("tab-1"));
        assert!(pending.take_generation("tab-1", generation).is_none());
    }

    #[test]
    fn older_pending_open_cannot_remove_a_newer_request() {
        let mut pending = PendingBrowserOpens::default();
        let older = pending.begin(pending_input("tab-1", "https://example.com/older"));
        let newer = pending.begin(pending_input("tab-1", "https://example.com/newer"));

        pending.cancel_generation("tab-1", older);
        assert_eq!(
            pending
                .take_generation("tab-1", newer)
                .expect("newer request remains")
                .input
                .url,
            "https://example.com/newer"
        );
    }

    #[test]
    fn pending_open_keeps_latest_navigation_bounds_and_visibility() {
        let mut pending = PendingBrowserOpens::default();
        let generation = pending.begin(pending_input("tab-1", "https://example.com/first"));
        let latest_bounds = BrowserBounds {
            x: 20.0,
            y: 30.0,
            width: 1024.0,
            height: 700.0,
        };

        assert!(pending.stop("tab-1"));
        assert!(pending.update_bounds("tab-1", latest_bounds.clone(), false));
        assert!(pending.update_navigation("tab-1", "https://example.com/latest".to_string()));
        let latest = pending
            .take_generation("tab-1", generation)
            .expect("pending request");

        assert_eq!(latest.input.url, "https://example.com/latest");
        assert_eq!(latest.input.bounds, latest_bounds);
        assert!(!latest.visible);
        assert!(!latest.stopped, "navigation resumes a stopped pending open");
    }

    #[test]
    fn agent_tabs_get_capture_in_every_frame_and_user_tabs_do_not() {
        let user = page_scripts(false, false);
        assert_eq!(user.len(), 1, "a user tab only gets the panel script");
        assert!(!user[0].all_frames);
        assert!(user[0].source.contains("argmax-newtab"));
        assert!(!user[0].source.contains("__argmaxCapture"));
        assert!(!user[0].source.contains("__argmaxDialog"));

        let agent = page_scripts(true, false);
        let sources: Vec<&str> = agent.iter().map(|script| script.source.as_str()).collect();
        assert!(
            !agent[0].all_frames,
            "the panel script stays in the main frame"
        );
        for marker in [
            "__argmaxCapture",
            "__argmaxDialog",
            "__argmaxCookies",
            "argmaxFrame",
        ] {
            let script = agent
                .iter()
                .find(|script| script.source.contains(marker))
                .unwrap_or_else(|| panic!("no agent script carries {marker}: {sources:?}"));
            assert!(
                script.all_frames,
                "{marker} must reach cross-origin iframes"
            );
        }
        let probe = agent
            .iter()
            .find(|script| script.source.contains("argmaxFrame"))
            .expect("frame probe");
        assert_eq!(
            probe.world,
            ScriptWorld::Agent,
            "the page must not see the probe's message handler"
        );

        let popup = page_scripts(true, true);
        assert_eq!(
            popup.last().expect("popup marker").source,
            BROWSER_POPUP_MARKER_SCRIPT,
            "a popup window has no tab strip to shortcut into"
        );
        assert!(
            popup.iter().all(|script| script.world == ScriptWorld::Page),
            "popups are not agent-addressable, so they get no frame probe"
        );
    }

    #[test]
    fn validated_browser_url_accepts_http_and_https_only() {
        assert!(validated_browser_url("https://github.com").is_ok());
        assert!(validated_browser_url("http://localhost:3000").is_ok());
        assert!(validated_browser_url("file:///etc/passwd").is_err());
        assert!(validated_browser_url("javascript:alert(1)").is_err());
        assert!(validated_browser_url("not a url").is_err());
    }

    #[test]
    fn new_tab_request_url_validates_the_payload() {
        let ok = Url::parse("argmax-newtab://open?u=https%3A%2F%2Fgithub.com%2Fargmax").unwrap();
        assert_eq!(
            new_tab_request_url(&ok).as_deref(),
            Some("https://github.com/argmax")
        );
        let bad_scheme = Url::parse("argmax-newtab://open?u=javascript%3Aalert(1)").unwrap();
        assert_eq!(new_tab_request_url(&bad_scheme), None);
        let no_param = Url::parse("argmax-newtab://open").unwrap();
        assert_eq!(new_tab_request_url(&no_param), None);
    }

    #[test]
    fn page_command_whitelists_known_commands() {
        let reload = Url::parse("argmax-newtab://command?c=reload").unwrap();
        assert_eq!(page_command(&reload), Some("reload"));
        let close = Url::parse("argmax-newtab://command?c=close-tab").unwrap();
        assert_eq!(page_command(&close), Some("close-tab"));
        let back = Url::parse("argmax-newtab://command?c=back").unwrap();
        assert_eq!(page_command(&back), Some("back"));
        let forward = Url::parse("argmax-newtab://command?c=forward").unwrap();
        assert_eq!(page_command(&forward), Some("forward"));
        let find = Url::parse("argmax-newtab://command?c=find").unwrap();
        assert_eq!(page_command(&find), Some("find"));
        let focus = Url::parse("argmax-newtab://command?c=focus").unwrap();
        assert_eq!(page_command(&focus), Some("focus"));
        for command in ["reopen-tab", "next-tab", "previous-tab", "close-panel"] {
            let url = Url::parse(&format!("argmax-newtab://command?c={command}")).unwrap();
            assert_eq!(page_command(&url), Some(command));
        }
        let unknown = Url::parse("argmax-newtab://command?c=quit-app").unwrap();
        assert_eq!(page_command(&unknown), None);
        // `open` navigations carry URLs, never commands — and vice versa.
        let open = Url::parse("argmax-newtab://open?u=https%3A%2F%2Fgithub.com").unwrap();
        assert_eq!(page_command(&open), None);
        assert_eq!(new_tab_request_url(&close), None);
    }

    #[test]
    fn tab_label_accepts_slugs_and_rejects_label_syntax() {
        assert_eq!(tab_label("tab-1").unwrap(), "browser-tab-1");
        assert!(tab_label("").is_err());
        assert!(tab_label("Tab_1").is_err());
        assert!(tab_label("main").is_ok()); // prefixed, so it cannot collide
        assert!(tab_label(&"x".repeat(33)).is_err());
        assert!(tab_label("a/b").is_err());
    }

    #[test]
    fn personal_accounts_sort_before_business_ones() {
        let mut accounts = vec![
            OpAccount {
                url: "mentimeter.1password.com".into(),
            },
            OpAccount {
                url: "my.1password.com".into(),
            },
        ];
        personal_accounts_first(&mut accounts);
        assert_eq!(accounts[0].url, "my.1password.com");
        assert_eq!(accounts[1].url, "mentimeter.1password.com");
    }

    #[cfg(unix)]
    #[test]
    fn op_command_hydrates_path_for_packaged_app() {
        let command = op_command(&["--version"]);
        let path = command
            .as_std()
            .get_envs()
            .find_map(|(key, value)| (key == "PATH").then_some(value).flatten())
            .expect("op command PATH");
        let entries = std::env::split_paths(path).collect::<Vec<_>>();

        assert!(entries.contains(&std::path::PathBuf::from("/opt/homebrew/bin")));
        assert!(entries.contains(&std::path::PathBuf::from("/usr/local/bin")));
    }

    #[test]
    fn op_environment_keeps_op_exports_and_defaults_app_integration_on() {
        let login_shell = vec![
            ("OP_ACCOUNT".to_string(), "my.1password.com".to_string()),
            ("GIT_DIR".to_string(), "/elsewhere".to_string()),
        ];

        let vars = op_environment(login_shell);

        assert_eq!(
            vars,
            vec![
                ("OP_ACCOUNT".to_string(), "my.1password.com".to_string()),
                (
                    "OP_BIOMETRIC_UNLOCK_ENABLED".to_string(),
                    "true".to_string()
                ),
            ]
        );
    }

    #[test]
    fn op_environment_respects_an_explicit_integration_choice() {
        let login_shell = vec![(
            "OP_BIOMETRIC_UNLOCK_ENABLED".to_string(),
            "false".to_string(),
        )];

        let vars = op_environment(login_shell);

        assert_eq!(
            vars,
            vec![(
                "OP_BIOMETRIC_UNLOCK_ENABLED".to_string(),
                "false".to_string()
            )]
        );
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
    fn hosts_match_refuses_subdomain_crossing_on_shared_hosts() {
        // Sibling subdomains of hosting platforms are unrelated users.
        assert!(!hosts_match("github.io", "evil.github.io"));
        assert!(!hosts_match("me.github.io", "github.io"));
        assert!(!hosts_match("me.vercel.app", "vercel.app"));
        // Exact matches still work.
        assert!(hosts_match("me.github.io", "me.github.io"));
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
                OpItemUrl {
                    href: "not a url".into(),
                },
                OpItemUrl {
                    href: "https://github.com/login".into(),
                },
            ],
        };
        assert!(item_matches_host(&item, "github.com"));
        assert!(!item_matches_host(&item, "gitlab.com"));
    }
}
