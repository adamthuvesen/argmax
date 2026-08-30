//! Session sync: import sessions started outside Argmax (a plain `claude` in
//! a terminal, say) by reading the provider CLI's own transcript store.
//!
//! The provider's files are the source of truth. An imported session is a
//! disposable projection of one: it carries the provider conversation id, so
//! continuing it in Argmax resumes the real conversation, and until that
//! happens it can be deleted and re-imported freely. That is what makes the
//! "turn sync off and everything you never continued goes away" contract
//! safe, and it is why sync never writes to the provider's files.
//!
//! Scanning is a polled sweep, never a filesystem watcher: watchers on the
//! provider stores would fire on every keystroke of every running CLI, and
//! this app has been bitten by watcher amplification before.

pub mod claude;
mod engine;

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use specta::Type;

pub use engine::{run_sync, SyncOutcome, SUPPORTED_PROVIDERS};

/// Result of the most recent sweep, surfaced in Settings.
#[derive(Debug, Clone, PartialEq)]
pub struct SyncReport {
    pub ran_at: String,
    pub imported: u32,
    pub error: Option<String>,
}

impl SyncReport {
    pub fn ok(outcome: SyncOutcome) -> Self {
        Self {
            ran_at: crate::persistence::time::now_iso(),
            imported: outcome.imported,
            error: None,
        }
    }

    pub fn failed(error: String) -> Self {
        Self {
            ran_at: crate::persistence::time::now_iso(),
            imported: 0,
            error: Some(error),
        }
    }
}

/// The user's home directory, where every provider keeps its transcripts.
pub fn home_dir() -> PathBuf {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
}

pub fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

const CONFIG_FILE_NAME: &str = "sync.json";

/// Sync windows. Deliberately not "everything": the provider stores hold
/// years of sessions, and importing all of them would bury the dashboard and
/// cost minutes of parsing for sessions nobody will reopen.
pub const WINDOW_24H: u32 = 24;
pub const WINDOW_7D: u32 = 24 * 7;

fn default_window_hours() -> u32 {
    WINDOW_24H
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SyncConfig {
    /// Per-provider opt-in. Only providers whose transcript format Argmax can
    /// read are honored; see `SyncStatus::supported_providers`.
    #[serde(default)]
    pub claude: bool,
    #[serde(default)]
    pub codex: bool,
    #[serde(default)]
    pub cursor: bool,
    #[serde(default)]
    pub opencode: bool,
    #[serde(default = "default_window_hours")]
    pub window_hours: u32,
}

impl Default for SyncConfig {
    fn default() -> Self {
        Self {
            claude: false,
            codex: false,
            cursor: false,
            opencode: false,
            window_hours: default_window_hours(),
        }
    }
}

impl SyncConfig {
    pub fn enabled_for(&self, provider: &str) -> bool {
        match provider {
            "claude" => self.claude,
            "codex" => self.codex,
            "cursor" => self.cursor,
            "opencode" => self.opencode,
            _ => false,
        }
    }

    /// Clamp to the two offered windows so a hand-edited `sync.json` cannot
    /// ask for an unbounded import.
    pub fn normalized(mut self) -> Self {
        self.window_hours = if self.window_hours >= WINDOW_7D {
            WINDOW_7D
        } else {
            WINDOW_24H
        };
        // Providers whose transcript format Argmax cannot read yet stay off,
        // whatever the file says.
        self.codex = false;
        self.cursor = false;
        self.opencode = false;
        self
    }
}

/// What the Settings pane renders: the config plus what the last sweep did.
#[derive(Debug, Clone, PartialEq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SyncStatus {
    pub config: SyncConfig,
    /// Providers Argmax can actually read transcripts for. The rest render
    /// disabled, rather than as toggles that silently do nothing.
    pub supported_providers: Vec<String>,
    pub last_run_at: Option<String>,
    pub imported_count: u32,
    pub last_error: Option<String>,
}

