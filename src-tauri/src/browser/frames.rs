//! The agent's way into a tab's iframes.
//!
//! Everything else in `automation` evaluates in the tab's main frame, and a
//! script there cannot read a cross-origin `<iframe>` — a Claude artifact, a
//! payment form, an embedded editor. WebKit can still evaluate *in* such a
//! frame (`evaluateJavaScript:inFrame:inContentWorld:`), but only given that
//! frame's `WKFrameInfo`, and the public API hands one out in exactly one
//! place: the message a frame's script sends to a script message handler.
//!
//! So each agent tab carries a probe. `frame_probe.js` runs in every frame,
//! in Argmax's isolated content world (`AGENT_WORLD`), where the
//! `argmaxFrame` handler is visible and the page's own scripts cannot reach
//! it. To discover frames, `snapshot.js` in the parent document tags each
//! `<iframe>` with an id (`f3`) and posts the id and a fresh nonce into it;
//! the child's probe answers through the handler, and WebKit attaches the
//! child's `WKFrameInfo`. That answer is what ties a frame Rust can evaluate
//! in to the element in the parent's DOM it lives in.
//!
//! An answer only counts when it carries the exact nonce its parent posted to
//! that one `<iframe>`. Any frame can make its own child answer with any id,
//! so the id alone proves nothing: without the nonce, an ad frame could claim
//! a payment frame's id and receive the agent's typing. Each round's nonces
//! also share a random prefix Rust issued, and answers without a live prefix
//! are dropped before they cost memory.
//!
//! `WKFrameInfo` is main-thread-only, so the handles live in a main-thread
//! table keyed by the nonce they were verified with; the async side only sees
//! ids, nonces and URLs. Frame ids are tab-wide and live on the `<iframe>`
//! element, like refs, so they stay valid for as long as the element does.

use std::collections::HashMap;
use std::sync::{Arc, LazyLock, Mutex};
use std::time::{Duration, Instant};

use tauri::{AppHandle, Webview};

use crate::error::{ArgmaxError, ArgmaxResult};

/// The isolated world the probe runs in. A named world is shared by every
/// webview in the process for as long as one instance is alive.
pub const AGENT_WORLD: &str = "argmax-agent";
pub const PROBE_JS: &str = include_str!("frame_probe.js");
#[cfg(target_os = "macos")]
const MESSAGE_HANDLER: &str = "argmaxFrame";

/// Answers held for a tab before its walk matches them to the nonces it
/// posted. A frame flooding the probe with made-up answers fills this and
/// then only loses its own later answers.
const MAX_UNVERIFIED_ANSWERS: usize = 64;
/// How long a frame that did not answer is not waited for again. It is
/// still probed, and an answer it sends in the meantime still counts.
const SILENT_FRAME_RETRY: Duration = Duration::from_secs(30);

/// What the async side knows about a tab's frames.
#[derive(Debug, Default)]
struct TabFrames {
    /// The next id a parent document hands an untagged `<iframe>`.
    next_id: u32,
    /// Prefixes of the probe rounds in flight. Every nonce of a round starts
    /// with its prefix.
    rounds: Vec<String>,
    /// Answers to a round in flight, keyed by frame id and nonce, with the
    /// frame's URL.
    answers: HashMap<(u32, String), String>,
    /// The nonce each frame was last verified with. Its handle is stored
    /// under that nonce, so an answer that was never verified has no way in.
    verified: HashMap<u32, String>,
    /// Frames that did not answer their last probe, and when.
    silent: HashMap<u32, Instant>,
    /// The frame the agent last clicked or typed into, so a key press without
    /// a target follows it the way a person's keyboard focus does.
    keyboard: Option<u32>,
}

static TABS: LazyLock<Mutex<HashMap<String, TabFrames>>> = LazyLock::new(Default::default);
static WALK_LOCKS: LazyLock<Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>> =
    LazyLock::new(Default::default);

