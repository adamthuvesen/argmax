//! Verification-only provider process isolation.
//!
//! A verification build must never fall through to a provider installed on the
//! developer's machine. When the mode flag is present, discovery resolves only
//! explicit fixture paths and reports every unconfigured provider as absent.

use std::path::PathBuf;

use super::ProviderId;

pub const MODE_ENV: &str = "ARGMAX_VERIFICATION";
pub const HOME_ENV: &str = "ARGMAX_VERIFICATION_HOME";

/// Whether the process asked for verification mode, including malformed
/// values. Callers use this broader predicate for fail-closed isolation: a
/// typo must never fall through to real provider discovery.
pub fn requested() -> bool {
    std::env::var_os(MODE_ENV).is_some()
}

/// Validates the process-wide contract before app services start. The app boot
/// path calls this so a malformed verification launch exits with one actionable
/// message rather than presenting a misleading provider picker.
pub fn validate_configuration() -> Result<(), String> {
    let Some(mode) = std::env::var_os(MODE_ENV) else {
        return Ok(());
    };
    if mode != "1" {
        return Err(format!("{MODE_ENV} must be exactly 1 when it is set"));
    }
    if !cfg!(feature = "verification") {
        return Err(format!(
            "{MODE_ENV}=1 requires an Argmax binary built with the verification Cargo feature"
        ));
    }
    let home = std::env::var_os(HOME_ENV)
        .map(PathBuf::from)
        .ok_or_else(|| format!("{HOME_ENV} must name an isolated profile directory"))?;
    if !home.is_absolute() || !home.is_dir() {
        return Err(format!(
            "{HOME_ENV} must name an existing absolute directory; received {}",
            home.display()
        ));
    }

    let configured = all_providers()
        .into_iter()
        .filter(|provider| std::env::var_os(binary_env(*provider)).is_some())
        .collect::<Vec<_>>();
    if configured.is_empty() {
        return Err(
            "verification mode requires at least one ARGMAX_VERIFICATION_<PROVIDER>_BINARY"
                .to_string(),
        );
    }
    for provider in configured {
        let variable = binary_env(provider);
        if configured_binary_path(std::env::var_os(variable)).is_none() {
            return Err(format!(
                "{variable} must name an existing absolute executable file"
            ));
        }
    }
    Ok(())
}

pub fn binary_env(provider: ProviderId) -> &'static str {
    match provider {
        ProviderId::Claude => "ARGMAX_VERIFICATION_CLAUDE_BINARY",
        ProviderId::Codex => "ARGMAX_VERIFICATION_CODEX_BINARY",
        ProviderId::Cursor => "ARGMAX_VERIFICATION_CURSOR_BINARY",
        ProviderId::Opencode => "ARGMAX_VERIFICATION_OPENCODE_BINARY",
        ProviderId::Grok => "ARGMAX_VERIFICATION_GROK_BINARY",
    }
}

/// Returns the configured fixture executable for `provider` while verification
/// mode is active. A missing, relative, or non-file path deliberately resolves
/// to `None`; callers must report the provider unavailable and must not search
/// the user's PATH as a fallback.
pub fn binary_path(provider: ProviderId) -> Option<String> {
    if validate_configuration().is_err() {
        return None;
    }
    configured_binary_path(std::env::var_os(binary_env(provider)))
        .map(|path| path.to_string_lossy().into_owned())
}

fn configured_binary_path(value: Option<std::ffi::OsString>) -> Option<PathBuf> {
    let path = PathBuf::from(value?);
    (path.is_absolute() && path.is_file() && is_executable(&path)).then_some(path)
}

fn all_providers() -> [ProviderId; 5] {
    [
        ProviderId::Claude,
        ProviderId::Codex,
        ProviderId::Cursor,
        ProviderId::Opencode,
        ProviderId::Grok,
    ]
}

#[cfg(unix)]
fn is_executable(path: &std::path::Path) -> bool {
    use std::os::unix::fs::PermissionsExt;

    path.metadata()
        .map(|metadata| metadata.permissions().mode() & 0o111 != 0)
        .unwrap_or(false)
}

#[cfg(not(unix))]
fn is_executable(_path: &std::path::Path) -> bool {
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn configured_binary_rejects_missing_and_relative_paths() {
        assert_eq!(configured_binary_path(None), None);
        assert_eq!(
            configured_binary_path(Some("scripts/provider-fixture.mjs".into())),
            None
        );
    }

    #[test]
    fn every_provider_has_a_distinct_override_name() {
        let names = all_providers().map(binary_env);
        let unique = names.into_iter().collect::<std::collections::HashSet<_>>();
        assert_eq!(unique.len(), 5);
    }
}
