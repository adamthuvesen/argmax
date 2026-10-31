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