fn with_tab<T>(tab_id: &str, read: impl FnOnce(&mut TabFrames) -> T) -> T {
    let mut tabs = TABS.lock().unwrap_or_else(|error| error.into_inner());
    read(tabs.entry(tab_id.to_string()).or_insert_with(|| TabFrames {
        next_id: 1,
        ..TabFrames::default()
    }))
}

/// One walk of a tab's frames at a time. Two at once would both read the id
/// counter before either advanced it, and hand two `<iframe>`s the same id.
pub fn walk_lock(tab_id: &str) -> Arc<tokio::sync::Mutex<()>> {
    let mut locks = WALK_LOCKS.lock().unwrap_or_else(|error| error.into_inner());
    Arc::clone(locks.entry(tab_id.to_string()).or_default())
}

/// The id the next untagged `<iframe>` in this tab gets.
pub fn next_id(tab_id: &str) -> u32 {
    with_tab(tab_id, |tab| tab.next_id)
}

/// Records how far a probe moved the tab's id counter. Only moves forward, so
/// two documents probed in turn can never hand out the same id.
pub fn advance(tab_id: &str, next: u32) {
    with_tab(tab_id, |tab| tab.next_id = tab.next_id.max(next));
}

/// Opens a probe round and returns the random prefix its nonces start with.
pub fn begin_round(tab_id: &str) -> String {
    let prefix = uuid::Uuid::new_v4().simple().to_string();
    with_tab(tab_id, |tab| tab.rounds.push(prefix.clone()));
    prefix
}

/// Closes a round: its unmatched answers are dropped, and with them the
/// handles they carried.
pub fn end_round(app: &AppHandle, tab_id: &str, prefix: &str) {
    with_tab(tab_id, |tab| {
        tab.rounds.retain(|round| round != prefix);
        tab.answers
            .retain(|(_, nonce), _| !nonce.starts_with(prefix));
    });
    prune_handles(app, tab_id);
}

/// Which of `expected` (frame id, the nonce its parent posted) have answered,
/// with their URLs.
pub fn answered(tab_id: &str, expected: &[(u32, String)]) -> HashMap<u32, String> {
    with_tab(tab_id, |tab| {
        expected
            .iter()
            .filter_map(|key| tab.answers.get(key).map(|url| (key.0, url.clone())))
            .collect()
    })
}

/// Makes `nonce` the one this frame's handle is looked up by.
pub fn verify(tab_id: &str, id: u32, nonce: &str) {
    with_tab(tab_id, |tab| {
        tab.verified.insert(id, nonce.to_string());
        tab.silent.remove(&id);
    });
}

pub fn mark_silent(tab_id: &str, id: u32) {
    with_tab(tab_id, |tab| {
        tab.silent.insert(id, Instant::now());
    });
}

/// Whether a walk should skip waiting for this frame's answer.
pub fn is_silent(tab_id: &str, id: u32) -> bool {
    with_tab(tab_id, |tab| {
        tab.silent
            .get(&id)
            .is_some_and(|since| since.elapsed() < SILENT_FRAME_RETRY)
    })
}

pub fn keyboard_frame(tab_id: &str) -> Option<u32> {
    with_tab(tab_id, |tab| tab.keyboard)
}

pub fn set_keyboard_frame(tab_id: &str, frame: Option<u32>) {
    with_tab(tab_id, |tab| tab.keyboard = frame);
}

/// Drops everything known about a closed tab, including its frame handles.
pub fn forget(app: &AppHandle, tab_id: &str) {
    TABS.lock()
        .unwrap_or_else(|error| error.into_inner())
        .remove(tab_id);
    WALK_LOCKS
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .remove(tab_id);
    #[cfg(target_os = "macos")]
    {
        let tab_id = tab_id.to_string();
        let _ = app.run_on_main_thread(move || macos::retain_handles(&tab_id, &HashMap::new()));
    }
    #[cfg(not(target_os = "macos"))]
    let _ = app;
}

