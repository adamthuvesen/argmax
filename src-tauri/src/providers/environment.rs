use std::{
    collections::BTreeSet,
    env,
    ffi::OsString,
    path::{Path, PathBuf},
    process::Command,
    sync::OnceLock,
};

pub fn build_provider_environment(
    overrides: impl IntoIterator<Item = (String, String)>,
) -> Vec<(String, String)> {
    // Base the child environment on the user's real login-shell environment,
    // then fill in anything unique to our own process. When Argmax is launched
    // from Finder/Dock it inherits only launchd's minimal environment — no
    // `CLAUDE_CONFIG_DIR`, a bare `PATH`, none of the shell-exported vars that
    // `claude`/`codex`/`cursor` need to resolve credentials. That's the
    // "works in `tauri dev`, fails in the packaged app, claude says not logged
    // in" symptom. Hydrating the login shell makes both launch paths identical.
    merge_provider_environment(login_shell_environment(), env::vars(), overrides)
}

/// Merge a login-shell base, the current process env, and explicit overrides
/// into a child environment, then normalize `PATH`.
///
/// Precedence: login-shell base wins over the process env (the bare launchd env
/// must not clobber the shell's `PATH`/config vars); process-only vars are
/// preserved; `overrides` win over everything.
fn merge_provider_environment(
    base: impl IntoIterator<Item = (String, String)>,
    process: impl IntoIterator<Item = (String, String)>,
    overrides: impl IntoIterator<Item = (String, String)>,
) -> Vec<(String, String)> {
    let mut env_map: Vec<(String, String)> = base.into_iter().collect();

    // Preserve vars the login shell didn't define (e.g. anything the runtime
    // set on our own process) without letting the bare process env override
    // values the shell already provided.
    for (key, value) in process {
        if !env_map.iter().any(|(existing, _)| existing == &key) {
            env_map.push((key, value));
        }
    }

    for (key, value) in overrides {
        if let Some((_, current)) = env_map.iter_mut().find(|(existing, _)| existing == &key) {
            *current = value;
        } else {
            env_map.push((key, value));
        }
    }

    let current_path = env_map
        .iter()
        .find_map(|(key, value)| (key == "PATH").then_some(value.as_str()));
    let path = provider_path(current_path);
    if let Some((_, current)) = env_map.iter_mut().find(|(key, _)| key == "PATH") {
        *current = path;
    } else {
        env_map.push(("PATH".to_string(), path));
    }
    env_map
}

/// The user's login-shell environment, resolved once and cached.
///
/// Empty when resolution fails or on non-Unix platforms — callers then fall
/// back to the process environment alone, matching the pre-hydration behavior.
fn login_shell_environment() -> Vec<(String, String)> {
    static CACHE: OnceLock<Vec<(String, String)>> = OnceLock::new();
    CACHE.get_or_init(resolve_login_shell_environment).clone()
}

#[cfg(unix)]
fn resolve_login_shell_environment() -> Vec<(String, String)> {
    use std::process::Stdio;

    // A sentinel separates any startup chatter the rc files print from our
    // env dump. `env -0` is NUL-delimited so values containing newlines (and
    // any noise before the sentinel) can't corrupt the parse.
    const SENTINEL: &str = "__ARGMAX_ENV_BOUNDARY__";
    let shell = provider_shell();
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
fn resolve_login_shell_environment() -> Vec<(String, String)> {
    Vec::new()
}

pub fn provider_shell() -> String {
    match env::var("SHELL") {
        Ok(shell) if shell.starts_with('/') => shell,
        _ => "/bin/zsh".to_string(),
    }
}

pub fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

pub fn provider_path(current_path: Option<&str>) -> String {
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
    fn shell_quote_escapes_single_quotes() {
        assert_eq!(shell_quote("it's fine"), "'it'\\''s fine'");
    }

    fn pairs(items: &[(&str, &str)]) -> Vec<(String, String)> {
        items
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect()
    }

    fn lookup<'a>(env: &'a [(String, String)], key: &str) -> Option<&'a str> {
        env.iter()
            .find_map(|(k, v)| (k == key).then_some(v.as_str()))
    }

    #[test]
    fn merge_keeps_login_shell_values_over_bare_process_env() {
        // Mimics the packaged-app case: the login shell has the real config,
        // the process env is the stripped launchd environment.
        let base = pairs(&[
            ("CLAUDE_CONFIG_DIR", "/Users/me/.claude"),
            ("PATH", "/opt/homebrew/bin:/Users/me/.local/bin"),
        ]);
        let process = pairs(&[("PATH", "/usr/bin:/bin"), ("XPC_SERVICE_NAME", "argmax")]);

        let merged = merge_provider_environment(base, process, []);

        assert_eq!(
            lookup(&merged, "CLAUDE_CONFIG_DIR"),
            Some("/Users/me/.claude")
        );
        // Login-shell PATH wins over the bare process PATH (then gets fallbacks
        // appended), so the shell's custom entries survive.
        let path = lookup(&merged, "PATH").unwrap();
        assert!(path.starts_with("/opt/homebrew/bin:/Users/me/.local/bin"));
        // Process-only vars are still carried through.
        assert_eq!(lookup(&merged, "XPC_SERVICE_NAME"), Some("argmax"));
    }

    #[test]
    fn merge_overrides_win_over_base_and_process() {
        let base = pairs(&[("NO_COLOR", "0")]);
        let process = pairs(&[("TERM", "dumb")]);
        let overrides = pairs(&[("NO_COLOR", "1"), ("TERM", "xterm-256color")]);

        let merged = merge_provider_environment(base, process, overrides);

        assert_eq!(lookup(&merged, "NO_COLOR"), Some("1"));
        assert_eq!(lookup(&merged, "TERM"), Some("xterm-256color"));
    }

    #[test]
    fn merge_falls_back_to_process_env_when_base_empty() {
        // Hydration failure / non-Unix: behave like the pre-hydration code.
        let process = pairs(&[("CLAUDE_CONFIG_DIR", "/Users/me/.claude")]);

        let merged = merge_provider_environment(Vec::new(), process, []);

        assert_eq!(
            lookup(&merged, "CLAUDE_CONFIG_DIR"),
            Some("/Users/me/.claude")
        );
        assert!(lookup(&merged, "PATH").is_some());
    }

    #[test]
    fn provider_path_preserves_order_and_dedupes() {
        let path = provider_path(Some("/bin:/usr/bin:/bin"));
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
}
