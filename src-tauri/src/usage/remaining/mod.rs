//! Live remaining usage on each provider's signed-in plan.
//!
//! Distinct from the transcript ledger: these numbers come from the same
//! login the CLI already has, and they include use outside Argmax. One
//! provider failing must not take the others (or the Usage page) down.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use chrono::Utc;
use serde::{Deserialize, Serialize};
use specta::Type;

use crate::ipc::validation::ProviderId;
use crate::sync::home_dir;
use crate::util::login_shell;

mod claude;
mod codex;
mod cursor;
mod grok;
mod http;
mod opencode;
mod windows;

pub use windows::{
    remaining_from_used, resets_at_from_epoch, resets_at_from_iso, window_id_for_minutes,
    window_label_for_minutes,
};

/// Providers on the remaining card, matching the Usage page's identity order.
pub const REMAINING_PROVIDER_ORDER: [ProviderId; 5] = [
    ProviderId::Claude,
    ProviderId::Codex,
    ProviderId::Cursor,
    ProviderId::Opencode,
    ProviderId::Grok,
];

const FETCH_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum UsagePlanKind {
    Subscription,
    Enterprise,
    ApiKey,
    Unavailable,
    Error,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct UsageLimitWindow {
    pub id: String,
    pub label: String,
    /// 0–100, how much of the window is still left.
    pub remaining_percent: f64,
    /// RFC 3339 UTC; `None` when the provider did not send a reset.
    pub resets_at: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct UsageProviderRemaining {
    pub provider: ProviderId,
    pub kind: UsagePlanKind,
    pub plan_label: Option<String>,
    pub windows: Vec<UsageLimitWindow>,
    pub message: Option<String>,
    /// When set, the renderer opens this URL from the message (e.g. Cursor Spending).
    pub message_url: Option<String>,
}

impl UsageProviderRemaining {
    pub fn unavailable(provider: ProviderId, message: impl Into<String>) -> Self {
        Self {
            provider,
            kind: UsagePlanKind::Unavailable,
            plan_label: None,
            windows: Vec::new(),
            message: Some(message.into()),
            message_url: None,
        }
    }

    pub fn error(provider: ProviderId, message: impl Into<String>) -> Self {
        Self {
            provider,
            kind: UsagePlanKind::Error,
            plan_label: None,
            windows: Vec::new(),
            message: Some(message.into()),
            message_url: None,
        }
    }

    pub fn enterprise(provider: ProviderId, plan_label: impl Into<String>) -> Self {
        Self {
            provider,
            kind: UsagePlanKind::Enterprise,
            plan_label: Some(plan_label.into()),
            windows: Vec::new(),
            message: None,
            message_url: None,
        }
    }

    pub fn api_key(provider: ProviderId) -> Self {
        Self {
            provider,
            kind: UsagePlanKind::ApiKey,
            plan_label: None,
            windows: Vec::new(),
            message: Some("Billed by API key. No included allowance.".to_string()),
            message_url: None,
        }
    }

    pub fn subscription(
        provider: ProviderId,
        plan_label: Option<String>,
        windows: Vec<UsageLimitWindow>,
    ) -> Self {
        Self {
            provider,
            kind: UsagePlanKind::Subscription,
            plan_label,
            windows,
            message: None,
            message_url: None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct UsageRemaining {
    /// RFC 3339 UTC.
    pub fetched_at: String,
    pub providers: Vec<UsageProviderRemaining>,
}

/// One answer from a provider endpoint: status and parsed body, or the
/// transport error.
pub type HttpAnswer = Result<(u16, serde_json::Value), String>;

/// Reads the files and endpoints remaining usage needs. Tests inject a fake.
pub trait RemainingSource: Send + Sync {
    fn home(&self) -> &Path;
    fn env(&self, key: &str) -> Option<String>;
    fn http_get(&self, url: &str, headers: &[(&str, &str)]) -> HttpAnswer;
    fn keychain_password(&self, service: &str) -> Option<String>;
    /// Official Codex remaining snapshot, if the app-server answered.
    fn codex_rate_limits(&self) -> Result<serde_json::Value, String>;
}

pub struct LiveRemainingSource {
    home: PathBuf,
}

impl LiveRemainingSource {
    pub fn new() -> Self {
        Self { home: home_dir() }
    }
}

impl Default for LiveRemainingSource {
    fn default() -> Self {
        Self::new()
    }
}

impl RemainingSource for LiveRemainingSource {
    fn home(&self) -> &Path {
        &self.home
    }

    fn env(&self, key: &str) -> Option<String> {
        if let Some(value) = std::env::var(key).ok().filter(|value| !value.is_empty()) {
            return Some(value);
        }
        // Launched from Finder, Argmax inherits launchd's minimal environment,
        // so `CLAUDE_CONFIG_DIR` and its kin live only in the login shell —
        // the same environment provider launches already hydrate. Without
        // this, the sessions Argmax starts and the card that reports on them
        // read two different credential stores. Verification stays fenced off
        // from the real one, as it is for provider launches.
        if crate::providers::verification::requested() {
            return None;
        }
        login_shell::environment()
            .into_iter()
            .find_map(|(candidate, value)| (candidate == key).then_some(value))
            .filter(|value| !value.is_empty())
    }

    fn http_get(&self, url: &str, headers: &[(&str, &str)]) -> HttpAnswer {
        http::get_json(url, headers, FETCH_TIMEOUT)
    }

    fn keychain_password(&self, service: &str) -> Option<String> {
        read_keychain_password(service)
    }

    fn codex_rate_limits(&self) -> Result<serde_json::Value, String> {
        codex::fetch_app_server_rate_limits(&self.home)
    }
}

/// Five provider rows, fetched in parallel. Never fails the IPC: a broken
/// adapter becomes an `error` or `unavailable` row.
pub fn fetch_remaining(source: Arc<dyn RemainingSource>) -> UsageRemaining {
    let providers = std::thread::scope(|scope| {
        let jobs = [
            spawn_row(scope, &source, ProviderId::Claude, claude::fetch),
            spawn_row(scope, &source, ProviderId::Codex, codex::fetch),
            spawn_row(scope, &source, ProviderId::Cursor, cursor::fetch),
            spawn_row(scope, &source, ProviderId::Opencode, opencode::fetch),
            spawn_row(scope, &source, ProviderId::Grok, grok::fetch),
        ];
        jobs.map(|job| join_row(job.0, job.1)).to_vec()
    });

    UsageRemaining {
        fetched_at: Utc::now().to_rfc3339(),
        providers,
    }
}

fn spawn_row<'scope, 'source>(
    scope: &'scope std::thread::Scope<'scope, 'source>,
    source: &'scope Arc<dyn RemainingSource>,
    provider: ProviderId,
    fetch: fn(&dyn RemainingSource) -> UsageProviderRemaining,
) -> (
    std::thread::ScopedJoinHandle<'scope, UsageProviderRemaining>,
    ProviderId,
)
where
    'source: 'scope,
{
    let source = Arc::clone(source);
    (
        scope.spawn(move || {
            std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| fetch(&*source)))
                .unwrap_or_else(|_| failed_row(provider))
        }),
        provider,
    )
}

fn join_row(
    handle: std::thread::ScopedJoinHandle<'_, UsageProviderRemaining>,
    provider: ProviderId,
) -> UsageProviderRemaining {
    handle.join().unwrap_or_else(|_| failed_row(provider))
}

fn failed_row(provider: ProviderId) -> UsageProviderRemaining {
    let name = match provider {
        ProviderId::Claude => "Claude",
        ProviderId::Codex => "Codex",
        ProviderId::Cursor => "Cursor",
        ProviderId::Opencode => "OpenCode",
        ProviderId::Grok => "Grok",
    };
    UsageProviderRemaining::error(provider, format!("Could not read {name} remaining usage."))
}

#[cfg(target_os = "macos")]
fn read_keychain_password(service: &str) -> Option<String> {
    let output = std::process::Command::new("security")
        .args(["find-generic-password", "-s", service, "-w"])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let secret = String::from_utf8(output.stdout).ok()?;
    let secret = secret.trim();
    if secret.is_empty() {
        None
    } else {
        Some(secret.to_string())
    }
}

#[cfg(not(target_os = "macos"))]
fn read_keychain_password(_service: &str) -> Option<String> {
    None
}

#[cfg(test)]
pub mod tests {
    use super::*;
    use serde_json::json;
    use std::collections::HashMap;
    use std::sync::Mutex;

    pub struct FakeSource {
        pub home: PathBuf,
        pub env: HashMap<String, String>,
        pub http: Mutex<HashMap<String, HttpAnswer>>,
        pub keychain: HashMap<String, String>,
        pub codex_limits: Result<serde_json::Value, String>,
    }

    impl FakeSource {
        pub fn new(home: PathBuf) -> Self {
            Self {
                home,
                env: HashMap::new(),
                http: Mutex::new(HashMap::new()),
                keychain: HashMap::new(),
                codex_limits: Err("no app-server".into()),
            }
        }

        pub fn with_http(self, url: &str, status: u16, body: serde_json::Value) -> Self {
            self.http
                .lock()
                .expect("http map")
                .insert(url.to_string(), Ok((status, body)));
            self
        }
    }

    impl RemainingSource for FakeSource {
        fn home(&self) -> &Path {
            &self.home
        }

        fn env(&self, key: &str) -> Option<String> {
            self.env.get(key).cloned()
        }

        fn http_get(&self, url: &str, _headers: &[(&str, &str)]) -> HttpAnswer {
            let map = self.http.lock().expect("http map");
            map.get(url)
                .cloned()
                .unwrap_or_else(|| Err(format!("no fake response for {url}")))
        }

        fn keychain_password(&self, service: &str) -> Option<String> {
            self.keychain.get(service).cloned()
        }

        fn codex_rate_limits(&self) -> Result<serde_json::Value, String> {
            self.codex_limits.clone()
        }
    }

    #[test]
    fn empty_home_is_unavailable_not_an_ipc_error() {
        let dir = tempfile::tempdir().expect("temp");
        let source = Arc::new(FakeSource::new(dir.path().to_path_buf()));
        let snapshot = fetch_remaining(source);
        assert_eq!(
            snapshot
                .providers
                .iter()
                .map(|row| row.provider)
                .collect::<Vec<_>>(),
            REMAINING_PROVIDER_ORDER.to_vec()
        );
        assert_eq!(snapshot.providers[0].kind, UsagePlanKind::Unavailable);
        assert!(chrono::DateTime::parse_from_rfc3339(&snapshot.fetched_at).is_ok());
    }

    #[test]
    fn one_http_failure_does_not_blank_the_others() {
        let dir = tempfile::tempdir().expect("temp");
        let home = dir.path();
        fs_write_opencode_go(home);
        let mut source = FakeSource::new(home.to_path_buf());
        source
            .env
            .insert("CLAUDE_CODE_OAUTH_TOKEN".into(), "tok".into());
        source = source.with_http(claude::USAGE_URL, 500, json!({"error": "nope"}));
        source = source.with_http(
            opencode::USAGE_URL,
            200,
            json!({
                "usage": {
                    "rolling": { "status": "ok", "percent": 10, "resetsAt": "2026-09-06T16:00:00Z" },
                    "weekly": { "status": "ok", "percent": 20, "resetsAt": "2026-09-13T00:00:00Z" },
                    "monthly": { "status": "ok", "percent": 30, "resetsAt": "2026-10-01T00:00:00Z" }
                }
            }),
        );
        let snapshot = fetch_remaining(Arc::new(source));
        let claude = snapshot
            .providers
            .iter()
            .find(|row| row.provider == ProviderId::Claude)
            .expect("claude");
        assert_eq!(claude.kind, UsagePlanKind::Error);
        let go = snapshot
            .providers
            .iter()
            .find(|row| row.provider == ProviderId::Opencode)
            .expect("opencode");
        assert_eq!(go.kind, UsagePlanKind::Subscription);
        assert_eq!(go.windows.len(), 3);
    }

    fn fs_write_opencode_go(home: &Path) {
        let dir = home.join(".local/share/opencode");
        std::fs::create_dir_all(&dir).expect("dir");
        std::fs::write(
            dir.join("auth.json"),
            r#"{"opencode-go":{"type":"key","key":"oc-go-test"}}"#,
        )
        .expect("auth");
    }
}
