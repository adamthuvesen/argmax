//! The browser half of the session-control protocol.
//!
//! The MCP server is a separate process with no `AppHandle`, so every browser
//! tool sends one [`BrowserRequest`] over the same Unix socket the session
//! tools use. This module owns both ends of that request: the wire type the
//! tool builds, and the app-side handler that resolves the caller's session
//! from its bearer token and calls `browser::automation` with the real handle.
//!
//! **Tab ownership is the whole safety model.** A session may only touch tabs
//! it opened. The user's own tabs, and other sessions' tabs, are refused with a
//! message that says so — nothing here can be pointed at a page the caller did
//! not open.
//!
//! **What runs where.** The socket handler is spawned onto Tauri's async
//! runtime, not the main thread. The read and write verbs are already safe
//! there: `evaluate_script_with_callback` and `takeSnapshot` post themselves to
//! the main queue. Creating, navigating, and destroying a webview is not — on
//! macOS those are AppKit calls — so they go through `run_on_main_thread`.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::AppHandle;

use crate::browser::automation::{self, BrowserAction, TabTarget};
use crate::browser::encode_base64;
use crate::error::{ArgmaxError, ArgmaxResult};
use crate::ipc::validation::{AttachmentMimeType, Base64ImageData, SessionId};
use crate::session_control::{argmax_protocol_error, SessionControlError};

/// Points, not device pixels: the capture is rasterised at this width so its
/// base64 survives the provider's own per-line JSON cap (4 MiB in
/// `providers::normalizer`). A whole retina window would not.
// Retina WebKit returns two device pixels per point. Keep the delivered image
// near 720 pixels wide so ordinary screenshots fit the provider's JSON limit.
const SCREENSHOT_MAX_WIDTH_POINTS: f64 = 360.0;

/// Above this the image is dropped and the reply is text only. A tool result
/// too large to parse is worse than one that explains itself.
const SCREENSHOT_MAX_BASE64_BYTES: usize = 900_000;
const SCREENSHOT_MIN_WIDTH_POINTS: f64 = 1.0;

/// Keeps a screenshot where the chat can draw it.
///
/// The image block a screenshot answers with reaches the model, not the
/// reader — no card draws it, and the remote bridge strips those bytes out of
/// the transcript. The copy this writes is what makes the capture showable:
/// `argmax-attachment://` serves the attachment store, so an agent that puts
/// the returned path in a Markdown image puts it on screen on the desktop,
/// over the bridge, and on the phone alike. The store is per session and is
/// pruned when the session is deleted.
fn save_screenshot(app: &AppHandle, session_id: &str, encoded: &str) -> Result<String, String> {
    let store = tauri::Manager::state::<crate::state::AppState>(app)
        .attachments
        .get()
        .cloned()
        .ok_or_else(|| "attachment storage is not initialized".to_string())?;
    let session = SessionId::try_from(session_id.to_string()).map_err(|issue| issue.message)?;
    let data = Base64ImageData::try_from(encoded.to_string()).map_err(|issue| issue.message)?;
    store
        .save_image(&session, AttachmentMimeType::ImagePng, &data)
        .map(|saved| saved.file_path)
        .map_err(|error| error.to_string())
}

fn next_screenshot_width(current: f64, encoded_bytes: usize) -> f64 {
    let target_ratio = (SCREENSHOT_MAX_BASE64_BYTES as f64 / encoded_bytes as f64).sqrt() * 0.9;
    (current * target_ratio.min(0.75)).max(SCREENSHOT_MIN_WIDTH_POINTS)
}

