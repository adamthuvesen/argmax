use chrono::Utc;
use serde::Serialize;
use specta::Type;

use super::inputs::*;

#[derive(Debug, Clone, PartialEq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct HealthPingOutput {
    pub ok: bool,
    pub timestamp: String,
}

#[tauri::command(rename = "health:ping")]
#[specta::specta]
pub fn health_ping(_input: HealthPingInput) -> HealthPingOutput {
    HealthPingOutput {
        ok: true,
        timestamp: Utc::now().to_rfc3339(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn health_ping_returns_smoke_payload() {
        let result = health_ping(HealthPingInput {});
        assert!(result.ok);
        assert!(chrono::DateTime::parse_from_rfc3339(&result.timestamp).is_ok());
    }
}
