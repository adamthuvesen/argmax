//! Run a script in a browser tab and get its value back as JSON.
//!
//! `Webview::eval` is fire-and-forget; `eval_with_callback` is the one that
//! carries a value back, through WebKit's `evaluateJavaScript:` completion
//! handler. Two properties of that path shape everything here:
//!
//! * **Errors are not reported.** wry's completion block reads only the value
//!   argument and drops WebKit's `NSError`, so a script that throws arrives as
//!   an empty string — the same thing a script returning `undefined` produces.
//!   Callers that need to tell those apart must catch inside the page and
//!   return an envelope; see `wrap_for_errors`.
//! * **The callback can simply never fire.** wry queues scripts issued before
//!   the webview's first load into `pending_scripts` and runs them later with
//!   no callback at all. Every call therefore carries a deadline.
//!
//! The oneshot channel per call *is* the request correlation: WebKit hands the
//! result to the block that asked for it, so there is nothing for an id map to
//! disambiguate.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use tauri::Webview;

use crate::error::{ArgmaxError, ArgmaxResult};

/// Evaluates `script` in the tab and returns WebKit's JSON encoding of the
/// resulting value. An empty string means the script produced `undefined` —
/// or threw. Multi-statement scripts work, but a top-level `return` does not:
/// this is an expression evaluation, not a function body.
pub async fn eval_json(webview: &Webview, script: &str, timeout: Duration) -> ArgmaxResult<String> {
    let (sender, receiver) = tokio::sync::oneshot::channel::<String>();
    // WebKit's completion handler is an `Fn` block, not `FnOnce`.
    let slot = Arc::new(Mutex::new(Some(sender)));
    let handler_slot = slot.clone();

    webview
        .eval_with_callback(script, move |value| {
            if let Some(sender) = handler_slot.lock().expect("eval slot poisoned").take() {
                let _ = sender.send(value);
            }
        })
        .map_err(|error| ArgmaxError::service("BROWSER_EVAL_FAILED", error.to_string()))?;

    match tokio::time::timeout(timeout, receiver).await {
        Ok(Ok(value)) => Ok(value),
        Ok(Err(_)) => Err(ArgmaxError::service(
            "BROWSER_EVAL_FAILED",
            "the eval handler was dropped without answering",
        )),
        Err(_) => Err(ArgmaxError::service(
            "BROWSER_EVAL_TIMEOUT",
            format!("the page did not answer within {} ms", timeout.as_millis()),
        )),
    }
}

/// Wraps a script so a thrown error comes back as data instead of vanishing
/// into WebKit's dropped `NSError`. The result is always a JSON string holding
/// either `{"ok":<value>}` or `{"error":"<message>"}`.
pub fn wrap_for_errors(script: &str) -> String {
    let literal = serde_json::to_string(script).unwrap_or_else(|_| "\"\"".to_string());
    format!(
        "(function () {{ \
           try {{ return JSON.stringify({{ ok: (0, eval)({literal}) }}); }} \
           catch (error) {{ return JSON.stringify({{ error: String(error) }}); }} \
         }})()"
    )
}

#[cfg(test)]
mod tests {
    use super::wrap_for_errors;

    #[test]
    fn wrapped_script_is_embedded_as_a_json_string_literal() {
        let wrapped = wrap_for_errors("document.title + \"!\"");
        assert!(wrapped.contains(r#"eval)("document.title + \"!\"")"#));
        assert!(wrapped.contains("catch (error)"));
    }
}
