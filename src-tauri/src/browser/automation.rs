//! Driving a browser tab from Rust: what an agent's browser tools call.
//!
//! Everything here takes `&AppHandle` explicitly rather than living on a
//! command struct, because the callers do not all come through Tauri's invoke
//! pipeline — the MCP server answers on a Unix socket and holds a handle of
//! its own. The IPC commands in `ipc::browser` are thin wrappers over these
//! same functions, which is also what makes the harness and the agent exercise
//! one code path.
//!
//! Two on-demand scripts do the DOM work (`snapshot.js`, `actions.js`). They
//! are re-sent with every call, guarded by `window.__argmax.v`, so the install
//! costs one property read on a warm page and re-arms itself automatically
//! after a navigation wipes the world. Agent-owned tabs also install
//! `capture.js` before page scripts run. Refs survive navigation only when the
//! same DOM node survives, because they live in the DOM rather than in a table
//! on the Rust side.
//!
//! A cross-origin `<iframe>` is a document of its own that no main-frame
//! script can read, so every read walks the tab's frames (`walk`) and every
//! ref-addressed action runs in the frame its ref names (`f3e5` lives in
//! frame `f3`). `frames` holds the WebKit handles that make that possible.

use std::collections::VecDeque;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use specta::Type;
use tauri::{AppHandle, Manager, Webview};

use super::frames::{self, EvalFailure};
use super::registry::BrowserTabInfo;
use super::{eval, snapshot_image, CaptureRect};
use crate::error::{ArgmaxError, ArgmaxResult};
use crate::state::AppState;

const AGENT_API_VERSION: u32 = 5;
const SNAPSHOT_JS: &str = include_str!("snapshot.js");
const ACTIONS_JS: &str = include_str!("actions.js");

/// A snapshot walks the whole DOM and can run into a page still streaming
/// content, so it gets more room than an action, which touches one node.
const READ_TIMEOUT: Duration = Duration::from_secs(15);
const ACTION_TIMEOUT: Duration = Duration::from_secs(10);
const SCREENSHOT_TIMEOUT: Duration = Duration::from_secs(5);
const EVAL_TIMEOUT: Duration = Duration::from_secs(10);
const LOAD_POLL_INTERVAL: Duration = Duration::from_millis(100);
const WAIT_POLL_INTERVAL: Duration = Duration::from_millis(150);
const WAIT_TIMEOUT_DEFAULT_MS: u32 = 10_000;
const WAIT_TIMEOUT_MAX_MS: u32 = 120_000;
/// Steps to take when `dragBegin` does not report its own count.
const DRAG_STEPS_DEFAULT: u64 = 10;
/// How long a document's frames get to answer the probe. An answer is a
/// same-process message hop and normally lands in a few milliseconds; a frame
/// that has not answered by now either cannot run script (a sandbox without
/// `allow-scripts`) or is still loading.
const PROBE_WAIT: Duration = Duration::from_millis(400);
const PROBE_POLL_INTERVAL: Duration = Duration::from_millis(10);
/// Nesting and count caps for one walk, so an ad-stuffed page cannot turn a
/// snapshot into dozens of evaluations.
const MAX_FRAME_DEPTH: usize = 3;
const MAX_FRAMES: usize = 24;
/// The whole composed tree, main frame and every frame spliced into it. Each
/// document is still capped at 40 KB by `snapshot.js` itself.
const MAX_COMPOSED_SNAPSHOT_BYTES: usize = 64 * 1024;
const MAX_FOUND: usize = 20;
const CANCEL_WAIT_TIMEOUT: Duration = Duration::from_secs(1);

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
    /// `captcha`, `cookie`, `error`, `loading`, or `ready`, plus a short reason.
    pub state: String,
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
    pub state: String,
    pub text: String,
    pub truncated: bool,
}

#[derive(Debug, Clone, Deserialize, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PageMetadata {
    pub title: String,
    pub description: Option<String>,
    pub canonical_url: Option<String>,
    pub language: Option<String>,
    pub author: Option<String>,
    pub published_time: Option<String>,
    pub modified_time: Option<String>,
    pub site_name: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PageHeading {
    pub level: u8,
    pub text: String,
}

#[derive(Debug, Clone, Deserialize, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PageSection {
    pub heading: Option<String>,
    pub level: Option<u8>,
    pub text: String,
}

#[derive(Debug, Clone, Deserialize, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PageTable {
    pub caption: Option<String>,
    pub headers: Vec<String>,
    pub rows: Vec<Vec<String>>,
}

#[derive(Debug, Clone, Deserialize, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PageLink {
    pub text: Option<String>,
    pub url: String,
}

