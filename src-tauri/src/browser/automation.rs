//! Driving a browser tab from Rust: what an agent's browser tools call.
//!
//! Everything here takes `&AppHandle` explicitly rather than living on a
//! command struct, because the callers do not all come through Tauri's invoke
//! pipeline — the MCP server answers on a Unix socket and holds a handle of
//! its own. The IPC commands in `ipc::browser` are thin wrappers over these
//! same functions, which is also what makes the harness and the agent exercise
//! one code path.
//!
//! Two scripts do the work inside the page (`snapshot.js`, `actions.js`). They
//! are re-sent with every call, guarded by `window.__argmax.v`, so the install
//! costs one property read on a warm page and re-arms itself automatically
//! after a navigation wipes the world. Refs survive that, because they live in
//! the DOM rather than in a table on the Rust side.

use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use specta::Type;
use tauri::{AppHandle, Manager, Webview};

use super::registry::BrowserTabInfo;
use super::{eval, snapshot_image, CaptureRect};
use crate::error::{ArgmaxError, ArgmaxResult};
use crate::state::AppState;

const AGENT_API_VERSION: u32 = 1;
const SNAPSHOT_JS: &str = include_str!("snapshot.js");
const ACTIONS_JS: &str = include_str!("actions.js");

/// A snapshot walks the whole DOM and can run into a page still streaming
/// content, so it gets more room than an action, which touches one node.
const READ_TIMEOUT: Duration = Duration::from_secs(15);
const ACTION_TIMEOUT: Duration = Duration::from_secs(10);
const SCREENSHOT_TIMEOUT: Duration = Duration::from_secs(5);
const EVAL_TIMEOUT: Duration = Duration::from_secs(10);
const WAIT_POLL_INTERVAL: Duration = Duration::from_millis(150);
const WAIT_TIMEOUT_DEFAULT_MS: u32 = 10_000;
const WAIT_TIMEOUT_MAX_MS: u32 = 120_000;

/// Which tab an action means. A session that names no tab gets the one it
/// touched most recently, the way a person's foreground tab works.
#[derive(Debug, Clone, PartialEq)]
pub enum TabTarget {
    Tab(String),
    Session(String),
}

impl TabTarget {
    /// Builds a target from the two optional fields every automation input
    /// carries. An explicit tab id wins; naming neither is a caller bug.
    pub fn from_inputs(tab_id: Option<String>, session_id: Option<String>) -> ArgmaxResult<Self> {
        match (tab_id, session_id) {
            (Some(tab_id), _) => Ok(Self::Tab(tab_id)),
            (None, Some(session_id)) => Ok(Self::Session(session_id)),
            (None, None) => Err(ArgmaxError::service(
                "BROWSER_NO_TAB",
                "name a tab id or a session to act on",
            )),
        }
    }
}

#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PageSnapshot {
    pub tab_id: String,
    pub url: String,
    pub title: String,
    /// Indented aria tree; interactive lines carry `[ref=eN]` handles.
    pub tree: String,
    /// True when the node or byte cap cut the tree short.
    pub truncated: bool,
}

#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct FoundElement {
    #[serde(rename = "ref")]
    pub element_ref: String,
    pub role: String,
    pub name: String,
    pub value: String,
}

#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PageFindResult {
    pub tab_id: String,
    pub matches: Vec<FoundElement>,
}

#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PageText {
    pub tab_id: String,
    pub url: String,
    pub title: String,
    pub text: String,
    pub truncated: bool,
}

#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ActionOutcome {
    pub tab_id: String,
    /// URL after the action — a click that navigated says so here.
    pub url: String,
    /// What the action touched, for a tool row a person can read.
    pub detail: Option<String>,
}

/// One interaction. Serialized tagged so a tool layer can pass it straight
/// through without a verb-per-command explosion on the IPC surface.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum BrowserAction {
    #[serde(rename_all = "camelCase")]
    Click {
        #[serde(rename = "ref")]
        element_ref: String,
    },
    #[serde(rename_all = "camelCase")]
    Type {
        #[serde(rename = "ref")]
        element_ref: String,
        text: String,
        /// Press Enter (falling back to the field's form) after typing.
        #[serde(default)]
        submit: bool,
    },
    #[serde(rename_all = "camelCase")]
    Select {
        #[serde(rename = "ref")]
        element_ref: String,
        value: String,
    },
    #[serde(rename_all = "camelCase")]
    Hover {
        #[serde(rename = "ref")]
        element_ref: String,
    },
    #[serde(rename_all = "camelCase")]
    PressKey {
        key: String,
        #[serde(default)]
        modifiers: Vec<String>,
    },
    #[serde(rename_all = "camelCase")]
    Scroll {
        #[serde(default, rename = "ref")]
        element_ref: Option<String>,
        /// `up`, `down`, `left` or `right`.
        direction: String,
        /// CSS pixels; defaults to most of the scrollport.
        #[serde(default)]
        amount: Option<f64>,
    },
    #[serde(rename_all = "camelCase")]
    WaitFor {
        #[serde(default)]
        text: Option<String>,
        #[serde(default, rename = "ref")]
        element_ref: Option<String>,
        #[serde(default)]
        url_includes: Option<String>,
        #[serde(default)]
        timeout_ms: Option<u32>,
    },
}

