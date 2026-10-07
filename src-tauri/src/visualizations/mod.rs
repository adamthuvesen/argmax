use rmcp::schemars;
pub mod document;
pub mod preview;
pub mod store;
pub mod tools;

use serde::{Deserialize, Serialize};
use specta::Type;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize, Type, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum VisualizationFormat {
    Html,
    Image,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize, Type, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum VisualizationMode {
    Wide,
}

#[derive(Debug, Clone, Deserialize, Serialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct VisualizationArtifact {
    pub id: String,
    pub session_id: String,
    pub title: String,
    pub summary: String,
    pub format: VisualizationFormat,
    pub mode: Option<VisualizationMode>,
    pub runtime_version: u32,
    pub external_dependencies: Vec<String>,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct VisualizationWidgetState {
    #[serde(default)]
    pub model_content: serde_json::Value,
    #[serde(default)]
    pub private_content: serde_json::Value,
}

#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct VisualizationRead {
    pub artifact: VisualizationArtifact,
    pub source: String,
    pub document: String,
    pub state: VisualizationWidgetState,
    pub control_values: VisualizationControlValues,
}

/// Copies cached marker snapshots and published artifacts with retained history.
pub(crate) fn copy_history_artifacts(
    connection: &rusqlite::Connection,
    source_session: &str,
    target_session: &str,
) -> crate::error::ArgmaxResult<()> {
    let Some(path) = connection.path().filter(|path| !path.is_empty()) else {
        return Ok(());
    };
    let data_dir = std::path::Path::new(path).parent().ok_or_else(|| {
        crate::error::ArgmaxError::service(
            "VISUALIZATION_STORAGE",
            "Database has no data directory",
        )
    })?;
    store::VisualizationStore::from_data_dir(data_dir).clone_session(source_session, target_session)
}

pub type VisualizationControlValues = std::collections::BTreeMap<String, serde_json::Value>;