/// One browser action on the session-control socket.
#[derive(Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub enum BrowserRequest {
    Open {
        url: String,
    },
    Activate {
        #[serde(default)]
        tab: Option<String>,
    },
    #[serde(rename_all = "camelCase")]
    Duplicate {
        #[serde(default)]
        tab: Option<String>,
        #[serde(default = "default_true")]
        activate: bool,
    },
    #[serde(rename_all = "camelCase")]
    GroupTabs {
        tabs: Vec<String>,
        #[serde(default)]
        group: Option<String>,
    },
    #[serde(rename_all = "camelCase")]
    OpenLink {
        #[serde(default)]
        tab: Option<String>,
        #[serde(rename = "ref")]
        element_ref: String,
        #[serde(default)]
        activate: bool,
    },
    Navigate {
        #[serde(default)]
        tab: Option<String>,
        url: String,
    },
    Back {
        #[serde(default)]
        tab: Option<String>,
    },
    Reload {
        #[serde(default)]
        tab: Option<String>,
    },
    Close {
        tab: String,
    },
    /// Every tab this session owns, newest first.
    Tabs,
    #[serde(rename_all = "camelCase")]
    Snapshot {
        #[serde(default)]
        tab: Option<String>,
        #[serde(default)]
        interactive_only: bool,
    },
    Find {
        #[serde(default)]
        tab: Option<String>,
        query: String,
    },
    #[serde(rename_all = "camelCase")]
    GetText {
        #[serde(default)]
        tab: Option<String>,
        #[serde(default)]
        max_chars: Option<u32>,
    },
    #[serde(rename_all = "camelCase")]
    Extract {
        #[serde(default)]
        tab: Option<String>,
        #[serde(default)]
        max_chars: Option<u32>,
    },
    /// Click, type, select, hover, press-key, scroll, wait-for.
    Act {
        #[serde(default)]
        tab: Option<String>,
        action: BrowserAction,
    },
    #[serde(rename_all = "camelCase")]
    Screenshot {
        #[serde(default)]
        tab: Option<String>,
        #[serde(default, rename = "ref")]
        element_ref: Option<String>,
    },
    Evaluate {
        #[serde(default)]
        tab: Option<String>,
        expression: String,
    },
    Console {
        #[serde(default)]
        tab: Option<String>,
        #[serde(default)]
        limit: Option<u32>,
        #[serde(default)]
        clear: bool,
    },
    Network {
        #[serde(default)]
        tab: Option<String>,
        #[serde(default)]
        limit: Option<u32>,
        #[serde(default)]
        clear: bool,
    },
    #[serde(rename_all = "camelCase")]
    HandleDialog {
        #[serde(default)]
        tab: Option<String>,
        accept: bool,
        #[serde(default)]
        prompt_text: Option<String>,
    },
}

fn default_true() -> bool {
    true
}

/// What a browser action answers with. `result` is the JSON the agent reads;
/// `pngBase64` rides alongside it so a screenshot can become an MCP image
/// block without the base64 landing inside the text the model also sees.
#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserOutcome {
    pub result: Value,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub png_base64: Option<String>,
}

impl BrowserOutcome {
    fn json(result: Value) -> Self {
        Self {
            result,
            png_base64: None,
        }
    }
}

/// Runs one browser action for the session the token identified.
pub async fn handle(
    app: &AppHandle,
    session_id: &str,
    request: BrowserRequest,
) -> Result<BrowserOutcome, SessionControlError> {
    run(app, session_id, request)
        .await
        .map_err(argmax_protocol_error)
}