// --- tab resolution ---------------------------------------------------------

fn registry(app: &AppHandle) -> std::sync::Arc<super::registry::BrowserTabRegistry> {
    std::sync::Arc::clone(&app.state::<AppState>().browser_tabs)
}

/// Resolves the target to a live tab id and marks it as the session's current
/// one. A session whose tabs were all closed gets a message that says to open
/// a page rather than a bare "not open".
pub fn resolve_tab(app: &AppHandle, target: &TabTarget) -> ArgmaxResult<String> {
    let tabs = registry(app);
    let tab_id = match target {
        TabTarget::Tab(tab_id) => {
            if !tabs.contains(tab_id) {
                return Err(ArgmaxError::service(
                    "BROWSER_NOT_OPEN",
                    format!("browser tab {tab_id} is not open"),
                ));
            }
            tab_id.clone()
        }
        TabTarget::Session(session_id) => tabs
            .latest_for_session(session_id)
            .map(|tab| tab.tab_id)
            .ok_or_else(|| {
                ArgmaxError::service(
                    "BROWSER_NO_TAB",
                    "this session has no browser tab open yet; open a page first",
                )
            })?,
    };
    tabs.touch(&tab_id);
    Ok(tab_id)
}

fn webview(app: &AppHandle, tab_id: &str) -> ArgmaxResult<Webview> {
    crate::ipc::browser::browser_webview(app, tab_id)
}

// --- script plumbing --------------------------------------------------------

/// Wraps one call to the injected API, installing it first when the page has
/// not got it (a fresh load, or a version bump after an app update).
fn call_script(call: &str) -> String {
    let mut script = String::with_capacity(SNAPSHOT_JS.len() + ACTIONS_JS.len() + call.len() + 256);
    script.push_str("(function () { try { if (!window.__argmax || window.__argmax.v !== ");
    script.push_str(&AGENT_API_VERSION.to_string());
    script.push_str(") {\n");
    script.push_str(SNAPSHOT_JS);
    script.push('\n');
    script.push_str(ACTIONS_JS);
    script.push_str("\n}\nreturn JSON.stringify(");
    script.push_str(call);
    script.push_str("); } catch (error) { return JSON.stringify({ error: String(error) }); } })()");
    script
}

/// Runs a call and unwraps its envelope. The script answers with a JSON
/// *string*, so WebKit's own JSON encoding wraps it once more — hence the
/// double decode.
async fn call(app: &AppHandle, tab_id: &str, call: &str, timeout: Duration) -> ArgmaxResult<Value> {
    let webview = webview(app, tab_id)?;
    let raw = eval::eval_json(&webview, &call_script(call), timeout).await?;
    let encoded: String = serde_json::from_str(&raw).map_err(|_| {
        ArgmaxError::service(
            "BROWSER_ACTION_FAILED",
            "the page returned nothing — it may still be loading",
        )
    })?;
    let value: Value = serde_json::from_str(&encoded).map_err(|error| {
        ArgmaxError::service(
            "BROWSER_ACTION_FAILED",
            format!("unreadable answer from the page: {error}"),
        )
    })?;
    if let Some(message) = value.get("error").and_then(Value::as_str) {
        return Err(ArgmaxError::service("BROWSER_ACTION_FAILED", message));
    }
    Ok(value)
}

fn string_field(value: &Value, key: &str) -> String {
    value
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string()
}

// --- tabs -------------------------------------------------------------------

