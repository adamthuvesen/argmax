//! Grok Build remaining usage: the same billing proxy `/usage` calls.

use serde_json::Value;

use crate::ipc::validation::ProviderId;

use super::{
    remaining_from_used, resets_at_from_iso, window_id_for_minutes, window_label_for_minutes,
    RemainingSource, UsageLimitWindow, UsageProviderRemaining,
};

pub const BILLING_URL: &str = "https://cli-chat-proxy.grok.com/v1/billing?format=credits";

pub fn fetch(source: &dyn RemainingSource) -> UsageProviderRemaining {
    let Some(auth) = read_auth(source.home()) else {
        if source.env("XAI_API_KEY").is_some() {
            return UsageProviderRemaining::api_key(ProviderId::Grok);
        }
        return UsageProviderRemaining::unavailable(
            ProviderId::Grok,
            "Sign in with the Grok CLI to see remaining usage.",
        );
    };
    if auth.expired {
        return UsageProviderRemaining::unavailable(
            ProviderId::Grok,
            "Sign in with the Grok CLI to see remaining usage.",
        );
    }
    if auth.is_team {
        return UsageProviderRemaining::enterprise(ProviderId::Grok, "Enterprise");
    }
    let auth_header = format!("Bearer {}", auth.key);
    let headers: Vec<(&str, &str)> = vec![
        ("Authorization", auth_header.as_str()),
        ("X-XAI-Token-Auth", "xai-grok-cli"),
        ("x-userid", auth.user_id.as_str()),
        ("Accept", "application/json"),
    ];
    match source.http_get(BILLING_URL, &headers) {
        Ok((200, body)) => parse_billing(&body),
        Ok((401 | 403, _)) => UsageProviderRemaining::unavailable(
            ProviderId::Grok,
            "Sign in with the Grok CLI to see remaining usage.",
        ),
        Ok((status, _)) => UsageProviderRemaining::error(
            ProviderId::Grok,
            format!("Grok remaining usage returned HTTP {status}."),
        ),
        Err(_) => {
            UsageProviderRemaining::error(ProviderId::Grok, "Could not reach Grok remaining usage.")
        }
    }
}

struct GrokAuth {
    key: String,
    user_id: String,
    expired: bool,
    is_team: bool,
}

fn read_auth(home: &std::path::Path) -> Option<GrokAuth> {
    let text = std::fs::read_to_string(home.join(".grok/auth.json")).ok()?;
    let json: Value = serde_json::from_str(&text).ok()?;
    let obj = json.as_object()?;
    for (_issuer, entry) in obj {
        let Some(entry) = entry.as_object() else {
            continue;
        };
        let key = entry
            .get("key")
            .and_then(|v| v.as_str())
            .filter(|k| !k.is_empty())?;
        let user_id = entry
            .get("user_id")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let expired = is_expired(entry.get("expires_at"));
        let principal = entry
            .get("principal_type")
            .and_then(|v| v.as_str())
            .unwrap_or("");
        let is_team = principal.eq_ignore_ascii_case("team")
            || principal.eq_ignore_ascii_case("organization");
        return Some(GrokAuth {
            key: key.to_string(),
            user_id,
            expired,
            is_team,
        });
    }
    None
}

fn is_expired(value: Option<&Value>) -> bool {
    let Some(value) = value else {
        return false;
    };
    if let Some(secs) = value.as_i64() {
        let secs = if secs > 10_000_000_000 {
            secs / 1000
        } else {
            secs
        };
        return secs < chrono::Utc::now().timestamp();
    }
    if let Some(text) = value.as_str() {
        if let Ok(at) = chrono::DateTime::parse_from_rfc3339(text) {
            return at < chrono::Utc::now();
        }
        if let Ok(secs) = text.parse::<i64>() {
            return secs < chrono::Utc::now().timestamp();
        }
    }
    false
}

fn parse_billing(body: &Value) -> UsageProviderRemaining {
    let config = body.get("config").unwrap_or(body);
    let used = config
        .get("creditUsagePercent")
        .or_else(|| config.get("credit_usage_percent"))
        .and_then(|v| v.as_f64());
    let period = config
        .get("currentPeriod")
        .or_else(|| config.get("current_period"));
    let period_type = period
        .and_then(|p| p.get("type").or_else(|| p.get("periodType")))
        .and_then(|v| v.as_str())
        .unwrap_or("");
    // Grok bills weekly unless the period says otherwise.
    let minutes = if period_type.contains("MONTH") {
        Some(43_200)
    } else {
        Some(10_080)
    };
    let resets = period
        .and_then(|p| p.get("end"))
        .and_then(resets_at_from_iso)
        .or_else(|| {
            config
                .get("billingPeriodEnd")
                .or_else(|| config.get("billing_period_end"))
                .and_then(resets_at_from_iso)
        });
    let tier = body
        .get("subscriptionTier")
        .or_else(|| body.get("subscription_tier"))
        .and_then(|v| v.as_str())
        .map(str::to_string)
        .or_else(|| Some("SuperGrok".into()));
    let Some(used) = used else {
        return UsageProviderRemaining::unavailable(
            ProviderId::Grok,
            "Grok did not report remaining usage.",
        );
    };
    UsageProviderRemaining::subscription(
        ProviderId::Grok,
        tier,
        vec![UsageLimitWindow {
            id: window_id_for_minutes(minutes).to_string(),
            label: window_label_for_minutes(minutes).to_string(),
            remaining_percent: remaining_from_used(used),
            resets_at: resets,
        }],
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::usage::remaining::tests::FakeSource;
    use crate::usage::remaining::UsagePlanKind;
    use serde_json::json;

    #[test]
    fn weekly_percent_and_period_end() {
        let dir = tempfile::tempdir().expect("temp");
        std::fs::create_dir_all(dir.path().join(".grok")).expect("dir");
        std::fs::write(
            dir.path().join(".grok/auth.json"),
            r#"{"https://auth.x.ai::abc":{"key":"k","user_id":"u","expires_at":"2099-01-01T00:00:00Z","principal_type":"user"}}"#,
        )
        .expect("auth");
        let source = FakeSource::new(dir.path().to_path_buf()).with_http(
            BILLING_URL,
            200,
            json!({
                "config": {
                    "creditUsagePercent": 38.0,
                    "currentPeriod": {
                        "type": "USAGE_PERIOD_TYPE_WEEKLY",
                        "end": "2026-09-13T00:00:00Z"
                    }
                },
                "subscriptionTier": "SuperGrok"
            }),
        );
        let row = fetch(&source);
        assert_eq!(row.kind, UsagePlanKind::Subscription);
        assert_eq!(row.plan_label.as_deref(), Some("SuperGrok"));
        assert_eq!(row.windows[0].label, "Weekly");
        assert!((row.windows[0].remaining_percent - 62.0).abs() < 0.01);
    }
}