#[derive(Debug, Clone, Deserialize, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PageItem {
    pub text: String,
    #[serde(default, rename = "ref")]
    pub element_ref: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PageField {
    pub name: String,
    pub value: String,
    pub role: String,
    #[serde(default, rename = "ref")]
    pub element_ref: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PageExtraction {
    #[serde(default)]
    pub tab_id: String,
    pub url: String,
    pub title: String,
    #[serde(default)]
    pub state: String,
    pub metadata: PageMetadata,
    pub headings: Vec<PageHeading>,
    pub sections: Vec<PageSection>,
    pub tables: Vec<PageTable>,
    pub links: Vec<PageLink>,
    #[serde(default)]
    pub items: Vec<PageItem>,
    #[serde(default)]
    pub fields: Vec<PageField>,
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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub matched: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub state: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url_changed: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text_chars: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text_chars_delta: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub listbox_open: Option<bool>,
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
    Drag {
        #[serde(rename = "ref")]
        element_ref: String,
        #[serde(default)]
        to_ref: Option<String>,
        #[serde(default)]
        start_x: Option<f64>,
        #[serde(default)]
        start_y: Option<f64>,
        #[serde(default)]
        end_x: Option<f64>,
        #[serde(default)]
        end_y: Option<f64>,
        #[serde(default)]
        delta_x: Option<f64>,
        #[serde(default)]
        delta_y: Option<f64>,
        #[serde(default)]
        steps: Option<u8>,
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
        /// Wait until fetch/XHR have been idle for this many milliseconds.
        #[serde(default)]
        quiet_ms: Option<u32>,
        /// Wait until at least this many visible list-like items exist
        /// (optionally containing `text`).
        #[serde(default)]
        min_count: Option<u32>,
        #[serde(default)]
        timeout_ms: Option<u32>,
    },
}

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

/// Where in a tab a script runs: the main frame (`None`) or one iframe.
pub type Frame = Option<u32>;

/// The frame a ref lives in: `f3e5` and `f3` itself are frame 3, `e5` is the
/// main frame.
pub fn frame_of_ref(element_ref: &str) -> Frame {
    let head = element_ref.split('e').next().unwrap_or_default();
    frames::parse_id(head)
}

fn frame_label(frame: Frame) -> String {
    frame.map(|id| format!("f{id}")).unwrap_or_default()
}

/// Wraps one call to the injected API, installing it first when the page has
/// not got it (a fresh load, or a version bump after an app update). The
/// frame id goes in first, because the refs a call hands out carry it.
fn call_script(frame: Frame, call: &str) -> String {
    let mut script = String::with_capacity(SNAPSHOT_JS.len() + ACTIONS_JS.len() + call.len() + 320);
    script.push_str("(function () { try { window.__argmaxFrameId = ");
    script.push_str(&json!(frame_label(frame)).to_string());
    script.push_str("; if (!window.__argmax || window.__argmax.v !== ");
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

/// Runs a call in the main frame and unwraps its envelope.
async fn call(app: &AppHandle, tab_id: &str, call: &str, timeout: Duration) -> ArgmaxResult<Value> {
    call_in(app, tab_id, None, call, timeout).await
}

/// Runs a call in one frame of the tab and unwraps its envelope. The script
/// answers with a JSON *string*, so WebKit's own JSON encoding wraps it once
/// more — hence the double decode.
async fn call_in(
    app: &AppHandle,
    tab_id: &str,
    frame: Frame,
    call: &str,
    timeout: Duration,
) -> ArgmaxResult<Value> {
    let webview = webview(app, tab_id)?;
    let script = call_script(frame, call);
    let raw = match frame {
        None => eval_page(app, tab_id, &webview, &script, timeout).await?,
        Some(_) => frames::eval(&webview, tab_id, frame, &script, timeout)
            .await
            .map_err(|failure| failure.into_error(frame))?,
    };
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

fn is_frame_gone(error: &ArgmaxError) -> bool {
    matches!(error, ArgmaxError::ServiceError { sub_code, .. } if sub_code == "BROWSER_FRAME_GONE")
}

/// Runs a call in the frame its ref names. A frame the tab has not probed
/// since it loaded (or since the app started) has no handle yet, so a miss
/// probes once and tries again before calling the frame gone.
async fn call_for_ref(
    app: &AppHandle,
    tab_id: &str,
    element_ref: &str,
    call: &str,
    timeout: Duration,
) -> ArgmaxResult<(Frame, Value)> {
    let frame = frame_of_ref(element_ref);
    match call_in(app, tab_id, frame, call, timeout).await {
        Err(error) if frame.is_some() && is_frame_gone(&error) => {
            discover(app, tab_id).await?;
            Ok((frame, call_in(app, tab_id, frame, call, timeout).await?))
        }
        result => Ok((frame, result?)),
    }
}

/// One frame a walk reached, and where its `<iframe>` sits in the parent's
/// viewport.
#[derive(Debug, Clone)]
struct FrameNode {
    id: u32,
    parent: Frame,
    rect: CaptureRect,
}

/// One document's answer to a walk's call, and the document whose
/// `<iframe>` it answered from.
#[derive(Debug, Clone)]
struct DocResult {
    frame: Frame,
    parent: Frame,
    url: String,
    value: Value,
}

/// Runs `build(frame, so_far)` in the main frame, then in every frame that
/// answers the probe, parents before children — the order the documents
/// appear in. `build` returning `None` skips that document and the frames
/// inside it, so a read whose budget ran out stops walking.
///
/// Each document's script probes its own `<iframe>`s before the call runs, so
/// a snapshot already prints the ids the children answer to. A main-frame
/// failure is the call's failure; a frame that fails is left out, because a
/// frame can navigate or vanish between the probe and the call.
async fn walk<F>(
    app: &AppHandle,
    tab_id: &str,
    timeout: Duration,
    mut build: F,
) -> ArgmaxResult<(Vec<DocResult>, Vec<FrameNode>)>
where
    F: FnMut(Frame, &[DocResult]) -> Option<String>,
{
    let lock = frames::walk_lock(tab_id);
    let _walking = lock.lock().await;
    let prefix = frames::begin_round(tab_id);
    let walked = walk_frames(app, tab_id, timeout, &prefix, &mut build).await;
    frames::end_round(app, tab_id, &prefix);
    walked
}

async fn walk_frames<F>(
    app: &AppHandle,
    tab_id: &str,
    timeout: Duration,
    prefix: &str,
    build: &mut F,
) -> ArgmaxResult<(Vec<DocResult>, Vec<FrameNode>)>
where
    F: FnMut(Frame, &[DocResult]) -> Option<String>,
{
    let wait_for_answers = cfg!(target_os = "macos")
        && registry(app)
            .get(tab_id)
            .is_some_and(|tab| tab.owner_session_id.is_some());
    let mut queue: VecDeque<(Frame, Frame, usize, String)> =
        VecDeque::from([(None, None, 0, String::new())]);
    let mut docs = Vec::new();
    let mut nodes: Vec<FrameNode> = Vec::new();
    let mut seen: Vec<u32> = Vec::new();
    let mut capped = false;

    while let Some((frame, parent, depth, url)) = queue.pop_front() {
        let Some(call) = build(frame, &docs) else {
            capped = true;
            continue;
        };
        let script = format!(
            "{{ probe: window.__argmax.probeFrames({}, {}), result: ({call}) }}",
            frames::next_id(tab_id),
            json!(prefix)
        );
        let value = match call_in(app, tab_id, frame, &script, timeout).await {
            Ok(value) => value,
            Err(error) if frame.is_some() => {
                tracing::debug!(tab = %tab_id, frame = ?frame, %error, "browser frame skipped");
                continue;
            }
            Err(error) => return Err(error),
        };
        let result = value.get("result").cloned().unwrap_or(Value::Null);
        if let Some(message) = result.get("error").and_then(Value::as_str) {
            if frame.is_none() {
                return Err(ArgmaxError::service("BROWSER_ACTION_FAILED", message));
            }
            continue;
        }
        let probe = value.get("probe").cloned().unwrap_or(Value::Null);
        if let Some(next) = probe.get("nextId").and_then(Value::as_u64) {
            frames::advance(tab_id, next as u32);
        }
        let listed: Vec<ProbedFrame> = probe
            .get("frames")
            .and_then(Value::as_array)
            .map(|items| items.iter().filter_map(ProbedFrame::from_value).collect())
            .unwrap_or_default();
        seen.extend(listed.iter().map(|listed| listed.id));
        docs.push(DocResult {
            frame,
            parent,
            url,
            value: result,
        });

        // A focused frame is waited for even when small or quiet: a key
        // press is about to need it.
        let wanted: Vec<&ProbedFrame> = listed
            .iter()
            .filter(|listed| listed.visible || listed.focused)
            .collect();
        if wanted.is_empty() || !wait_for_answers {
            continue;
        }
        if depth >= MAX_FRAME_DEPTH || docs.len() + queue.len() >= MAX_FRAMES {
            capped = true;
            continue;
        }
        let expected: Vec<(u32, String)> = wanted
            .iter()
            .map(|listed| (listed.id, listed.nonce.clone()))
            .collect();
        let awaited: Vec<u32> = wanted
            .iter()
            .filter(|listed| listed.focused || !frames::is_silent(tab_id, listed.id))
            .map(|listed| listed.id)
            .collect();
        let started = Instant::now();
        let answered = loop {
            let answered = frames::answered(tab_id, &expected);
            if awaited.iter().all(|id| answered.contains_key(id)) || started.elapsed() >= PROBE_WAIT
            {
                break answered;
            }
            tokio::time::sleep(PROBE_POLL_INTERVAL).await;
        };
        for listed in wanted {
            let Some(child_url) = answered.get(&listed.id) else {
                frames::mark_silent(tab_id, listed.id);
                continue;
            };
            frames::verify(tab_id, listed.id, &listed.nonce);
            nodes.push(FrameNode {
                id: listed.id,
                parent: frame,
                rect: listed.rect,
            });
            queue.push_back((Some(listed.id), frame, depth + 1, child_url.clone()));
        }
    }
    if !capped {
        frames::retain(app, tab_id, &seen);
    }
    Ok((docs, nodes))
}

/// One `<iframe>` a document's probe listed.
struct ProbedFrame {
    id: u32,
    nonce: String,
    visible: bool,
    focused: bool,
    rect: CaptureRect,
}

impl ProbedFrame {
    fn from_value(item: &Value) -> Option<Self> {
        let number = |key: &str| item.get(key).and_then(Value::as_f64).unwrap_or(0.0);
        let flag = |key: &str| item.get(key).and_then(Value::as_bool).unwrap_or(false);
        Some(Self {
            id: frames::parse_id(item.get("id")?.as_str()?)?,
            nonce: item.get("nonce")?.as_str()?.to_string(),
            visible: flag("visible"),
            focused: flag("focused"),
            rect: CaptureRect {
                x: number("x"),
                y: number("y"),
                width: number("width"),
                height: number("height"),
            },
        })
    }
}

/// Probes the tab's frames without reading anything, so their handles are
/// current and their geometry known.
async fn discover(app: &AppHandle, tab_id: &str) -> ArgmaxResult<Vec<FrameNode>> {
    Ok(
        walk(app, tab_id, READ_TIMEOUT, |_, _| Some("null".to_string()))
            .await?
            .1,
    )
}

/// WebKit drops the callback for an eval queued before the first page load.
/// Probe readiness with a side-effect-free expression so pages with slow
/// subresources can answer early, then run the requested script exactly once.
async fn eval_page(
    app: &AppHandle,
    tab_id: &str,
    webview: &Webview,
    script: &str,
    timeout: Duration,
) -> ArgmaxResult<String> {
    let initial_tab = registry(app).get(tab_id).ok_or_else(|| {
        ArgmaxError::service(
            "BROWSER_NOT_OPEN",
            format!("browser tab {tab_id} is not open"),
        )
    })?;
    if !initial_tab.loading {
        return eval::eval_json(webview, script, timeout).await;
    }

    let started = Instant::now();
    let mut readiness_probe = Box::pin(eval::eval_json(webview, "true", timeout));
    loop {
        tokio::select! {
            result = &mut readiness_probe => {
                if let Err(error) = result {
                    let tab = registry(app).get(tab_id).ok_or_else(|| {
                        ArgmaxError::service(
                            "BROWSER_NOT_OPEN",
                            format!("browser tab {tab_id} is not open"),
                        )
                    })?;
                    if tab.loading {
                        if matches!(
                            &error,
                            ArgmaxError::ServiceError { sub_code, .. }
                                if sub_code == "BROWSER_EVAL_TIMEOUT"
                        ) {
                            return Err(page_load_timeout(&tab, timeout));
                        }
                        return Err(error);
                    }
                }
                let remaining = timeout.saturating_sub(started.elapsed());
                return eval::eval_json(
                    webview,
                    script,
                    remaining.max(Duration::from_millis(1)),
                )
                .await;
            }
            _ = tokio::time::sleep(LOAD_POLL_INTERVAL) => {
                let tab = registry(app).get(tab_id).ok_or_else(|| {
                    ArgmaxError::service(
                        "BROWSER_NOT_OPEN",
                        format!("browser tab {tab_id} is not open"),
                    )
                })?;
                if !tab.loading {
                    let remaining = timeout.saturating_sub(started.elapsed());
                    return eval::eval_json(
                        webview,
                        script,
                        remaining.max(Duration::from_millis(1)),
                    )
                    .await;
                }
                if started.elapsed() >= timeout {
                    return Err(page_load_timeout(&tab, timeout));
                }
            }
        }
    }
}

fn page_load_timeout(tab: &BrowserTabInfo, timeout: Duration) -> ArgmaxError {
    ArgmaxError::service(
        "BROWSER_PAGE_LOAD_TIMEOUT",
        format!(
            "{} did not finish loading or answer within {} ms; the address may be unavailable",
            tab.url,
            timeout.as_millis()
        ),
    )
}

fn string_field(value: &Value, key: &str) -> String {
    value
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string()
}

fn optional_string_field(value: &Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .map(str::to_string)
        .filter(|text| !text.is_empty())
}

fn optional_bool_field(value: &Value, key: &str) -> Option<bool> {
    value.get(key).and_then(Value::as_bool)
}

fn optional_u32_field(value: &Value, key: &str) -> Option<u32> {
    value.get(key).and_then(Value::as_u64).map(|n| n as u32)
}

fn optional_i32_field(value: &Value, key: &str) -> Option<i32> {
    value.get(key).and_then(Value::as_i64).map(|n| n as i32)
}

/// Opens a page in a tab owned by `session_id`. The webview is created hidden
/// at the window's own size: the agent may be working while the user looks at
/// something else, and a child webview always paints over the DOM. The pane
/// showing that session glues and reveals it when it enters Browser mode.
pub fn open(app: &AppHandle, session_id: Option<&str>, url: &str) -> ArgmaxResult<String> {
    open_with_options(app, session_id, url, None, true)
}

pub fn open_with_options(
    app: &AppHandle,
    session_id: Option<&str>,
    url: &str,
    group: Option<String>,
    activate: bool,
) -> ArgmaxResult<String> {
    let tabs = registry(app);
    let tab_id = tabs.allocate_tab_id();
    crate::ipc::browser::open_tab(
        app,
        &tab_id,
        url,
        crate::ipc::browser::hidden_tab_bounds(app),
        false,
        session_id.map(str::to_string),
        None,
    )?;
    if group.is_some() && tabs.set_group(std::slice::from_ref(&tab_id), group) {
        super::registry::publish(app, &tabs);
    }
    if activate {
        if let Some(session_id) = session_id {
            crate::ipc::browser::emit_agent_open(app, session_id, &tab_id, url);
        }
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

pub fn activate(app: &AppHandle, session_id: &str, target: &TabTarget) -> ArgmaxResult<String> {
    let tab_id = resolve_tab(app, target)?;
    let tab = registry(app).get(&tab_id).ok_or_else(|| {
        ArgmaxError::service(
            "BROWSER_NOT_OPEN",
            format!("browser tab {tab_id} is not open"),
        )
    })?;
    crate::ipc::browser::emit_agent_open(app, session_id, &tab_id, &tab.url);
    Ok(tab_id)
}

pub fn duplicate(
    app: &AppHandle,
    session_id: &str,
    target: &TabTarget,
    activate: bool,
) -> ArgmaxResult<String> {
    let source_id = resolve_tab(app, target)?;
    let source = registry(app).get(&source_id).ok_or_else(|| {
        ArgmaxError::service(
            "BROWSER_NOT_OPEN",
            format!("browser tab {source_id} is not open"),
        )
    })?;
    let tab_id = open_with_options(app, Some(session_id), &source.url, source.group, activate)?;
    if !activate {
        keep_focus(app, &source_id);
    }
    Ok(tab_id)
}

/// Opening a tab makes it the newest, and a session with no tab named gets its
/// newest. A background tab must therefore hand the default back to the page
/// the agent is still reading, or queueing up links would move it off the
/// article it queued them from.
pub fn keep_focus(app: &AppHandle, tab_id: &str) {
    registry(app).touch(tab_id);
}

/// The group a tab carries, for a new tab that should join it.
pub fn tab_group(app: &AppHandle, tab_id: &str) -> Option<String> {
    registry(app).get(tab_id).and_then(|tab| tab.group)
}

pub fn group_tabs(app: &AppHandle, tab_ids: &[String], group: Option<String>) {
    let tabs = registry(app);
    if tabs.set_group(tab_ids, group) {
        super::registry::publish(app, &tabs);
    }
}

pub async fn snapshot(
    app: &AppHandle,
    target: &TabTarget,
    interactive_only: bool,
) -> ArgmaxResult<PageSnapshot> {
    let tab_id = resolve_tab(app, target)?;
    let (docs, _) = walk(app, &tab_id, READ_TIMEOUT, |frame, _| {
        Some(format!(
            "window.__argmax.snapshot({})",
            json!({ "interactiveOnly": interactive_only, "frame": frame.is_some() })
        ))
    })
    .await?;
    let main = &docs[0].value;
    let (tree, truncated) = compose_tree(&docs);
    Ok(PageSnapshot {
        tab_id,
        url: string_field(main, "url"),
        title: string_field(main, "title"),
        state: string_field(main, "state"),
        tree,
        truncated,
    })
}

/// The main frame's tree with each frame's tree spliced in under its
/// `[frame=fN]` line, indented one level deeper. A frame line nothing could
/// be read for says so, so an agent does not mistake it for an empty frame.
/// Frame dialogs join the header, because that is where an agent looks.
///
/// A frame's tree is the frame page's own output, so it is not trusted to
/// point anywhere else: a marker is only spliced when it names a frame that
/// document's own probe found, each frame is spliced once, refs it does not
/// own are dropped, and the byte cap applies while building, so a page that
/// lists itself as its own child cannot grow the tree without bound.
fn compose_tree(docs: &[DocResult]) -> (String, bool) {
    struct Splice<'a> {
        docs: &'a [DocResult],
        spliced: Vec<u32>,
        lines: Vec<String>,
        bytes: usize,
        truncated: bool,
    }

    impl Splice<'_> {
        fn push(&mut self, line: String) -> bool {
            if self.truncated {
                return false;
            }
            if self.bytes + line.len() + 1 > MAX_COMPOSED_SNAPSHOT_BYTES {
                self.truncated = true;
                return false;
            }
            self.bytes += line.len() + 1;
            self.lines.push(line);
            true
        }

        fn splice(&mut self, doc: &DocResult, indent: &str) {
            let tree = string_field(&doc.value, "tree");
            for line in tree.lines() {
                if line.trim_start() == "- (truncated)" {
                    self.truncated = true;
                    continue;
                }
                let line = owned_refs_only(line, doc.frame);
                let marker = frame_marker(&line);
                let child = marker
                    .filter(|id| !self.spliced.contains(id))
                    .and_then(|id| {
                        self.docs
                            .iter()
                            .find(|child| child.frame == Some(id) && child.parent == doc.frame)
                    });
                let (Some(id), Some(child)) = (marker, child) else {
                    let suffix = if marker.is_some() {
                        " (content not readable)"
                    } else {
                        ""
                    };
                    if !self.push(format!("{indent}{line}{suffix}")) {
                        return;
                    }
                    continue;
                };
                self.spliced.push(id);
                if !self.push(format!(
                    "{indent}{line} url={}",
                    truncate_chars(&child.url, 120)
                )) {
                    return;
                }
                let depth = line.len() - line.trim_start().len();
                let child_indent = format!("{indent}{}", " ".repeat(depth + 2));
                self.splice(child, &child_indent);
                if self.truncated {
                    return;
                }
            }
        }
    }

    let any_truncated = docs.iter().any(|doc| {
        doc.value
            .get("truncated")
            .and_then(Value::as_bool)
            .unwrap_or(false)
    });
    let mut splice = Splice {
        docs,
        spliced: Vec::new(),
        lines: Vec::new(),
        bytes: 0,
        truncated: false,
    };
    splice.splice(&docs[0], "");
    let truncated = splice.truncated || any_truncated;
    let mut lines = splice.lines;

    let header_end = lines
        .iter()
        .take_while(|line| {
            ["url: ", "title: ", "state: ", "dialog: "]
                .iter()
                .any(|key| line.starts_with(key))
        })
        .count();
    let frame_dialogs: Vec<String> = docs
        .iter()
        .filter_map(|doc| {
            let dialog = doc.value.get("dialog").and_then(Value::as_str)?;
            let id = doc.frame?;
            Some(truncate_chars(
                &dialog.replacen("dialog: ", &format!("dialog (frame f{id}): "), 1),
                400,
            ))
        })
        .take(MAX_FRAMES)
        .collect();
    lines.splice(header_end..header_end, frame_dialogs);
    if truncated {
        lines.push("- (truncated)".to_string());
    }
    (lines.join("\n"), truncated)
}

/// Whether a ref belongs to the document `frame` names: `e5` to the main
/// frame, `f3e5` (or `f3` itself) to frame 3.
fn ref_belongs_to(element_ref: &str, frame: Frame) -> bool {
    let shape_ok = match frame {
        None => element_ref
            .strip_prefix('e')
            .is_some_and(|digits| !digits.is_empty() && digits.bytes().all(|b| b.is_ascii_digit())),
        Some(id) => {
            let own = format!("f{id}");
            element_ref == own
                || element_ref
                    .strip_prefix(&format!("{own}e"))
                    .is_some_and(|digits| {
                        !digits.is_empty() && digits.bytes().all(|b| b.is_ascii_digit())
                    })
        }
    };
    shape_ok && frame_of_ref(element_ref) == frame
}

/// A tree line with every `[ref=…]` its document does not own taken out.
fn owned_refs_only(line: &str, frame: Frame) -> String {
    let mut out = String::with_capacity(line.len());
    let mut rest = line;
    while let Some(start) = rest.find(" [ref=") {
        let Some(end) = rest[start..].find(']').map(|end| start + end) else {
            break;
        };
        let element_ref = &rest[start + " [ref=".len()..end];
        out.push_str(&rest[..start]);
        if ref_belongs_to(element_ref, frame) {
            out.push_str(&rest[start..=end]);
        }
        rest = &rest[end + 1..];
    }
    out.push_str(rest);
    out
}

/// The frame id on a `- iframe … [frame=fN]` line.
fn frame_marker(line: &str) -> Option<u32> {
    let trimmed = line.trim_start();
    if !trimmed.starts_with("- iframe") {
        return None;
    }
    let start = trimmed.rfind("[frame=")? + "[frame=".len();
    let end = trimmed[start..].find(']')? + start;
    frames::parse_id(&trimmed[start..end])
}

fn truncate_chars(text: &str, limit: usize) -> String {
    if text.chars().count() <= limit {
        return text.to_string();
    }
    let mut cut: String = text.chars().take(limit.saturating_sub(1)).collect();
    cut.push('…');
    cut
}

pub async fn find(
    app: &AppHandle,
    target: &TabTarget,
    query: &str,
) -> ArgmaxResult<PageFindResult> {
    let tab_id = resolve_tab(app, target)?;
    let call = format!("window.__argmax.find({})", json!(query));
    let (docs, _) = walk(app, &tab_id, READ_TIMEOUT, |_, so_far| {
        let found: usize = so_far.iter().map(|doc| matches_in(doc).len()).sum();
        (found < MAX_FOUND).then(|| call.clone())
    })
    .await?;
    let matches = docs
        .iter()
        .flat_map(matches_in)
        .take(MAX_FOUND)
        .map(|item| FoundElement {
            element_ref: string_field(item, "ref"),
            role: string_field(item, "role"),
            name: string_field(item, "name"),
            value: string_field(item, "value"),
        })
        .collect();
    Ok(PageFindResult { tab_id, matches })
}

/// A document's matches, minus any whose ref it does not own: the frame's
/// page wrote them and could otherwise point the agent at another document.
fn matches_in(doc: &DocResult) -> Vec<&Value> {
    doc.value
        .get("matches")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter(|item| ref_belongs_to(&string_field(item, "ref"), doc.frame))
                .collect()
        })
        .unwrap_or_default()
}

/// Resolves a link ref to its absolute URL, and names the tab it was read
/// from — the caller opens the link beside that tab and hands focus back to it.
pub async fn link_url(
    app: &AppHandle,
    target: &TabTarget,
    element_ref: &str,
) -> ArgmaxResult<(String, String)> {
    let tab_id = resolve_tab(app, target)?;
    let (_, value) = call_for_ref(
        app,
        &tab_id,
        element_ref,
        &format!("window.__argmax.linkUrl({})", json!(element_ref)),
        READ_TIMEOUT,
    )
    .await?;
    let url = string_field(&value, "url");
    if url.is_empty() {
        return Err(ArgmaxError::service(
            "BROWSER_ACTION_FAILED",
            "the link returned no URL",
        ));
    }
    Ok((tab_id, url))
}

/// The main frame's text, then each frame's under a `[frame fN: url]` line,
/// all within one `max_chars` budget.
pub async fn get_text(
    app: &AppHandle,
    target: &TabTarget,
    max_chars: Option<u32>,
) -> ArgmaxResult<PageText> {
    let tab_id = resolve_tab(app, target)?;
    let budget = max_chars.unwrap_or(20_000) as usize;
    let used = |docs: &[DocResult]| -> usize {
        docs.iter()
            .map(|doc| string_field(&doc.value, "text").chars().count())
            .sum()
    };
    let (docs, _) = walk(app, &tab_id, READ_TIMEOUT, |_, so_far| {
        let remaining = budget.saturating_sub(used(so_far));
        (remaining > 0).then(|| format!("window.__argmax.getText({})", json!(remaining)))
    })
    .await?;
    let main = &docs[0].value;
    let mut text = string_field(main, "text");
    for doc in &docs[1..] {
        let frame_text = string_field(&doc.value, "text");
        if frame_text.is_empty() {
            continue;
        }
        text.push_str(&format!(
            "\n\n[frame {}: {}]\n{frame_text}",
            frame_label(doc.frame),
            truncate_chars(&doc.url, 120)
        ));
    }
    let truncated = used(&docs) >= budget
        || docs.iter().any(|doc| {
            doc.value
                .get("truncated")
                .and_then(Value::as_bool)
                .unwrap_or(false)
        });
    Ok(PageText {
        tab_id,
        url: string_field(main, "url"),
        title: string_field(main, "title"),
        state: string_field(main, "state"),
        text,
        truncated,
    })
}

/// The main frame's extraction with each frame's headings, sections, tables,
/// links, items and fields appended after it, within one `max_chars` budget.
pub async fn extract(
    app: &AppHandle,
    target: &TabTarget,
    max_chars: Option<u32>,
) -> ArgmaxResult<PageExtraction> {
    let tab_id = resolve_tab(app, target)?;
    let budget = max_chars.unwrap_or(30_000) as usize;
    let (docs, _) = walk(app, &tab_id, READ_TIMEOUT, |_, so_far| {
        let used: usize = so_far.iter().map(|doc| extracted_chars(&doc.value)).sum();
        let remaining = budget.saturating_sub(used);
        (remaining > 0).then(|| format!("window.__argmax.extract({})", json!(remaining)))
    })
    .await?;
    let parse = |value: &Value| -> ArgmaxResult<PageExtraction> {
        serde_json::from_value(value.clone()).map_err(|error| {
            ArgmaxError::service(
                "BROWSER_EXTRACT_FAILED",
                format!("unreadable structured page content: {error}"),
            )
        })
    };
    let owned = |element_ref: Option<String>, frame: Frame| {
        element_ref.filter(|element_ref| ref_belongs_to(element_ref, frame))
    };
    let mut extracted = parse(&docs[0].value)?;
    for doc in &docs[1..] {
        let Ok(mut frame) = parse(&doc.value) else {
            continue;
        };
        for item in &mut frame.items {
            item.element_ref = owned(item.element_ref.take(), doc.frame);
        }
        for field in &mut frame.fields {
            field.element_ref = owned(field.element_ref.take(), doc.frame);
        }
        extracted.headings.extend(frame.headings);
        extracted.sections.extend(frame.sections);
        extracted.tables.extend(frame.tables);
        extracted.links.extend(frame.links);
        extracted.items.extend(frame.items);
        extracted.fields.extend(frame.fields);
        extracted.truncated |= frame.truncated;
    }
    extracted.truncated |= docs
        .iter()
        .map(|doc| extracted_chars(&doc.value))
        .sum::<usize>()
        >= budget;
    extracted.tab_id = tab_id;
    Ok(extracted)
}

/// Text characters an extraction spent from its budget, as `extract` in
/// snapshot.js counts them: headings and section text.
fn extracted_chars(value: &Value) -> usize {
    let count = |key: &str, field: &str| -> usize {
        value
            .get(key)
            .and_then(Value::as_array)
            .map(|items| {
                items
                    .iter()
                    .map(|item| string_field(item, field).chars().count())
                    .sum()
            })
            .unwrap_or(0)
    };
    count("headings", "text") + count("sections", "text")
}

pub async fn act(
    app: &AppHandle,
    target: &TabTarget,
    action: &BrowserAction,
) -> ArgmaxResult<ActionOutcome> {
    let tab_id = resolve_tab(app, target)?;
    if let BrowserAction::WaitFor { .. } = action {
        return wait_for(app, &tab_id, action).await;
    }
    if let BrowserAction::Drag {
        element_ref,
        to_ref,
        start_x,
        start_y,
        end_x,
        end_y,
        delta_x,
        delta_y,
        steps,
    } = action
    {
        let frame = frame_of_ref(element_ref);
        if let Some(to_ref) = to_ref {
            if frame_of_ref(to_ref) != frame {
                return Err(ArgmaxError::service(
                    "BROWSER_ACTION_FAILED",
                    "ref and to_ref are in different frames; a drag cannot cross a frame boundary",
                ));
            }
        }
        return drag(
            app,
            &tab_id,
            frame,
            &json!({
                "ref": element_ref,
                "toRef": to_ref,
                "startX": start_x,
                "startY": start_y,
                "endX": end_x,
                "endY": end_y,
                "deltaX": delta_x,
                "deltaY": delta_y,
                "steps": steps,
            }),
        )
        .await;
    }
    if let BrowserAction::PressKey { key, modifiers } = action {
        return press_key(app, &tab_id, key, modifiers).await;
    }
    if let BrowserAction::Scroll {
        element_ref: None,
        direction,
        amount,
    } = action
    {
        return scroll_page(app, &tab_id, direction, *amount).await;
    }
    let (element_ref, script, moves_focus) = match action {
        BrowserAction::Click { element_ref } => (
            element_ref,
            format!("window.__argmax.click({})", json!(element_ref)),
            true,
        ),
        BrowserAction::Type {
            element_ref,
            text,
            submit,
        } => (
            element_ref,
            format!(
                "window.__argmax.type({}, {}, {})",
                json!(element_ref),
                json!(text),
                json!({ "submit": submit })
            ),
            true,
        ),
        BrowserAction::Select { element_ref, value } => (
            element_ref,
            format!(
                "window.__argmax.select({}, {})",
                json!(element_ref),
                json!(value)
            ),
            true,
        ),
        BrowserAction::Hover { element_ref } => (
            element_ref,
            format!("window.__argmax.hover({})", json!(element_ref)),
            false,
        ),
        BrowserAction::Scroll {
            element_ref: Some(element_ref),
            direction,
            amount,
        } => (
            element_ref,
            format!(
                "window.__argmax.scroll({})",
                json!({ "ref": element_ref, "direction": direction, "amount": amount })
            ),
            false,
        ),
        BrowserAction::Scroll { .. }
        | BrowserAction::PressKey { .. }
        | BrowserAction::Drag { .. }
        | BrowserAction::WaitFor { .. } => {
            unreachable!("handled above")
        }
    };
    let (frame, value) = call_for_ref(app, &tab_id, element_ref, &script, ACTION_TIMEOUT).await?;
    // Keys without a target follow the last click or typing, the way a
    // person's keyboard focus does — into a frame and back out again.
    if moves_focus {
        frames::set_keyboard_frame(&tab_id, frame);
    }
    Ok(outcome_in(app, tab_id, frame, &value))
}

fn outcome(tab_id: String, value: &Value) -> ActionOutcome {
    action_outcome(tab_id, None, string_field(value, "url"), value)
}

/// An action's outcome inside a frame. The detail names the frame, and `url`
/// stays the tab's, as it is for every other action — a frame's own address
/// would read as though the tab had navigated.
fn outcome_in(app: &AppHandle, tab_id: String, frame: Frame, value: &Value) -> ActionOutcome {
    let url = match frame {
        None => string_field(value, "url"),
        Some(_) => registry(app)
            .get(&tab_id)
            .map(|tab| tab.url)
            .unwrap_or_default(),
    };
    action_outcome(tab_id, frame, url, value)
}

fn action_outcome(tab_id: String, frame: Frame, url: String, value: &Value) -> ActionOutcome {
    let detail = value
        .get("target")
        .and_then(Value::as_str)
        .map(|target| match frame {
            Some(id) => format!("{target} (in frame f{id})"),
            None => target.to_string(),
        });
    ActionOutcome {
        tab_id,
        url,
        detail,
        matched: optional_bool_field(value, "matched"),
        state: optional_string_field(value, "state"),
        url_changed: optional_bool_field(value, "urlChanged"),
        text_chars: optional_u32_field(value, "textChars"),
        text_chars_delta: optional_i32_field(value, "textCharsDelta"),
        listbox_open: optional_bool_field(value, "listboxOpen"),
    }
}

/// A key press goes where focus is. That starts in the frame the agent last
/// clicked or typed into, and moves into an `<iframe>` whenever the document
/// it reached says its focus sits on one — the case a page embedded in an
/// iframe (a Claude artifact, a slide deck) lands in.
async fn press_key(
    app: &AppHandle,
    tab_id: &str,
    key: &str,
    modifiers: &[String],
) -> ArgmaxResult<ActionOutcome> {
    let script = format!(
        "window.__argmax.pressKey({}, {})",
        json!(key),
        json!(modifiers)
    );
    let mut frame = frames::keyboard_frame(tab_id);
    let mut probed = false;
    for _ in 0..=MAX_FRAME_DEPTH + 2 {
        let value = match call_in(app, tab_id, frame, &script, ACTION_TIMEOUT).await {
            Ok(value) => value,
            Err(error) if frame.is_some() && is_frame_gone(&error) => {
                if !probed {
                    probed = true;
                    discover(app, tab_id).await?;
                    continue;
                }
                if frames::keyboard_frame(tab_id) == frame {
                    frames::set_keyboard_frame(tab_id, None);
                    frame = None;
                    continue;
                }
                return Err(ArgmaxError::service(
                    "BROWSER_FRAME_UNREACHABLE",
                    format!(
                        "focus is inside frame {} but its page cannot run script, so a key \
                         press cannot reach it",
                        frame_label(frame)
                    ),
                ));
            }
            Err(error) => return Err(error),
        };
        let Some(child) = value.get("frame").and_then(Value::as_str) else {
            return Ok(outcome_in(app, tab_id.to_string(), frame, &value));
        };
        match frames::parse_id(child) {
            Some(id) => frame = Some(id),
            // The focused <iframe> has never been probed, so it has no id
            // yet. Probe, then ask the same document again.
            None if !probed => {
                probed = true;
                discover(app, tab_id).await?;
            }
            None => {
                return Err(ArgmaxError::service(
                    "BROWSER_FRAME_UNREACHABLE",
                    "focus is on an iframe that did not answer the frame probe, so a key \
                     press cannot reach its page",
                ))
            }
        }
    }
    Err(ArgmaxError::service(
        "BROWSER_FRAME_UNREACHABLE",
        "focus is nested deeper in iframes than a key press follows",
    ))
}

/// Scrolls the window, and when the window has nothing to scroll — the page
/// lives in an `<iframe>` that fills it — the frame the keyboard is in, then
/// the largest visible frame. A window that is only at its end stays put, so
/// the agent learns it reached the end.
async fn scroll_page(
    app: &AppHandle,
    tab_id: &str,
    direction: &str,
    amount: Option<f64>,
) -> ArgmaxResult<ActionOutcome> {
    let script = format!(
        "window.__argmax.scroll({})",
        json!({ "ref": Value::Null, "direction": direction, "amount": amount })
    );
    let value = call(app, tab_id, &script, ACTION_TIMEOUT).await?;
    // `overflow: hidden` still lets script nudge the window through a few
    // pixels of slack, so whether it moved says nothing; whether a person
    // could scroll it does.
    let stuck = value.get("scrollable").and_then(Value::as_bool) == Some(false);
    if !stuck {
        return Ok(outcome(tab_id.to_string(), &value));
    }
    let mut candidates: Vec<FrameNode> = discover(app, tab_id).await?;
    candidates.sort_by(|a, b| {
        let area = |node: &FrameNode| node.rect.width * node.rect.height;
        area(b).total_cmp(&area(a))
    });
    if let Some(keyboard) = frames::keyboard_frame(tab_id) {
        candidates.sort_by_key(|node| node.id != keyboard);
    }
    for node in candidates {
        let frame = Some(node.id);
        let Ok(scrolled) = call_in(app, tab_id, frame, &script, ACTION_TIMEOUT).await else {
            continue;
        };
        if scrolled.get("moved").and_then(Value::as_bool) == Some(true) {
            let mut outcome = outcome_in(app, tab_id.to_string(), frame, &scrolled);
            outcome.detail = Some(format!("scrolled frame f{}", node.id));
            return Ok(outcome);
        }
    }
    Ok(outcome(tab_id.to_string(), &value))
}

/// One drag, driven a step at a time from here.
///
/// Every step is its own `evaluateJavaScript:` call, and therefore its own
/// macrotask in the page: React commits the drag-start render and flushes the
/// effects that measure drop targets before the next move arrives. Dispatching
/// the whole gesture in one task is what makes a synthetic drag land back
/// where it started on dnd-kit and react-beautiful-dnd.
///
/// The button goes down in `dragBegin` and must come back up on every exit
/// path, so a failed step cancels the gesture rather than leaving the page
/// with a pointer stuck down. Every step runs in the frame both refs live in.
async fn drag(
    app: &AppHandle,
    tab_id: &str,
    frame: Frame,
    spec: &Value,
) -> ArgmaxResult<ActionOutcome> {
    let drag_id = format!("d{}", wait_id_seed());
    let element_ref = spec.get("ref").and_then(Value::as_str).unwrap_or_default();
    let (_, begun) = call_for_ref(
        app,
        tab_id,
        element_ref,
        &format!("window.__argmax.dragBegin({}, {})", json!(drag_id), spec),
        ACTION_TIMEOUT,
    )
    .await?;
    let steps = begun
        .get("steps")
        .and_then(Value::as_u64)
        .unwrap_or(DRAG_STEPS_DEFAULT);

    for step in 1..=steps {
        let stepped = call_in(
            app,
            tab_id,
            frame,
            &format!("window.__argmax.dragStep({}, {step})", json!(drag_id)),
            ACTION_TIMEOUT,
        )
        .await;
        if let Err(error) = stepped {
            let _ = call_in(
                app,
                tab_id,
                frame,
                &format!("window.__argmax.dragEnd({}, true)", json!(drag_id)),
                ACTION_TIMEOUT,
            )
            .await;
            return Err(error);
        }
    }

    let value = call_in(
        app,
        tab_id,
        frame,
        &format!("window.__argmax.dragEnd({})", json!(drag_id)),
        ACTION_TIMEOUT,
    )
    .await?;
    frames::set_keyboard_frame(tab_id, frame);
    Ok(outcome_in(app, tab_id.to_string(), frame, &value))
}

/// Polls the page's own watcher until it reports a match or the deadline
/// passes. The watcher is idempotent by id, so a navigation that wipes it
/// simply re-arms it against the new document on the next poll.
fn wait_miss(
    tab_id: String,
    budget: Duration,
    spec: &Value,
    last: Option<&Value>,
) -> ActionOutcome {
    let state = last.and_then(|value| optional_string_field(value, "state"));
    let sample = last
        .and_then(|value| value.get("sample").and_then(Value::as_str))
        .unwrap_or("");
    let inflight = last
        .and_then(|value| value.get("inflight").and_then(Value::as_u64))
        .unwrap_or(0);
    let count = last
        .and_then(|value| value.get("count").and_then(Value::as_u64))
        .unwrap_or(0);
    let url = last
        .map(|value| string_field(value, "url"))
        .filter(|url| !url.is_empty())
        .unwrap_or_default();
    let detail = format!(
        "wait missed after {} ms ({}); state: {}; inflight: {}; saw {} items; sample: {}",
        budget.as_millis(),
        spec,
        state.as_deref().unwrap_or("unknown"),
        inflight,
        count,
        sample
    );
    ActionOutcome {
        tab_id,
        url,
        detail: Some(detail),
        matched: Some(false),
        state,
        url_changed: None,
        text_chars: None,
        text_chars_delta: None,
        listbox_open: None,
    }
}

fn is_pending(value: &Value) -> bool {
    value.get("pending").and_then(Value::as_bool) == Some(true)
}

/// Waits in the main frame, and in every frame too when the condition is
/// about content (text, a list count) that a page embedded in an `<iframe>`
/// would show. A ref inside a frame is waited for in that frame alone. URL
/// and network-quiet conditions always read the tab itself, so a frame's
/// match only counts once the main frame satisfies those as well.
async fn wait_for(
    app: &AppHandle,
    tab_id: &str,
    action: &BrowserAction,
) -> ArgmaxResult<ActionOutcome> {
    let BrowserAction::WaitFor {
        text,
        element_ref,
        url_includes,
        quiet_ms,
        min_count,
        timeout_ms,
    } = action
    else {
        unreachable!("wait_for is only called with WaitFor");
    };
    let spec = json!({
        "text": text,
        "ref": element_ref,
        "urlIncludes": url_includes,
        "quietMs": quiet_ms,
        "minCount": min_count,
    });
    let wait_id = format!("w{}", wait_id_seed());
    let budget = Duration::from_millis(
        timeout_ms
            .unwrap_or(WAIT_TIMEOUT_DEFAULT_MS)
            .clamp(1, WAIT_TIMEOUT_MAX_MS)
            .into(),
    );
    let deadline = Instant::now() + budget;
    let ref_frame = element_ref.as_deref().and_then(frame_of_ref);
    let content_spec = (text.is_some() || min_count.is_some())
        .then(|| json!({ "text": text, "minCount": min_count }));
    let rest_spec = (url_includes.is_some() || quiet_ms.is_some())
        .then(|| json!({ "urlIncludes": url_includes, "quietMs": quiet_ms }));
    let frame_call = format!("window.__argmax.waitFor({}, {})", json!(wait_id), spec);
    let main_call = match (&content_spec, &rest_spec) {
        (Some(_), Some(rest)) if ref_frame.is_none() => format!(
            "{{ full: {frame_call}, rest: window.__argmax.waitFor({}, {rest}) }}",
            json!(format!("{wait_id}-rest"))
        ),
        _ => format!("{{ full: {frame_call}, rest: null }}"),
    };
    // A ref in the main frame is a condition only the main frame can meet,
    // so frames are only consulted when the wait names no ref.
    let content_call = content_spec
        .as_ref()
        .filter(|_| element_ref.is_none())
        .map(|content| {
            format!(
                "window.__argmax.waitFor({}, {content})",
                json!(format!("{wait_id}-frame"))
            )
        });

    let mut last_pending: Option<Value> = None;
    let mut armed: Vec<Frame> = vec![ref_frame];
    let result = loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            break Ok(wait_miss(
                tab_id.to_string(),
                budget,
                &spec,
                last_pending.as_ref(),
            ));
        }
        let poll_timeout = remaining.min(ACTION_TIMEOUT);
        // A navigation mid-wait tears the page down, and the eval racing it
        // fails; that is a state to keep waiting through, not to report.
        let polled: ArgmaxResult<Option<ActionOutcome>> = async {
            if ref_frame.is_some() {
                let value = call_in(app, tab_id, ref_frame, &frame_call, poll_timeout).await?;
                if !is_pending(&value) {
                    return Ok(Some(outcome_in(app, tab_id.to_string(), ref_frame, &value)));
                }
                last_pending = Some(value);
                return Ok(None);
            }
            let Some(content_call) = &content_call else {
                let value = call(app, tab_id, &frame_call, poll_timeout).await?;
                if !is_pending(&value) {
                    return Ok(Some(outcome(tab_id.to_string(), &value)));
                }
                last_pending = Some(value);
                return Ok(None);
            };
            let (docs, _) = walk(app, tab_id, poll_timeout, |frame, _| {
                Some(match frame {
                    None => main_call.clone(),
                    Some(_) => content_call.clone(),
                })
            })
            .await?;
            for doc in &docs {
                if !armed.contains(&doc.frame) {
                    armed.push(doc.frame);
                }
            }
            let main = &docs[0].value;
            let full = main.get("full").cloned().unwrap_or(Value::Null);
            if !is_pending(&full) {
                return Ok(Some(outcome(tab_id.to_string(), &full)));
            }
            let rest_met = match main.get("rest") {
                Some(Value::Null) | None => true,
                Some(rest) => !is_pending(rest),
            };
            if rest_met {
                if let Some(doc) = docs[1..].iter().find(|doc| !is_pending(&doc.value)) {
                    return Ok(Some(outcome_in(
                        app,
                        tab_id.to_string(),
                        doc.frame,
                        &doc.value,
                    )));
                }
            }
            last_pending = Some(full);
            Ok(None)
        }
        .await;
        match polled {
            Ok(Some(outcome)) => break Ok(outcome),
            Ok(None) => {}
            Err(error) if Instant::now() >= deadline => break Err(error),
            Err(_) => {}
        }
        tokio::time::sleep(
            WAIT_POLL_INTERVAL.min(deadline.saturating_duration_since(Instant::now())),
        )
        .await;
    };
    // The waiters that did not settle would keep observing the page until
    // their TTL. Best effort: a document that navigated took them with it.
    let cancel = format!(
        "[{}].map(function (id) {{ return window.__argmax.cancelWait(id); }})",
        [
            wait_id.clone(),
            format!("{wait_id}-rest"),
            format!("{wait_id}-frame")
        ]
        .iter()
        .map(|id| json!(id).to_string())
        .collect::<Vec<_>>()
        .join(", ")
    );
    for frame in armed {
        let _ = call_in(app, tab_id, frame, &cancel, CANCEL_WAIT_TIMEOUT).await;
    }
    result
}

