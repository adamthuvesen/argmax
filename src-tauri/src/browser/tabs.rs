//! Creating, navigating, and closing the child webview behind a browser tab.
//! The panel's IPC commands and the agent's automation verbs both land here.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::{AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, Url, Webview, WebviewUrl};

use crate::browser::registry::{self, BrowserAgentOpenEvent, BrowserTabRegistry};
use crate::browser::user_agent;
use crate::browser::user_scripts::{PageScript, ScriptWorld};
use crate::state::AppState;
use argmax_contracts::error::{ArgmaxError, ArgmaxResult};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BrowserOpenInput {
    pub url: String,
    pub bounds: BrowserBounds,
    pub tab_id: String,
    /// Session that owns the tab. `None` for a tab the user opened, and for
    /// the renderer re-materializing a tab it restored from a previous run —
    /// the registry keeps the owner it already has in that case.
    #[serde(default)]
    pub owner_session_id: Option<String>,
}

/// Logical (CSS-pixel) rect of the renderer placeholder the browser webview
/// is glued to. The main webview fills the whole window, so viewport
/// coordinates map 1:1 onto window coordinates.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BrowserBounds {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

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

/// Pushed when a page asks for a `target="_blank"` link — the renderer
/// answers by creating a new tab at `url`.
#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct BrowserNewTabEvent {
    /// Tab whose page requested the link.
    pub tab_id: String,
    pub url: String,
}

/// A browser shortcut pressed while the page (not the panel chrome) had
/// focus. `command` is one of `close-tab`, `new-tab`, `focus-address`,
/// `reopen-tab`, `next-tab`, `previous-tab`, `reload`, `back`, `forward`,
/// `find`, or a native-page `focus` notification.
#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct BrowserPageCommandEvent {
    pub tab_id: String,
    pub command: String,
}

#[derive(Debug, Clone)]
pub(crate) struct PendingBrowserOpen {
    pub(crate) generation: u64,
    pub(crate) input: BrowserOpenInput,
    pub(crate) visible: bool,
    pub(crate) stopped: bool,
}

/// User-tab opens waiting for native content rules to finish preparing.
///
/// Commands arriving during that wait update this state. The eventual
/// main-thread creator consumes only its own generation, so an older open can
/// never remove or recreate a newer request for the same tab.
#[derive(Debug, Default)]
pub(crate) struct PendingBrowserOpens {
    next_generation: u64,
    by_tab: HashMap<String, PendingBrowserOpen>,
}

impl PendingBrowserOpens {
    pub(crate) fn begin(&mut self, input: BrowserOpenInput) -> u64 {
        self.next_generation = self.next_generation.wrapping_add(1).max(1);
        let generation = self.next_generation;
        self.by_tab.insert(
            input.tab_id.clone(),
            PendingBrowserOpen {
                generation,
                input,
                visible: true,
                stopped: false,
            },
        );
        generation
    }

    pub(crate) fn update_navigation(&mut self, tab_id: &str, url: String) -> bool {
        let Some(pending) = self.by_tab.get_mut(tab_id) else {
            return false;
        };
        pending.input.url = url;
        pending.stopped = false;
        true
    }

    pub(crate) fn update_bounds(
        &mut self,
        tab_id: &str,
        bounds: BrowserBounds,
        visible: bool,
    ) -> bool {
        let Some(pending) = self.by_tab.get_mut(tab_id) else {
            return false;
        };
        pending.input.bounds = bounds;
        pending.visible = visible;
        true
    }

    pub(crate) fn stop(&mut self, tab_id: &str) -> bool {
        let Some(pending) = self.by_tab.get_mut(tab_id) else {
            return false;
        };
        pending.stopped = true;
        true
    }

    pub(crate) fn contains(&self, tab_id: &str) -> bool {
        self.by_tab.contains_key(tab_id)
    }

    pub(crate) fn cancel(&mut self, tab_id: &str) -> bool {
        self.by_tab.remove(tab_id).is_some()
    }

    pub(crate) fn cancel_generation(&mut self, tab_id: &str, generation: u64) {
        if self
            .by_tab
            .get(tab_id)
            .is_some_and(|pending| pending.generation == generation)
        {
            self.by_tab.remove(tab_id);
        }
    }

    pub(crate) fn take_generation(
        &mut self,
        tab_id: &str,
        generation: u64,
    ) -> Option<PendingBrowserOpen> {
        if self
            .by_tab
            .get(tab_id)
            .is_some_and(|pending| pending.generation == generation)
        {
            self.by_tab.remove(tab_id)
        } else {
            None
        }
    }
}

