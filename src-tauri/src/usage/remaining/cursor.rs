//! Cursor remaining numbers need unofficial dashboard APIs. v1 only labels
//! Teams/Enterprise from the local CLI login.

use serde_json::Value;

use crate::ipc::validation::ProviderId;

use super::{RemainingSource, UsageProviderRemaining};

/// Every row points at the same place, since neither login exposes a number.
const WHERE_IT_LIVES: &str = "Cursor remaining lives on the Spending dashboard.";
const SPENDING_DASHBOARD_URL: &str = "https://cursor.com/dashboard/spending";

pub fn fetch(source: &dyn RemainingSource) -> UsageProviderRemaining {
    if is_team_login(source.home()) {
        let mut row = UsageProviderRemaining::enterprise(ProviderId::Cursor, "Teams");
        row.message = Some(WHERE_IT_LIVES.to_string());
        row.message_url = Some(SPENDING_DASHBOARD_URL.to_string());
        return row;
    }
    let mut row = UsageProviderRemaining::unavailable(ProviderId::Cursor, WHERE_IT_LIVES);
    row.message_url = Some(SPENDING_DASHBOARD_URL.to_string());
    row
}

fn is_team_login(home: &std::path::Path) -> bool {
    let Ok(text) = std::fs::read_to_string(home.join(".cursor/cli-config.json")) else {
        return false;
    };
    let Ok(json) = serde_json::from_str::<Value>(&text) else {
        return false;
    };
    let Some(info) = json.get("authInfo") else {
        return false;
    };
    info.get("teamId").is_some()
        || info
            .get("teamName")
            .and_then(|v| v.as_str())
            .is_some_and(|name| !name.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::usage::remaining::tests::FakeSource;
    use crate::usage::remaining::UsagePlanKind;

    #[test]
    fn team_is_enterprise_with_no_windows() {
        let dir = tempfile::tempdir().expect("temp");
        std::fs::create_dir_all(dir.path().join(".cursor")).expect("dir");
        std::fs::write(
            dir.path().join(".cursor/cli-config.json"),
            r#"{"authInfo":{"teamId":1,"teamName":"Mentimeter"}}"#,
        )
        .expect("config");
        let source = FakeSource::new(dir.path().to_path_buf());
        let row = fetch(&source);
        assert_eq!(row.kind, UsagePlanKind::Enterprise);
        assert_eq!(row.plan_label.as_deref(), Some("Teams"));
        assert!(row.windows.is_empty());
        assert_eq!(
            row.message_url.as_deref(),
            Some(SPENDING_DASHBOARD_URL)
        );
    }

    #[test]
    fn individual_points_at_the_dashboard() {
        let dir = tempfile::tempdir().expect("temp");
        let source = FakeSource::new(dir.path().to_path_buf());
        let row = fetch(&source);
        assert_eq!(row.kind, UsagePlanKind::Unavailable);
        assert!(row.message.as_deref().unwrap_or("").contains("Spending"));
        assert_eq!(
            row.message_url.as_deref(),
            Some(SPENDING_DASHBOARD_URL)
        );
    }
}