/// Keeps only the frames a full discovery just saw. Ids of `<iframe>`
/// elements that left the page would otherwise pile up for the tab's life.
pub fn retain(app: &AppHandle, tab_id: &str, keep: &[u32]) {
    with_tab(tab_id, |tab| {
        tab.verified.retain(|id, _| keep.contains(id));
        tab.silent.retain(|id, _| keep.contains(id));
        if tab.keyboard.is_some_and(|id| !keep.contains(&id)) {
            tab.keyboard = None;
        }
    });
    prune_handles(app, tab_id);
}

/// Drops every handle not stored under its frame's verified nonce.
fn prune_handles(app: &AppHandle, tab_id: &str) {
    #[cfg(target_os = "macos")]
    {
        let verified = with_tab(tab_id, |tab| tab.verified.clone());
        let tab_id = tab_id.to_string();
        let _ = app.run_on_main_thread(move || macos::retain_handles(&tab_id, &verified));
    }
    #[cfg(not(target_os = "macos"))]
    let _ = (app, tab_id);
}

/// Parses a frame id (`f3`) into its number.
pub fn parse_id(text: &str) -> Option<u32> {
    let digits = text.strip_prefix('f')?;
    if digits.is_empty() || !digits.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    digits.parse().ok().filter(|id| *id > 0)
}

/// Why a native evaluation failed.
#[derive(Debug)]
pub enum EvalFailure {
    /// The frame is no longer in the page, or was never probed in this tab.
    FrameGone,
    /// The script threw, did not parse, or returned something WebKit could
    /// not hand back. The text is WebKit's own message.
    Script(String),
    /// Anything else, already in the app's error shape.
    Other(ArgmaxError),
}

impl EvalFailure {
    pub fn into_error(self, frame: Option<u32>) -> ArgmaxError {
        match self {
            EvalFailure::FrameGone => ArgmaxError::service(
                "BROWSER_FRAME_GONE",
                format!(
                    "frame {} is no longer in the page; take a fresh snapshot",
                    frame
                        .map(|id| format!("f{id}"))
                        .unwrap_or_else(|| "main".into())
                ),
            ),
            EvalFailure::Script(message) => ArgmaxError::service("BROWSER_EVAL_FAILED", message),
            EvalFailure::Other(error) => error,
        }
    }
}

/// Evaluates `script` in one frame of the tab (the main frame for `None`) in
/// the page's own world, and returns the value as JSON text — the same
/// encoding `eval::eval_json` returns, so callers decode either one the same
/// way. Unlike wry's path, a thrown error comes back with WebKit's message.
pub async fn eval(
    webview: &Webview,
    tab_id: &str,
    frame: Option<u32>,
    script: &str,
    timeout: Duration,
) -> Result<String, EvalFailure> {
    let (sender, receiver) = tokio::sync::oneshot::channel::<Result<String, EvalFailure>>();
    dispatch_eval(webview, tab_id, frame, script, sender).map_err(EvalFailure::Other)?;
    match tokio::time::timeout(timeout, receiver).await {
        Ok(Ok(outcome)) => outcome,
        Ok(Err(_)) => Err(EvalFailure::Other(ArgmaxError::service(
            "BROWSER_EVAL_FAILED",
            "the eval handler was dropped without answering",
        ))),
        Err(_) => Err(EvalFailure::Other(ArgmaxError::service(
            "BROWSER_EVAL_TIMEOUT",
            format!("the page did not answer within {} ms", timeout.as_millis()),
        ))),
    }
}

type EvalSender = tokio::sync::oneshot::Sender<Result<String, EvalFailure>>;

