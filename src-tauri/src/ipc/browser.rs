//! In-app browser pane: one child webview per tab (label `browser-<tabId>`)
//! glued to a renderer placeholder. The renderer keeps exactly one tab
//! visible; the others stay hidden but alive, so each keeps its history,
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
use tauri::{AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, Url, Webview, WebviewUrl};
use tokio::process::Command;

use super::inputs::*;
use super::system::SystemOk;
use crate::browser::automation::{
    self, ActionOutcome, PageExtraction, PageFindResult, PageSnapshot, PageText, TabTarget,
};
use crate::browser::registry::{self, BrowserAgentOpenEvent, BrowserTabRegistry, BrowserTabsEvent};
use crate::browser::{encode_base64, eval, snapshot_image, CaptureRect};
use crate::error::{ArgmaxError, ArgmaxResult};
use crate::state::AppState;

pub const BROWSER_WEBVIEW_LABEL_PREFIX: &str = "browser-";

/// Event pushed to the main webview whenever a tab navigates, starts loading,
/// or finishes loading. `title` is only present on load-finish.
#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct BrowserStateEvent {
    pub tab_id: String,
    pub url: String,
    pub title: Option<String>,
    pub loading: bool,
}

/// Pushed when a page asks for a popup or `target="_blank"` — the renderer
/// answers by creating a new tab at `url`.
#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct BrowserNewTabEvent {
    /// Tab whose page requested the popup.
    pub tab_id: String,
    pub url: String,
}

/// A browser shortcut pressed while the page (not the panel chrome) had
/// focus. `command` is one of `close-tab`, `new-tab`, `focus-address`,
/// `back`, `forward`.
#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct BrowserPageCommandEvent {
    pub tab_id: String,
    pub command: String,
}

#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct BrowserFillResult {
    pub ok: bool,
    /// Title of the 1Password item that was filled.
    pub item_title: String,
}

