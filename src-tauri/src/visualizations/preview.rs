//! Disposable visualization capture, independent of authenticated browser tabs.

use std::time::{Duration, Instant};

use tauri::{AppHandle, WebviewUrl, WebviewWindowBuilder};

use crate::browser::{eval, snapshot_image, user_scripts, CaptureRect};

#[derive(Debug)]
pub struct PreviewCapture {
    pub png: Vec<u8>,
    pub width: u32,
    pub height: u32,
    pub content_height: f64,
    pub diagnostics: Vec<String>,
}

// Preview needs animation frames even when its window is hidden. A timer clock
// makes animation-driven initial layout run without borrowing keyboard focus.
const PREVIEW_SCRIPT: &str = r#"
(() => {
  const diagnostics = [];
  const report = (message) => { if (diagnostics.length < 100) diagnostics.push(String(message).slice(0, 2000)); };
  window.__argmaxPreview = { diagnostics, fontsReady: false, loaded: false };
  for (const level of ['log', 'info', 'warn', 'error']) {
    const original = console[level].bind(console);
    console[level] = (...args) => { report(level + ': ' + args.map(String).join(' ')); original(...args); };
  }
  addEventListener('error', event => report(event.message || ('Missing resource: ' + (event.target?.src || event.target?.href || 'unknown'))), true);
  addEventListener('unhandledrejection', event => report('Unhandled rejection: ' + String(event.reason)));
  addEventListener('securitypolicyviolation', event => report('Blocked resource: ' + event.blockedURI));
  window.requestAnimationFrame = callback => setTimeout(() => callback(performance.now()), 16);
  window.cancelAnimationFrame = id => clearTimeout(id);
  addEventListener('load', () => {
    window.__argmaxPreview.loaded = true;
    document.fonts.ready.then(() => { window.__argmaxPreview.fontsReady = true; });
  });
})();
"#;

/// A failed preview never prevents publishing the immutable draft.
pub async fn capture(
    app: &AppHandle,
    document: &str,
    width: u32,
    height: u32,
) -> Result<PreviewCapture, String> {
    if !(240..=1600).contains(&width) || !(80..=2000).contains(&height) {
        return Err("Preview width must be 240–1600 and height 80–2000 pixels.".into());
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, document);
        return Err("Native visualization preview is available on macOS only.".into());
    }
    #[cfg(target_os = "macos")]
    {
        // Serialize captures to bound native windows and WebContent memory.
        static CAPTURE: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
        let _capture = CAPTURE.lock().await;
        let label = format!("visualization-preview-{}", uuid::Uuid::new_v4());
        let html = document.to_owned();
        let handle = app.clone();
        let (sender, receiver) = tokio::sync::oneshot::channel();
        app.run_on_main_thread(move || {
            let result = (|| {
                let window = WebviewWindowBuilder::new(
                    &handle,
                    &label,
                    WebviewUrl::External("about:blank".parse().expect("constant URL")),
                )
                .inner_size(width as f64, height as f64)
                .visible(false)
                .focused(false)
                .skip_taskbar(true)
                .incognito(true)
                .disable_drag_drop_handler()
                .on_navigation(|url| url.as_str() == "about:blank")
                .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny)
                .build()
                .map_err(|error| error.to_string())?;
                let setup = user_scripts::replace(
                    window.as_ref(),
                    &[user_scripts::PageScript {
                        source: PREVIEW_SCRIPT.to_string(),
                        all_frames: false,
                        world: user_scripts::ScriptWorld::Page,
                    }],
                )
                .map_err(|error| error.to_string())
                .and_then(|_| load_html(&window, &html));
                if let Err(error) = setup {
                    let _ = window.destroy();
                    return Err(error);
                }
                Ok(window)
            })();
            let _ = sender.send(result);
        })
        .map_err(|error| error.to_string())?;
        let window = receiver.await.map_err(|error| error.to_string())??;
        let result = capture_loaded(window.as_ref(), width, height).await;
        // Destruction runs on the main thread internally, including on errors.
        let cleanup = window.destroy().map_err(|error| error.to_string());
        match (result, cleanup) {
            (Ok(_), Err(error)) => Err(format!("Could not close visualization preview: {error}")),
            (result, _) => result,
        }
    }
}

#[cfg(target_os = "macos")]
fn load_html(window: &tauri::WebviewWindow, html: &str) -> Result<(), String> {
    use objc2_foundation::NSString;
    use objc2_web_kit::WKWebView;
    let html = html.to_owned();
    window
        .with_webview(move |platform| unsafe {
            // The closure receives the live WKWebView on AppKit's main thread.
            let view: &WKWebView = &*platform.inner().cast();
            view.loadHTMLString_baseURL(&NSString::from_str(&html), None);
        })
        .map_err(|error| error.to_string())
}

#[cfg(target_os = "macos")]
async fn capture_loaded(
    webview: &tauri::Webview,
    width: u32,
    height: u32,
) -> Result<PreviewCapture, String> {
    let start = Instant::now();
    let mut last_height = 0.0;
    let mut stable_since = Instant::now();
    let measure = r#"(() => {
      const preview = window.__argmaxPreview;
      return JSON.stringify({
        ready: !!preview?.loaded && !!preview?.fontsReady && [...document.images].every(image => image.complete),
        height: Math.max(document.body?.scrollHeight || 0, document.body?.getBoundingClientRect().height || 0),
        diagnostics: preview?.diagnostics || []
      });
    })()"#;
    let mut measurements;
    loop {
        if start.elapsed() > Duration::from_secs(15) {
            return Err("Visualization preview timed out waiting for scripts, fonts, images, or stable layout.".into());
        }
        let raw = eval::eval_json(webview, measure, Duration::from_secs(1)).await;
        measurements = raw.ok().and_then(|raw| {
            // WebKit serializes the JavaScript string returned by JSON.stringify.
            let json = serde_json::from_str::<String>(&raw).unwrap_or(raw);
            serde_json::from_str::<serde_json::Value>(&json).ok()
        });
        if let Some(value) = &measurements {
            let measured = value["height"].as_f64().unwrap_or(0.0);
            if (measured - last_height).abs() > 1.0 {
                stable_since = Instant::now();
                last_height = measured;
            }
            if value["ready"].as_bool() == Some(true)
                && measured > 0.0
                && stable_since.elapsed() >= Duration::from_millis(350)
                && start.elapsed() >= Duration::from_millis(750)
            {
                break;
            }
        }
        tokio::time::sleep(Duration::from_millis(80)).await;
    }
    let image = snapshot_image::capture(
        webview,
        Some(CaptureRect {
            x: 0.0,
            y: 0.0,
            width: width as f64,
            height: last_height.min(height as f64),
        }),
        Some(720.0),
        Duration::from_secs(5),
    )
    .await
    .map_err(|error| error.to_string())?;
    let value = measurements.expect("settled measurements");
    let diagnostics = value["diagnostics"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|value| value.as_str().map(str::to_owned))
        .collect();
    Ok(PreviewCapture {
        png: image.png,
        width: image.width,
        height: image.height,
        content_height: last_height,
        diagnostics,
    })
}