/// Adds the probe's message handler to a tab's content controller. The probe
/// script itself goes in with the tab's other user scripts.
#[cfg(target_os = "macos")]
pub fn install(webview: &Webview, tab_id: &str) -> ArgmaxResult<()> {
    let tab_id = tab_id.to_string();
    webview
        .with_webview(move |platform| {
            // SAFETY: `with_webview` hands us the live WKWebView on the main
            // thread, where WebKit requires content-controller changes.
            unsafe { macos::install_handler(platform.inner().cast(), &tab_id) }
        })
        .map_err(|error| ArgmaxError::service("BROWSER_SCRIPTS_FAILED", error.to_string()))
}

#[cfg(not(target_os = "macos"))]
pub fn install(_webview: &Webview, _tab_id: &str) -> ArgmaxResult<()> {
    Ok(())
}

#[cfg(target_os = "macos")]
pub(super) fn agent_world(
    mtm: objc2::MainThreadMarker,
) -> objc2::rc::Retained<objc2_web_kit::WKContentWorld> {
    // SAFETY: a plain class-method call on the main thread.
    unsafe {
        objc2_web_kit::WKContentWorld::worldWithName(
            &objc2_foundation::NSString::from_str(AGENT_WORLD),
            mtm,
        )
    }
}

#[cfg(target_os = "macos")]
fn dispatch_eval(
    webview: &Webview,
    tab_id: &str,
    frame: Option<u32>,
    script: &str,
    sender: EvalSender,
) -> ArgmaxResult<()> {
    let tab_id = tab_id.to_string();
    let script = script.to_string();
    webview
        .with_webview(move |platform| {
            // SAFETY: as above — main thread, live WKWebView.
            unsafe { macos::evaluate(platform.inner().cast(), &tab_id, frame, &script, sender) }
        })
        .map_err(|error| ArgmaxError::service("BROWSER_EVAL_FAILED", error.to_string()))
}

#[cfg(not(target_os = "macos"))]
fn dispatch_eval(
    _webview: &Webview,
    _tab_id: &str,
    _frame: Option<u32>,
    _script: &str,
    _sender: EvalSender,
) -> ArgmaxResult<()> {
    Err(ArgmaxError::service(
        "BROWSER_FRAMES_UNSUPPORTED",
        "evaluating in a frame is implemented for WKWebView only",
    ))
}

#[cfg(target_os = "macos")]
mod macos {
    use std::cell::RefCell;
    use std::collections::HashMap;
    use std::sync::{Arc, Mutex};

    use block2::RcBlock;
    use objc2::rc::Retained;
    use objc2::runtime::{AnyObject, NSObject, NSObjectProtocol, ProtocolObject};
    use objc2::{define_class, msg_send, DefinedClass, MainThreadMarker, MainThreadOnly};
    use objc2_foundation::{NSArray, NSError, NSJSONSerialization, NSJSONWritingOptions, NSString};
    use objc2_web_kit::{
        WKContentWorld, WKFrameInfo, WKScriptMessage, WKScriptMessageHandler,
        WKUserContentController, WKWebView,
    };

    use super::{
        parse_id, with_tab, EvalFailure, EvalSender, MAX_UNVERIFIED_ANSWERS, MESSAGE_HANDLER,
    };

    /// WebKit's `WKErrorJavaScriptInvalidFrameTarget`.
    const INVALID_FRAME_TARGET: isize = 12;
    const MAX_NONCE: usize = 64;
    const MAX_URL: usize = 2048;

    thread_local! {
        /// `WKFrameInfo` per (tab, frame id, nonce it answered). Main thread
        /// only, like the object itself.
        static HANDLES: RefCell<HashMap<(String, u32, String), Retained<WKFrameInfo>>> =
            RefCell::new(HashMap::new());
    }

    /// Keeps a tab's handles only where they sit under the frame's verified
    /// nonce; an empty map drops all of them.
    pub(super) fn retain_handles(tab_id: &str, verified: &HashMap<u32, String>) {
        HANDLES.with(|handles| {
            handles
                .borrow_mut()
                .retain(|(tab, id, nonce), _| tab != tab_id || verified.get(id) == Some(nonce))
        });
    }

