//! OpenCode remaining usage is the Go subscription, not BYOK or Zen credits.

use serde_json::Value;

use crate::ipc::validation::ProviderId;

use super::{
    remaining_from_used, resets_at_from_epoch, resets_at_from_iso, RemainingSource,
    UsageLimitWindow, UsageProviderRemaining,
};

pub const USAGE_URL: &str = "https://opencode.ai/zen/go/v1/usage";

pub fn fetch(source: &dyn RemainingSource) -> UsageProviderRemaining {
    let Some(key) = go_key(source) else {
        return UsageProviderRemaining::unavailable(
            ProviderId::Opencode,
            "OpenCode has no subscription quota unless you use OpenCode Go.",
        );
    };
    match source.http_get(
        USAGE_URL,
        &[
            ("Authorization", &format!("Bearer {key}")),
            ("Accept", "application/json"),
        ],
    ) {
        Ok((200, body)) => parse_go_usage(&body),
        Ok((401 | 403, _)) => UsageProviderRemaining::unavailable(
            ProviderId::Opencode,
            "OpenCode Go is not signed in.",
        ),
        Ok((status, _)) => UsageProviderRemaining::error(
            ProviderId::Opencode,
            format!("OpenCode Go remaining usage returned HTTP {status}."),
        ),
        Err(_) => UsageProviderRemaining::error(
            ProviderId::Opencode,
            "Could not reach OpenCode Go remaining usage.",
        ),
    }
}

fn go_key(source: &dyn RemainingSource) -> Option<String> {
    if let Some(key) = source.env("OPENCODE_API_KEY") {
        return Some(key);
    }
    let auth = read_auth_json(source.home())?;
    auth.get("opencode-go")
        .or_else(|| auth.get("opencodeGo"))
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

pub fn parse_go_usage(body: &Value) -> UsageProviderRemaining {
    let usage = body.get("usage").unwrap_or(body);
    let mut windows = Vec::new();
    push_go_window(
        &mut windows,
        usage,
        &["rolling", "rollingUsage"],
        "five_hour",
        "5-hour",
    );
    push_go_window(
        &mut windows,
        usage,
        &["weekly", "weeklyUsage"],
        "seven_day",
        "Weekly",
    );
    push_go_window(
        &mut windows,
        usage,
        &["monthly", "monthlyUsage"],
        "monthly",
        "Monthly",
    );
    if windows.is_empty() {
        return UsageProviderRemaining::unavailable(
            ProviderId::Opencode,
            "OpenCode Go did not report remaining usage.",
        );
    }
    UsageProviderRemaining::subscription(ProviderId::Opencode, Some("OpenCode Go".into()), windows)
}

fn push_go_window(
    windows: &mut Vec<UsageLimitWindow>,
    usage: &Value,
    keys: &[&str],
    id: &str,
    label: &str,
) {
    let mut raw = None;
    for key in keys {
        if let Some(value) = usage.get(*key) {
            raw = Some(value);
            break;
        }
    }
    let Some(raw) = raw else {
        return;
    };
    if raw
        .get("status")
        .and_then(|v| v.as_str())
        .is_some_and(|status| status != "ok")
    {
        return;
    }
    let used = raw
        .get("percent")
        .or_else(|| raw.get("usagePercent"))
        .and_then(|v| v.as_f64());
    let Some(used) = used else {
        return;
    };
    let resets = raw
        .get("resetsAt")
        .or_else(|| raw.get("resets_at"))
        .and_then(resets_at_from_iso)
        .or_else(|| {
            raw.get("resetInSec")
                .and_then(|v| v.as_i64())
                .map(|secs| chrono::Utc::now() + chrono::Duration::seconds(secs))
                .map(|at| at.to_rfc3339())
        })
        .or_else(|| raw.get("resetInSec").and_then(resets_at_from_epoch));
    windows.push(UsageLimitWindow {
        id: id.to_string(),
        label: label.to_string(),
        remaining_percent: remaining_from_used(used),
        resets_at: resets,
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::usage::remaining::tests::FakeSource;
    use crate::usage::remaining::UsagePlanKind;
    use serde_json::json;

    #[test]
    fn nested_and_flat_shapes() {
        let nested = json!({
            "usage": {
                "rolling": { "status": "ok", "percent": 4, "resetsAt": "2026-09-06T16:27:38Z" },
                "weekly": { "status": "ok", "percent": 3, "resetsAt": "2026-09-13T00:00:00Z" },
                "monthly": { "status": "ok", "percent": 1, "resetsAt": "2026-10-01T00:00:00Z" }
            }
        });
        let row = parse_go_usage(&nested);
        assert_eq!(row.windows.len(), 3);
        assert_eq!(row.windows[0].label, "5-hour");
        assert!((row.windows[0].remaining_percent - 96.0).abs() < 0.01);

        let flat = json!({
            "rollingUsage": { "status": "ok", "usagePercent": 10, "resetInSec": 3600 },
            "weeklyUsage": { "status": "ok", "usagePercent": 20, "resetInSec": 86400 },
            "monthlyUsage": { "status": "ok", "usagePercent": 30, "resetInSec": 604800 }
        });
        let row = parse_go_usage(&flat);
        assert_eq!(row.windows.len(), 3);
        assert_eq!(row.plan_label.as_deref(), Some("OpenCode Go"));
    }

    #[test]
    fn without_go_key() {
        let dir = tempfile::tempdir().expect("temp");
        let source = FakeSource::new(dir.path().to_path_buf());
        let row = fetch(&source);
        assert_eq!(row.kind, UsagePlanKind::Unavailable);
        assert!(row.message.as_deref().unwrap_or("").contains("OpenCode Go"));
    }
}