/// `window.open` popups and `target="_blank"` anchors would be dead ends in a
/// child webview — route them through the `argmax-newtab:` scheme instead,
/// which `on_navigation` intercepts and turns into a real new tab. The same
/// scheme carries browser shortcuts pressed while the page has focus: without
/// interception those fall through to the app menu, where ⌘W is Close Window
/// and would take the whole app with it.
const BROWSER_INIT_SCRIPT: &str = r#"
(function () {
  var requestTab = function (url) {
    try {
      var absolute = new URL(url, window.location.href).href;
      window.location.href = "argmax-newtab://open?u=" + encodeURIComponent(absolute);
    } catch (e) {}
  };
  window.open = function (url) {
    if (url) requestTab(url);
    return null;
  };
  document.addEventListener(
    "click",
    function (event) {
      var target = event.target;
      if (!target || !target.closest) return;
      // Cmd/Ctrl-click on any link opens a new tab, like every browser.
      if (event.metaKey || event.ctrlKey) {
        var linked = target.closest("a[href]");
        if (linked && /^https?:/i.test(linked.href)) {
          event.preventDefault();
          requestTab(linked.href);
          return;
        }
      }
      var anchor = target.closest('a[target="_blank"]');
      if (anchor && anchor.href) {
        event.preventDefault();
        requestTab(anchor.href);
      }
    },
    true
  );
  window.addEventListener(
    "keydown",
    function (event) {
      if (!event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
      var key = event.key.toLowerCase();
      var command =
        key === "w" ? "close-tab" :
        key === "t" ? "new-tab" :
        key === "l" ? "focus-address" : null;
      if (!command) return;
      event.preventDefault();
      window.location.href = "argmax-newtab://command?c=" + command;
    },
    true
  );
  // Mouse thumb buttons: 3 = back, 4 = forward. The page's own history is the
  // webview's, so relay them as commands and let the pane drive navigation —
  // history.back() inside the page would skip the pane's toolbar state.
  var historyCommand = function (button) {
    return button === 3 ? "back" : button === 4 ? "forward" : null;
  };
  window.addEventListener(
    "mousedown",
    function (event) {
      if (historyCommand(event.button)) event.preventDefault();
    },
    true
  );
  window.addEventListener(
    "mouseup",
    function (event) {
      var command = historyCommand(event.button);
      if (!command) return;
      event.preventDefault();
      window.location.href = "argmax-newtab://command?c=" + command;
    },
    true
  );
})();
"#;

/// Dialog capture, installed *only* on tabs a session opened: silently
/// answering the user's own `confirm()` would misreport what they clicked.
const BROWSER_DIALOG_SCRIPT: &str = include_str!("../browser/dialog.js");

/// The initialization script one tab gets. Two documents' worth, because the
/// agent-only half must be in place before the page's first statement runs
/// and an initialization script is fixed when the webview is created.
fn init_script(owned_by_session: bool) -> String {
    if owned_by_session {
        format!("{BROWSER_INIT_SCRIPT}\n{BROWSER_DIALOG_SCRIPT}")
    } else {
        BROWSER_INIT_SCRIPT.to_string()
    }
}

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

/// Tab ids come from the renderer, but they become native webview labels —
/// reject anything that isn't a short slug so a bad id can't smuggle label
/// syntax or collide with the app's own webviews.
fn tab_label(tab_id: &str) -> ArgmaxResult<String> {
    let valid = !tab_id.is_empty()
        && tab_id.len() <= 32
        && tab_id
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-');
    if !valid {
        return Err(ArgmaxError::service(
            "BROWSER_TAB_ID_INVALID",
            format!("invalid browser tab id: {tab_id:?}"),
        ));
    }
    Ok(format!("{BROWSER_WEBVIEW_LABEL_PREFIX}{tab_id}"))
}

pub(crate) fn browser_webview(app: &AppHandle, tab_id: &str) -> ArgmaxResult<Webview> {
    app.get_webview(&tab_label(tab_id)?)
        .ok_or_else(|| ArgmaxError::service("BROWSER_NOT_OPEN", "browser tab is not open"))
}

fn bounds_rect(bounds: &BrowserBounds) -> tauri::Rect {
    tauri::Rect {
        position: LogicalPosition::new(bounds.x, bounds.y).into(),
        size: LogicalSize::new(bounds.width.max(1.0), bounds.height.max(1.0)).into(),
    }
}

fn tab_registry(app: &AppHandle) -> std::sync::Arc<BrowserTabRegistry> {
    std::sync::Arc::clone(&app.state::<AppState>().browser_tabs)
}

fn emit_state(app: &AppHandle, tab_id: String, url: String, title: Option<String>, loading: bool) {
    let tabs = tab_registry(app);
    if tabs.update_state(&tab_id, &url, title.clone(), loading) {
        registry::publish(app, &tabs);
    }
    let _ = app.emit_to(
        "main",
        "browser:state",
        BrowserStateEvent {
            tab_id,
            url,
            title,
            loading,
        },
    );
}

/// A tab a session opened is created at the window's own size and then
/// hidden: laying it out at 1×1 would collapse the page, and every snapshot
/// after that would see a document with no visible boxes.
pub(crate) fn hidden_tab_bounds(app: &AppHandle) -> BrowserBounds {
    let logical = app.get_window("main").and_then(|window| {
        let scale = window.scale_factor().ok()?;
        let size = window.inner_size().ok()?.to_logical::<f64>(scale);
        Some((size.width, size.height))
    });
    let (width, height) = logical.unwrap_or((1280.0, 900.0));
    BrowserBounds {
        x: 0.0,
        y: 0.0,
        width: width.max(1000.0),
        height: height.max(760.0),
    }
}

pub(crate) fn emit_agent_open(app: &AppHandle, session_id: &str, tab_id: &str, url: &str) {
    let _ = app.emit_to(
        "main",
        "browser:agent-open",
        BrowserAgentOpenEvent {
            session_id: session_id.to_string(),
            tab_id: tab_id.to_string(),
            url: url.to_string(),
        },
    );
}

/// Extract the requested URL from an `argmax-newtab://open?u=…` navigation.
/// Returns None (and the navigation is simply blocked) unless the payload is
/// a well-formed http(s) URL.
fn new_tab_request_url(url: &Url) -> Option<String> {
    if url.host_str() != Some("open") {
        return None;
    }
    let (_, encoded) = url.query_pairs().find(|(key, _)| key == "u")?;
    validated_browser_url(&encoded)
        .ok()
        .map(|url| url.to_string())
}

/// Extract a captured dialog from an `argmax-newtab://dialog?k=&m=`
/// navigation, which `dialog.js` posts when a page raises one.
fn page_dialog(url: &Url) -> Option<(String, String)> {
    if url.host_str() != Some("dialog") {
        return None;
    }
    let kind = url
        .query_pairs()
        .find(|(key, _)| key == "k")
        .map(|(_, value)| value.into_owned())?;
    let message = url
        .query_pairs()
        .find(|(key, _)| key == "m")
        .map(|(_, value)| value.into_owned())
        .unwrap_or_default();
    Some((kind, message))
}

/// Extract a whitelisted shortcut command from an
/// `argmax-newtab://command?c=…` navigation.
fn page_command(url: &Url) -> Option<&'static str> {
    if url.host_str() != Some("command") {
        return None;
    }
    let (_, command) = url.query_pairs().find(|(key, _)| key == "c")?;
    match command.as_ref() {
        "close-tab" => Some("close-tab"),
        "new-tab" => Some("new-tab"),
        "focus-address" => Some("focus-address"),
        "back" => Some("back"),
        "forward" => Some("forward"),
        _ => None,
    }
}