async fn run(
    app: &AppHandle,
    session_id: &str,
    request: BrowserRequest,
) -> ArgmaxResult<BrowserOutcome> {
    match request {
        BrowserRequest::Open { url } => {
            let session = session_id.to_string();
            let tab_id =
                on_main(app, move |app| automation::open(app, Some(&session), &url)).await?;
            Ok(BrowserOutcome::json(
                json!({ "tabId": tab_id, "opened": true }),
            ))
        }
        BrowserRequest::Activate { tab } => {
            let target = owned_target(app, session_id, tab)?;
            let tab_id = automation::activate(app, session_id, &target)?;
            Ok(BrowserOutcome::json(
                json!({ "tabId": tab_id, "active": true }),
            ))
        }
        BrowserRequest::Duplicate { tab, activate } => {
            let target = owned_target(app, session_id, tab)?;
            let session = session_id.to_string();
            let tab_id = on_main(app, move |app| {
                automation::duplicate(app, &session, &target, activate)
            })
            .await?;
            Ok(BrowserOutcome::json(
                json!({ "tabId": tab_id, "opened": true }),
            ))
        }
        BrowserRequest::GroupTabs { tabs, group } => {
            if tabs.is_empty() || tabs.len() > 50 {
                return Err(ArgmaxError::service(
                    "BROWSER_INVALID_GROUP",
                    "group between 1 and 50 tabs",
                ));
            }
            let group = group
                .map(|label| label.trim().to_string())
                .filter(|label| !label.is_empty());
            if group
                .as_ref()
                .is_some_and(|label| label.chars().count() > 80)
            {
                return Err(ArgmaxError::service(
                    "BROWSER_INVALID_GROUP",
                    "a browser tab group label may not exceed 80 characters",
                ));
            }
            let mut owned_tabs = Vec::with_capacity(tabs.len());
            for tab in tabs {
                let target = owned_target(app, session_id, Some(tab))?;
                if let TabTarget::Tab(tab_id) = target {
                    if !owned_tabs.contains(&tab_id) {
                        owned_tabs.push(tab_id);
                    }
                }
            }
            automation::group_tabs(app, &owned_tabs, group.clone())?;
            Ok(BrowserOutcome::json(
                json!({ "tabs": owned_tabs, "group": group }),
            ))
        }
        BrowserRequest::OpenLink {
            tab,
            element_ref,
            activate,
        } => {
            let target = owned_target(app, session_id, tab)?;
            let (source_id, url) = automation::link_url(app, &target, &element_ref).await?;
            // A link opened from a grouped page belongs to the same reading:
            // inherit the group so the strip keeps the research together.
            let group = automation::tab_group(app, &source_id);
            let session = session_id.to_string();
            let opened_url = url.clone();
            let tab_id = on_main(app, move |app| {
                automation::open_with_options(app, Some(&session), &opened_url, group, activate)
            })
            .await?;
            if !activate {
                automation::keep_focus(app, &source_id);
            }
            Ok(BrowserOutcome::json(
                json!({ "tabId": tab_id, "url": url, "opened": true }),
            ))
        }
        BrowserRequest::Navigate { tab, url } => {
            let target = owned_target(app, session_id, tab)?;
            let tab_id = on_main(app, move |app| automation::navigate(app, &target, &url)).await?;
            Ok(BrowserOutcome::json(json!({ "tabId": tab_id })))
        }
        BrowserRequest::Back { tab } => {
            let target = owned_target(app, session_id, tab)?;
            let tab_id = on_main(app, move |app| automation::back(app, &target)).await?;
            Ok(BrowserOutcome::json(json!({ "tabId": tab_id })))
        }
        BrowserRequest::Reload { tab } => {
            let target = owned_target(app, session_id, tab)?;
            let tab_id = on_main(app, move |app| automation::reload(app, &target)).await?;
            Ok(BrowserOutcome::json(json!({ "tabId": tab_id })))
        }
        BrowserRequest::Close { tab } => {
            let target = owned_target(app, session_id, Some(tab))?;
            let tab_id = on_main(app, move |app| automation::close(app, &target)).await?;
            Ok(BrowserOutcome::json(
                json!({ "tabId": tab_id, "closed": true }),
            ))
        }
        BrowserRequest::Tabs => Ok(BrowserOutcome::json(
            json!({ "tabs": automation::tabs(app, Some(session_id)) }),
        )),
        BrowserRequest::Snapshot {
            tab,
            interactive_only,
        } => {
            let target = owned_target(app, session_id, tab)?;
            let snapshot = automation::snapshot(app, &target, interactive_only).await?;
            Ok(BrowserOutcome::json(encode(snapshot)?))
        }
        BrowserRequest::Find { tab, query } => {
            let target = owned_target(app, session_id, tab)?;
            let found = automation::find(app, &target, &query).await?;
            Ok(BrowserOutcome::json(encode(found)?))
        }
        BrowserRequest::GetText { tab, max_chars } => {
            let target = owned_target(app, session_id, tab)?;
            let text = automation::get_text(app, &target, max_chars).await?;
            Ok(BrowserOutcome::json(encode(text)?))
        }
        BrowserRequest::Extract { tab, max_chars } => {
            let target = owned_target(app, session_id, tab)?;
            let extracted = automation::extract(app, &target, max_chars).await?;
            Ok(BrowserOutcome::json(encode(extracted)?))
        }
        BrowserRequest::Act { tab, action } => {
            let target = owned_target(app, session_id, tab)?;
            let outcome = automation::act(app, &target, &action).await?;
            Ok(BrowserOutcome::json(encode(outcome)?))
        }
        BrowserRequest::Screenshot { tab, element_ref } => {
            let target = owned_target(app, session_id, tab)?;
            let mut width_points = SCREENSHOT_MAX_WIDTH_POINTS;
            let (captured, encoded) = loop {
                let captured = automation::screenshot(
                    app,
                    &target,
                    element_ref.as_deref(),
                    Some(width_points),
                )
                .await?;
                let encoded = encode_base64(&captured.png);
                if encoded.len() <= SCREENSHOT_MAX_BASE64_BYTES
                    || width_points <= SCREENSHOT_MIN_WIDTH_POINTS
                {
                    break (captured, encoded);
                }
                width_points = next_screenshot_width(width_points, encoded.len());
            };
            let oversized = encoded.len() > SCREENSHOT_MAX_BASE64_BYTES;
            let mut result = json!({
                "width": captured.width,
                "height": captured.height,
                "bytes": captured.png.len(),
                "dropped": oversized,
            });
            // A screenshot that reached the model but not the disk is degraded,
            // not broken: report why and still hand over the image block.
            match save_screenshot(app, session_id, &encoded) {
                Ok(path) => result["path"] = json!(path),
                Err(message) => result["pathError"] = json!(message),
            }
            Ok(BrowserOutcome {
                result,
                png_base64: (!oversized).then_some(encoded),
            })
        }
        BrowserRequest::Evaluate { tab, expression } => {
            let target = owned_target(app, session_id, tab)?;
            Ok(BrowserOutcome::json(
                automation::evaluate(app, &target, &expression).await?,
            ))
        }
        BrowserRequest::Console { tab, limit, clear } => {
            let target = owned_target(app, session_id, tab)?;
            Ok(BrowserOutcome::json(
                automation::read_capture(
                    app,
                    &target,
                    automation::CaptureKind::Console,
                    limit,
                    clear,
                )
                .await?,
            ))
        }
        BrowserRequest::Network { tab, limit, clear } => {
            let target = owned_target(app, session_id, tab)?;
            Ok(BrowserOutcome::json(
                automation::read_capture(
                    app,
                    &target,
                    automation::CaptureKind::Network,
                    limit,
                    clear,
                )
                .await?,
            ))
        }
        BrowserRequest::HandleDialog {
            tab,
            accept,
            prompt_text,
        } => {
            let target = owned_target(app, session_id, tab)?;
            Ok(BrowserOutcome::json(
                automation::handle_dialog(app, &target, accept, prompt_text.as_deref()).await?,
            ))
        }
    }
}