    struct HandlerIvars {
        tab_id: String,
    }

    define_class!(
        #[unsafe(super(NSObject))]
        #[thread_kind = MainThreadOnly]
        #[name = "ArgmaxFrameProbeHandler"]
        #[ivars = HandlerIvars]
        struct FrameProbeHandler;

        unsafe impl NSObjectProtocol for FrameProbeHandler {}

        unsafe impl WKScriptMessageHandler for FrameProbeHandler {
            #[unsafe(method(userContentController:didReceiveScriptMessage:))]
            fn did_receive(
                &self,
                _controller: &WKUserContentController,
                message: &WKScriptMessage,
            ) {
                // SAFETY: WebKit calls this on the main thread with a live
                // message; `body` is whatever the probe posted.
                unsafe { receive(&self.ivars().tab_id, message) }
            }
        }
    );

    impl FrameProbeHandler {
        fn new(tab_id: &str, mtm: MainThreadMarker) -> Retained<Self> {
            let this = Self::alloc(mtm).set_ivars(HandlerIvars {
                tab_id: tab_id.to_string(),
            });
            // SAFETY: NSObject's designated initializer.
            unsafe { msg_send![super(this), init] }
        }
    }

    #[derive(serde::Deserialize)]
    struct ProbeMessage {
        id: String,
        nonce: String,
        url: String,
    }

    unsafe fn receive(tab_id: &str, message: &WKScriptMessage) {
        let frame = message.frameInfo();
        // The probe never runs in the main frame; an answer claiming to is
        // not one this table should hold.
        if frame.isMainFrame() {
            return;
        }
        let body = message.body();
        let Some(text) = body.downcast_ref::<NSString>() else {
            return;
        };
        let Ok(probe) = serde_json::from_str::<ProbeMessage>(&text.to_string()) else {
            return;
        };
        let Some(id) = parse_id(&probe.id) else {
            return;
        };
        if probe.nonce.is_empty() || probe.nonce.len() > MAX_NONCE {
            return;
        }
        let url: String = probe.url.chars().take(MAX_URL).collect();
        let accepted = with_tab(tab_id, |tab| {
            let live = tab
                .rounds
                .iter()
                .any(|round| probe.nonce.starts_with(round.as_str()));
            if !live || tab.answers.len() >= MAX_UNVERIFIED_ANSWERS {
                return false;
            }
            tab.answers.insert((id, probe.nonce.clone()), url);
            true
        });
        if accepted {
            HANDLES.with(|handles| {
                handles
                    .borrow_mut()
                    .insert((tab_id.to_string(), id, probe.nonce), frame);
            });
        }
    }

    pub(super) unsafe fn install_handler(view: *const WKWebView, tab_id: &str) {
        let Some(mtm) = MainThreadMarker::new() else {
            tracing::error!("browser frame probe was installed off the macOS main thread");
            return;
        };
        let view = &*view;
        let controller = view.configuration().userContentController();
        let world = super::agent_world(mtm);
        let name = NSString::from_str(MESSAGE_HANDLER);
        // Adding a name twice raises an Objective-C exception, which would
        // abort the app; removing a name that is absent is a no-op.
        controller.removeScriptMessageHandlerForName_contentWorld(&name, &world);
        let handler = FrameProbeHandler::new(tab_id, mtm);
        controller.addScriptMessageHandler_contentWorld_name(
            ProtocolObject::from_ref(&*handler),
            &world,
            &name,
        );
    }

