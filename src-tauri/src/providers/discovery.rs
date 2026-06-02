use std::{collections::HashMap, sync::Arc, time::Duration};

use serde::{Deserialize, Serialize};
use specta::Type;
use tokio::{process::Command, sync::Mutex};

use super::{
    adapters::get_provider_definition, environment::build_provider_environment, ProviderId,
    ProviderMode,
};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ProviderCapabilityReport {
    pub provider: ProviderId,
    pub display_name: String,
    pub binary_name: String,
    pub installed: bool,
    pub binary_path: Option<String>,
    pub version: Option<String>,
    /// Tri-state auth signal. `None` = not installed or the status probe was
    /// inconclusive (timed out / errored); `Some(true)` = logged in;
    /// `Some(false)` = installed but not authenticated. Advisory only — the UI
    /// never hard-blocks on it, since a CLI changing its status command must not
    /// lock out a working provider.
    pub authenticated: Option<bool>,
    pub modes: Vec<ProviderMode>,
    pub setup_guidance: Option<String>,
}

#[derive(Debug, Clone, Default)]
pub struct ProviderDiscovery {
    cache: Arc<Mutex<HashMap<ProviderId, ProviderCapabilityReport>>>,
}

impl ProviderDiscovery {
    pub fn new() -> Self {
        Self::default()
    }

    pub async fn discover_all(&self) -> Vec<ProviderCapabilityReport> {
        // `cursor-agent --version` alone runs ~350ms on macOS, so sequential
        // discovery serialized the settings open behind that floor. Fan the
        // three providers out in parallel; the cache (held in AppState)
        // persists across calls — a fresh boot pays the cold cost once.
        let (claude, codex, cursor) = tokio::join!(
            self.discover(ProviderId::Claude),
            self.discover(ProviderId::Codex),
            self.discover(ProviderId::Cursor),
        );
        vec![claude, codex, cursor]
    }

    /// Drop every cached capability report so the next `discover` re-probes the
    /// provider CLIs. Backs the renderer's explicit "Refresh" / "Try again"
    /// actions — without it a provider installed after boot stays "Not found"
    /// until the app restarts.
    pub async fn invalidate(&self) {
        self.cache.lock().await.clear();
    }

    pub async fn discover(&self, provider_id: ProviderId) -> ProviderCapabilityReport {
        if let Some(cached) = self.cache.lock().await.get(&provider_id).cloned() {
            return cached;
        }
        let report = discover_uncached(provider_id).await;
        self.cache.lock().await.insert(provider_id, report.clone());
        report
    }
}

/// Upper bound on any single provider CLI probe. `cursor-agent --version`
/// already runs ~350ms; a misbehaving CLI must not stall settings open, so we
/// cap version and auth probes and treat a timeout as "inconclusive".
const PROBE_TIMEOUT: Duration = Duration::from_secs(5);

async fn discover_uncached(provider_id: ProviderId) -> ProviderCapabilityReport {
    let definition = get_provider_definition(provider_id);
    let binary_path = resolve_binary(definition.binary_name).await;

    // Version and auth are independent reads — run them together so the auth
    // probe doesn't serialize behind `--version`. Both are skipped when the
    // binary is absent (nothing to probe).
    let (version, authenticated) = match binary_path.as_deref() {
        Some(path) => {
            tokio::join!(read_version(path), probe_auth(path, definition.status_args))
        }
        None => (None, None),
    };

    let setup_guidance = match (binary_path.is_some(), authenticated) {
        (false, _) => Some(setup_guidance(provider_id).to_string()),
        (true, Some(false)) => Some(login_guidance(provider_id).to_string()),
        (true, _) => None,
    };

    ProviderCapabilityReport {
        provider: provider_id,
        display_name: definition.display_name.to_string(),
        binary_name: definition.binary_name.to_string(),
        installed: binary_path.is_some(),
        binary_path: binary_path.clone(),
        version,
        authenticated,
        modes: provider_modes(provider_id),
        setup_guidance,
    }
}

async fn resolve_binary(binary_name: &str) -> Option<String> {
    command_output("which", &[binary_name]).await
}