/// Route `target="_blank"` anchors through the `argmax-newtab:` scheme,
/// which `on_navigation` intercepts and turns into a real new tab. The same
/// scheme carries browser shortcuts pressed while the page has focus: without
/// interception those fall through to the app menu, where ⌘W is Close Window
/// and would take the whole app with it.
const BROWSER_INIT_SCRIPT: &str = r#"
(function () {
  // Tauri rejects WebKit's empty popup URL before its new-window callback.
  // Keep the real WindowProxy, including for blank-then-navigate auth flows.
  var openWindow = window.open;
  window.open = function (url, target, features) {
    return openWindow.call(window, url === undefined || url === "" ? "about:blank" : url, target, features);
  };
  var requestTab = function (url) {
    try {
      var absolute = new URL(url, window.location.href).href;
      window.location.href = "argmax-newtab://open?u=" + encodeURIComponent(absolute);
    } catch (e) {}
  };
  // Native child views do not bubble focus or pointer events into the grid.
  // Relay focus so app-menu commands follow the page the user is using.
  window.addEventListener("focus", function () {
    if (window.__argmaxBrowserPopup) return;
    window.location.href = "argmax-newtab://command?c=focus";
  });
  document.addEventListener(
    "click",
    function (event) {
      if (window.__argmaxBrowserPopup) return;
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
      if (window.__argmaxBrowserPopup || !event.isTrusted) return;
      var key = event.key.toLowerCase();
      var command = null;
      if (event.ctrlKey && !event.metaKey && !event.altKey && key === "tab") {
        command = event.shiftKey ? "previous-tab" : "next-tab";
      } else if (event.metaKey && !event.ctrlKey && !event.altKey) {
        command = event.shiftKey ? (key === "t" ? "reopen-tab" : null) :
          key === "w" ? "close-tab" :
          key === "t" ? "new-tab" :
          key === "r" ? "reload" :
          key === "l" ? "focus-address" :
          key === "f" ? "find" : null;
      }
      if (!command) return;
      event.preventDefault();
      window.location.href = "argmax-newtab://command?c=" + command;
    },
    true
  );
  // Bubble phase, and never preventDefault: the page gets Escape first to
  // close its own modal, clear a field or cancel an edit.
  window.addEventListener("keydown", function (event) {
    if (window.__argmaxBrowserPopup || !event.isTrusted || event.defaultPrevented) return;
    if (event.key !== "Escape" || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey || event.isComposing || event.repeat) return;
    var target = event.target;
    if (target && target.closest && target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])')) return;
    if (document.querySelector('dialog[open], [aria-modal="true"]')) return;
    window.location.href = "argmax-newtab://command?c=close-panel";
  });
  // Mouse thumb buttons: 3 = back, 4 = forward. Navigate the page directly:
  // a tab can receive these events without a mounted pane to relay a command.
  var historyCommand = function (button) {
    if (window.__argmaxBrowserPopup) return null;
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
      if (command === "back") window.history.back();
      else window.history.forward();
    },
    true
  );
})();
"#;

/// Dialog capture, installed *only* on tabs a session opened: silently
/// answering the user's own `confirm()` would misreport what they clicked.
const BROWSER_DIALOG_SCRIPT: &str = include_str!("dialog.js");

/// Console and network capture, agent tabs only for the same reason: it
/// wraps `console` and `fetch`, which is not something to do to a page a
/// person is debugging in their own inspector.
const BROWSER_CAPTURE_SCRIPT: &str = include_str!("capture.js");

/// Cookie CMP auto-click, agent tabs only, every frame — a consent iframe is
/// a common host for the accept button.
const BROWSER_COOKIE_SCRIPT: &str = include_str!("cookie.js");

/// Marks a popup window's pages, so the panel shortcuts and new-tab routing
/// inherited from the opener stay out of a window that has no tab strip.
pub(crate) const BROWSER_POPUP_MARKER_SCRIPT: &str = "window.__argmaxBrowserPopup = true;";

/// The agent-only initialization script, for every frame of a tab a session
/// opened. A cross-origin iframe is a document of its own: its `alert` and its
/// console errors are only caught if the recorders are installed in it too,
/// and the agent reads them there through `browser::frames`.
pub(crate) fn agent_frame_script() -> String {
    format!("{BROWSER_DIALOG_SCRIPT}\n{BROWSER_CAPTURE_SCRIPT}")
}