/// Opens a page in a tab owned by `session_id`. The webview is created hidden
/// at the window's own size: the agent may be working while the user looks at
/// something else, and a child webview always paints over the DOM. The pane
/// showing that session glues and reveals it when it enters Browser mode.
pub fn open(app: &AppHandle, session_id: Option<&str>, url: &str) -> ArgmaxResult<String> {
    let tabs = registry(app);
    let tab_id = tabs.allocate_tab_id();
    crate::ipc::browser::open_tab(
        app,
        &tab_id,
        url,
        crate::ipc::browser::hidden_tab_bounds(app),
        false,
        session_id.map(str::to_string),
    )?;
    if let Some(session_id) = session_id {
        crate::ipc::browser::emit_agent_open(app, session_id, &tab_id, url);
    }
    Ok(tab_id)
}

pub fn tabs(app: &AppHandle, session_id: Option<&str>) -> Vec<BrowserTabInfo> {
    let tabs = registry(app);
    match session_id {
        Some(session_id) => tabs.for_session(session_id),
        None => tabs.list(),
    }
}

pub fn navigate(app: &AppHandle, target: &TabTarget, url: &str) -> ArgmaxResult<String> {
    let tab_id = resolve_tab(app, target)?;
    crate::ipc::browser::navigate_tab(app, &tab_id, url)?;
    Ok(tab_id)
}

pub fn back(app: &AppHandle, target: &TabTarget) -> ArgmaxResult<String> {
    let tab_id = resolve_tab(app, target)?;
    webview(app, &tab_id)?
        .eval("history.back()")
        .map_err(|error| ArgmaxError::service("BROWSER_EVAL_FAILED", error.to_string()))?;
    Ok(tab_id)
}

pub fn reload(app: &AppHandle, target: &TabTarget) -> ArgmaxResult<String> {
    let tab_id = resolve_tab(app, target)?;
    webview(app, &tab_id)?
        .eval("location.reload()")
        .map_err(|error| ArgmaxError::service("BROWSER_EVAL_FAILED", error.to_string()))?;
    Ok(tab_id)
}

pub fn close(app: &AppHandle, target: &TabTarget) -> ArgmaxResult<String> {
    let tab_id = resolve_tab(app, target)?;
    crate::ipc::browser::close_tab(app, &tab_id)?;
    Ok(tab_id)
}

// --- reads ------------------------------------------------------------------

pub async fn snapshot(
    app: &AppHandle,
    target: &TabTarget,
    interactive_only: bool,
) -> ArgmaxResult<PageSnapshot> {
    let tab_id = resolve_tab(app, target)?;
    let value = call(
        app,
        &tab_id,
        &format!(
            "window.__argmax.snapshot({})",
            json!({ "interactiveOnly": interactive_only })
        ),
        READ_TIMEOUT,
    )
    .await?;
    Ok(PageSnapshot {
        tab_id,
        url: string_field(&value, "url"),
        title: string_field(&value, "title"),
        tree: string_field(&value, "tree"),
        truncated: value
            .get("truncated")
            .and_then(Value::as_bool)
            .unwrap_or(false),
    })
}

pub async fn find(
    app: &AppHandle,
    target: &TabTarget,
    query: &str,
) -> ArgmaxResult<PageFindResult> {
    let tab_id = resolve_tab(app, target)?;
    let value = call(
        app,
        &tab_id,
        &format!("window.__argmax.find({})", json!(query)),
        READ_TIMEOUT,
    )
    .await?;
    let matches = value
        .get("matches")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .map(|item| FoundElement {
                    element_ref: string_field(item, "ref"),
                    role: string_field(item, "role"),
                    name: string_field(item, "name"),
                    value: string_field(item, "value"),
                })
                .collect()
        })
        .unwrap_or_default();
    Ok(PageFindResult { tab_id, matches })
}

pub async fn get_text(
    app: &AppHandle,
    target: &TabTarget,
    max_chars: Option<u32>,
) -> ArgmaxResult<PageText> {
    let tab_id = resolve_tab(app, target)?;
    let value = call(
        app,
        &tab_id,
        &format!(
            "window.__argmax.getText({})",
            json!(max_chars.unwrap_or(20_000))
        ),
        READ_TIMEOUT,
    )
    .await?;
    Ok(PageText {
        tab_id,
        url: string_field(&value, "url"),
        title: string_field(&value, "title"),
        text: string_field(&value, "text"),
        truncated: value
            .get("truncated")
            .and_then(Value::as_bool)
            .unwrap_or(false),
    })
}

// --- writes -----------------------------------------------------------------

