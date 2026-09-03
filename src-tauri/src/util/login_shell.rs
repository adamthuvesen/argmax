// The user's login shell, and what Argmax learns by asking it.
//
// Launched from Finder or the Dock, Argmax inherits launchd's minimal
// environment: a bare `PATH` with no `/opt/homebrew/bin`, and none of the
// shell-exported vars provider CLIs read to find their credentials. Asking the
// login shell for its own environment makes the Finder and terminal launch
// paths identical.
//
// Provider spawns merge the whole environment ([`environment`]); git takes only
// [`path`], because a `GIT_DIR` or `GIT_CONFIG` exported in someone's `.zshrc`
// would silently retarget every git command Argmax runs.

use std::{
    collections::BTreeSet,
    env,
    ffi::OsString,
    path::{Path, PathBuf},
    process::Command,
    sync::OnceLock,
};

/// The user's login-shell environment, resolved once and cached.
///
/// Empty when resolution fails or on non-Unix platforms — callers then fall
/// back to the process environment alone, matching the pre-hydration behavior.
pub fn environment() -> Vec<(String, String)> {
    static CACHE: OnceLock<Vec<(String, String)>> = OnceLock::new();
    CACHE.get_or_init(resolve_environment).clone()
}

/// The login shell's `PATH` with Argmax's fallbacks appended, resolved once and
/// cached. Falls back to the process `PATH` when the shell didn't report one.
pub fn path() -> String {
    static CACHE: OnceLock<String> = OnceLock::new();
    CACHE
        .get_or_init(|| {
            let from_shell = environment()
                .into_iter()
                .find_map(|(key, value)| (key == "PATH").then_some(value));
            let current = from_shell.or_else(|| env::var("PATH").ok());
            path_from(current.as_deref())
        })
        .clone()
}

/// Resolve both caches now, off whatever thread the caller provides.
///
/// [`resolve_environment`] shells out to `zsh -lic`, which costs as long as the
/// user's rc files take. Startup pays it so no request path does: the first git
/// command otherwise blocks a runtime worker on someone else's `.zshrc`.
pub fn warm() {
    let _ = path();
}

#[cfg(unix)]
fn resolve_environment() -> Vec<(String, String)> {
    use std::process::Stdio;

    // A sentinel separates any startup chatter the rc files print from our
    // env dump. `env -0` is NUL-delimited so values containing newlines (and
    // any noise before the sentinel) can't corrupt the parse.
    const SENTINEL: &str = "__ARGMAX_ENV_BOUNDARY__";
    let shell = shell();
    // `-l` runs login files (~/.zprofile), `-i` runs interactive rc files
    // (~/.zshrc, where exports like CLAUDE_CONFIG_DIR usually live).
    let output = Command::new(&shell)
        .args(["-lic", &format!("printf %s {SENTINEL}; env -0")])
        .stdin(Stdio::null())
        .output();
    let Ok(output) = output else {
        return Vec::new();
    };
    if !output.status.success() {
        return Vec::new();
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    let Some(boundary) = stdout.find(SENTINEL) else {
        return Vec::new();
    };
    let blob = &stdout[boundary + SENTINEL.len()..];
    blob.split('\0')
        .filter_map(|entry| entry.split_once('='))
        .filter(|(key, _)| {
            !key.is_empty() && key.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_')
        })
        .map(|(key, value)| (key.to_string(), value.to_string()))
        .collect()
}

#[cfg(not(unix))]
fn resolve_environment() -> Vec<(String, String)> {
    Vec::new()
}

pub fn shell() -> String {
    match env::var("SHELL") {
        Ok(shell) if shell.starts_with('/') => shell,
        _ => "/bin/zsh".to_string(),
    }
}

pub fn quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

/// `current_path` with Argmax's fallback entries appended, order preserved and
/// duplicates dropped.
pub fn path_from(current_path: Option<&str>) -> String {
    let mut seen = BTreeSet::<OsString>::new();
    let mut entries = Vec::<PathBuf>::new();

    if let Some(current_path) = current_path {
        for path in env::split_paths(current_path) {
            if seen.insert(path.as_os_str().to_os_string()) {
                entries.push(path);
            }
        }
    }

    for path in fallback_path_entries() {
        if seen.insert(path.as_os_str().to_os_string()) {
            entries.push(path);
        }
    }

    env::join_paths(entries)
        .unwrap_or_else(|_| OsString::new())
        .to_string_lossy()
        .into_owned()
}

fn fallback_path_entries() -> Vec<PathBuf> {
    let mut entries = Vec::new();
    if let Some(home) = env::var_os("HOME") {
        let home = Path::new(&home);
        entries.push(home.join("bin"));
        entries.push(home.join(".local/bin"));
        entries.push(home.join(".npm-global/bin"));
        entries.push(home.join(".bun/bin"));
    }
    entries.extend([
        PathBuf::from("/opt/homebrew/bin"),
        PathBuf::from("/opt/homebrew/sbin"),
        PathBuf::from("/usr/local/bin"),
        PathBuf::from("/usr/bin"),
        PathBuf::from("/bin"),
        PathBuf::from("/usr/sbin"),
        PathBuf::from("/sbin"),
    ]);
    entries
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quote_escapes_single_quotes() {
        assert_eq!(quote("it's fine"), "'it'\\''s fine'");
    }

    #[test]
    fn path_from_preserves_order_and_dedupes() {
        let path = path_from(Some("/bin:/usr/bin:/bin"));
        let parts = env::split_paths(&path).collect::<Vec<_>>();
        assert_eq!(parts[0], PathBuf::from("/bin"));
        assert_eq!(parts[1], PathBuf::from("/usr/bin"));
        assert_eq!(
            parts
                .iter()
                .filter(|entry| entry == &&PathBuf::from("/bin"))
                .count(),
            1
        );
    }

    #[test]
    fn path_from_hydrates_a_stripped_launchd_path() {
        // The Finder-launch case: without the fallbacks, a git hook calling a
        // Homebrew binary exits 127 and takes `git worktree add` down with it.
        let path = path_from(Some("/usr/bin:/bin"));
        let parts = env::split_paths(&path).collect::<Vec<_>>();
        assert!(parts.contains(&PathBuf::from("/opt/homebrew/bin")));
        assert!(parts.contains(&PathBuf::from("/usr/local/bin")));
    }
}
