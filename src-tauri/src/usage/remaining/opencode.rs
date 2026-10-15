//! OpenCode remaining usage is the credit left on the gateway every OpenCode
//! model in the picker bills to: OpenRouter's key, or the Vercel AI Gateway
//! team's balance, whichever Settings → Agents selects.

use serde_json::Value;

use crate::ipc::validation::ProviderId;
use crate::providers::opencode_gateway::OpencodeGateway;

use super::{RemainingSource, UsageLimitWindow, UsageProviderRemaining};

pub const USAGE_URL: &str = "https://openrouter.ai/api/v1/key";
pub const VERCEL_CREDITS_URL: &str = "https://ai-gateway.vercel.sh/v1/credits";
const PLAN_LABEL: &str = "OpenRouter";
const VERCEL_PLAN_LABEL: &str = "Vercel AI Gateway";

pub fn fetch(source: &dyn RemainingSource) -> UsageProviderRemaining {
    let (gateway, saved_key) = source.opencode_gateway();
    match gateway {
        OpencodeGateway::Openrouter => fetch_openrouter(source, saved_key),
        OpencodeGateway::Vercel => fetch_vercel(source, saved_key),
    }
}

fn fetch_openrouter(
    source: &dyn RemainingSource,
    saved_key: Option<String>,
) -> UsageProviderRemaining {
    let Some(key) = saved_key.or_else(|| gateway_key(source, "OPENROUTER_API_KEY", "openrouter"))
    else {
        return UsageProviderRemaining::unavailable(
            ProviderId::Opencode,
            "OpenRouter is not signed in. Add a key in Settings → Agents, or run opencode auth login and pick OpenRouter.",
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

fn fetch_vercel(source: &dyn RemainingSource, saved_key: Option<String>) -> UsageProviderRemaining {
    let Some(key) = saved_key.or_else(|| gateway_key(source, "AI_GATEWAY_API_KEY", "vercel"))
    else {
        return UsageProviderRemaining::unavailable(
            ProviderId::Opencode,
            "Vercel AI Gateway is not signed in. Add a key in Settings → Agents, or run opencode auth login and pick Vercel AI Gateway.",
        );
    };
    match source.http_get(
        VERCEL_CREDITS_URL,
        &[
            ("Authorization", &format!("Bearer {key}")),
            ("Accept", "application/json"),
        ],
    ) {
        Ok((200, body)) => parse_vercel_credits(&body),
        Ok((401 | 403, _)) => UsageProviderRemaining::unavailable(
            ProviderId::Opencode,
            "Vercel AI Gateway rejected the API key.",
        ),
        Ok((status, _)) => UsageProviderRemaining::error(
            ProviderId::Opencode,
            format!("Vercel AI Gateway credits returned HTTP {status}."),
        ),
        Err(_) => UsageProviderRemaining::error(
            ProviderId::Opencode,
            "Could not reach Vercel AI Gateway credits.",
        ),
    }
}

/// The key OpenCode itself would use without one saved in Argmax: the
/// gateway's environment variable first, as OpenCode reads it, then the one
/// `opencode auth login` stored.
fn gateway_key(source: &dyn RemainingSource, env_name: &str, auth_id: &str) -> Option<String> {
    if let Some(key) = source.env(env_name) {
        return Some(key);
    }
    let auth = read_auth_json(source.home())?;
    auth.get(auth_id)
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

/// Vercel reports a team balance with no allowance to measure it against
/// (`{"balance":"95.50","total_used":"4.50"}`, both USD strings), so the row
/// says what is left and what has been spent.
fn parse_vercel_credits(body: &Value) -> UsageProviderRemaining {
    let amount = |field: &str| {
        body.get(field).and_then(|value| {
            value
                .as_f64()
                .or_else(|| value.as_str().and_then(|text| text.parse().ok()))
        })
    };
    let message = match (amount("balance"), amount("total_used")) {
        (Some(balance), Some(used)) => format!("${balance:.2} left, ${used:.2} spent."),
        (Some(balance), None) => format!("${balance:.2} left."),
        _ => {
            return UsageProviderRemaining::error(
                ProviderId::Opencode,
                "Vercel AI Gateway credits had no balance.",
            )
        }
    };
    UsageProviderRemaining {
        plan_label: Some(VERCEL_PLAN_LABEL.into()),
        message: Some(message),
        ..UsageProviderRemaining::api_key(ProviderId::Opencode)
    }
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
    fn a_key_saved_in_argmax_wins_over_opencode_auth() {
        let dir = tempfile::tempdir().expect("temp");
        let mut source = FakeSource::new(dir.path().to_path_buf()).with_http(
            USAGE_URL,
            200,
            json!({ "data": { "limit": 10, "limit_remaining": 5, "usage": 5 } }),
        );
        source.opencode_key = Some("sk-or-v1-saved-in-argmax".into());
        let row = fetch(&source);
        assert_eq!(row.kind, UsagePlanKind::Subscription);
    }

    #[test]
    fn vercel_reports_balance_and_spend() {
        let dir = tempfile::tempdir().expect("temp");
        let mut source = FakeSource::new(dir.path().to_path_buf()).with_http(
            VERCEL_CREDITS_URL,
            200,
            json!({ "balance": "95.50", "total_used": "4.50" }),
        );
        source.opencode_gateway = OpencodeGateway::Vercel;
        source.opencode_key = Some("vck_0123456789abcdef".into());
        let row = fetch(&source);
        assert_eq!(row.kind, UsagePlanKind::ApiKey);
        assert_eq!(row.plan_label.as_deref(), Some("Vercel AI Gateway"));
        assert_eq!(row.message.as_deref(), Some("$95.50 left, $4.50 spent."));
    }

    #[test]
    fn vercel_without_a_key_names_vercel() {
        let dir = tempfile::tempdir().expect("temp");
        let mut source = FakeSource::new(dir.path().to_path_buf());
        source.opencode_gateway = OpencodeGateway::Vercel;
        let row = fetch(&source);
        assert_eq!(row.kind, UsagePlanKind::Unavailable);
        assert!(row
            .message
            .as_deref()
            .unwrap_or("")
            .contains("Vercel AI Gateway"));
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