pub async fn act(
    app: &AppHandle,
    target: &TabTarget,
    action: &BrowserAction,
) -> ArgmaxResult<ActionOutcome> {
    let tab_id = resolve_tab(app, target)?;
    if let BrowserAction::WaitFor {
        text,
        element_ref,
        url_includes,
        timeout_ms,
    } = action
    {
        return wait_for(
            app,
            &tab_id,
            text.as_deref(),
            element_ref.as_deref(),
            url_includes.as_deref(),
            *timeout_ms,
        )
        .await;
    }
    let script = match action {
        BrowserAction::Click { element_ref } => {
            format!("window.__argmax.click({})", json!(element_ref))
        }
        BrowserAction::Type {
            element_ref,
            text,
            submit,
        } => format!(
            "window.__argmax.type({}, {}, {})",
            json!(element_ref),
            json!(text),
            json!({ "submit": submit })
        ),
        BrowserAction::Select { element_ref, value } => format!(
            "window.__argmax.select({}, {})",
            json!(element_ref),
            json!(value)
        ),
        BrowserAction::Hover { element_ref } => {
            format!("window.__argmax.hover({})", json!(element_ref))
        }
        BrowserAction::PressKey { key, modifiers } => format!(
            "window.__argmax.pressKey({}, {})",
            json!(key),
            json!(modifiers)
        ),
        BrowserAction::Scroll {
            element_ref,
            direction,
            amount,
        } => format!(
            "window.__argmax.scroll({})",
            json!({ "ref": element_ref, "direction": direction, "amount": amount })
        ),
        BrowserAction::WaitFor { .. } => unreachable!("handled above"),
    };
    let value = call(app, &tab_id, &script, ACTION_TIMEOUT).await?;
    Ok(outcome(tab_id, &value))
}

fn outcome(tab_id: String, value: &Value) -> ActionOutcome {
    let detail = value
        .get("target")
        .and_then(Value::as_str)
        .map(str::to_string);
    ActionOutcome {
        tab_id,
        url: string_field(value, "url"),
        detail,
    }
}

/// Polls the page's own watcher until it reports a match or the deadline
/// passes. The watcher is idempotent by id, so a navigation that wipes it
/// simply re-arms it against the new document on the next poll.
async fn wait_for(
    app: &AppHandle,
    tab_id: &str,
    text: Option<&str>,
    element_ref: Option<&str>,
    url_includes: Option<&str>,
    timeout_ms: Option<u32>,
) -> ArgmaxResult<ActionOutcome> {
    let spec = json!({ "text": text, "ref": element_ref, "urlIncludes": url_includes });
    let wait_id = format!("w{}", wait_id_seed());
    let budget = Duration::from_millis(
        timeout_ms
            .unwrap_or(WAIT_TIMEOUT_DEFAULT_MS)
            .clamp(1, WAIT_TIMEOUT_MAX_MS)
            .into(),
    );
    let deadline = Instant::now() + budget;
    let script = format!(
        "window.__argmax.waitFor({}, {})",
        json!(wait_id),
        spec.to_string()
    );
    loop {
        // A navigation mid-wait tears the page down, and the eval racing it
        // fails; that is a state to keep waiting through, not to report.
        match call(app, tab_id, &script, ACTION_TIMEOUT).await {
            Ok(value) => {
                if value.get("pending").and_then(Value::as_bool) != Some(true) {
                    return Ok(outcome(tab_id.to_string(), &value));
                }
            }
            Err(error) if Instant::now() >= deadline => return Err(error),
            Err(_) => {}
        }
        if Instant::now() >= deadline {
            return Err(ArgmaxError::service(
                "BROWSER_WAIT_TIMEOUT",
                format!(
                    "the page did not match within {} ms: {}",
                    budget.as_millis(),
                    spec
                ),
            ));
        }
        tokio::time::sleep(WAIT_POLL_INTERVAL).await;
    }
}

/// Wait ids only have to be unique within one page, and an abandoned wait is
/// cleaned up by the page's own TTL — a nanosecond clock read is enough
/// without pulling in a generator.
fn wait_id_seed() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|since| since.as_nanos())
        .unwrap_or(0)
}

// --- capture ----------------------------------------------------------------

/// PNG of the tab, cropped to one element when a ref is given. The crop is in
/// the page's own CSS pixels, so the element is scrolled into view first.
pub async fn screenshot(
    app: &AppHandle,
    target: &TabTarget,
    element_ref: Option<&str>,
    max_width_points: Option<f64>,
) -> ArgmaxResult<snapshot_image::CapturedPng> {
    let tab_id = resolve_tab(app, target)?;
    let rect = match element_ref {
        None => None,
        Some(element_ref) => {
            let value = call(
                app,
                &tab_id,
                &format!("window.__argmax.rect({})", json!(element_ref)),
                ACTION_TIMEOUT,
            )
            .await?;
            let box_ = value.get("ok").ok_or_else(|| {
                ArgmaxError::service("BROWSER_ACTION_FAILED", "the page returned no element box")
            })?;
            let number = |key: &str| box_.get(key).and_then(Value::as_f64).unwrap_or(0.0);
            Some(CaptureRect {
                x: number("x"),
                y: number("y"),
                width: number("width"),
                height: number("height"),
            })
        }
    };
    let view = webview(app, &tab_id)?;
    snapshot_image::capture(&view, rect, max_width_points, SCREENSHOT_TIMEOUT).await
}