fn encode(value: impl Serialize) -> ArgmaxResult<Value> {
    serde_json::to_value(value).map_err(|error| {
        ArgmaxError::service(
            "BROWSER_ENCODE_FAILED",
            format!("could not encode the browser result: {error}"),
        )
    })
}

/// Resolves the tab a request names, refusing one this session does not own.
/// Naming no tab means "the tab this session touched last", which no other
/// session can reach by construction.
fn owned_target(app: &AppHandle, session_id: &str, tab: Option<String>) -> ArgmaxResult<TabTarget> {
    let Some(tab_id) = tab else {
        return Ok(TabTarget::Session(session_id.to_string()));
    };
    let owner = automation::tabs(app, None)
        .into_iter()
        .find(|info| info.tab_id == tab_id)
        .ok_or_else(|| {
            ArgmaxError::service(
                "BROWSER_NOT_OPEN",
                format!("browser tab {tab_id} is not open"),
            )
        })?
        .owner_session_id;
    match owner.as_deref() {
        Some(owner) if owner == session_id => Ok(TabTarget::Tab(tab_id)),
        Some(_) => Err(ArgmaxError::service(
            "BROWSER_TAB_NOT_OWNED",
            format!(
                "browser tab {tab_id} belongs to another session; open your own page with \
                 browser_open"
            ),
        )),
        None => Err(ArgmaxError::service(
            "BROWSER_TAB_NOT_OWNED",
            format!(
                "browser tab {tab_id} is the user's own tab; a session may only drive tabs it \
                 opened"
            ),
        )),
    }
}