/// Wait ids only have to be unique within one page, and a wait that ends is
/// cancelled (or, failing that, cleaned up by the page's own TTL) — a
/// nanosecond clock read is enough without pulling in a generator.
fn wait_id_seed() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|since| since.as_nanos())
        .unwrap_or(0)
}

/// PNG of the tab, cropped to one element when a ref is given. The crop is in
/// the page's own CSS pixels, so the element is scrolled into view first. An
/// element inside a frame is measured there and then carried out through each
/// enclosing `<iframe>`'s content box and scale to the tab's viewport.
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
            let (frame, value) = call_for_ref(
                app,
                &tab_id,
                element_ref,
                &format!("window.__argmax.rect({})", json!(element_ref)),
                ACTION_TIMEOUT,
            )
            .await?;
            let mut rect = box_of(&value, "the page returned no element box")?;
            if let Some(id) = frame {
                let nodes = discover(app, &tab_id).await?;
                let mut current = Some(id);
                while let Some(child) = current {
                    let node = nodes
                        .iter()
                        .find(|node| node.id == child)
                        .ok_or_else(|| frames::EvalFailure::FrameGone.into_error(Some(child)))?;
                    let placed = call_in(
                        app,
                        &tab_id,
                        node.parent,
                        &format!("window.__argmax.frameBox({})", json!(format!("f{child}"))),
                        ACTION_TIMEOUT,
                    )
                    .await?;
                    let frame_box = box_of(&placed, "the page returned no frame box")?;
                    let scale = placed
                        .get("ok")
                        .and_then(|ok| ok.get("scale"))
                        .and_then(Value::as_f64)
                        .filter(|scale| *scale > 0.0)
                        .unwrap_or(1.0);
                    rect = CaptureRect {
                        x: frame_box.x + rect.x * scale,
                        y: frame_box.y + rect.y * scale,
                        width: rect.width * scale,
                        height: rect.height * scale,
                    };
                    current = node.parent;
                }
            }
            Some(rect)
        }
    };
    let view = webview(app, &tab_id)?;
    snapshot_image::capture(&view, rect, max_width_points, SCREENSHOT_TIMEOUT).await
}