/// Read `sync.json`, seeding a disabled one when missing. Any failure leaves
/// sync off rather than guessing.
pub fn load_or_create_config(app_data_dir: &Path) -> SyncConfig {
    let path = config_path(app_data_dir);
    match std::fs::read_to_string(&path) {
        Ok(body) => match serde_json::from_str::<SyncConfig>(&body) {
            Ok(config) => config.normalized(),
            Err(error) => {
                tracing::warn!(%error, path = %path.display(), "sync.json is malformed; sync stays off");
                SyncConfig::default()
            }
        },
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            let config = SyncConfig::default();
            if let Err(error) = write_config(&path, &config) {
                tracing::warn!(?error, path = %path.display(), "failed to seed sync.json");
            }
            config
        }
        Err(error) => {
            tracing::warn!(?error, path = %path.display(), "failed to read sync.json; sync stays off");
            SyncConfig::default()
        }
    }
}

pub fn save_config(app_data_dir: &Path, config: &SyncConfig) -> crate::error::ArgmaxResult<()> {
    write_config(&config_path(app_data_dir), config)
}

fn config_path(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join(CONFIG_FILE_NAME)
}

fn write_config(path: &Path, config: &SyncConfig) -> crate::error::ArgmaxResult<()> {
    let body = serde_json::to_vec_pretty(config).map_err(|error| {
        crate::error::ArgmaxError::service("SYNC_CONFIG_ENCODE", error.to_string())
    })?;
    std::fs::write(path, body).map_err(|error| {
        crate::error::ArgmaxError::service(
            "SYNC_CONFIG_WRITE",
            format!("failed to write {}: {error}", path.display()),
        )
    })
}

/// A session found in a provider's transcript store, before Argmax decides
/// whether to import it.
#[derive(Debug, Clone, PartialEq)]
pub struct DiscoveredSession {
    /// The provider's own session id — also the resume id, which is what
    /// makes an imported session continuable.
    pub external_id: String,
    /// Working directory the session ran in. Only sessions inside a
    /// registered project are imported.
    pub cwd: PathBuf,
    pub source_path: PathBuf,
    pub source_mtime_ms: i64,
    pub started_at: String,
    pub last_activity_at: String,
    /// Session title for the sidebar: the CLI's own title when it set one,
    /// otherwise the opening prompt.
    pub prompt: String,
    pub model_id: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn config_clamps_window_and_unsupported_providers() {
        let config = SyncConfig {
            claude: true,
            codex: true,
            cursor: true,
            opencode: true,
            window_hours: 9_999,
        }
        .normalized();
        assert_eq!(config.window_hours, WINDOW_7D);
        assert!(config.claude);
        // Unreadable transcript formats stay off however the file was edited.
        assert!(!config.codex && !config.cursor && !config.opencode);

        let short = SyncConfig {
            window_hours: 1,
            ..SyncConfig::default()
        }
        .normalized();
        assert_eq!(short.window_hours, WINDOW_24H);
    }

    #[test]
    fn missing_config_seeds_a_disabled_file() {
        let dir = tempfile::tempdir().expect("tempdir");
        let config = load_or_create_config(dir.path());
        assert_eq!(config, SyncConfig::default());
        assert!(dir.path().join(CONFIG_FILE_NAME).exists());

        // A malformed file is not fatal; sync just stays off.
        std::fs::write(dir.path().join(CONFIG_FILE_NAME), b"{ not json").expect("write");
        assert_eq!(load_or_create_config(dir.path()), SyncConfig::default());
    }

    #[test]
    fn saved_config_round_trips() {
        let dir = tempfile::tempdir().expect("tempdir");
        let config = SyncConfig {
            claude: true,
            window_hours: WINDOW_7D,
            ..SyncConfig::default()
        };
        save_config(dir.path(), &config).expect("save");
        assert_eq!(load_or_create_config(dir.path()), config);
    }
}