/// Runs AppKit-touching work on the main thread and waits for its result.
/// Creating, navigating and destroying a webview all qualify; reading a page
/// does not, because WebKit's own callbacks already hop the queue.
async fn on_main<T, F>(app: &AppHandle, work: F) -> ArgmaxResult<T>
where
    F: FnOnce(&AppHandle) -> ArgmaxResult<T> + Send + 'static,
    T: Send + 'static,
{
    let (sender, receiver) = tokio::sync::oneshot::channel();
    let handle = app.clone();
    app.run_on_main_thread(move || {
        let _ = sender.send(work(&handle));
    })
    .map_err(|error| ArgmaxError::service("BROWSER_MAIN_THREAD_FAILED", error.to_string()))?;
    receiver.await.map_err(|_| {
        ArgmaxError::service(
            "BROWSER_MAIN_THREAD_FAILED",
            "the browser action was dropped before it ran",
        )
    })?
}

#[cfg(test)]
mod tests {
    use super::{next_screenshot_width, BrowserRequest, SCREENSHOT_MAX_BASE64_BYTES};
    use crate::browser::automation::BrowserAction;

    #[test]
    fn oversized_screenshots_are_retried_at_a_narrower_width() {
        let next = next_screenshot_width(360.0, SCREENSHOT_MAX_BASE64_BYTES * 4);
        assert!(next < 180.0);
        assert!(next >= 1.0);
    }

    #[test]
    fn requests_round_trip_through_the_wire_shape() {
        let encoded = serde_json::to_string(&BrowserRequest::Snapshot {
            tab: None,
            interactive_only: true,
        })
        .expect("encode");
        assert_eq!(
            encoded,
            r#"{"snapshot":{"tab":null,"interactiveOnly":true}}"#
        );
        assert_eq!(
            serde_json::from_str::<BrowserRequest>(&encoded).expect("decode"),
            BrowserRequest::Snapshot {
                tab: None,
                interactive_only: true
            }
        );
    }

    #[test]
    fn an_act_request_carries_the_automation_action_verbatim() {
        let request: BrowserRequest =
            serde_json::from_str(r#"{"act":{"action":{"kind":"click","ref":"e7"}}}"#)
                .expect("decode");
        assert_eq!(
            request,
            BrowserRequest::Act {
                tab: None,
                action: BrowserAction::Click {
                    element_ref: "e7".into()
                }
            }
        );
    }

    #[test]
    fn a_dialog_answer_decodes_without_prompt_text() {
        let request: BrowserRequest =
            serde_json::from_str(r#"{"handleDialog":{"accept":true}}"#).expect("decode");
        assert_eq!(
            request,
            BrowserRequest::HandleDialog {
                tab: None,
                accept: true,
                prompt_text: None
            }
        );
    }

    #[test]
    fn capture_requests_carry_bounds_and_clear_across_the_wire() {
        for (encoded, expected) in [
            (
                r#"{"console":{"tab":"tab-1","limit":12,"clear":true}}"#,
                BrowserRequest::Console {
                    tab: Some("tab-1".to_string()),
                    limit: Some(12),
                    clear: true,
                },
            ),
            (
                r#"{"network":{"limit":200,"clear":false}}"#,
                BrowserRequest::Network {
                    tab: None,
                    limit: Some(200),
                    clear: false,
                },
            ),
        ] {
            let decoded = serde_json::from_str::<BrowserRequest>(encoded).expect("decode");
            assert_eq!(decoded, expected);
            let round_trip =
                serde_json::from_str::<BrowserRequest>(&serde_json::to_string(&decoded).unwrap())
                    .expect("round trip");
            assert_eq!(round_trip, expected);
        }
    }
}