async fn read_version(binary_path: &str) -> Option<String> {
    tokio::time::timeout(PROBE_TIMEOUT, command_output(binary_path, &["--version"]))
        .await
        .unwrap_or_default()
}

/// Probe the provider's auth/login status command. Returns `Some(true)` on a
/// clean exit, `Some(false)` on a non-zero exit (installed but not logged in),
/// and `None` when the probe times out or can't be spawned (inconclusive — the
/// UI then shows plain "Installed", never a false "needs login").
async fn probe_auth(binary_path: &str, status_args: &[&str]) -> Option<bool> {
    let env = build_provider_environment([]);
    let run = async {
        Command::new(binary_path)
            .args(status_args)
            .env_clear()
            .envs(env)
            .output()
            .await
            .ok()
    };
    match tokio::time::timeout(PROBE_TIMEOUT, run).await {
        Ok(Some(output)) => Some(output.status.success()),
        Ok(None) | Err(_) => None,
    }
}

async fn command_output(command: &str, args: &[&str]) -> Option<String> {
    let env = build_provider_environment([]);
    let output = Command::new(command)
        .args(args)
        .env_clear()
        .envs(env)
        .output()
        .await
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    let text = if stdout.trim().is_empty() {
        stderr
    } else {
        stdout
    };
    let text = text.trim();
    (!text.is_empty()).then(|| text.to_string())
}

fn provider_modes(provider_id: ProviderId) -> Vec<ProviderMode> {
    match provider_id {
        ProviderId::Claude | ProviderId::Codex => vec![ProviderMode::StructuredJson],
        ProviderId::Cursor => vec![ProviderMode::StructuredJson],
    }
}

fn setup_guidance(provider_id: ProviderId) -> &'static str {
    match provider_id {
        ProviderId::Claude => {
            "Install Claude Code locally and authenticate it in your normal terminal. Argmax will launch the local `claude` CLI from the selected workspace."
        }
        ProviderId::Codex => {
            "Install the Codex CLI locally and authenticate it in your normal terminal. Argmax will launch the local `codex` CLI from the selected workspace."
        }
        ProviderId::Cursor => {
            "Install the Cursor CLI and run `cursor-agent login` (or set CURSOR_API_KEY). Argmax will launch the local `cursor-agent` CLI from the selected workspace."
        }
    }
}

/// Shown when the CLI is installed but its status probe reports "not logged in".
/// Names the exact login command so the user can fix it in their terminal.
fn login_guidance(provider_id: ProviderId) -> &'static str {
    match provider_id {
        ProviderId::Claude => {
            "Claude Code is installed but not authenticated. Run `claude auth login` in your terminal, then refresh."
        }
        ProviderId::Codex => {
            "Codex is installed but not authenticated. Run `codex login` in your terminal, then refresh."
        }
        ProviderId::Cursor => {
            "Cursor is installed but not authenticated. Run `cursor-agent login` (or set CURSOR_API_KEY), then refresh."
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn provider_modes_match_runtime_support() {
        assert_eq!(
            provider_modes(ProviderId::Claude),
            vec![ProviderMode::StructuredJson]
        );
        assert_eq!(
            provider_modes(ProviderId::Cursor),
            vec![ProviderMode::StructuredJson]
        );
    }

    #[test]
    fn setup_guidance_names_local_cli() {
        assert!(setup_guidance(ProviderId::Codex).contains("Codex CLI"));
        assert!(setup_guidance(ProviderId::Cursor).contains("cursor-agent login"));
    }

    #[test]
    fn status_args_match_provider_cli() {
        use crate::providers::adapters::get_provider_definition;
        assert_eq!(
            get_provider_definition(ProviderId::Claude).status_args,
            &["auth", "status"]
        );
        assert_eq!(
            get_provider_definition(ProviderId::Codex).status_args,
            &["login", "status"]
        );
        assert_eq!(
            get_provider_definition(ProviderId::Cursor).status_args,
            &["status"]
        );
    }

    #[test]
    fn login_guidance_names_login_command() {
        assert!(login_guidance(ProviderId::Claude).contains("claude auth login"));
        assert!(login_guidance(ProviderId::Codex).contains("codex login"));
        assert!(login_guidance(ProviderId::Cursor).contains("cursor-agent login"));
    }
}
