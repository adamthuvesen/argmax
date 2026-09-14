//! Native WebKit content-rule compilation and installation.
//!
//! Every retained WebKit object stays in main-thread storage. Async callers
//! only receive the compilation outcome through a oneshot channel.

use std::cell::RefCell;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use block2::RcBlock;
use objc2::rc::Retained;
use objc2::MainThreadMarker;
use objc2_foundation::{NSArray, NSError, NSString, NSURL};
use objc2_web_kit::{
    WKContentRuleList, WKContentRuleListStore, WKUserContentController, WKWebView,
    WKWebViewConfiguration,
};
use tauri::{AppHandle, Webview};

use crate::error::{ArgmaxError, ArgmaxResult};

const PREPARE_TIMEOUT: Duration = Duration::from_secs(30);
const CLEANUP_TIMEOUT: Duration = Duration::from_secs(2);
const RULE_LIST_IDENTIFIER_PREFIX: &str = "argmax-domains-v1-";

thread_local! {
    static RULE_LISTS: RefCell<HashMap<String, Retained<WKContentRuleList>>> =
        RefCell::new(HashMap::new());
    static ACTIVE_IDENTIFIER: RefCell<Option<String>> = const { RefCell::new(None) };
}

type PrepareSlot = Arc<Mutex<Option<tokio::sync::oneshot::Sender<Result<(), String>>>>>;

/// Loads a compiled rule list from WebKit's store or compiles and caches it.
pub async fn prepare(app: &AppHandle, identifier: String, json: String) -> ArgmaxResult<()> {
    let store_dir = crate::util::data_dir::app_data_dir(app)
        .map_err(|error| content_blocking_error(error.to_string()))?
        .join("browser-content-rules");
    std::fs::create_dir_all(&store_dir).map_err(|error| {
        content_blocking_error(format!("could not create {}: {error}", store_dir.display()))
    })?;
    let store_path = store_dir.to_str().ok_or_else(|| {
        content_blocking_error("the browser content-rule store path is not valid Unicode")
    })?;

    let (sender, receiver) = tokio::sync::oneshot::channel::<Result<(), String>>();
    let slot = Arc::new(Mutex::new(Some(sender)));
    let dispatch_slot = slot.clone();
    let store_path = store_path.to_owned();
    let cleanup_store_path = store_path.clone();
    let cleanup_identifier = identifier.clone();

    app.run_on_main_thread(move || {
        let Some(mtm) = MainThreadMarker::new() else {
            finish(
                &dispatch_slot,
                Err("content-rule preparation ran off the main thread".to_string()),
            );
            return;
        };

        // SAFETY: the marker proves this closure is on the main thread, and
        // all retained WebKit objects stay in this closure or main-thread TLS.
        unsafe {
            let store_url = NSURL::fileURLWithPath_isDirectory(
                &NSString::from_str(&store_path),
                true,
            );
            let Some(store) = WKContentRuleListStore::storeWithURL(Some(&store_url), mtm) else {
                finish(
                    &dispatch_slot,
                    Err("WebKit could not open the content-rule store".to_string()),
                );
                return;
            };

            let native_identifier = NSString::from_str(&identifier);
            let lookup_key = native_identifier.clone();
            let encoded_rules = NSString::from_str(&json);
            let lookup_identifier = identifier.clone();
            let lookup_slot = dispatch_slot.clone();
            let lookup_store = store.clone();
            let lookup = RcBlock::new(
                move |rule_list: *mut WKContentRuleList, _error: *mut NSError| {
                    if !is_waiting(&lookup_slot) {
                        return;
                    }
                    let Some(_mtm) = MainThreadMarker::new() else {
                        finish(
                            &lookup_slot,
                            Err("content-rule lookup completed off the main thread".to_string()),
                        );
                        return;
                    };

                    if let Some(rule_list) = Retained::retain(rule_list) {
                        cache_rule_list(lookup_identifier.clone(), rule_list);
                        finish(&lookup_slot, Ok(()));
                        return;
                    }

                    let compile_identifier = lookup_identifier.clone();
                    let compile_slot = lookup_slot.clone();
                    let compile = RcBlock::new(
                        move |rule_list: *mut WKContentRuleList, error: *mut NSError| {
                            if !is_waiting(&compile_slot) {
                                return;
                            }
                            let Some(_mtm) = MainThreadMarker::new() else {
                                finish(
                                    &compile_slot,
                                    Err(
                                        "content-rule compilation completed off the main thread"
                                            .to_string(),
                                    ),
                                );
                                return;
                            };

                            if !error.is_null() {
                                finish(
                                    &compile_slot,
                                    Err((*error).localizedDescription().to_string()),
                                );
                                return;
                            }
                            let Some(rule_list) = Retained::retain(rule_list) else {
                                finish(
                                    &compile_slot,
                                    Err("WebKit compiled no content rule list".to_string()),
                                );
                                return;
                            };

                            cache_rule_list(compile_identifier.clone(), rule_list);
                            finish(&compile_slot, Ok(()));
                        },
                    );
                    lookup_store
                        .compileContentRuleListForIdentifier_encodedContentRuleList_completionHandler(
                            Some(&native_identifier),
                            Some(&encoded_rules),
                            Some(&compile),
                        );
                },
            );
            store.lookUpContentRuleListForIdentifier_completionHandler(
                Some(&lookup_key),
                Some(&lookup),
            );
        }
    })
    .map_err(|error| content_blocking_error(error.to_string()))?;

    match tokio::time::timeout(PREPARE_TIMEOUT, receiver).await {
        Ok(Ok(Ok(()))) => {
            if let Err(error) =
                prune_stale_rule_lists(app, cleanup_store_path, cleanup_identifier).await
            {
                tracing::warn!(%error, "could not prune stale browser content rules");
            }
            Ok(())
        }
        Ok(Ok(Err(message))) => Err(content_blocking_error(message)),
        Ok(Err(_)) => Err(content_blocking_error(
            "the content-rule handler was dropped without answering",
        )),
        Err(_) => Err(ArgmaxError::service(
            "BROWSER_CONTENT_BLOCKING_TIMEOUT",
            format!(
                "content-rule preparation did not finish after {} seconds",
                PREPARE_TIMEOUT.as_secs()
            ),
        )),
    }
}

