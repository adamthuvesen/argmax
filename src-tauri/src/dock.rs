use std::sync::{Arc, Mutex};

use tauri::{AppHandle, Manager, Runtime, Window, WindowEvent};

use crate::error::{ArgmaxError, ArgmaxResult};
use crate::persistence::dashboard::count_attention;
use crate::persistence::database::Database;

pub trait DockBadgeSink: Send + Sync + 'static {
    fn set_badge(&self, text: &str) -> ArgmaxResult<()>;
}

pub type AttentionCounter = Arc<dyn Fn() -> ArgmaxResult<i64> + Send + Sync>;

pub struct DockBadgeService<S: DockBadgeSink> {
    sink: S,
    count_attention: AttentionCounter,
    last_text: Mutex<String>,
}

impl<S: DockBadgeSink> DockBadgeService<S> {
    pub fn new(sink: S, count_attention: AttentionCounter) -> Self {
        Self {
            sink,
            count_attention,
            last_text: Mutex::new(String::new()),
        }
    }

    pub fn update(&self) -> ArgmaxResult<bool> {
        let total = (self.count_attention)()?;
        let text = format_badge(total);
        let mut last_text = self.last_text.lock().expect("dock badge text poisoned");
        if *last_text == text {
            return Ok(false);
        }
        self.sink.set_badge(&text)?;
        *last_text = text;
        Ok(true)
    }

    pub fn clear(&self) -> ArgmaxResult<bool> {
        let mut last_text = self.last_text.lock().expect("dock badge text poisoned");
        if last_text.is_empty() {
            return Ok(false);
        }
        self.sink.set_badge("")?;
        last_text.clear();
        Ok(true)
    }
}

pub struct TauriDockBadgeSink<R: Runtime> {
    app: AppHandle<R>,
}

impl<R: Runtime> TauriDockBadgeSink<R> {
    pub fn new(app: AppHandle<R>) -> Self {
        Self { app }
    }
}

impl<R: Runtime> DockBadgeSink for TauriDockBadgeSink<R> {
    fn set_badge(&self, text: &str) -> ArgmaxResult<()> {
        set_app_badge(&self.app, text)
    }
}

pub fn database_attention_counter(database: Arc<Database>) -> AttentionCounter {
    Arc::new(move || {
        let connection = database.connection();
        count_attention(&connection).map(|counts| counts.total)
    })
}

pub fn clear_badge_on_focus<R: Runtime>(window: &Window<R>, event: &WindowEvent) {
    if matches!(event, WindowEvent::Focused(true)) {
        clear_window_badge(window);
    }
}

fn format_badge(total: i64) -> String {
    if total <= 0 {
        String::new()
    } else if total > 99 {
        "99+".to_string()
    } else {
        total.to_string()
    }
}

#[cfg(target_os = "macos")]
fn set_app_badge<R: Runtime>(app: &AppHandle<R>, text: &str) -> ArgmaxResult<()> {
    let label = if text.is_empty() {
        None
    } else {
        Some(text.to_string())
    };
    app.get_webview_window("main")
        .ok_or_else(|| ArgmaxError::service("DOCK_BADGE_WINDOW_MISSING", "main window missing"))?
        .set_badge_label(label)
        .map_err(|error| ArgmaxError::service("DOCK_BADGE_FAILED", error.to_string()))
}

#[cfg(not(target_os = "macos"))]
fn set_app_badge<R: Runtime>(_app: &AppHandle<R>, _text: &str) -> ArgmaxResult<()> {
    Ok(())
}

#[cfg(target_os = "macos")]
fn clear_window_badge<R: Runtime>(window: &Window<R>) {
    if let Err(error) = window.set_badge_label(None) {
        tracing::warn!(?error, "failed to clear dock badge on focus");
    }
}

#[cfg(not(target_os = "macos"))]
fn clear_window_badge<R: Runtime>(_window: &Window<R>) {}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Default)]
    struct StubSink {
        calls: Mutex<Vec<String>>,
    }

    impl StubSink {
        fn calls(&self) -> Vec<String> {
            self.calls.lock().expect("calls poisoned").clone()
        }
    }

    impl DockBadgeSink for Arc<StubSink> {
        fn set_badge(&self, text: &str) -> ArgmaxResult<()> {
            self.calls
                .lock()
                .expect("calls poisoned")
                .push(text.to_string());
            Ok(())
        }
    }

    #[test]
    fn sets_badge_text_to_attention_count() {
        let sink = Arc::new(StubSink::default());
        let service = service_with_total(sink.clone(), 3);

        assert!(service.update().expect("update ok"));

        assert_eq!(sink.calls(), ["3"]);
    }

    #[test]
    fn clears_badge_when_total_is_zero() {
        let sink = Arc::new(StubSink::default());
        let total = Arc::new(Mutex::new(2));
        let service = DockBadgeService::new(sink.clone(), {
            let total = total.clone();
            Arc::new(move || Ok(*total.lock().expect("total poisoned")))
        });

        service.update().expect("first update ok");
        *total.lock().expect("total poisoned") = 0;
        service.update().expect("second update ok");

        assert_eq!(sink.calls(), ["2", ""]);
    }

    #[test]
    fn caps_high_counts_at_99_plus() {
        let sink = Arc::new(StubSink::default());
        let service = service_with_total(sink.clone(), 150);

        service.update().expect("update ok");

        assert_eq!(sink.calls(), ["99+"]);
    }

    #[test]
    fn skips_redundant_updates() {
        let sink = Arc::new(StubSink::default());
        let service = service_with_total(sink.clone(), 4);

        service.update().expect("first update ok");
        assert!(!service.update().expect("second update ok"));
        assert!(!service.update().expect("third update ok"));

        assert_eq!(sink.calls(), ["4"]);
    }

    #[test]
    fn clear_skips_redundant_empty_badge() {
        let sink = Arc::new(StubSink::default());
        let service = service_with_total(sink.clone(), 4);

        assert!(!service.clear().expect("empty clear ok"));
        service.update().expect("update ok");
        assert!(service.clear().expect("clear ok"));
        assert!(!service.clear().expect("second clear ok"));

        assert_eq!(sink.calls(), ["4", ""]);
    }

    fn service_with_total(sink: Arc<StubSink>, total: i64) -> DockBadgeService<Arc<StubSink>> {
        DockBadgeService::new(sink, Arc::new(move || Ok(total)))
    }
}
