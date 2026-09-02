//! The browser tools: open a page, read it, act on it, look at it.
//!
//! Each one builds a [`BrowserRequest`] and sends it over the session-control
//! socket, exactly as the session tools send a `SessionControlAction`. The app
//! side owns the policy — which tab, and whether this session is allowed to
//! touch it — so a tool here is a described face on one wire action.
//!
//! The descriptions are the agent's whole manual for this surface, so they
//! carry the three rules that make the difference between a working run and a
//! flailing one: snapshot before acting, address elements by `ref`, and reach
//! for a screenshot only when the answer is visual.

use rmcp::{
    handler::server::wrapper::Parameters,
    model::{CallToolResult, ContentBlock},
    schemars, tool, tool_router, ErrorData,
};
use serde::Deserialize;

use crate::browser::automation::BrowserAction;
use crate::session_control::{SessionControlAction, SessionControlResult};

use super::browser_bridge::{BrowserOutcome, BrowserRequest};
use super::session_tools::ArgmaxTools;

/// `browser_wait_for` blocks the socket round trip, and the client's own read
/// deadline is 75 s. Stay well inside it.
const MAX_WAIT_SECONDS: u32 = 60;

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct OpenParams {
    /// Absolute http(s) URL to open.
    pub url: String,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct NavigateParams {
    /// Where to go, as an absolute http(s) URL.
    pub url: String,
    /// Tab id from browser_open or browser_tabs. Defaults to the tab this
    /// session used last.
    pub tab: Option<String>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct TabParams {
    /// Tab id from browser_open or browser_tabs. Defaults to the tab this
    /// session used last.
    pub tab: Option<String>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct CloseParams {
    /// Tab id to close, from browser_open or browser_tabs. Closing destroys
    /// the page's history, cookies for the session, and scroll position.
    pub tab: String,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct SnapshotParams {
    /// Tab id from browser_open or browser_tabs. Defaults to the tab this
    /// session used last.
    pub tab: Option<String>,
    /// Drop prose and keep only controls, links and headings. Cheaper on a
    /// dense page when you already know what you are looking for.
    pub interactive_only: Option<bool>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct FindParams {
    /// Text to look for in an element's role, name, value or text
    /// (case-insensitive substring, for example "Sign in" or "search").
    pub query: String,
    /// Tab id from browser_open or browser_tabs. Defaults to the tab this
    /// session used last.
    pub tab: Option<String>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct GetTextParams {
    /// Tab id from browser_open or browser_tabs. Defaults to the tab this
    /// session used last.
    pub tab: Option<String>,
    /// Cap on the characters returned. Defaults to 20000.
    pub max_chars: Option<u32>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct ClickParams {
    /// Element handle from a snapshot line or browser_find, for example "e12".
    #[serde(rename = "ref")]
    pub element_ref: String,
    /// Tab id from browser_open or browser_tabs. Defaults to the tab this
    /// session used last.
    pub tab: Option<String>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct TypeParams {
    /// Handle of the text field, from a snapshot line or browser_find.
    #[serde(rename = "ref")]
    pub element_ref: String,
    /// Text to put in the field. It replaces what is there rather than
    /// appending.
    pub text: String,
    /// Press Enter afterwards, falling back to submitting the field's form.
    /// This is how you run a search box.
    pub submit: Option<bool>,
    /// Tab id from browser_open or browser_tabs. Defaults to the tab this
    /// session used last.
    pub tab: Option<String>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct SelectParams {
    /// Handle of the `select` element, from a snapshot line or browser_find.
    #[serde(rename = "ref")]
    pub element_ref: String,
    /// Option to choose, matched against the option's value or its visible
    /// label.
    pub value: String,
    /// Tab id from browser_open or browser_tabs. Defaults to the tab this
    /// session used last.
    pub tab: Option<String>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct PressKeyParams {
    /// Key name as the DOM reports it: "Enter", "Escape", "Tab",
    /// "ArrowDown", or a single character.
    pub key: String,
    /// Modifiers held down: any of "Meta", "Control", "Alt", "Shift".
    pub modifiers: Option<Vec<String>>,
    /// Tab id from browser_open or browser_tabs. Defaults to the tab this
    /// session used last.
    pub tab: Option<String>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct ScrollParams {
    /// One of "up", "down", "left", "right".
    pub direction: String,
    /// Distance in CSS pixels. Defaults to most of the scrollport.
    pub amount: Option<f64>,
    /// Handle of a scrollable element to scroll instead of the page.
    #[serde(rename = "ref")]
    pub element_ref: Option<String>,
    /// Tab id from browser_open or browser_tabs. Defaults to the tab this
    /// session used last.
    pub tab: Option<String>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct WaitForParams {
    /// Wait until this text appears anywhere in the page's visible text.
    pub text: Option<String>,
    /// Wait until this element handle exists and is visible.
    #[serde(rename = "ref")]
    pub element_ref: Option<String>,
    /// Wait until the page's URL contains this substring. Use it after a
    /// click that navigates.
    pub url_includes: Option<String>,
    /// Seconds to wait before giving up. Defaults to 10, capped at 60.
    pub timeout_s: Option<u32>,
    /// Tab id from browser_open or browser_tabs. Defaults to the tab this
    /// session used last.
    pub tab: Option<String>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct ScreenshotParams {
    /// Tab id from browser_open or browser_tabs. Defaults to the tab this
    /// session used last.
    pub tab: Option<String>,
    /// Element handle to crop to. Without one the whole visible page is
    /// captured.
    #[serde(rename = "ref")]
    pub element_ref: Option<String>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct EvaluateParams {
    /// A JavaScript expression evaluated in the page. The value comes back as
    /// JSON, so return something serializable. A thrown error is reported
    /// rather than swallowed.
    pub expression: String,
    /// Tab id from browser_open or browser_tabs. Defaults to the tab this
    /// session used last.
    pub tab: Option<String>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct HandleDialogParams {
    /// True accepts the dialog (confirm returns true, prompt returns text);
    /// false dismisses it.
    pub accept: bool,
    /// Text to answer a `prompt()` with. Ignored by alert and confirm.
    pub prompt_text: Option<String>,
    /// Tab id from browser_open or browser_tabs. Defaults to the tab this
    /// session used last.
    pub tab: Option<String>,
}

#[tool_router(router = browser_tool_router, vis = "pub(super)")]
impl ArgmaxTools {
    #[tool(
        name = "browser_open",
        description = "Open a URL in a new browser tab inside Argmax and return its tab id. The \
user watches the page in this session's own pane, so browsing is visible work, not a hidden \
side channel. Follow it with browser_snapshot to see what is on the page. Tabs you open belong to \
this session; you cannot touch the user's tabs or another session's."
    )]
    async fn browser_open(
        &self,
        Parameters(params): Parameters<OpenParams>,
    ) -> Result<CallToolResult, ErrorData> {
        call(BrowserRequest::Open { url: params.url }).await
    }

    #[tool(
        name = "browser_navigate",
        description = "Point an existing tab at a new URL. Every [ref=eN] handle from an earlier \
snapshot of that tab dies with the old page, so take a fresh browser_snapshot afterwards."
    )]
    async fn browser_navigate(
        &self,
        Parameters(params): Parameters<NavigateParams>,
    ) -> Result<CallToolResult, ErrorData> {
        call(BrowserRequest::Navigate {
            tab: params.tab,
            url: params.url,
        })
        .await
    }

    #[tool(
        name = "browser_back",
        description = "Go back one entry in a tab's history. Refs from the page you left are \
stale; snapshot again."
    )]
    async fn browser_back(
        &self,
        Parameters(params): Parameters<TabParams>,
    ) -> Result<CallToolResult, ErrorData> {
        call(BrowserRequest::Back { tab: params.tab }).await
    }

    #[tool(
        name = "browser_reload",
        description = "Reload a tab. Refs survive only if the page rebuilds the same elements, so \
treat them as stale and snapshot again."
    )]
    async fn browser_reload(
        &self,
        Parameters(params): Parameters<TabParams>,
    ) -> Result<CallToolResult, ErrorData> {
        call(BrowserRequest::Reload { tab: params.tab }).await
    }

    #[tool(
        name = "browser_tabs",
        description = "List the browser tabs this session has open, with each one's id, URL, \
title and loading state. Tools that name no tab act on the one you used last."
    )]
    async fn browser_tabs(&self) -> Result<CallToolResult, ErrorData> {
        call(BrowserRequest::Tabs).await
    }

    #[tool(
        name = "browser_close",
        description = "Close one of this session's tabs. Do it when you are done with a page — \
each open tab is a live webview in the user's window."
    )]
    async fn browser_close(
        &self,
        Parameters(params): Parameters<CloseParams>,
    ) -> Result<CallToolResult, ErrorData> {
        call(BrowserRequest::Close { tab: params.tab }).await
    }

    #[tool(
        name = "browser_snapshot",
        description = "Read the page as an accessibility tree: one indented line per element, \
with its role, name and value, and a [ref=eN] handle on everything you can interact with. This is \
the tool to reach for first and after every action — it is far cheaper than a screenshot and it is \
what gives you the refs the click and type tools need. Refs live in the page, so they stay valid \
while the element does and go stale the moment the page navigates. A `dialog:` header line means \
the page raised an alert, confirm or prompt; see browser_handle_dialog."
    )]
    async fn browser_snapshot(
        &self,
        Parameters(params): Parameters<SnapshotParams>,
    ) -> Result<CallToolResult, ErrorData> {
        call(BrowserRequest::Snapshot {
            tab: params.tab,
            interactive_only: params.interactive_only.unwrap_or(false),
        })
        .await
    }

    #[tool(
        name = "browser_find",
        description = "Find interactive elements whose role, name, value or text match a query, \
and return their refs. Use it instead of a full snapshot when you know what you are looking for on \
a long page."
    )]
    async fn browser_find(
        &self,
        Parameters(params): Parameters<FindParams>,
    ) -> Result<CallToolResult, ErrorData> {
        call(BrowserRequest::Find {
            tab: params.tab,
            query: params.query,
        })
        .await
    }

    #[tool(
        name = "browser_get_text",
        description = "Read the page's visible text, main content first. Use it to read an \
article or a result; use browser_snapshot when you need to act on something."
    )]
    async fn browser_get_text(
        &self,
        Parameters(params): Parameters<GetTextParams>,
    ) -> Result<CallToolResult, ErrorData> {
        call(BrowserRequest::GetText {
            tab: params.tab,
            max_chars: params.max_chars,
        })
        .await
    }

    #[tool(
        name = "browser_click",
        description = "Click the element a ref names. Take a browser_snapshot first to get the \
ref. The reply reports the URL afterwards, so a click that navigated says so; follow a navigation \
with a fresh snapshot, because the old refs are gone."
    )]
    async fn browser_click(
        &self,
        Parameters(params): Parameters<ClickParams>,
    ) -> Result<CallToolResult, ErrorData> {
        act(
            params.tab,
            BrowserAction::Click {
                element_ref: params.element_ref,
            },
        )
        .await
    }

    #[tool(
        name = "browser_type",
        description = "Type text into the field a ref names, replacing what is there. Set submit \
to true to press Enter afterwards, which is how you run a search box. The value goes in through \
the DOM's native setter, so React and Vue forms see it."
    )]
    async fn browser_type(
        &self,
        Parameters(params): Parameters<TypeParams>,
    ) -> Result<CallToolResult, ErrorData> {
        act(
            params.tab,
            BrowserAction::Type {
                element_ref: params.element_ref,
                text: params.text,
                submit: params.submit.unwrap_or(false),
            },
        )
        .await
    }

    #[tool(
        name = "browser_select",
        description = "Choose an option in a dropdown the ref names, by the option's value or its \
visible label."
    )]
    async fn browser_select(
        &self,
        Parameters(params): Parameters<SelectParams>,
    ) -> Result<CallToolResult, ErrorData> {
        act(
            params.tab,
            BrowserAction::Select {
                element_ref: params.element_ref,
                value: params.value,
            },
        )
        .await
    }

    #[tool(
        name = "browser_hover",
        description = "Move the pointer onto the element a ref names, for menus and tooltips that \
only appear on hover. Snapshot afterwards to see what appeared."
    )]
    async fn browser_hover(
        &self,
        Parameters(params): Parameters<ClickParams>,
    ) -> Result<CallToolResult, ErrorData> {
        act(
            params.tab,
            BrowserAction::Hover {
                element_ref: params.element_ref,
            },
        )
        .await
    }

    #[tool(
        name = "browser_press_key",
        description = "Send a key press to whatever has focus — Enter to submit, Escape to close \
an overlay, Tab to move on, arrows to walk a list."
    )]
    async fn browser_press_key(
        &self,
        Parameters(params): Parameters<PressKeyParams>,
    ) -> Result<CallToolResult, ErrorData> {
        act(
            params.tab,
            BrowserAction::PressKey {
                key: params.key,
                modifiers: params.modifiers.unwrap_or_default(),
            },
        )
        .await
    }

    #[tool(
        name = "browser_scroll",
        description = "Scroll the page, or one scrollable element when you name its ref. A \
snapshot already covers the whole document, so scroll for pages that load more content as you go."
    )]
    async fn browser_scroll(
        &self,
        Parameters(params): Parameters<ScrollParams>,
    ) -> Result<CallToolResult, ErrorData> {
        act(
            params.tab,
            BrowserAction::Scroll {
                element_ref: params.element_ref,
                direction: params.direction,
                amount: params.amount,
            },
        )
        .await
    }

    #[tool(
        name = "browser_wait_for",
        description = "Block until the page catches up: until some text appears, an element \
becomes visible, or the URL contains a substring. Name at least one of them. This is what to use \
after a click or a search that navigates, instead of snapshotting a page that has not landed yet."
    )]
    async fn browser_wait_for(
        &self,
        Parameters(params): Parameters<WaitForParams>,
    ) -> Result<CallToolResult, ErrorData> {
        if params.text.is_none() && params.element_ref.is_none() && params.url_includes.is_none() {
            return Ok(CallToolResult::error(vec![ContentBlock::text(
                "browser_wait_for needs one of text, ref or url_includes.",
            )]));
        }
        act(
            params.tab,
            BrowserAction::WaitFor {
                text: params.text,
                element_ref: params.element_ref,
                url_includes: params.url_includes,
                timeout_ms: params
                    .timeout_s
                    .map(|seconds| seconds.clamp(1, MAX_WAIT_SECONDS) * 1_000),
            },
        )
        .await
    }

    #[tool(
        name = "browser_screenshot",
        description = "Capture the page as a PNG, cropped to one element when you name its ref. \
Only reach for this when the question is visual — how something looks, whether a layout is broken, \
what an image shows. For reading and acting, browser_snapshot is cheaper and more precise. The \
reply carries the image and a line with its pixel size."
    )]
    async fn browser_screenshot(
        &self,
        Parameters(params): Parameters<ScreenshotParams>,
    ) -> Result<CallToolResult, ErrorData> {
        call(BrowserRequest::Screenshot {
            tab: params.tab,
            element_ref: params.element_ref,
        })
        .await
    }

    #[tool(
        name = "browser_evaluate",
        description = "Evaluate a JavaScript expression in the page and get its value back as \
JSON. For inspection and debugging — reading computed styles, checking a global, counting nodes. \
Drive the UI with the click and type tools instead, so the user can follow along."
    )]
    async fn browser_evaluate(
        &self,
        Parameters(params): Parameters<EvaluateParams>,
    ) -> Result<CallToolResult, ErrorData> {
        call(BrowserRequest::Evaluate {
            tab: params.tab,
            expression: params.expression,
        })
        .await
    }

    #[tool(
        name = "browser_handle_dialog",
        description = "Answer this tab's next alert, confirm or prompt. A page's dialog call \
cannot wait for you — it is synchronous — so an unexpected one is dismissed on the spot and \
reported in the next snapshot's `dialog:` header line. Call this before the action that raises the \
dialog to have it answered your way, then repeat the action."
    )]
    async fn browser_handle_dialog(
        &self,
        Parameters(params): Parameters<HandleDialogParams>,
    ) -> Result<CallToolResult, ErrorData> {
        call(BrowserRequest::HandleDialog {
            tab: params.tab,
            accept: params.accept,
            prompt_text: params.prompt_text,
        })
        .await
    }
}

