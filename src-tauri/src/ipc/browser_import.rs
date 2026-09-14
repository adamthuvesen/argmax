use serde::Deserialize;
use specta::Type;

use crate::browser::chrome_history::{self, ChromeHistoryImport, ChromeProfile};
use crate::error::{ArgmaxError, ArgmaxResult};

#[derive(Debug, Clone, Deserialize, Type)]
#[serde(deny_unknown_fields)]
pub struct ChromeProfilesInput {}

#[derive(Debug, Clone, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ImportChromeHistoryInput {
    pub profile_id: String,
}

#[tauri::command(rename = "browser:chrome-profiles")]
#[specta::specta]
pub async fn browser_chrome_profiles(
    input: ChromeProfilesInput,
) -> ArgmaxResult<Vec<ChromeProfile>> {
    let _ = input;
    tauri::async_runtime::spawn_blocking(|| {
        let root = chrome_history::default_profile_root()?;
        chrome_history::discover_profiles(&root)
    })
    .await
    .map_err(|error| ArgmaxError::service("CHROME_PROFILE_READ_JOIN", error.to_string()))?
}

#[tauri::command(rename = "browser:import-chrome-history")]
#[specta::specta]
pub async fn browser_import_chrome_history(
    input: ImportChromeHistoryInput,
) -> ArgmaxResult<ChromeHistoryImport> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = chrome_history::default_profile_root()?;
        chrome_history::import_history(&root, &input.profile_id)
    })
    .await
    .map_err(|error| ArgmaxError::service("CHROME_HISTORY_READ_JOIN", error.to_string()))?
}
