use std::{
    collections::BTreeSet,
    env,
    ffi::OsString,
    path::{Path, PathBuf},
};

pub fn build_provider_environment(
    overrides: impl IntoIterator<Item = (String, String)>,
) -> Vec<(String, String)> {
    let mut env_map: Vec<(String, String)> = env::vars().collect();
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