#[tauri::command(rename = "browser:open")]
#[specta::specta]
pub fn browser_open(app: AppHandle, input: BrowserOpenInput) -> ArgmaxResult<SystemOk> {
    open_tab(
        &app,
        &input.tab_id,
        &input.url,
        input.bounds,
        true,
        input.owner_session_id,
    )?;
    Ok(SystemOk { ok: true })
}

/// Creates the tab's webview, or navigates and re-shows one that exists.
/// `visible` is false for a tab a session opened while nobody is watching:
/// a child webview paints over the DOM, so it stays hidden until the pane
/// showing that session glues it to its surface.
pub(crate) fn open_tab(
    app: &AppHandle,
    tab_id: &str,
    raw_url: &str,
    bounds: BrowserBounds,
    visible: bool,
    owner_session_id: Option<String>,
) -> ArgmaxResult<()> {
    let url = validated_browser_url(raw_url)?;
    let label = tab_label(tab_id)?;
    let tabs = tab_registry(app);

    if let Some(webview) = app.get_webview(&label) {
        if visible {
            webview
                .set_bounds(bounds_rect(&bounds))
                .and_then(|_| webview.show())
        } else {
            webview.hide()
        }
        .and_then(|_| webview.navigate(url))
        .map_err(|error| ArgmaxError::service("BROWSER_NAVIGATE_FAILED", error.to_string()))?;
        if tabs.insert(tab_id, owner_session_id, raw_url) {
            registry::publish(app, &tabs);
        }
        return Ok(());
    }

    let window = app
        .get_window("main")
        .ok_or_else(|| ArgmaxError::service("BROWSER_NO_MAIN_WINDOW", "main window missing"))?;

    let nav_app = app.clone();
    let nav_tab = tab_id.to_string();
    let load_app = app.clone();
    let load_tab = tab_id.to_string();
    let builder = tauri::webview::WebviewBuilder::new(&label, WebviewUrl::External(url))
        // WKWebView's default UA reads as an embedded webview; Google (and
        // others) then warn "browser no longer supported" and refuse OAuth.
        // Present as desktop Safari, which is what this engine actually is.
        .user_agent(
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 \
             (KHTML, like Gecko) Version/18.5 Safari/605.1.15",
        )
        .initialization_script(init_script(owner_session_id.is_some()))
        .on_navigation(move |url| {
            if url.scheme() == "argmax-newtab" {
                if let Some(target) = new_tab_request_url(url) {
                    let _ = nav_app.emit_to(
                        "main",
                        "browser:new-tab",
                        BrowserNewTabEvent {
                            tab_id: nav_tab.clone(),
                            url: target,
                        },
                    );
                } else if let Some(dialog) = page_dialog(url) {
                    // Nothing to push: the agent reads the dialog off the next
                    // snapshot's header line, and the user's tabs never raise
                    // one here. The log is what makes it visible in
                    // `system:debug-snapshot` while verifying.
                    tracing::info!(
                        tab = %nav_tab,
                        kind = %dialog.0,
                        message = %dialog.1,
                        "browser dialog captured on an agent tab"
                    );
                } else if let Some(command) = page_command(url) {
                    let _ = nav_app.emit_to(
                        "main",
                        "browser:page-command",
                        BrowserPageCommandEvent {
                            tab_id: nav_tab.clone(),
                            command: command.to_string(),
                        },
                    );
                }
                return false;
            }
            // No emit_state here: this callback also fires for iframe
            // navigations (with the iframe's URL), which would leak into the
            // address bar and strand the tab spinner. Loading state comes
            // from on_page_load below, which is main-frame only. `blob:` is
            // allowed for in-page viewers (PDF previews render via blob URLs).
            matches!(url.scheme(), "http" | "https" | "about" | "blob")
        })
        .on_page_load(move |webview, payload| {
            let url = payload.url().to_string();
            if payload.event() != tauri::webview::PageLoadEvent::Finished {
                emit_state(&load_app, load_tab.clone(), url, None, true);
                return;
            }
            tracing::debug!(%url, tab = %load_tab, "browser tab page loaded");
            let title_app = load_app.clone();
            let title_tab = load_tab.clone();
            let title_url = url.clone();
            let eval_result = webview.eval_with_callback("document.title", move |value| {
                let title = serde_json::from_str::<String>(&value).unwrap_or_default();
                emit_state(
                    &title_app,
                    title_tab.clone(),
                    title_url.clone(),
                    Some(title),
                    false,
                );
            });
            if eval_result.is_err() {
                emit_state(&load_app, load_tab.clone(), url, None, false);
            }
        });

    let created = window
        .add_child(
            builder,
            LogicalPosition::new(bounds.x, bounds.y),
            LogicalSize::new(bounds.width.max(1.0), bounds.height.max(1.0)),
        )
        .map_err(|error| ArgmaxError::service("BROWSER_CREATE_FAILED", error.to_string()))?;
    if !visible {
        let _ = created.hide();
    }
    tabs.insert(tab_id, owner_session_id, raw_url);
    registry::publish(app, &tabs);
    tracing::info!(tab = %tab_id, visible, "browser tab webview created");
    Ok(())
}

