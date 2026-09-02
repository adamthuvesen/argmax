//! The app-wide default agent: one model and effort for the whole app, chosen
//! in Settings → Agents. The renderer owns the preference and mirrors it to
//! `default-agent.json` in the app data dir through `system:set-default-agent`,
//! so the sessions Argmax starts on its own — the PR check-failure fix chat —
//! launch on the same model the user picked rather than a hard-coded one.
//!
//! There is deliberately no per-project default: a project holds where its
//! worktrees go and what its checks are, not which model to think with.

use std::path::Path;

use serde::{Deserialize, Serialize};

pub const DEFAULT_AGENT_FILE: &str = "default-agent.json";

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DefaultAgent {
    pub provider: String,
    pub model_label: String,
    pub model_id: String,
    pub reasoning_effort: Option<String>,
}

impl DefaultAgent {
    /// Mirrors PROVIDER_MODEL_DEFAULTS.claude and DEFAULT_REASONING_EFFORT in
    /// src/shared/providerModels.ts — what the launcher shows on a fresh
    /// install, before anything is chosen.
    pub fn factory() -> Self {
        Self {
            provider: "claude".to_string(),
            model_label: "Opus 5".to_string(),
            model_id: "claude-opus-5".to_string(),
            reasoning_effort: Some("medium".to_string()),
        }
    }
}

/// The mirrored default, or the factory one when it has never been written
/// (fresh install) or no longer parses (a hand-edited or truncated file).
pub fn read_default_agent(app_data_dir: &Path) -> DefaultAgent {
    let path = app_data_dir.join(DEFAULT_AGENT_FILE);
    let Ok(body) = std::fs::read(&path) else {
        return DefaultAgent::factory();
    };
    match serde_json::from_slice::<DefaultAgent>(&body) {
        Ok(agent) if !agent.model_id.is_empty() && !agent.provider.is_empty() => agent,
        _ => {
            tracing::warn!(path = %path.display(), "unreadable default agent; using the factory default");
            DefaultAgent::factory()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn missing_file_falls_back_to_the_factory_agent() {
        let dir = tempdir().expect("tempdir");
        assert_eq!(read_default_agent(dir.path()), DefaultAgent::factory());
    }

    #[test]
    fn round_trips_a_mirrored_agent() {
        let dir = tempdir().expect("tempdir");
        let agent = DefaultAgent {
            provider: "codex".to_string(),
            model_label: "GPT-5.6 Sol".to_string(),
            model_id: "gpt-5.6-sol".to_string(),
            reasoning_effort: Some("xhigh".to_string()),
        };
        std::fs::write(
            dir.path().join(DEFAULT_AGENT_FILE),
            serde_json::to_vec(&agent).expect("serialize"),
        )
        .expect("write");

        assert_eq!(read_default_agent(dir.path()), agent);
    }

    #[test]
    fn corrupt_json_falls_back_rather_than_launching_nothing() {
        let dir = tempdir().expect("tempdir");
        std::fs::write(dir.path().join(DEFAULT_AGENT_FILE), b"{not json").expect("write");
        assert_eq!(read_default_agent(dir.path()), DefaultAgent::factory());
    }
}
