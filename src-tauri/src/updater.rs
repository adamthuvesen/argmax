use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

use tauri::{AppHandle, Manager, Runtime};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use tauri_plugin_updater::UpdaterExt;

use crate::error::{ArgmaxError, ArgmaxResult};

type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AvailableUpdate {
    pub version: String,
    pub body: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum UpdateCheckResult {
    UpToDate,
    Available(AvailableUpdate),
}

pub trait UpdateChecker: Send + Sync + 'static {
    fn check(&self) -> BoxFuture<'_, ArgmaxResult<Option<AvailableUpdate>>>;
}

pub trait UpdateDialog: Send + Sync + 'static {
    fn show_info(&self, title: &str, message: &str);
    fn show_error(&self, title: &str, message: &str);
}

pub struct UpdateService<C: UpdateChecker, D: UpdateDialog> {
    checker: C,
    dialog: D,
}

impl<C: UpdateChecker, D: UpdateDialog> UpdateService<C, D> {
    pub fn new(checker: C, dialog: D) -> Self {
        Self { checker, dialog }
    }

    pub async fn check_on_user_request(&self) -> ArgmaxResult<UpdateCheckResult> {
        match self.checker.check().await {
            Ok(Some(update)) => {
                self.dialog.show_info(
                    "Update available",
                    &format!(
                        "Argmax {} is available from the release feed.",
                        update.version
                    ),
                );
                Ok(UpdateCheckResult::Available(update))
            }
            Ok(None) => {
                self.dialog.show_info("Updates", "Argmax is up to date.");
                Ok(UpdateCheckResult::UpToDate)
            }
            Err(error) => {
                self.dialog
                    .show_error("Update check failed", "Argmax could not check for updates.");
                Err(error)
            }
        }
    }
}

pub type TauriUpdateService<R> = UpdateService<TauriUpdateChecker<R>, TauriUpdateDialog<R>>;

pub fn tauri_update_service<R: Runtime>(app: AppHandle<R>) -> Arc<TauriUpdateService<R>> {
    Arc::new(UpdateService::new(
        TauriUpdateChecker::new(app.clone()),
        TauriUpdateDialog::new(app),
    ))
}

#[derive(Clone)]
pub struct TauriUpdateChecker<R: Runtime> {
    app: AppHandle<R>,
}

impl<R: Runtime> TauriUpdateChecker<R> {
    pub fn new(app: AppHandle<R>) -> Self {
        Self { app }
    }
}

impl<R: Runtime> UpdateChecker for TauriUpdateChecker<R> {
    fn check(&self) -> BoxFuture<'_, ArgmaxResult<Option<AvailableUpdate>>> {
        Box::pin(async move {
            let updater = self
                .app
                .updater()
                .map_err(|error| ArgmaxError::service("UPDATER_INIT_FAILED", error.to_string()))?;
            let update = updater
                .check()
                .await
                .map_err(|error| ArgmaxError::service("UPDATER_CHECK_FAILED", error.to_string()))?;

            Ok(update.map(|update| AvailableUpdate {
                version: update.version,
                body: update.body,
            }))
        })
    }
}

#[derive(Clone)]
pub struct TauriUpdateDialog<R: Runtime> {
    app: AppHandle<R>,
}

impl<R: Runtime> TauriUpdateDialog<R> {
    pub fn new(app: AppHandle<R>) -> Self {
        Self { app }
    }
}

impl<R: Runtime> UpdateDialog for TauriUpdateDialog<R> {
    fn show_info(&self, title: &str, message: &str) {
        show_message(&self.app, MessageDialogKind::Info, title, message);
    }

    fn show_error(&self, title: &str, message: &str) {
        show_message(&self.app, MessageDialogKind::Error, title, message);
    }
}

pub fn run_menu_update_check<R: Runtime>(app: AppHandle<R>) {
    tauri::async_runtime::spawn(async move {
        let service = tauri_update_service(app);
        if let Err(error) = service.check_on_user_request().await {
            tracing::warn!(?error, "user-triggered update check failed");
        }
    });
}

fn show_message<R: Runtime>(
    app: &AppHandle<R>,
    kind: MessageDialogKind,
    title: &str,
    message: &str,
) {
    let mut builder = app
        .dialog()
        .message(message)
        .title(title)
        .kind(kind)
        .buttons(MessageDialogButtons::Ok);
    if let Some(window) = app.get_webview_window("main") {
        builder = builder.parent(&window);
    }
    builder.show(|_| {});
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    struct StubChecker {
        results: Mutex<Vec<ArgmaxResult<Option<AvailableUpdate>>>>,
    }

    impl StubChecker {
        fn new(results: Vec<ArgmaxResult<Option<AvailableUpdate>>>) -> Self {
            Self {
                results: Mutex::new(results),
            }
        }
    }

    impl UpdateChecker for StubChecker {
        fn check(&self) -> BoxFuture<'_, ArgmaxResult<Option<AvailableUpdate>>> {
            Box::pin(async move { self.results.lock().expect("results poisoned").remove(0) })
        }
    }

    #[derive(Default)]
    struct StubDialog {
        messages: Mutex<Vec<(String, String, &'static str)>>,
    }

    impl UpdateDialog for Arc<StubDialog> {
        fn show_info(&self, title: &str, message: &str) {
            self.messages.lock().expect("messages poisoned").push((
                title.to_string(),
                message.to_string(),
                "info",
            ));
        }

        fn show_error(&self, title: &str, message: &str) {
            self.messages.lock().expect("messages poisoned").push((
                title.to_string(),
                message.to_string(),
                "error",
            ));
        }
    }

    #[tokio::test]
    async fn manual_check_reports_up_to_date() {
        let dialog = Arc::new(StubDialog::default());
        let service = UpdateService::new(StubChecker::new(vec![Ok(None)]), dialog.clone());

        let result = service
            .check_on_user_request()
            .await
            .expect("check succeeds");

        assert_eq!(result, UpdateCheckResult::UpToDate);
        assert_eq!(
            *dialog.messages.lock().expect("messages poisoned"),
            vec![(
                "Updates".to_string(),
                "Argmax is up to date.".to_string(),
                "info"
            )]
        );
    }

    #[tokio::test]
    async fn manual_check_reports_available_update() {
        let dialog = Arc::new(StubDialog::default());
        let update = AvailableUpdate {
            version: "0.3.0".to_string(),
            body: Some("Release notes".to_string()),
        };
        let service = UpdateService::new(
            StubChecker::new(vec![Ok(Some(update.clone()))]),
            dialog.clone(),
        );

        let result = service
            .check_on_user_request()
            .await
            .expect("check succeeds");

        assert_eq!(result, UpdateCheckResult::Available(update));
        let messages = dialog.messages.lock().expect("messages poisoned");
        assert_eq!(messages.len(), 1);
        assert_eq!(messages[0].0, "Update available");
        assert!(messages[0].1.contains("0.3.0"));
        assert_eq!(messages[0].2, "info");
    }

    #[tokio::test]
    async fn manual_check_surfaces_errors() {
        let dialog = Arc::new(StubDialog::default());
        let service = UpdateService::new(
            StubChecker::new(vec![Err(ArgmaxError::service(
                "UPDATER_TEST",
                "network failed",
            ))]),
            dialog.clone(),
        );

        let error = service
            .check_on_user_request()
            .await
            .expect_err("check fails");

        assert!(error.to_string().contains("network failed"));
        assert_eq!(
            *dialog.messages.lock().expect("messages poisoned"),
            vec![(
                "Update check failed".to_string(),
                "Argmax could not check for updates.".to_string(),
                "error"
            )]
        );
    }
}