#[tauri::command(rename = "browser:navigate")]
#[specta::specta]
pub fn browser_navigate(app: AppHandle, input: BrowserNavigateInput) -> ArgmaxResult<SystemOk> {
    navigate_tab(&app, &input.tab_id, &input.url)?;
    Ok(SystemOk { ok: true })
}

pub(crate) fn navigate_tab(app: &AppHandle, tab_id: &str, raw_url: &str) -> ArgmaxResult<()> {
    let url = validated_browser_url(raw_url)?;
    browser_webview(app, tab_id)?
        .navigate(url)
        .map_err(|error| ArgmaxError::service("BROWSER_NAVIGATE_FAILED", error.to_string()))
}

#[tauri::command(rename = "browser:back")]
#[specta::specta]
pub fn browser_back(app: AppHandle, input: BrowserBackInput) -> ArgmaxResult<SystemOk> {
    eval_in_browser(&app, &input.tab_id, "history.back()")
}

#[tauri::command(rename = "browser:forward")]
#[specta::specta]
pub fn browser_forward(app: AppHandle, input: BrowserForwardInput) -> ArgmaxResult<SystemOk> {
    eval_in_browser(&app, &input.tab_id, "history.forward()")
}

#[tauri::command(rename = "browser:reload")]
#[specta::specta]
pub fn browser_reload(app: AppHandle, input: BrowserReloadInput) -> ArgmaxResult<SystemOk> {
    eval_in_browser(&app, &input.tab_id, "location.reload()")
}

#[tauri::command(rename = "browser:stop")]
#[specta::specta]
pub fn browser_stop(app: AppHandle, input: BrowserStopInput) -> ArgmaxResult<SystemOk> {
    eval_in_browser(&app, &input.tab_id, "window.stop()")
}

fn eval_in_browser(app: &AppHandle, tab_id: &str, js: &str) -> ArgmaxResult<SystemOk> {
    browser_webview(app, tab_id)?
        .eval(js)
        .map_err(|error| ArgmaxError::service("BROWSER_EVAL_FAILED", error.to_string()))?;
    Ok(SystemOk { ok: true })
}

#[tauri::command(rename = "browser:set-bounds")]
#[specta::specta]
pub fn browser_set_bounds(app: AppHandle, input: BrowserSetBoundsInput) -> ArgmaxResult<SystemOk> {
    let webview = browser_webview(&app, &input.tab_id)?;
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
pub fn browser_close(app: AppHandle, input: BrowserCloseInput) -> ArgmaxResult<SystemOk> {
    close_tab(&app, &input.tab_id)?;
    Ok(SystemOk { ok: true })
}

/// Destroys the tab's webview — history and session go with it. Hiding the
/// pane goes through `browser:set-bounds` with `visible: false` instead, which
/// keeps those alive.
pub(crate) fn close_tab(app: &AppHandle, tab_id: &str) -> ArgmaxResult<()> {
    browser_webview(app, tab_id)?
        .close()
        .map_err(|error| ArgmaxError::service("BROWSER_CLOSE_FAILED", error.to_string()))?;
    let tabs = tab_registry(app);
    if tabs.remove(tab_id) {
        registry::publish(app, &tabs);
    }
    Ok(())
}

// --- Programmatic capture and evaluation ------------------------------------

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

// --- Agent automation -------------------------------------------------------
//
// Six channels over `browser::automation`. They exist so the renderer and the
// verification harness reach the same code an agent's MCP tools will, rather
// than a parallel implementation that drifts.

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

// --- 1Password fill ---------------------------------------------------------

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
    command.env("PATH", crate::util::login_shell::path());
    command
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
            "no 1Password accounts on this device; sign in with `op signin` first",
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
        let close = Url::parse("argmax-newtab://command?c=close-tab").unwrap();
        assert_eq!(page_command(&close), Some("close-tab"));
        let back = Url::parse("argmax-newtab://command?c=back").unwrap();
        assert_eq!(page_command(&back), Some("back"));
        let forward = Url::parse("argmax-newtab://command?c=forward").unwrap();
        assert_eq!(page_command(&forward), Some("forward"));
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
