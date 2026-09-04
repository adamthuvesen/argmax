use std::env;

use crate::util::login_shell;

pub fn build_provider_environment(
    overrides: impl IntoIterator<Item = (String, String)>,
) -> Vec<(String, String)> {
    if super::verification::requested() {
        return verification_environment(overrides);
    }
    // Base the child environment on the user's real login-shell environment,
    // then fill in anything unique to our own process. When Argmax is launched
    // from Finder/Dock it inherits only launchd's minimal environment — no
    // `CLAUDE_CONFIG_DIR`, a bare `PATH`, none of the shell-exported vars that
    // `claude`/`codex`/`cursor` need to resolve credentials. That's the
    // "works in `tauri dev`, fails in the packaged app, claude says not logged
    // in" symptom. Hydrating the login shell makes both launch paths identical.
    merge_provider_environment(login_shell::environment(), env::vars(), overrides)
}

/// A verification fixture gets only the process plumbing it needs. In
/// particular, provider credentials and config paths from the user's login
/// shell never enter the child. Startup validation requires an isolated HOME;
/// the deliberately nonexistent fallback keeps lower-level calls fail-closed
/// if they are exercised before that validation.
fn verification_environment(
    overrides: impl IntoIterator<Item = (String, String)>,
) -> Vec<(String, String)> {
    verification_environment_from(std::env::vars(), overrides)
}

fn verification_environment_from(
    process: impl IntoIterator<Item = (String, String)>,
    overrides: impl IntoIterator<Item = (String, String)>,
) -> Vec<(String, String)> {
    let process = process.into_iter().collect::<Vec<_>>();
    let lookup = |key: &str| {
        process
            .iter()
            .find_map(|(candidate, value)| (candidate == key).then(|| value.clone()))
    };
    let verification_home = lookup(super::verification::HOME_ENV).unwrap_or_else(|| {
        std::env::temp_dir()
            .join("argmax-verification-home-not-configured")
            .to_string_lossy()
            .into_owned()
    });
    let mut environment = vec![
        ("HOME".to_string(), verification_home.clone()),
        (
            "XDG_CONFIG_HOME".to_string(),
            format!("{verification_home}/.config"),
        ),
        (
            "XDG_DATA_HOME".to_string(),
            format!("{verification_home}/.local/share"),
        ),
        (
            "XDG_CACHE_HOME".to_string(),
            format!("{verification_home}/.cache"),
        ),
        (
            "PATH".to_string(),
            lookup("PATH").unwrap_or_else(|| "/usr/bin:/bin".to_string()),
        ),
        (super::verification::MODE_ENV.to_string(), "1".to_string()),
    ];
    for key in ["TMPDIR", "LANG", "LC_ALL"] {
        if let Some(value) = lookup(key) {
            environment.push((key.to_string(), value));
        }
    }
    for (key, value) in process
        .iter()
        .filter(|(key, _)| key.starts_with("ARGMAX_VERIFICATION_"))
    {
        environment.push((key.clone(), value.clone()));
    }
    for (key, value) in overrides {
        if let Some((_, current)) = environment
            .iter_mut()
            .find(|(candidate, _)| candidate == &key)
        {
            *current = value;
        } else {
            environment.push((key, value));
        }
    }
    environment
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
    let path = login_shell::path_from(current_path);
    if let Some((_, current)) = env_map.iter_mut().find(|(key, _)| key == "PATH") {
        *current = path;
    } else {
        env_map.push(("PATH".to_string(), path));
    }
    env_map
}

#[cfg(test)]
mod tests {
    use super::*;

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
    fn verification_environment_isolates_provider_credentials_and_home() {
        let process = pairs(&[
            ("ARGMAX_VERIFICATION_HOME", "/tmp/verification-home"),
            ("ARGMAX_VERIFICATION_LOG", "/tmp/invocations.jsonl"),
            ("PATH", "/usr/bin:/bin"),
            ("ANTHROPIC_API_KEY", "secret"),
            ("CLAUDE_CONFIG_DIR", "/Users/me/.claude"),
        ]);

        let environment =
            verification_environment_from(process, pairs(&[("TERM", "xterm-256color")]));

        assert_eq!(lookup(&environment, "HOME"), Some("/tmp/verification-home"));
        assert_eq!(
            lookup(&environment, "ARGMAX_VERIFICATION_LOG"),
            Some("/tmp/invocations.jsonl")
        );
        assert_eq!(lookup(&environment, "TERM"), Some("xterm-256color"));
        assert_eq!(lookup(&environment, "ANTHROPIC_API_KEY"), None);
        assert_eq!(lookup(&environment, "CLAUDE_CONFIG_DIR"), None);
    }
}