/// Every script a tab's page runs before its own first statement, in
/// injection order. The builder installs the page-world ones, and on macOS
/// `browser::user_scripts` reinstalls exactly this list so Wry's `window.ipc`
/// definition does not travel with them into a third-party page. The frame
/// probe needs Argmax's isolated world, which only that reinstall can give it.
pub(crate) fn page_scripts(owned_by_session: bool, popup: bool) -> Vec<PageScript> {
    let mut scripts = vec![PageScript {
        source: BROWSER_INIT_SCRIPT.to_string(),
        all_frames: false,
        world: ScriptWorld::Page,
    }];
    if owned_by_session {
        scripts.push(PageScript {
            source: agent_frame_script(),
            all_frames: true,
            world: ScriptWorld::Page,
        });
        scripts.push(PageScript {
            source: BROWSER_COOKIE_SCRIPT.to_string(),
            all_frames: true,
            world: ScriptWorld::Page,
        });
        if !popup {
            scripts.push(PageScript {
                source: crate::browser::frames::PROBE_JS.to_string(),
                all_frames: true,
                world: ScriptWorld::Agent,
            });
        }
    }
    if popup {
        scripts.push(PageScript {
            source: BROWSER_POPUP_MARKER_SCRIPT.to_string(),
            all_frames: false,
            world: ScriptWorld::Page,
        });
    }
    scripts
}