/// Runs an expression in the page and returns what it evaluated to.
///
/// `wrap_for_errors` catches inside the page, because WebKit's completion
/// handler drops the `NSError` and a script that threw would otherwise be
/// indistinguishable from one that returned `undefined`.
pub async fn evaluate(
    app: &AppHandle,
    target: &TabTarget,
    expression: &str,
) -> ArgmaxResult<Value> {
    let tab_id = resolve_tab(app, target)?;
    let view = webview(app, &tab_id)?;
    let raw = eval::eval_json(&view, &eval::wrap_for_errors(expression), EVAL_TIMEOUT).await?;
    let encoded: String = serde_json::from_str(&raw).map_err(|_| {
        ArgmaxError::service(
            "BROWSER_EVAL_FAILED",
            "the page returned nothing — it may still be loading",
        )
    })?;
    let value: Value = serde_json::from_str(&encoded).map_err(|error| {
        ArgmaxError::service(
            "BROWSER_EVAL_FAILED",
            format!("unreadable answer from the page: {error}"),
        )
    })?;
    if let Some(message) = value.get("error").and_then(Value::as_str) {
        return Err(ArgmaxError::service("BROWSER_EVAL_FAILED", message));
    }
    Ok(json!({ "tabId": tab_id, "result": value.get("ok").cloned().unwrap_or(Value::Null) }))
}

/// Answers this tab's next `alert`/`confirm`/`prompt`, and acknowledges the
/// one that just fired. A page's dialog call is synchronous and cannot wait
/// for an answer from another process, so it is auto-dismissed on the spot and
/// this arms the reply for the next one; `dialog.js` has the reasoning.
pub async fn handle_dialog(
    app: &AppHandle,
    target: &TabTarget,
    accept: bool,
    prompt_text: Option<&str>,
) -> ArgmaxResult<Value> {
    let tab_id = resolve_tab(app, target)?;
    let mut value = call(
        app,
        &tab_id,
        &format!(
            "window.__argmax.handleDialog({}, {})",
            json!(accept),
            json!(prompt_text)
        ),
        ACTION_TIMEOUT,
    )
    .await?;
    if let Some(object) = value.as_object_mut() {
        object.insert("tabId".to_string(), json!(tab_id));
    }
    Ok(value)
}

#[cfg(test)]
mod tests {
    use super::{call_script, BrowserAction, TabTarget};

    #[test]
    fn a_call_installs_the_api_and_returns_an_envelope() {
        let script = call_script("window.__argmax.snapshot({})");
        assert!(script.contains("window.__argmax.v !== 1"));
        assert!(script.contains("data-argmax-ref"), "snapshot.js is inlined");
        assert!(
            script.contains("api.click = click"),
            "actions.js is inlined"
        );
        assert!(script.ends_with("})()"));
    }

    #[test]
    fn an_explicit_tab_wins_over_the_session() {
        let target =
            TabTarget::from_inputs(Some("tab-1".into()), Some("s1".into())).expect("target");
        assert_eq!(target, TabTarget::Tab("tab-1".into()));
        assert_eq!(
            TabTarget::from_inputs(None, Some("s1".into())).expect("target"),
            TabTarget::Session("s1".into())
        );
        assert!(TabTarget::from_inputs(None, None).is_err());
    }

    #[test]
    fn actions_deserialize_from_the_shape_a_tool_call_sends() {
        let action: BrowserAction =
            serde_json::from_str(r#"{"kind":"type","ref":"e3","text":"hi","submit":true}"#)
                .expect("type action");
        assert_eq!(
            action,
            BrowserAction::Type {
                element_ref: "e3".into(),
                text: "hi".into(),
                submit: true
            }
        );
        let wait: BrowserAction =
            serde_json::from_str(r#"{"kind":"waitFor","urlIncludes":"iana.org"}"#)
                .expect("wait action");
        assert_eq!(
            wait,
            BrowserAction::WaitFor {
                text: None,
                element_ref: None,
                url_includes: Some("iana.org".into()),
                timeout_ms: None
            }
        );
    }
}
