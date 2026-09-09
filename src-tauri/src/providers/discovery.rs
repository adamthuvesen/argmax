use std::{collections::HashMap, sync::Arc, time::Duration};

use serde::{Deserialize, Serialize};
use specta::Type;
use tokio::{process::Command, sync::Mutex};

use super::{
    adapters::get_provider_definition, environment::build_provider_environment,
    opencode_isolation::IsolatedOpenCodeData, ApprovalSupport, ProviderId,
};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CapabilityAvailability {
    pub available: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

impl CapabilityAvailability {
    fn available_when_installed(installed: bool, display_name: &str) -> Self {
        if installed {
            Self {
                available: true,
                reason: None,
            }
        } else {
            Self {
                available: false,
                reason: Some(format!("{display_name} is not installed.")),
            }
        }
    }

    fn unavailable(reason: impl Into<String>) -> Self {
        Self {
            available: false,
            reason: Some(reason.into()),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ProviderGoalSupport {
    /// Finite continuation owned by Argmax. Every provider turn settles before
    /// Argmax advances into checks or review.
    pub app_managed: CapabilityAvailability,
    /// Whether the provider product is known to expose a native Goal feature.
    /// Product availability alone never enables host control.
    pub native_product: bool,
    /// Host control requires start/status/pause/stop/resume semantics that can
    /// survive Argmax's per-turn process lifecycle without a second loop.
    pub native_control: CapabilityAvailability,
    /// Fresh read-only subprocess plus a candidate-bound structured verdict.
    pub independent_reviewer: CapabilityAvailability,
}

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
    pub setup_guidance: Option<String>,
    /// Whether Argmax can answer a native provider permission request. The
    /// current structured runtime is observation-only for Claude/Codex and
    /// has no Cursor gate detector, so the UI must not imply live approval.
    pub approval_support: ApprovalSupport,
    pub goal_support: ProviderGoalSupport,
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
        // providers out in parallel; the cache (held in AppState)
        // persists across calls — a fresh boot pays the cold cost once.
        let (claude, codex, cursor, opencode, grok) = tokio::join!(
            self.discover(ProviderId::Claude),
            self.discover(ProviderId::Codex),
            self.discover(ProviderId::Cursor),
            self.discover(ProviderId::Opencode),
            self.discover(ProviderId::Grok),
        );
        vec![claude, codex, cursor, opencode, grok]
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
    let binary_path = resolve_binary(provider_id, definition.binary_name).await;

    // Version and auth are independent reads — run them together so the auth
    // probe doesn't serialize behind `--version`. Both are skipped when the
    // binary is absent (nothing to probe). OpenCode probes each get their own
    // throwaway data dir so `--version` and `providers list` cannot lock the
    // session store (or each other) while a launch is in flight.
    let (version, authenticated) = match binary_path.as_deref() {
        Some(path) => {
            let version_isolation = opencode_helper_isolation(provider_id);
            let auth_isolation = opencode_helper_isolation(provider_id);
            tokio::join!(
                read_version(path, env_from_isolation(version_isolation.as_ref())),
                probe_auth(
                    path,
                    definition.status_args,
                    env_from_isolation(auth_isolation.as_ref()),
                )
            )
        }
        None => (None, None),
    };

    let setup_guidance = match (binary_path.is_some(), authenticated) {
        (false, _) if super::verification::requested() => Some(
            super::verification::validate_configuration()
                .err()
                .unwrap_or_else(|| {
                    format!(
                        "Verification mode has no fixture configured in {}.",
                        super::verification::binary_env(provider_id)
                    )
                }),
        ),
        (false, _) => Some(setup_guidance(provider_id).to_string()),
        (true, Some(false)) => Some(login_guidance(provider_id).to_string()),
        (true, _) => None,
    };

    let installed = binary_path.is_some();
    ProviderCapabilityReport {
        provider: provider_id,
        display_name: definition.display_name.to_string(),
        binary_name: definition.binary_name.to_string(),
        installed,
        binary_path: binary_path.clone(),
        version,
        authenticated,
        setup_guidance,
        approval_support: definition.approval_support,
        goal_support: goal_support(provider_id, installed, definition.display_name),
    }
}

fn goal_support(provider: ProviderId, installed: bool, display_name: &str) -> ProviderGoalSupport {
    let native_product = !matches!(provider, ProviderId::Opencode);
    let native_control_reason = match provider {
        ProviderId::Codex => "Codex native Goal state CRUD is verified, but its autonomous continuation lifecycle is not controllable through Argmax's per-turn app-server host yet.",
        ProviderId::Claude => "Claude Code has native Goals, but Argmax has not verified host-controlled lifecycle events through its current CLI transport.",
        ProviderId::Cursor => "Cursor has native Goals, but Argmax has not verified host-controlled lifecycle events through ACP.",
        ProviderId::Grok => "Grok Build has native Goals, but Argmax has not verified host-controlled lifecycle events through ACP.",
        ProviderId::Opencode => "OpenCode does not expose a verified native Goal lifecycle.",
    };
    let independent_reviewer = match provider {
        ProviderId::Claude => {
            CapabilityAvailability::available_when_installed(installed, display_name)
        }
        ProviderId::Codex => CapabilityAvailability::unavailable(
            "Codex read-only sandboxing is verified, but Argmax cannot yet prove that every installed customization and hook is excluded from a fresh reviewer invocation.",
        ),
        ProviderId::Cursor => CapabilityAvailability::unavailable(
            "Cursor ask mode is read-only by convention, but Argmax has not verified an enforced no-write reviewer boundary for this CLI version.",
        ),
        ProviderId::Opencode => CapabilityAvailability::unavailable(
            "OpenCode's plan agent is read-only by convention, but Argmax has not verified an enforced no-write reviewer boundary.",
        ),
        ProviderId::Grok => CapabilityAvailability::unavailable(
            "Grok can restrict built-in tools, but its CLI still loads discovered MCP servers, plugins, and hooks during review.",
        ),
    };
    ProviderGoalSupport {
        app_managed: CapabilityAvailability::available_when_installed(installed, display_name),
        native_product,
        native_control: CapabilityAvailability::unavailable(native_control_reason),
        independent_reviewer,
    }
}

fn opencode_helper_isolation(provider_id: ProviderId) -> Option<IsolatedOpenCodeData> {
    if provider_id == ProviderId::Opencode {
        IsolatedOpenCodeData::prepare()
    } else {
        None
    }
}

fn env_from_isolation(isolation: Option<&IsolatedOpenCodeData>) -> Vec<(String, String)> {
    isolation
        .map(IsolatedOpenCodeData::env_overrides)
        .unwrap_or_default()
}

async fn resolve_binary(provider_id: ProviderId, binary_name: &str) -> Option<String> {
    if super::verification::requested() {
        return super::verification::binary_path(provider_id);
    }
    command_output("which", &[binary_name], Vec::new()).await
}

async fn read_version(binary_path: &str, extra_env: Vec<(String, String)>) -> Option<String> {
    tokio::time::timeout(
        PROBE_TIMEOUT,
        command_output(binary_path, &["--version"], extra_env),
    )
    .await
    .unwrap_or_default()
}

/// Probe the provider's auth/login status command. Returns `Some(true)` on a
/// clean exit, `Some(false)` on a non-zero exit (installed but not logged in),
/// and `None` when the probe times out or can't be spawned (inconclusive — the
/// UI then shows plain "Installed", never a false "needs login").
async fn probe_auth(
    binary_path: &str,
    status_args: &[&str],
    extra_env: Vec<(String, String)>,
) -> Option<bool> {
    let env = build_provider_environment(extra_env);
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

async fn command_output(
    command: &str,
    args: &[&str],
    extra_env: Vec<(String, String)>,
) -> Option<String> {
    let env = build_provider_environment(extra_env);
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
        ProviderId::Opencode => {
            "Install OpenCode locally and authenticate a provider with `opencode auth login`. Argmax will launch the local `opencode` CLI from the selected workspace."
        }
        ProviderId::Grok => {
            "Install Grok Build locally and sign in with `grok login`. Argmax will launch the local `grok` CLI from the selected workspace."
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
        ProviderId::Opencode => {
            "OpenCode is installed but not authenticated. Run `opencode auth login` in your terminal, then refresh."
        }
        ProviderId::Grok => {
            "Grok Build is installed but not authenticated. Run `grok login` in your terminal, then refresh."
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
        assert_eq!(
            get_provider_definition(ProviderId::Opencode).status_args,
            &["providers", "list"]
        );
    }

    #[test]
    fn approval_support_uses_native_response_transports() {
        use crate::providers::adapters::get_provider_definition;
        assert_eq!(
            get_provider_definition(ProviderId::Claude).approval_support,
            ApprovalSupport::Respondable
        );
        assert_eq!(
            get_provider_definition(ProviderId::Codex).approval_support,
            ApprovalSupport::Respondable
        );
        assert_eq!(
            get_provider_definition(ProviderId::Cursor).approval_support,
            ApprovalSupport::Respondable
        );
        assert_eq!(
            get_provider_definition(ProviderId::Opencode).approval_support,
            ApprovalSupport::Respondable
        );
    }

    #[test]
    fn login_guidance_names_login_command() {
        assert!(login_guidance(ProviderId::Claude).contains("claude auth login"));
        assert!(login_guidance(ProviderId::Codex).contains("codex login"));
        assert!(login_guidance(ProviderId::Cursor).contains("cursor-agent login"));
        assert!(login_guidance(ProviderId::Opencode).contains("opencode auth login"));
    }

    #[test]
    fn opencode_helper_isolation_is_opencode_only() {
        assert!(opencode_helper_isolation(ProviderId::Claude).is_none());
        assert!(opencode_helper_isolation(ProviderId::Codex).is_none());
        assert!(opencode_helper_isolation(ProviderId::Cursor).is_none());
        assert!(opencode_helper_isolation(ProviderId::Opencode).is_some());
    }

    #[test]
    fn native_product_presence_does_not_claim_host_control() {
        for provider in [
            ProviderId::Claude,
            ProviderId::Codex,
            ProviderId::Cursor,
            ProviderId::Grok,
        ] {
            let support = goal_support(provider, true, "provider");
            assert!(support.native_product);
            assert!(!support.native_control.available);
            assert!(support.app_managed.available);
            assert_eq!(
                support.independent_reviewer.available,
                provider == ProviderId::Claude
            );
        }
        let opencode = goal_support(ProviderId::Opencode, true, "OpenCode");
        assert!(!opencode.native_product);
        assert!(!opencode.native_control.available);
    }
}