async fn act(tab: Option<String>, action: BrowserAction) -> Result<CallToolResult, ErrorData> {
    call(BrowserRequest::Act { tab, action }).await
}

/// One socket round trip, off the async runtime because the client is
/// blocking. A screenshot's PNG comes back beside the JSON and becomes an MCP
/// image block; everything else is the JSON alone.
#[cfg(unix)]
async fn call(request: BrowserRequest) -> Result<CallToolResult, ErrorData> {
    let outcome = tokio::task::spawn_blocking(move || {
        crate::session_control::send_session_control(SessionControlAction::Browser(request))
    })
    .await
    .map_err(|error| ErrorData::internal_error(format!("the tool call panicked: {error}"), None))?;
    match outcome {
        Ok(response) => match response.result {
            SessionControlResult::Browsed(outcome) => Ok(CallToolResult::success(blocks(outcome))),
            other => Err(ErrorData::internal_error(
                format!("Argmax answered a browser action with {other:?}"),
                None,
            )),
        },
        // A refused action (a tab this session does not own, a stale ref) is
        // the agent's to read and act on, not a transport failure.
        Err(error) => Ok(CallToolResult::error(vec![ContentBlock::text(format!(
            "{}: {}",
            error.code, error.message
        ))])),
    }
}

fn blocks(outcome: BrowserOutcome) -> Vec<ContentBlock> {
    let text = serde_json::to_string(&outcome.result)
        .unwrap_or_else(|error| format!("{{\"error\":\"could not encode the result: {error}\"}}"));
    match outcome.png_base64 {
        Some(png) => vec![
            ContentBlock::image(png, "image/png"),
            ContentBlock::text(text),
        ],
        None => vec![ContentBlock::text(text)],
    }
}

#[cfg(not(unix))]
async fn call(_request: BrowserRequest) -> Result<CallToolResult, ErrorData> {
    Err(ErrorData::internal_error(
        "the Argmax browser is not available on this platform".to_string(),
        None,
    ))
}