fn box_of(value: &Value, missing: &str) -> ArgmaxResult<CaptureRect> {
    let box_ = value
        .get("ok")
        .ok_or_else(|| ArgmaxError::service("BROWSER_ACTION_FAILED", missing))?;
    let number = |key: &str| box_.get(key).and_then(Value::as_f64).unwrap_or(0.0);
    Ok(CaptureRect {
        x: number("x"),
        y: number("y"),
        width: number("width"),
        height: number("height"),
    })
}

/// Which capture buffer a read wants.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CaptureKind {
    Console,
    Network,
}

impl CaptureKind {
    fn reader(self) -> &'static str {
        match self {
            CaptureKind::Console => "readConsole",
            CaptureKind::Network => "readNetwork",
        }
    }
}

/// The tab's captured console lines or network records, newest last, from
/// the main frame and every frame in it. A frame's records carry its id.
///
/// `capture.js` is an initialization script on agent-opened tabs only, so a
/// tab that has none is a tab this session did not open — or one created
/// before an app update added the script. Either way the honest answer is that
/// nothing was recorded, not an empty list that reads like a clean page.
pub async fn read_capture(
    app: &AppHandle,
    target: &TabTarget,
    kind: CaptureKind,
    limit: Option<u32>,
    clear: bool,
) -> ArgmaxResult<Value> {
    let tab_id = resolve_tab(app, target)?;
    let limit = limit.unwrap_or(50);
    let call = format!(
        "(window.__argmaxCapture ? window.__argmaxCapture.{}({}, {}) : {{ unavailable: true }})",
        kind.reader(),
        json!(limit),
        json!(clear)
    );
    let (docs, _) = walk(app, &tab_id, READ_TIMEOUT, |_, _| Some(call.clone())).await?;
    let main = &docs[0].value;
    if main
        .get("unavailable")
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        return Err(ArgmaxError::service(
            "BROWSER_CAPTURE_UNAVAILABLE",
            "this tab has no capture installed — reopen the page with browser_open so the \
             recorder is in place before the page loads",
        ));
    }
    let mut entries: Vec<Value> = Vec::new();
    let mut truncated = false;
    for doc in &docs {
        truncated |= doc
            .value
            .get("truncated")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let Some(records) = doc.value.get("entries").and_then(Value::as_array) else {
            continue;
        };
        entries.extend(records.iter().cloned().map(|mut record| {
            if let (Some(id), Some(object)) = (doc.frame, record.as_object_mut()) {
                object.insert("frame".to_string(), json!(format!("f{id}")));
            }
            record
        }));
    }
    // ISO-8601 stamps from one clock sort as text.
    entries.sort_by_key(|entry| string_field(entry, "at"));
    let keep = limit.clamp(1, 200) as usize;
    if entries.len() > keep {
        truncated = true;
        entries.drain(..entries.len() - keep);
    }
    Ok(json!({
        "tabId": tab_id,
        "url": string_field(main, "url"),
        "entries": entries,
        "truncated": truncated,
    }))
}