/// Makes a successfully prepared identifier active and drops stale candidates.
pub fn activate(identifier: &str) -> ArgmaxResult<()> {
    require_main_thread()?;
    let found = RULE_LISTS.with(|lists| {
        let mut lists = lists.borrow_mut();
        let found = lists.contains_key(identifier);
        if found {
            lists.retain(|candidate, _| candidate == identifier);
        }
        found
    });
    if !found {
        return Err(missing_rule_list(identifier));
    }
    ACTIVE_IDENTIFIER.with(|active| *active.borrow_mut() = Some(identifier.to_owned()));
    Ok(())
}

/// Returns the committed content-rule identifier from the macOS main thread.
pub fn active_identifier() -> Option<String> {
    MainThreadMarker::new()?;
    ACTIVE_IDENTIFIER.with(|active| active.borrow().clone())
}

/// Builds a fresh WebKit configuration with the requested rule list installed.
pub fn configuration(identifier: &str) -> ArgmaxResult<Retained<WKWebViewConfiguration>> {
    let mtm = require_main_thread()?;
    // SAFETY: the marker proves the new configuration and its controller are
    // created and accessed exclusively on the main thread.
    unsafe {
        let configuration = WKWebViewConfiguration::new(mtm);
        let controller = WKUserContentController::new(mtm);
        add_to_controller(&controller, identifier)?;
        configuration.setUserContentController(&controller);
        Ok(configuration)
    }
}

/// Adds a cached content rule list to a popup's fresh content controller.
pub fn add_to_controller(
    controller: &WKUserContentController,
    identifier: &str,
) -> ArgmaxResult<()> {
    require_main_thread()?;
    RULE_LISTS.with(|lists| {
        let lists = lists.borrow();
        let rule_list = lists
            .get(identifier)
            .ok_or_else(|| missing_rule_list(identifier))?;
        // SAFETY: both the controller and cached rule list are main-thread-only
        // WebKit objects, and the marker above proves this is the main thread.
        unsafe { controller.addContentRuleList(rule_list) };
        Ok(())
    })
}

/// Replaces the rule lists installed on an existing browser webview.
pub fn apply(webview: &Webview, identifier: Option<String>) -> ArgmaxResult<()> {
    require_main_thread()?;
    if let Some(identifier) = identifier.as_deref() {
        RULE_LISTS.with(|lists| {
            if lists.borrow().contains_key(identifier) {
                Ok(())
            } else {
                Err(missing_rule_list(identifier))
            }
        })?;
    }

    webview
        .with_webview(move |platform| {
            // SAFETY: Tauri runs this closure on the main thread and supplies
            // the live WKWebView pointer. The caller is already on the main
            // thread, and Tauri queues this handler before returning to the
            // serialized settings operation. A later activation therefore
            // cannot prune the checked identifier before this handler runs.
            unsafe {
                let view: &WKWebView = &*platform.inner().cast();
                let controller = view.configuration().userContentController();
                controller.removeAllContentRuleLists();
                if let Some(identifier) = identifier {
                    if let Err(error) = add_to_controller(&controller, &identifier) {
                        tracing::error!(%error, "cached browser content rules disappeared before apply");
                    }
                }
            }
        })
        .map_err(|error| content_blocking_error(error.to_string()))
}

fn cache_rule_list(identifier: String, rule_list: Retained<WKContentRuleList>) {
    let active = ACTIVE_IDENTIFIER.with(|active| active.borrow().clone());
    RULE_LISTS.with(|lists| {
        let mut lists = lists.borrow_mut();
        lists.insert(identifier.clone(), rule_list);
        lists.retain(|candidate, _| {
            candidate == &identifier || active.as_deref() == Some(candidate.as_str())
        });
    });
}

