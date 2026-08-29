//! Throwaway OpenCode data dirs for one-shot helper CLIs.
//!
//! OpenCode keeps every session in one SQLite file
//! (`$XDG_DATA_HOME/opencode/opencode.db`, defaulting to
//! `~/.local/share/opencode/opencode.db`). Two CLI processes that share that
//! file fail immediately with `database is locked`. Session launches must use
//! the real store so `run -s` resume works. Title generation and discovery
//! probes do not, so they get an isolated data dir with auth files copied in.

use std::{
    env, fs,
    path::{Path, PathBuf},
};

const AUTH_FILES: &[&str] = &["auth.json", "mcp-auth.json"];

pub struct IsolatedOpenCodeData {
    _dir: tempfile::TempDir,
    data_home: PathBuf,
    state_home: PathBuf,
}

impl IsolatedOpenCodeData {
    pub fn prepare() -> Option<Self> {
        Self::prepare_from(&shared_opencode_data_dir())
    }

    pub fn prepare_from(shared_data_dir: &Path) -> Option<Self> {
        let dir = tempfile::Builder::new()
            .prefix("argmax-opencode-")
            .tempdir()
            .ok()?;
        let data_home = dir.path().join("share");
        let state_home = dir.path().join("state");
        let isolated = data_home.join("opencode");
        fs::create_dir_all(&isolated).ok()?;
        fs::create_dir_all(&state_home).ok()?;
        for name in AUTH_FILES {
            let source = shared_data_dir.join(name);
            if source.is_file() {
                let _ = fs::copy(&source, isolated.join(name));
            }
        }
        Some(Self {
            _dir: dir,
            data_home,
            state_home,
        })
    }

    pub fn env_overrides(&self) -> Vec<(String, String)> {
        vec![
            (
                "XDG_DATA_HOME".to_string(),
                self.data_home.to_string_lossy().into_owned(),
            ),
            (
                "XDG_STATE_HOME".to_string(),
                self.state_home.to_string_lossy().into_owned(),
            ),
        ]
    }

    #[cfg(test)]
    fn isolated_opencode_dir(&self) -> PathBuf {
        self.data_home.join("opencode")
    }
}

fn shared_opencode_data_dir() -> PathBuf {
    if let Some(xdg) = env::var_os("XDG_DATA_HOME") {
        if !xdg.is_empty() {
            return PathBuf::from(xdg).join("opencode");
        }
    }
    env::var_os("HOME")
        .map(|home| PathBuf::from(home).join(".local/share/opencode"))
        .unwrap_or_else(|| PathBuf::from(".local/share/opencode"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    #[test]
    fn prepare_copies_auth_files_and_skips_the_session_db() {
        let source = tempfile::tempdir().expect("source dir");
        let source_opencode = source.path();
        fs::write(source_opencode.join("auth.json"), b"{\"ok\":true}").expect("auth");
        fs::write(source_opencode.join("mcp-auth.json"), b"{}").expect("mcp-auth");
        fs::write(source_opencode.join("opencode.db"), b"not-copied").expect("db");

        let isolated = IsolatedOpenCodeData::prepare_from(source_opencode).expect("prepare");
        let dest = isolated.isolated_opencode_dir();

        assert_eq!(
            fs::read_to_string(dest.join("auth.json")).expect("copied auth"),
            "{\"ok\":true}"
        );
        assert_eq!(
            fs::read_to_string(dest.join("mcp-auth.json")).expect("copied mcp-auth"),
            "{}"
        );
        assert!(
            !dest.join("opencode.db").exists(),
            "the shared session DB must not follow the helper"
        );

        let env = isolated.env_overrides();
        assert_eq!(env[0].0, "XDG_DATA_HOME");
        assert_eq!(env[1].0, "XDG_STATE_HOME");
        assert_eq!(Path::new(&env[0].1), isolated.data_home.as_path());
        assert_eq!(Path::new(&env[1].1), isolated.state_home.as_path());
        assert!(isolated.data_home.join("opencode").exists());
        assert!(isolated.state_home.exists());
    }

    #[test]
    fn prepare_succeeds_when_the_shared_dir_is_missing() {
        let missing = std::env::temp_dir().join(format!(
            "argmax-opencode-isolation-missing-{}",
            uuid::Uuid::new_v4()
        ));
        let isolated = IsolatedOpenCodeData::prepare_from(&missing).expect("empty isolation");
        assert!(isolated.isolated_opencode_dir().is_dir());
        assert!(!isolated.isolated_opencode_dir().join("auth.json").exists());
    }
}