/// Runs an expression in the page — or in one of its frames, named by the id
/// a snapshot prints (`f3`) — and returns what it evaluated to.
///
/// `wrap_for_errors` catches inside the page, because wry's completion
/// handler drops the `NSError` and a script that threw would otherwise be
/// indistinguishable from one that returned `undefined`. It evaluates through
/// the page's `eval`, which a strict Content Security Policy (no
/// `unsafe-eval`, or Trusted Types) refuses. Script WebKit injects itself is
/// not subject to the page's CSP, so a refusal falls back to evaluating the
/// expression directly, as a block, with WebKit reporting what it threw.
pub async fn evaluate(
    app: &AppHandle,
    target: &TabTarget,
    expression: &str,
    frame: Option<&str>,
) -> ArgmaxResult<Value> {
    let tab_id = resolve_tab(app, target)?;
    let frame = match frame.map(str::trim).filter(|text| !text.is_empty() && *text != "main") {
        None => None,
        Some(text) => Some(frames::parse_id(text).ok_or_else(|| {
            ArgmaxError::service(
                "BROWSER_FRAME_INVALID",
                format!("{text:?} is not a frame id; use the f-number a snapshot's [frame=…] line shows"),
            )
        })?),
    };
    let view = webview(app, &tab_id)?;
    let wrapped = eval::wrap_for_errors(expression);
    let raw = match frame {
        None => eval_page(app, &tab_id, &view, &wrapped, EVAL_TIMEOUT).await?,
        Some(_) => match frames::eval(&view, &tab_id, frame, &wrapped, EVAL_TIMEOUT).await {
            Err(EvalFailure::FrameGone) => {
                discover(app, &tab_id).await?;
                frames::eval(&view, &tab_id, frame, &wrapped, EVAL_TIMEOUT)
                    .await
                    .map_err(|failure| failure.into_error(frame))?
            }
            result => result.map_err(|failure| failure.into_error(frame))?,
        },
    };
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
    let result = match value.get("refused").and_then(Value::as_str) {
        None => value.get("ok").cloned().unwrap_or(Value::Null),
        Some(message) => {
            let direct = frames::eval(
                &view,
                &tab_id,
                frame,
                &eval::as_block(expression),
                EVAL_TIMEOUT,
            )
            .await
            .map_err(|failure| match failure {
                // Platforms without the native path keep the page's own
                // refusal, which names the real cause.
                EvalFailure::Other(_) => ArgmaxError::service("BROWSER_EVAL_FAILED", message),
                other => other.into_error(frame),
            })?;
            if direct.is_empty() {
                Value::Null
            } else {
                serde_json::from_str(&direct).map_err(|error| {
                    ArgmaxError::service(
                        "BROWSER_EVAL_FAILED",
                        format!("unreadable answer from the page: {error}"),
                    )
                })?
            }
        }
    };
    let mut answer = json!({ "tabId": tab_id, "result": result });
    if let Some(id) = frame {
        answer["frame"] = json!(format!("f{id}"));
    }
    Ok(answer)
}