async fn prune_stale_rule_lists(
    app: &AppHandle,
    store_path: String,
    prepared_identifier: String,
) -> ArgmaxResult<()> {
    let (sender, receiver) = tokio::sync::oneshot::channel::<Result<(), String>>();
    let slot = Arc::new(Mutex::new(Some(sender)));
    let dispatch_slot = slot.clone();

    app.run_on_main_thread(move || {
        let Some(mtm) = MainThreadMarker::new() else {
            finish(
                &dispatch_slot,
                Err("content-rule cleanup ran off the main thread".to_string()),
            );
            return;
        };
        let store_url = NSURL::fileURLWithPath_isDirectory(&NSString::from_str(&store_path), true);
        let Some(store) = (unsafe { WKContentRuleListStore::storeWithURL(Some(&store_url), mtm) })
        else {
            finish(
                &dispatch_slot,
                Err("WebKit could not open the content-rule store for cleanup".to_string()),
            );
            return;
        };

        // Cleanup starts only after lookup or compilation has completed. If
        // cleanup times out, the closed slot keeps a late enumeration callback
        // from starting any removals.
        prune_stale_rule_lists_in_store(store, prepared_identifier, dispatch_slot);
    })
    .map_err(|error| content_blocking_error(error.to_string()))?;

    match tokio::time::timeout(CLEANUP_TIMEOUT, receiver).await {
        Ok(Ok(Ok(()))) => Ok(()),
        Ok(Ok(Err(message))) => Err(content_blocking_error(message)),
        Ok(Err(_)) => Err(content_blocking_error(
            "the content-rule cleanup handler was dropped without answering",
        )),
        Err(_) => Err(content_blocking_error(format!(
            "content-rule cleanup did not finish after {} seconds",
            CLEANUP_TIMEOUT.as_secs()
        ))),
    }
}

fn prune_stale_rule_lists_in_store(
    store: Retained<WKContentRuleListStore>,
    prepared_identifier: String,
    slot: PrepareSlot,
) {
    let active_identifier = ACTIVE_IDENTIFIER.with(|active| active.borrow().clone());
    let cleanup_store = store.clone();
    let identifiers = RcBlock::new(move |identifiers: *mut NSArray<NSString>| {
        if !is_waiting(&slot) {
            return;
        }
        let Some(identifiers) = (unsafe { Retained::retain(identifiers) }) else {
            tracing::warn!("WebKit returned no browser content-rule identifiers for cleanup");
            finish(&slot, Ok(()));
            return;
        };

        let stale_identifiers = (0..identifiers.count())
            .map(|index| identifiers.objectAtIndex(index).to_string())
            .filter(|identifier| identifier.starts_with(RULE_LIST_IDENTIFIER_PREFIX))
            .filter(|identifier| identifier != &prepared_identifier)
            .filter(|identifier| active_identifier.as_ref() != Some(identifier))
            .collect::<Vec<_>>();
        if stale_identifiers.is_empty() {
            finish(&slot, Ok(()));
            return;
        }

        let remaining = Arc::new(Mutex::new(stale_identifiers.len()));
        for stale_identifier in stale_identifiers {
            let remove_slot = slot.clone();
            let remove_remaining = remaining.clone();
            let identifier = NSString::from_str(&stale_identifier);
            let completion = RcBlock::new(move |error: *mut NSError| {
                if !is_waiting(&remove_slot) {
                    return;
                }
                if !error.is_null() {
                    let error_description = unsafe { (*error).localizedDescription().to_string() };
                    tracing::warn!(
                        identifier = %stale_identifier,
                        error = %error_description,
                        "could not remove stale browser content rules"
                    );
                }
                let finished = {
                    let mut remaining = remove_remaining
                        .lock()
                        .expect("content-rule cleanup count poisoned");
                    *remaining -= 1;
                    *remaining == 0
                };
                if finished {
                    finish(&remove_slot, Ok(()));
                }
            });
            unsafe {
                cleanup_store.removeContentRuleListForIdentifier_completionHandler(
                    Some(&identifier),
                    Some(&completion),
                );
            }
        }
    });
    // SAFETY: this helper is only called from WebKit callbacks on the main
    // thread. The store and all callback values remain main-thread-only.
    unsafe { store.getAvailableContentRuleListIdentifiers(Some(&identifiers)) };
}

fn require_main_thread() -> ArgmaxResult<MainThreadMarker> {
    MainThreadMarker::new().ok_or_else(|| {
        content_blocking_error("browser content rules must be accessed on the macOS main thread")
    })
}

fn missing_rule_list(identifier: &str) -> ArgmaxError {
    content_blocking_error(format!(
        "content rule list {identifier:?} has not been prepared"
    ))
}

fn content_blocking_error(message: impl Into<String>) -> ArgmaxError {
    ArgmaxError::service("BROWSER_CONTENT_BLOCKING_FAILED", message)
}

fn finish(slot: &PrepareSlot, outcome: Result<(), String>) {
    if let Some(sender) = slot.lock().expect("content-rule slot poisoned").take() {
        let _ = sender.send(outcome);
    }
}

fn is_waiting(slot: &PrepareSlot) -> bool {
    slot.lock()
        .expect("content-rule slot poisoned")
        .as_ref()
        .is_some_and(|sender| !sender.is_closed())
}