pub(crate) fn validated_browser_url(raw: &str) -> ArgmaxResult<Url> {
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
pub(crate) fn tab_label(tab_id: &str) -> ArgmaxResult<String> {
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

/// A tab's surface is measured in the renderer, in CSS px; `add_child` and
/// `set_bounds` take window points. Page zoom is the ratio between them, so a
/// zoomed-out window would otherwise glue the page to a webview that overhangs
/// it by 1/zoom.
pub(crate) fn scaled_bounds(bounds: &BrowserBounds) -> (LogicalPosition<f64>, LogicalSize<f64>) {
    let (x, y, width, height) = scale_bounds(bounds, crate::menu::main_window_zoom());
    (LogicalPosition::new(x, y), LogicalSize::new(width, height))
}

/// CSS px times the window's page zoom, floored at one point so a collapsed
/// panel still leaves the webview something to be.
pub(crate) fn scale_bounds(bounds: &BrowserBounds, zoom: f64) -> (f64, f64, f64, f64) {
    (
        bounds.x * zoom,
        bounds.y * zoom,
        (bounds.width * zoom).max(1.0),
        (bounds.height * zoom).max(1.0),
    )
}

pub(crate) fn bounds_rect(bounds: &BrowserBounds) -> tauri::Rect {
    let (position, size) = scaled_bounds(bounds);
    tauri::Rect {
        position: position.into(),
        size: size.into(),
    }
}

pub(crate) fn tab_registry(app: &AppHandle) -> std::sync::Arc<BrowserTabRegistry> {
    std::sync::Arc::clone(&app.state::<AppState>().browser_tabs)
}

pub(crate) fn emit_state(
    app: &AppHandle,
    tab_id: String,
    url: String,
    title: Option<String>,
    loading: bool,
) {
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
pub(crate) fn new_tab_request_url(url: &Url) -> Option<String> {
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
pub(crate) fn page_dialog(url: &Url) -> Option<(String, String)> {
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
pub(crate) fn page_command(url: &Url) -> Option<&'static str> {
    if url.host_str() != Some("command") {
        return None;
    }
    let (_, command) = url.query_pairs().find(|(key, _)| key == "c")?;
    match command.as_ref() {
        "close-tab" => Some("close-tab"),
        "close-panel" => Some("close-panel"),
        "new-tab" => Some("new-tab"),
        "reopen-tab" => Some("reopen-tab"),
        "next-tab" => Some("next-tab"),
        "previous-tab" => Some("previous-tab"),
        "focus-address" => Some("focus-address"),
        "reload" => Some("reload"),
        "back" => Some("back"),
        "forward" => Some("forward"),
        "find" => Some("find"),
        "focus" => Some("focus"),
        _ => None,
    }
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
    blocking_identifier: Option<String>,
) -> ArgmaxResult<()> {
    let url = validated_browser_url(raw_url)?;
    open_tab_with_url(
        app,
        tab_id,
        url,
        raw_url,
        bounds,
        visible,
        owner_session_id,
        blocking_identifier,
    )
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn open_tab_with_url(
    app: &AppHandle,
    tab_id: &str,
    url: Url,
    raw_url: &str,
    bounds: BrowserBounds,
    visible: bool,
    owner_session_id: Option<String>,
    blocking_identifier: Option<String>,
) -> ArgmaxResult<()> {
    let label = tab_label(tab_id)?;
    let tabs = tab_registry(app);

    if let Some(webview) = app.get_webview(&label) {
        #[cfg(target_os = "macos")]
        crate::browser::content_blocking_macos::apply(&webview, blocking_identifier.clone())?;
        user_agent::apply(&webview, user_agent::for_url(&url))?;
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
    let popup_app = app.clone();
    let popup_owned_by_session = owner_session_id.is_some();
    let nav_label = label.clone();
    let tab_user_agent = user_agent::for_url(&url);
    let builder = tauri::webview::WebviewBuilder::new(&label, WebviewUrl::External(url));
    #[cfg(target_os = "macos")]
    let builder = if let Some(identifier) = blocking_identifier.as_deref() {
        builder.with_webview_configuration(crate::browser::content_blocking_macos::configuration(
            identifier,
        )?)
    } else {
        builder
    };
    #[cfg(not(target_os = "macos"))]
    let _ = blocking_identifier;
    let owned = owner_session_id.is_some();
    // Tauri's default drag-drop handler answers every native file drop
    // itself (for its `DragDrop` event) and never hands it to WebKit, so a
    // page's dropzone — an upload field, a file picker — saw nothing. Nothing
    // in the app listens for that event from a browser tab.
    let builder = builder
        .user_agent(tab_user_agent)
        .disable_drag_drop_handler()
        .initialization_script(BROWSER_INIT_SCRIPT);
    let builder = if owned {
        builder
            .initialization_script_for_all_frames(agent_frame_script())
            .initialization_script_for_all_frames(BROWSER_COOKIE_SCRIPT)
    } else {
        builder
    };
    let builder = builder
        .on_new_window(move |url, features| {
            // Auth SDKs open a blank window, then navigate it and wait for
            // postMessage or closure. A separate tab loses that opener link.
            // window_features carries WebKit's required opener configuration.
            if !matches!(url.scheme(), "http" | "https" | "about" | "blob") {
                return tauri::webview::NewWindowResponse::Deny;
            }
            if let Err(error) =
                crate::browser::popup::prepare_configuration(&features, !popup_owned_by_session)
            {
                tracing::error!(%error, "could not prepare browser popup configuration");
                return tauri::webview::NewWindowResponse::Deny;
            }
            let popup_builder = tauri::WebviewWindowBuilder::new(
                &popup_app,
                format!(
                    "browser-popup-{}-{}",
                    if popup_owned_by_session {
                        "agent"
                    } else {
                        "user"
                    },
                    uuid::Uuid::new_v4()
                ),
                WebviewUrl::External(Url::parse("about:blank").expect("valid blank URL")),
            )
            .title("Browser")
            .inner_size(600.0, 720.0)
            .window_features(features)
            .user_agent(user_agent::SAFARI)
            .disable_drag_drop_handler()
            // The popup gets a fresh WKUserContentController on macOS, so
            // explicitly restore the panel scripts Wry would otherwise see
            // through the inherited controller.
            .initialization_script(BROWSER_INIT_SCRIPT);
            let popup_builder = if popup_owned_by_session {
                popup_builder
                    .initialization_script_for_all_frames(agent_frame_script())
                    .initialization_script_for_all_frames(BROWSER_COOKIE_SCRIPT)
            } else {
                popup_builder
            };
            let window = popup_builder
                // Check the marker at event time, since OAuth redirects can sever
                // window.opener.
                .initialization_script(BROWSER_POPUP_MARKER_SCRIPT)
                .on_navigation(|url| matches!(url.scheme(), "http" | "https" | "about" | "blob"))
                .on_document_title_changed(|window, title| {
                    let _ = window.set_title(&title);
                })
                .build();
            match window {
                Ok(window) => {
                    if let Err(error) = crate::browser::user_scripts::replace(
                        window.as_ref(),
                        &page_scripts(popup_owned_by_session, true),
                    ) {
                        tracing::error!(%error, "could not install browser popup scripts");
                        let _ = window.close();
                        return tauri::webview::NewWindowResponse::Deny;
                    }
                    let browser_theme = *popup_app
                        .state::<AppState>()
                        .browser_theme
                        .lock()
                        .unwrap_or_else(|error| error.into_inner());
                    if let Err(error) = crate::browser::theme::apply(window.as_ref(), browser_theme)
                    {
                        tracing::error!(%error, "could not apply browser popup theme");
                        let _ = window.close();
                        return tauri::webview::NewWindowResponse::Deny;
                    }
                    tauri::webview::NewWindowResponse::Create { window }
                }
                Err(error) => {
                    tracing::error!(%error, "could not create browser popup");
                    tauri::webview::NewWindowResponse::Deny
                }
            }
        })
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
                    if matches!(command, "focus-address" | "find" | "close-panel") {
                        // DOM focus in the renderer does not move the native
                        // first responder out of the child WKWebView.
                        if let Some(main) = nav_app.get_webview("main") {
                            if let Err(error) = main.set_focus() {
                                tracing::warn!(%error, "could not focus browser address bar");
                            }
                        }
                    }
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
            // A link, not the address bar, can walk a tab into a Docs
            // editor. Upgrade only: this callback fires for iframes too, and
            // a consent frame must not take the grid's resolution with it.
            if user_agent::needs_docs_editor(url) {
                if let Some(webview) = nav_app.get_webview(&nav_label) {
                    if let Err(error) = user_agent::apply(&webview, user_agent::DOCS_EDITOR) {
                        tracing::warn!(%error, tab = %nav_tab, "could not set the editor user agent");
                    }
                }
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
            // Loading is a navigation fact, not a title-eval fact. WebKit can
            // drop a callback queued around the first load, which used to
            // leave a fully rendered tab spinning forever.
            emit_state(&load_app, load_tab.clone(), url.clone(), None, false);
            let title_app = load_app.clone();
            let title_tab = load_tab.clone();
            let title_url = url.clone();
            let _ = webview.eval_with_callback("document.title", move |value| {
                let title = serde_json::from_str::<String>(&value).unwrap_or_default();
                emit_state(
                    &title_app,
                    title_tab.clone(),
                    title_url.clone(),
                    Some(title),
                    false,
                );
            });
        });

    let (position, size) = scaled_bounds(&bounds);
    let created = window
        .add_child(builder, position, size)
        .map_err(|error| ArgmaxError::service("BROWSER_CREATE_FAILED", error.to_string()))?;
    // Before WebKit creates the first document: this call is inline on the
    // main thread, and the navigation started above cannot produce a document
    // until the run loop turns again.
    crate::browser::user_scripts::replace(&created, &page_scripts(owned, false))?;
    if owned {
        crate::browser::frames::install(&created, tab_id)?;
    }
    crate::browser::focus_guard::install();
    let browser_theme = *app
        .state::<AppState>()
        .browser_theme
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    crate::browser::theme::apply(&created, browser_theme)?;
    crate::browser::popup::install_close_handler(&created).map_err(|error| {
        ArgmaxError::service(
            "BROWSER_CREATE_FAILED",
            format!("install popup close callback: {error}"),
        )
    })?;
    crate::browser::js_dialogs::install(&created).map_err(|error| {
        ArgmaxError::service(
            "BROWSER_CREATE_FAILED",
            format!("install page dialogs: {error}"),
        )
    })?;
    if !visible {
        let _ = created.hide();
    }
    tabs.insert(tab_id, owner_session_id, raw_url);
    registry::publish(app, &tabs);
    tracing::info!(tab = %tab_id, visible, "browser tab webview created");
    Ok(())
}

pub(crate) fn navigate_tab(app: &AppHandle, tab_id: &str, raw_url: &str) -> ArgmaxResult<()> {
    let url = validated_browser_url(raw_url)?;
    let webview = browser_webview(app, tab_id)?;
    user_agent::apply(&webview, user_agent::for_url(&url))?;
    webview
        .navigate(url)
        .map_err(|error| ArgmaxError::service("BROWSER_NAVIGATE_FAILED", error.to_string()))
}

/// Destroys the tab's webview — history and session go with it. Hiding the
/// pane goes through `browser:set-bounds` with `visible: false` instead, which
/// keeps those alive.
pub(crate) fn close_tab(app: &AppHandle, tab_id: &str) -> ArgmaxResult<()> {
    browser_webview(app, tab_id)?
        .close()
        .map_err(|error| ArgmaxError::service("BROWSER_CLOSE_FAILED", error.to_string()))?;
    crate::browser::frames::forget(app, tab_id);
    let tabs = tab_registry(app);
    if tabs.remove(tab_id) {
        registry::publish(app, &tabs);
    }
    Ok(())
}
