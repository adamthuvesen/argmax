//! OpenCode remaining usage is the credit left on its OpenRouter key, the one
//! account every OpenCode model in the picker bills to.

use serde_json::Value;

use crate::ipc::validation::ProviderId;

use super::{RemainingSource, UsageLimitWindow, UsageProviderRemaining};

pub const USAGE_URL: &str = "https://openrouter.ai/api/v1/key";
const PLAN_LABEL: &str = "OpenRouter";

pub fn fetch(source: &dyn RemainingSource) -> UsageProviderRemaining {
    let Some(key) = openrouter_key(source) else {
        return UsageProviderRemaining::unavailable(
            ProviderId::Opencode,
            "OpenRouter is not signed in. Run opencode auth login and pick OpenRouter.",
        );
    };
    match source.http_get(
        USAGE_URL,
        &[
            ("Authorization", &format!("Bearer {key}")),
            ("Accept", "application/json"),
        ],
    ) {
        Ok((200, body)) => parse_key_usage(&body),
        Ok((401 | 403, _)) => UsageProviderRemaining::unavailable(
            ProviderId::Opencode,
            "OpenRouter rejected the API key.",
        ),
        Ok((status, _)) => UsageProviderRemaining::error(
            ProviderId::Opencode,
            format!("OpenRouter key usage returned HTTP {status}."),
        ),
        Err(_) => UsageProviderRemaining::error(
            ProviderId::Opencode,
            "Could not reach OpenRouter key usage.",
        ),
    }
}

/// The key OpenCode itself uses: `OPENROUTER_API_KEY` first, as OpenCode
/// reads it, then the one `opencode auth login` stored.
fn openrouter_key(source: &dyn RemainingSource) -> Option<String> {
    if let Some(key) = source.env("OPENROUTER_API_KEY") {
        return Some(key);
    }
    let auth = read_auth_json(source.home())?;
    auth.get("openrouter")
        .and_then(|entry| entry.get("key"))
        .and_then(|v| v.as_str())
        .filter(|key| !key.is_empty())
        .map(str::to_string)
}

fn read_auth_json(home: &std::path::Path) -> Option<Value> {
    let candidates = [
        home.join(".local/share/opencode/auth.json"),
        home.join("Library/Application Support/opencode/auth.json"),
    ];
    for path in candidates {
        if let Ok(text) = std::fs::read_to_string(path) {
            if let Ok(json) = serde_json::from_str::<Value>(&text) {
                return Some(json);
            }
        }
    }
    None
}

/// A key with a credit limit reads as one meter. A key without one has no
/// allowance to measure, so the row says what it has spent instead.
fn parse_key_usage(body: &Value) -> UsageProviderRemaining {
    let data = body.get("data").unwrap_or(body);
    let limit = data.get("limit").and_then(Value::as_f64);
    let remaining = data.get("limit_remaining").and_then(Value::as_f64);
    match (limit, remaining) {
        (Some(limit), Some(remaining)) if limit > 0.0 => UsageProviderRemaining::subscription(
            ProviderId::Opencode,
            Some(PLAN_LABEL.into()),
            vec![UsageLimitWindow {
                id: "credit".into(),
                label: format!("Credit, ${remaining:.2} of ${limit:.2}"),
                remaining_percent: (remaining / limit * 100.0).clamp(0.0, 100.0),
                resets_at: None,
            }],
        ),
        _ => {
            let spent = data.get("usage").and_then(Value::as_f64).unwrap_or(0.0);
            UsageProviderRemaining {
                plan_label: Some(PLAN_LABEL.into()),
                message: Some(format!("${spent:.2} spent. The key has no credit limit.")),
                ..UsageProviderRemaining::api_key(ProviderId::Opencode)
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::usage::remaining::tests::FakeSource;
    use crate::usage::remaining::UsagePlanKind;
    use serde_json::json;

    #[test]
    fn a_limited_key_reads_as_one_credit_meter() {
        let row = parse_key_usage(&json!({
            "data": { "limit": 125, "limit_remaining": 25, "usage": 100, "limit_reset": null }
        }));
        assert_eq!(row.kind, UsagePlanKind::Subscription);
        assert_eq!(row.plan_label.as_deref(), Some("OpenRouter"));
        assert_eq!(row.windows.len(), 1);
        assert_eq!(row.windows[0].label, "Credit, $25.00 of $125.00");
        assert!((row.windows[0].remaining_percent - 20.0).abs() < 0.01);
    }

    #[test]
    fn an_unlimited_key_reports_its_spend() {
        let row = parse_key_usage(&json!({
            "data": { "limit": null, "limit_remaining": null, "usage": 12.5 }
        }));
        assert_eq!(row.kind, UsagePlanKind::ApiKey);
        assert!(row.windows.is_empty());
        assert_eq!(
            row.message.as_deref(),
            Some("$12.50 spent. The key has no credit limit.")
        );
    }

    #[test]
    fn without_openrouter_key() {
        let dir = tempfile::tempdir().expect("temp");
        let source = FakeSource::new(dir.path().to_path_buf());
        let row = fetch(&source);
        assert_eq!(row.kind, UsagePlanKind::Unavailable);
        assert!(row.message.as_deref().unwrap_or("").contains("OpenRouter"));
    }
}
