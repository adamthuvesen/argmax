//! Claude remaining usage: plan from `~/.claude.json`, remaining from the
//! OAuth usage endpoint Claude Code itself calls for `/usage`.

use serde_json::Value;

use crate::ipc::validation::ProviderId;

use super::{
    remaining_from_used, resets_at_from_iso, RemainingSource, UsageLimitWindow,
    UsageProviderRemaining,
};

pub const USAGE_URL: &str = "https://api.anthropic.com/api/oauth/usage";
const KEYCHAIN_SERVICE: &str = "Claude Code-credentials";

pub fn fetch(source: &dyn RemainingSource) -> UsageProviderRemaining {
    let account = read_oauth_account(source);
    if account.as_ref().is_some_and(is_enterprise) {
        return UsageProviderRemaining::enterprise(ProviderId::Claude, "Enterprise");
    }
    if looks_like_api_key_only(source, account.as_ref()) {
        return UsageProviderRemaining::api_key(ProviderId::Claude);
    }
    let plan_label = account.as_ref().and_then(plan_label);
    let Some(token) = claude_access_token(source) else {
        return UsageProviderRemaining::unavailable(
            ProviderId::Claude,
            "Sign in with the Claude CLI to see remaining usage.",
        );
    };
    let mut row = match source.http_get(
        USAGE_URL,
        &[
            ("Authorization", &format!("Bearer {token}")),
            ("anthropic-beta", "oauth-2025-04-20"),
            ("Accept", "application/json"),
            // This endpoint buckets non-Claude-Code clients into a tight 429
            // limit. The UA is the same family Claude Code sends for `/usage`.
            ("User-Agent", "claude-code/2.1.261"),
        ],
    ) {
        Ok((200, body)) => {
            let windows = parse_usage_windows(&body);
            if windows.is_empty() {
                UsageProviderRemaining::unavailable(
                    ProviderId::Claude,
                    "Claude did not report a remaining-usage window.",
                )
            } else {
                UsageProviderRemaining::subscription(ProviderId::Claude, None, windows)
            }
        }
        Ok((401 | 403, _)) => UsageProviderRemaining::unavailable(
            ProviderId::Claude,
            "Sign in with the Claude CLI to see remaining usage.",
        ),
        Ok((429, _)) => UsageProviderRemaining::error(
            ProviderId::Claude,
            "Claude’s usage endpoint is rate-limited; try again later.",
        ),
        Ok((status, _)) => UsageProviderRemaining::error(
            ProviderId::Claude,
            format!("Claude remaining usage returned HTTP {status}."),
        ),
        Err(_) => UsageProviderRemaining::error(
            ProviderId::Claude,
            "Could not reach Claude remaining usage.",
        ),
    };
    // The plan name comes from disk, so every outcome can still show it.
    row.plan_label = plan_label;
    row
}

struct OAuthAccount {
    organization_type: Option<String>,
    rate_limit_tier: Option<String>,
}

fn read_oauth_account(source: &dyn RemainingSource) -> Option<OAuthAccount> {
    for path in claude_json_paths(source) {
        let Ok(text) = std::fs::read_to_string(&path) else {
            continue;
        };
        let Ok(json) = serde_json::from_str::<Value>(&text) else {
            continue;
        };
        let Some(account) = json.get("oauthAccount") else {
            continue;
        };
        return Some(OAuthAccount {
            organization_type: account
                .get("organizationType")
                .and_then(|v| v.as_str())
                .map(str::to_string),
            rate_limit_tier: account
                .get("organizationRateLimitTier")
                .and_then(|v| v.as_str())
                .map(str::to_string),
        });
    }
    None
}

fn claude_json_paths(source: &dyn RemainingSource) -> Vec<std::path::PathBuf> {
    let home = source.home();
    let mut paths = Vec::new();
    if let Some(dir) = source.env("CLAUDE_CONFIG_DIR") {
        paths.push(std::path::PathBuf::from(dir).join(".claude.json"));
    }
    paths.push(home.join(".claude.json"));
    paths.push(home.join(".claude/.claude.json"));
    paths
}

fn credentials_paths(source: &dyn RemainingSource) -> Vec<std::path::PathBuf> {
    let home = source.home();
    let mut paths = Vec::new();
    if let Some(dir) = source.env("CLAUDE_CONFIG_DIR") {
        paths.push(std::path::PathBuf::from(dir).join(".credentials.json"));
    }
    paths.push(home.join(".claude/.credentials.json"));
    paths
}

fn is_enterprise(account: &OAuthAccount) -> bool {
    account
        .organization_type
        .as_deref()
        .is_some_and(|kind| kind.to_ascii_lowercase().contains("enterprise"))
}

fn looks_like_api_key_only(source: &dyn RemainingSource, account: Option<&OAuthAccount>) -> bool {
    if account.is_some() {
        return false;
    }
    source.env("ANTHROPIC_API_KEY").is_some() && claude_access_token(source).is_none()
}

fn plan_label(account: &OAuthAccount) -> Option<String> {
    let org = account.organization_type.as_deref().unwrap_or("");
    let tier = account.rate_limit_tier.as_deref().unwrap_or("");
    if org.contains("max") {
        if tier.contains("20x") {
            return Some("Max 20x".into());
        }
        if tier.contains("5x") {
            return Some("Max 5x".into());
        }
        return Some("Max".into());
    }
    if org.contains("pro") {
        return Some("Pro".into());
    }
    if org.contains("team") {
        return Some("Team".into());
    }
    if !org.is_empty() {
        return Some(org.replace('_', " "));
    }
    None
}