/// Answers this tab's next `alert`/`confirm`/`prompt`, and acknowledges the
/// one that just fired. A page's dialog call is synchronous and cannot wait
/// for an answer from another process, so it is auto-dismissed on the spot and
/// this arms the reply for the next one; `dialog.js` has the reasoning.
///
/// Every frame records its own dialogs. The answer is armed in the document
/// that raised the most recent one, or in the main frame when none is fresh.
pub async fn handle_dialog(
    app: &AppHandle,
    target: &TabTarget,
    accept: bool,
    prompt_text: Option<&str>,
) -> ArgmaxResult<Value> {
    let tab_id = resolve_tab(app, target)?;
    let (docs, _) = walk(app, &tab_id, READ_TIMEOUT, |_, _| {
        Some(
            "(window.__argmaxDialog && window.__argmaxDialog.current ? window.__argmaxDialog.current() : null)"
                .to_string(),
        )
    })
    .await?;
    let frame = docs
        .iter()
        .filter(|doc| doc.value.is_object())
        .max_by(|a, b| {
            let at = |doc: &DocResult| doc.value.get("at").and_then(Value::as_f64).unwrap_or(0.0);
            at(a).total_cmp(&at(b))
        })
        .and_then(|doc| doc.frame);
    let mut value = call_in(
        app,
        &tab_id,
        frame,
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
        if let Some(id) = frame {
            object.insert("frame".to_string(), json!(format!("f{id}")));
        }
    }
    Ok(value)
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::{
        compose_tree, frame_of_ref, BrowserAction, DocResult, TabTarget, AGENT_API_VERSION,
        SNAPSHOT_JS,
    };

    #[test]
    fn a_ref_names_the_frame_it_lives_in() {
        assert_eq!(frame_of_ref("e12"), None);
        assert_eq!(frame_of_ref("f3e12"), Some(3));
        assert_eq!(
            frame_of_ref("f3"),
            Some(3),
            "a frame's own id addresses its document"
        );
        assert_eq!(frame_of_ref("garbage"), None);
    }

    fn doc(
        frame: Option<u32>,
        parent: Option<u32>,
        url: &str,
        value: serde_json::Value,
    ) -> DocResult {
        DocResult {
            frame,
            parent,
            url: url.to_string(),
            value,
        }
    }

    #[test]
    fn frame_trees_are_spliced_under_their_iframe_line() {
        let docs = vec![
            doc(
                None,
                None,
                "",
                json!({
                    "tree": "url: https://claude.ai/artifact/x\ntitle: Deck\nstate: ready\n- main\n  - iframe \"Slides\" [frame=f1]\n  - iframe [frame=f2]\n- button \"Share\" [ref=e4]",
                    "truncated": false
                }),
            ),
            doc(
                Some(1),
                None,
                "https://a.claudeusercontent.com/",
                json!({
                    "tree": "- heading \"Self-Service ARR missed\" level=1\n- iframe [frame=f3]",
                    "dialog": "dialog: confirm \"Leave?\" pending (auto-dismissed with false)",
                    "truncated": false
                }),
            ),
            doc(
                Some(3),
                Some(1),
                "https://nested.example/",
                json!({ "tree": "- button \"Next\" [ref=f3e1]", "truncated": false }),
            ),
        ];
        let (tree, truncated) = compose_tree(&docs);
        assert!(!truncated);
        assert_eq!(
            tree,
            [
                "url: https://claude.ai/artifact/x",
                "title: Deck",
                "state: ready",
                "dialog (frame f1): confirm \"Leave?\" pending (auto-dismissed with false)",
                "- main",
                "  - iframe \"Slides\" [frame=f1] url=https://a.claudeusercontent.com/",
                "    - heading \"Self-Service ARR missed\" level=1",
                "    - iframe [frame=f3] url=https://nested.example/",
                "      - button \"Next\" [ref=f3e1]",
                "  - iframe [frame=f2] (content not readable)",
                "- button \"Share\" [ref=e4]",
            ]
            .join("\n")
        );
    }

    #[test]
    fn a_composed_tree_past_the_cap_ends_in_one_truncation_marker() {
        let long_line = format!("- text: {}", "x".repeat(1000));
        let frame_tree = vec![long_line; 80].join("\n");
        let docs = vec![
            doc(
                None,
                None,
                "",
                json!({ "tree": "url: u\ntitle: t\nstate: ready\n- iframe [frame=f1]", "truncated": false }),
            ),
            doc(
                Some(1),
                None,
                "u",
                json!({ "tree": frame_tree, "truncated": false }),
            ),
        ];
        let (tree, truncated) = compose_tree(&docs);
        assert!(truncated);
        assert!(tree.len() <= super::MAX_COMPOSED_SNAPSHOT_BYTES + "- (truncated)".len());
        assert!(tree.ends_with("- (truncated)"));
        assert_eq!(tree.matches("- (truncated)").count(), 1);
    }

    /// A page can tag its own <iframe>s with its own frame id. Splicing by id
    /// alone would recurse into itself once per tag, at every level.
    #[test]
    fn a_frame_that_lists_itself_is_spliced_once() {
        let self_loop = vec!["- iframe [frame=f1]"; 800].join("\n");
        let docs = vec![
            doc(
                None,
                None,
                "",
                json!({ "tree": "url: u\ntitle: t\nstate: ready\n- iframe [frame=f1]", "truncated": false }),
            ),
            doc(
                Some(1),
                None,
                "u",
                json!({ "tree": self_loop, "truncated": false }),
            ),
        ];
        let (tree, _) = compose_tree(&docs);
        assert_eq!(
            tree.matches(" url=u").count(),
            1,
            "f1 is spliced exactly once"
        );
        assert!(tree.lines().count() <= 805);
    }

    /// A frame's page writes its own tree, so it could print a ref that names
    /// the top document or a sibling frame and steer the agent there.
    #[test]
    fn a_frame_cannot_print_refs_it_does_not_own() {
        let docs = vec![
            doc(
                None,
                None,
                "",
                json!({ "tree": "url: u\ntitle: t\nstate: ready\n- iframe [frame=f2]\n- button \"Pay\" [ref=e7]", "truncated": false }),
            ),
            doc(
                Some(2),
                None,
                "ad",
                json!({ "tree": "- button \"Close\" [ref=e7]\n- button \"Win\" [ref=f1e3]\n- button \"Own\" [ref=f2e1]", "truncated": false }),
            ),
        ];
        let (tree, _) = compose_tree(&docs);
        assert!(tree.contains("  - button \"Close\"\n"), "{tree}");
        assert!(tree.contains("  - button \"Win\"\n"), "{tree}");
        assert!(tree.contains("  - button \"Own\" [ref=f2e1]"), "{tree}");
        assert!(
            tree.contains("- button \"Pay\" [ref=e7]"),
            "the main frame keeps its own refs"
        );
    }

    /// The wrapper installs the scripts whenever the page reports a different
    /// version, so a `v` that trails the constant reinstalls on *every* call
    /// and wipes whatever the page was holding between them — which is how a
    /// three-call drag lost its gesture halfway through.
    #[test]
    fn the_page_reports_the_version_the_install_guard_expects() {
        assert!(
            SNAPSHOT_JS.contains(&format!("v: {AGENT_API_VERSION},")),
            "snapshot.js must declare v: {AGENT_API_VERSION} to match AGENT_API_VERSION"
        );
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
                quiet_ms: None,
                min_count: None,
                timeout_ms: None
            }
        );
    }
}
