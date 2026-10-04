//! Scripted remaining usage for verification builds.
//!
//! A verification app must never ask a real provider account how much is left,
//! yet the composer's usage chip has to show something to be driven. This
//! source answers the one Claude endpoint the production adapter calls with a
//! fixed body, so the real parsing and the real chip run on known figures. The
//! token below is a placeholder that is only ever handed to this source, never
//! to a network. Every other read fails the way `LiveRemainingSource` does in
//! verification mode.

use std::path::{Path, PathBuf};

use chrono::{Duration, Utc};
use serde_json::{json, Value};

use super::{claude, HttpAnswer, RemainingSource};
use crate::sync::home_dir;

const FIXTURE_TOKEN: &str = "argmax-verification-token";
const DISABLED: &str = "Live remaining usage is disabled in verification mode.";

/// Used and remaining percent of each window the fixture reports. The 5-hour
/// window is the tighter one, so the chip reads `63%`.
pub const FIVE_HOUR_USED_PERCENT: f64 = 37.0;
pub const WEEKLY_USED_PERCENT: f64 = 12.0;

pub struct VerificationRemainingSource {
    home: PathBuf,
}

impl VerificationRemainingSource {
    pub fn new() -> Self {
        Self { home: home_dir() }
    }
}

impl Default for VerificationRemainingSource {
    fn default() -> Self {
        Self::new()
    }
}

fn usage_body() -> Value {
    let now = Utc::now();
    json!({
        "five_hour": {
            "utilization": FIVE_HOUR_USED_PERCENT,
            "resets_at": (now + Duration::hours(3)).to_rfc3339(),
        },
        "seven_day": {
            "utilization": WEEKLY_USED_PERCENT,
            "resets_at": (now + Duration::days(4)).to_rfc3339(),
        },
    })
}

impl RemainingSource for VerificationRemainingSource {
    fn home(&self) -> &Path {
        &self.home
    }

    fn env(&self, key: &str) -> Option<String> {
        (key == "CLAUDE_CODE_OAUTH_TOKEN").then(|| FIXTURE_TOKEN.to_string())
    }

    fn http_get(&self, url: &str, _headers: &[(&str, &str)]) -> HttpAnswer {
        if url == claude::USAGE_URL {
            return Ok((200, usage_body()));
        }
        Err(DISABLED.into())
    }

    fn keychain_password(&self, _service: &str) -> Option<String> {
        None
    }

    fn codex_rate_limits(&self) -> Result<Value, String> {
        Err(DISABLED.into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ipc::validation::ProviderId;
    use crate::usage::remaining::{fetch_remaining, UsagePlanKind};
    use std::sync::Arc;

    #[test]
    fn claude_reports_the_scripted_windows_and_nothing_else_does() {
        // An empty home, so the other providers' file readers find nothing,
        // and the test never reads the developer's real profile.
        let home = tempfile::tempdir().expect("empty home");
        let remaining = fetch_remaining(Arc::new(VerificationRemainingSource {
            home: home.path().to_path_buf(),
        }));
        let claude_row = remaining
            .providers
            .iter()
            .find(|row| row.provider == ProviderId::Claude)
            .expect("claude row");
        assert_eq!(claude_row.kind, UsagePlanKind::Subscription);
        let windows: Vec<_> = claude_row
            .windows
            .iter()
            .map(|window| (window.label.as_str(), window.remaining_percent))
            .collect();
        assert_eq!(windows, vec![("5-hour", 63.0), ("Weekly", 88.0)]);
        assert!(remaining
            .providers
            .iter()
            .filter(|row| row.provider != ProviderId::Claude)
            .all(|row| row.windows.is_empty()));
    }

    #[test]
    fn nothing_but_the_claude_endpoint_is_answered() {
        let source = VerificationRemainingSource::new();
        assert_eq!(
            source.http_get("https://api.anthropic.com/api/other", &[]),
            Err(DISABLED.into())
        );
        assert_eq!(source.keychain_password("Claude Code-credentials"), None);
        assert_eq!(source.env("HOME"), None);
        assert_eq!(source.codex_rate_limits(), Err(DISABLED.into()));
    }
}
