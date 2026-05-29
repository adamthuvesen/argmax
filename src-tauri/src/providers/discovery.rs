use std::{collections::HashMap, sync::Arc};

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

    pub async fn discover(&self, provider_id: ProviderId) -> ProviderCapabilityReport {
        if let Some(cached) = self.cache.lock().await.get(&provider_id).cloned() {
            return cached;
        }
        let report = discover_uncached(provider_id).await;
        self.cache.lock().await.insert(provider_id, report.clone());
        report
    }
}

async fn discover_uncached(provider_id: ProviderId) -> ProviderCapabilityReport {
    let definition = get_provider_definition(provider_id);
    let binary_path = resolve_binary(definition.binary_name).await;
    let version = match binary_path.as_deref() {
        Some(path) => read_version(path).await,
        None => None,
    };

    ProviderCapabilityReport {
        provider: provider_id,
        display_name: definition.display_name.to_string(),
        binary_name: definition.binary_name.to_string(),
        installed: binary_path.is_some(),
        binary_path: binary_path.clone(),
        version,
        modes: provider_modes(provider_id),
        setup_guidance: if binary_path.is_some() {
            None
        } else {
            Some(setup_guidance(provider_id).to_string())
        },
    }
}

async fn resolve_binary(binary_name: &str) -> Option<String> {
    command_output("which", &[binary_name]).await
}

async fn read_version(binary_path: &str) -> Option<String> {
    command_output(binary_path, &["--version"]).await
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
}