fn claude_access_token(source: &dyn RemainingSource) -> Option<String> {
    if let Some(token) = source.env("CLAUDE_CODE_OAUTH_TOKEN") {
        return Some(token);
    }
    if let Some(token) = token_from_credentials_file(source) {
        return Some(token);
    }
    let raw = source.keychain_password(KEYCHAIN_SERVICE)?;
    token_from_credentials_json(&raw)
}

fn token_from_credentials_file(source: &dyn RemainingSource) -> Option<String> {
    for path in credentials_paths(source) {
        if let Ok(text) = std::fs::read_to_string(path) {
            if let Some(token) = token_from_credentials_json(&text) {
                return Some(token);
            }
        }
    }
    None
}

fn token_from_credentials_json(text: &str) -> Option<String> {
    let json: Value = serde_json::from_str(text).ok()?;
    json.pointer("/claudeAiOauth/accessToken")
        .and_then(|v| v.as_str())
        .filter(|token| !token.is_empty())
        .map(str::to_string)
        .or_else(|| {
            json.get("accessToken")
                .and_then(|v| v.as_str())
                .filter(|token| !token.is_empty())
                .map(str::to_string)
        })
}

pub fn parse_usage_windows(body: &Value) -> Vec<UsageLimitWindow> {
    let mut windows = Vec::new();
    push_named_window(&mut windows, body, "five_hour", "five_hour", "5-hour");
    push_named_window(&mut windows, body, "seven_day", "seven_day", "Weekly");
    windows
}

fn push_named_window(
    windows: &mut Vec<UsageLimitWindow>,
    body: &Value,
    key: &str,
    id: &str,
    label: &str,
) {
    let Some(window) = body.get(key) else {
        return;
    };
    if window.is_null() {
        return;
    }
    let used = window
        .get("utilization")
        .and_then(|v| v.as_f64())
        .or_else(|| window.get("used_percentage").and_then(|v| v.as_f64()))
        .or_else(|| window.get("usedPercentage").and_then(|v| v.as_f64()));
    let Some(used) = used else {
        return;
    };
    windows.push(UsageLimitWindow {
        id: id.to_string(),
        label: label.to_string(),
        remaining_percent: remaining_from_used(used),
        resets_at: window
            .get("resets_at")
            .or_else(|| window.get("resetsAt"))
            .and_then(resets_at_from_iso),
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::usage::remaining::tests::FakeSource;
    use crate::usage::remaining::UsagePlanKind;
    use serde_json::json;

    #[test]
    fn max_plan_parses_five_hour_and_weekly() {
        let dir = tempfile::tempdir().expect("temp");
        write_account(dir.path(), "claude_max", "default_claude_max_20x");
        let mut source = FakeSource::new(dir.path().to_path_buf());
        source
            .env
            .insert("CLAUDE_CODE_OAUTH_TOKEN".into(), "tok".into());
        source = source.with_http(
            USAGE_URL,
            200,
            json!({
                "five_hour": { "utilization": 15.2, "resets_at": "2026-09-06T16:00:00Z" },
                "seven_day": { "utilization": 42.0, "resets_at": "2026-09-13T00:00:00Z" },
                "seven_day_sonnet": { "utilization": 80.0, "resets_at": "2026-09-10T00:00:00Z" }
            }),
        );
        let row = fetch(&source);
        assert_eq!(row.kind, UsagePlanKind::Subscription);
        assert_eq!(row.plan_label.as_deref(), Some("Max 20x"));
        assert_eq!(row.windows.len(), 2);
        assert_eq!(row.windows[0].id, "five_hour");
        assert!((row.windows[0].remaining_percent - 84.8).abs() < 0.01);
        assert_eq!(row.windows[1].label, "Weekly");
    }

    #[test]
    fn enterprise_skips_the_usage_call() {
        let dir = tempfile::tempdir().expect("temp");
        write_account(dir.path(), "claude_enterprise", "default");
        let source = FakeSource::new(dir.path().to_path_buf());
        let row = fetch(&source);
        assert_eq!(row.kind, UsagePlanKind::Enterprise);
        assert!(row.windows.is_empty());
        assert!(source.http.lock().expect("http").is_empty());
    }

    #[test]
    fn expired_token_is_sign_in() {
        let dir = tempfile::tempdir().expect("temp");
        write_account(dir.path(), "claude_pro", "default");
        let mut source = FakeSource::new(dir.path().to_path_buf());
        source
            .env
            .insert("CLAUDE_CODE_OAUTH_TOKEN".into(), "stale".into());
        source = source.with_http(USAGE_URL, 401, json!({}));
        let row = fetch(&source);
        assert_eq!(row.kind, UsagePlanKind::Unavailable);
        assert!(row.message.as_deref().unwrap_or("").contains("Sign in"));
    }

    fn write_account(home: &std::path::Path, org: &str, tier: &str) {
        std::fs::write(
            home.join(".claude.json"),
            format!(
                r#"{{"oauthAccount":{{"organizationType":"{org}","organizationRateLimitTier":"{tier}","billingType":"stripe_subscription"}}}}"#
            ),
        )
        .expect("json");
    }
}
