//! PNG capture of one browser tab.
//!
//! wry has no capture API, so this reaches through `Webview::with_webview` to
//! the child `WKWebView` itself and calls
//! `takeSnapshotWithConfiguration:completionHandler:`. Everything inside that
//! closure runs on the macOS main thread — `with_webview` posts to the event
//! loop when called from a worker — and WebKit answers on the main queue too,
//! so the only thing crossing threads is the finished PNG, over a oneshot.
//!
//! WebKit rasterises on demand rather than reading back what is on screen, so
//! a hidden tab still captures: measured against a live instance, both a tab
//! hidden with `browser:set-bounds { visible: false }` and one hidden before
//! it had ever painted returned the full page. Agents can therefore screenshot
//! a background tab without stealing the panel from the user.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use tauri::Webview;

use super::CaptureRect;
use crate::error::{ArgmaxError, ArgmaxResult};

/// A finished capture. `width`/`height` are *device* pixels, so a retina
/// display returns twice the CSS-pixel size of the captured rect.
#[derive(Debug, Clone)]
pub struct CapturedPng {
    pub png: Vec<u8>,
    pub width: u32,
    pub height: u32,
}

/// Captures `rect` (or the whole visible view when `None`) as a PNG.
pub async fn capture(
    webview: &Webview,
    rect: Option<CaptureRect>,
    timeout: Duration,
) -> ArgmaxResult<CapturedPng> {
    let (sender, receiver) = tokio::sync::oneshot::channel::<Result<CapturedPng, String>>();
    // The WebKit completion handler is an `Fn` block, not `FnOnce`, so the
    // sender lives behind a take-once slot.
    let slot = Arc::new(Mutex::new(Some(sender)));

    dispatch_snapshot(webview, rect, slot)?;

    match tokio::time::timeout(timeout, receiver).await {
        Ok(Ok(Ok(captured))) => Ok(captured),
        Ok(Ok(Err(message))) => Err(ArgmaxError::service("BROWSER_SNAPSHOT_FAILED", message)),
        Ok(Err(_)) => Err(ArgmaxError::service(
            "BROWSER_SNAPSHOT_FAILED",
            "the snapshot handler was dropped without answering",
        )),
        Err(_) => Err(ArgmaxError::service(
            "BROWSER_SNAPSHOT_TIMEOUT",
            format!("no snapshot after {} ms", timeout.as_millis()),
        )),
    }
}

type SnapshotSlot = Arc<Mutex<Option<tokio::sync::oneshot::Sender<Result<CapturedPng, String>>>>>;

#[cfg(target_os = "macos")]
fn dispatch_snapshot(
    webview: &Webview,
    rect: Option<CaptureRect>,
    slot: SnapshotSlot,
) -> ArgmaxResult<()> {
    use block2::RcBlock;
    use objc2::MainThreadMarker;
    use objc2_app_kit::{NSBitmapImageFileType, NSBitmapImageRep, NSImage};
    use objc2_core_foundation::{CGPoint, CGRect, CGSize};
    use objc2_foundation::{NSDictionary, NSError};
    use objc2_web_kit::{WKSnapshotConfiguration, WKWebView};

    webview
        .with_webview(move |platform| {
            // SAFETY: `with_webview` hands us the live WKWebView pointer on
            // the main thread, which is the only thread WebKit allows here.
            unsafe {
                let view: &WKWebView = &*platform.inner().cast();
                let Some(mtm) = MainThreadMarker::new() else {
                    fulfil(&slot, Err("snapshot ran off the main thread".to_string()));
                    return;
                };
                let config = WKSnapshotConfiguration::new(mtm);
                if let Some(rect) = rect {
                    config.setRect(CGRect::new(
                        CGPoint::new(rect.x, rect.y),
                        CGSize::new(rect.width, rect.height),
                    ));
                }

                let slot = slot.clone();
                let handler = RcBlock::new(move |image: *mut NSImage, error: *mut NSError| {
                    if image.is_null() {
                        let detail = if error.is_null() {
                            "WebKit returned no image".to_string()
                        } else {
                            (*error).localizedDescription().to_string()
                        };
                        fulfil(&slot, Err(detail));
                        return;
                    }
                    fulfil(&slot, png_from_image(&*image));
                });
                view.takeSnapshotWithConfiguration_completionHandler(Some(&config), &handler);
            }

            /// Converts the snapshot NSImage to PNG bytes. The TIFF round-trip
            /// is what gets a bitmap rep at full device resolution; the
            /// NSImage's own `size` is in points and would halve the numbers
            /// on a retina display.
            unsafe fn png_from_image(image: &NSImage) -> Result<CapturedPng, String> {
                let tiff = image
                    .TIFFRepresentation()
                    .ok_or("the snapshot image had no bitmap representation")?;
                let rep = NSBitmapImageRep::imageRepWithData(&tiff)
                    .ok_or("the snapshot bitmap could not be read back")?;
                let png = rep
                    .representationUsingType_properties(
                        NSBitmapImageFileType::PNG,
                        &NSDictionary::new(),
                    )
                    .ok_or("the snapshot bitmap could not be encoded as PNG")?;
                Ok(CapturedPng {
                    png: png.to_vec(),
                    width: rep.pixelsWide().max(0) as u32,
                    height: rep.pixelsHigh().max(0) as u32,
                })
            }
        })
        .map_err(|error| ArgmaxError::service("BROWSER_SNAPSHOT_FAILED", error.to_string()))
}

#[cfg(not(target_os = "macos"))]
fn dispatch_snapshot(
    _webview: &Webview,
    _rect: Option<CaptureRect>,
    _slot: SnapshotSlot,
) -> ArgmaxResult<()> {
    Err(ArgmaxError::service(
        "BROWSER_SNAPSHOT_UNSUPPORTED",
        "browser capture is implemented for WKWebView only",
    ))
}

#[cfg(target_os = "macos")]
fn fulfil(slot: &SnapshotSlot, outcome: Result<CapturedPng, String>) {
    if let Some(sender) = slot.lock().expect("snapshot slot poisoned").take() {
        let _ = sender.send(outcome);
    }
}