    pub(super) unsafe fn evaluate(
        view: *const WKWebView,
        tab_id: &str,
        frame: Option<u32>,
        script: &str,
        sender: EvalSender,
    ) {
        let slot = Arc::new(Mutex::new(Some(sender)));
        let fulfil = {
            let slot = Arc::clone(&slot);
            move |outcome: Result<String, EvalFailure>| {
                if let Some(sender) = slot
                    .lock()
                    .unwrap_or_else(|error| error.into_inner())
                    .take()
                {
                    let _ = sender.send(outcome);
                }
            }
        };
        let Some(mtm) = MainThreadMarker::new() else {
            fulfil(Err(EvalFailure::Script(
                "frame eval ran off the main thread".to_string(),
            )));
            return;
        };
        let handle = match frame {
            None => None,
            Some(id) => {
                let nonce = with_tab(tab_id, |tab| tab.verified.get(&id).cloned());
                let found = nonce.and_then(|nonce| {
                    HANDLES.with(|handles| {
                        handles
                            .borrow()
                            .get(&(tab_id.to_string(), id, nonce))
                            .cloned()
                    })
                });
                match found {
                    Some(handle) => Some(handle),
                    None => {
                        fulfil(Err(EvalFailure::FrameGone));
                        return;
                    }
                }
            }
        };
        let view = &*view;
        let handler = RcBlock::new(move |value: *mut AnyObject, error: *mut NSError| {
            if !error.is_null() {
                fulfil(Err(failure(&*error)));
                return;
            }
            fulfil(json_text(value.as_ref()).map_err(EvalFailure::Script));
        });
        view.evaluateJavaScript_inFrame_inContentWorld_completionHandler(
            &NSString::from_str(script),
            handle.as_deref(),
            &WKContentWorld::pageWorld(mtm),
            Some(&handler),
        );
    }

    fn failure(error: &NSError) -> EvalFailure {
        if error.code() == INVALID_FRAME_TARGET {
            return EvalFailure::FrameGone;
        }
        let info = error.userInfo();
        let message = info
            .objectForKey(&NSString::from_str("WKJavaScriptExceptionMessage"))
            .and_then(|value| value.downcast::<NSString>().ok())
            .map(|text| text.to_string())
            .unwrap_or_else(|| error.localizedDescription().to_string());
        EvalFailure::Script(message)
    }

    /// WebKit's value as JSON text. `nil` is `undefined`, which wry also
    /// reports as an empty string.
    unsafe fn json_text(value: Option<&AnyObject>) -> Result<String, String> {
        let Some(value) = value else {
            return Ok(String::new());
        };
        if let Some(text) = value.downcast_ref::<NSString>() {
            return serde_json::to_string(&text.to_string()).map_err(|error| error.to_string());
        }
        // Wrapped in an array so numbers, booleans and null serialize too:
        // NSJSONSerialization wants a container at the top, and raises an
        // exception (an abort, here) on anything it was not first asked
        // about with `isValidJSONObject`.
        let wrapped = NSArray::from_slice(&[value]);
        if !NSJSONSerialization::isValidJSONObject(&wrapped) {
            return Err(
                "the expression's value is not JSON (a DOM node, a function, a date?); \
                 return JSON.stringify(...) of the part you need"
                    .to_string(),
            );
        }
        let data = NSJSONSerialization::dataWithJSONObject_options_error(
            &wrapped,
            NSJSONWritingOptions::empty(),
        )
        .map_err(|error| error.localizedDescription().to_string())?;
        let text = String::from_utf8(data.to_vec()).map_err(|error| error.to_string())?;
        let inner = text
            .strip_prefix('[')
            .and_then(|rest| rest.strip_suffix(']'))
            .ok_or("WebKit's value did not serialize as expected")?;
        Ok(inner.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::parse_id;

    #[test]
    fn frame_ids_are_f_and_a_positive_number() {
        assert_eq!(parse_id("f3"), Some(3));
        assert_eq!(parse_id("f12"), Some(12));
        assert_eq!(parse_id("f0"), None);
        assert_eq!(parse_id("f"), None);
        assert_eq!(parse_id("e3"), None);
        assert_eq!(parse_id("f3e1"), None);
        assert_eq!(parse_id("f-1"), None);
    }
}
