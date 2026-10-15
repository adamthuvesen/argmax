//! API keys the user saves in Settings, kept in the macOS Keychain through
//! `security`, the tool Argmax already reads Claude's credentials with. The key
//! travels on stdin (`security -i`), never in an argv another process could
//! read. Each profile gets its own item, so a scratch instance started with
//! ARGMAX_DATA_DIR never reads or overwrites the real app's key.

use std::{
    io::Write,
    process::{Command, Stdio},
    sync::Mutex,
};

use crate::error::{ArgmaxError, ArgmaxResult};

/// One saved key: a Keychain service name plus the words its errors use.
pub struct KeychainSecret {
    service: &'static str,
    /// How errors name the key: "Jev API key".
    name: &'static str,
    invalid_code: &'static str,
    failed_code: &'static str,
    /// `None` until first read; then the stored key, or `Some(None)` for none.
    /// Spawning `security` per launch would cost a process each time.
    cache: Mutex<Option<Option<String>>>,
}

impl KeychainSecret {
    pub const fn new(
        service: &'static str,
        name: &'static str,
        invalid_code: &'static str,
        failed_code: &'static str,
    ) -> Self {
        Self {
            service,
            name,
            invalid_code,
            failed_code,
            cache: Mutex::new(None),
        }
    }

    pub fn stored(&self) -> Option<String> {
        self.read().ok().flatten()
    }

    /// The saved key, telling a failed read apart from no key. A caller that
    /// would otherwise fall back to some other credential uses this, so a
    /// locked Keychain fails the call instead of billing another account.
    pub fn read(&self) -> ArgmaxResult<Option<String>> {
        // No key is the definite answer here, so nothing retries.
        if keychain_fenced() {
            return Ok(None);
        }
        let mut cache = self.lock();
        if cache.is_none() {
            // A failed read (locked keychain, `security` unavailable) is not
            // "no key". Leave the cache empty so the next call retries; caching
            // it would hide the key until the app restarted.
            match read_keychain(self.service) {
                Some(found) => *cache = Some(found),
                None => {
                    return Err(ArgmaxError::service(
                        self.failed_code,
                        format!("Could not read the {} from the Keychain.", self.name),
                    ))
                }
            }
        }
        Ok(cache.clone().flatten())
    }

    pub fn store(&self, api_key: &str) -> ArgmaxResult<()> {
        let api_key = self.validate_format(api_key)?;
        self.run_security_script(&format!(
            "add-generic-password -U -s \"{}\" -a \"{}\" -w \"{api_key}\"\n",
            self.service,
            keychain_account()
        ))?;
        // `security -i` can report a failed add (a locked Keychain says "User
        // interaction is not allowed") and still exit 0, so read the item back
        // rather than trusting its stderr: a key only cached in memory would
        // vanish at the next restart.
        if read_keychain(self.service) != Some(Some(api_key.to_string())) {
            return Err(ArgmaxError::service(
                self.failed_code,
                format!(
                    "Could not save the {} to the Keychain. Unlock it and try again.",
                    self.name
                ),
            ));
        }
        *self.lock() = Some(Some(api_key.to_string()));
        Ok(())
    }

    pub fn clear(&self) -> ArgmaxResult<()> {
        if keychain_fenced() {
            return Ok(());
        }
        let removal_error = |detail: String| {
            ArgmaxError::service(
                self.failed_code,
                format!(
                    "Could not remove the {} from the Keychain: {detail}",
                    self.name
                ),
            )
        };
        let output = Command::new("security")
            .args(["delete-generic-password", "-s", self.service, "-a"])
            .arg(keychain_account())
            .output()
            .map_err(|error| removal_error(error.to_string()))?;
        // 44 is a missing item, which is already the state we want. Anything
        // else (a locked Keychain, denied access) leaves the key in place, so
        // the cache keeps it and Settings keeps showing it.
        if !output.status.success() && output.status.code() != Some(44) {
            return Err(removal_error(
                String::from_utf8_lossy(&output.stderr).trim().to_string(),
            ));
        }
        *self.lock() = Some(None);
        Ok(())
    }

    /// Rejects anything but the token characters API keys use, loudly: the
    /// key is written into a `security` command line on stdin, so a quote or
    /// newline must never reach it.
    pub fn validate_format<'a>(&self, api_key: &'a str) -> ArgmaxResult<&'a str> {
        let api_key = api_key.trim();
        if api_key.len() < 16 || api_key.len() > 512 {
            return Err(ArgmaxError::service(
                self.invalid_code,
                format!(
                    "That doesn't look like a valid {}: it should be 16 to 512 characters.",
                    self.name
                ),
            ));
        }
        if !api_key
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || "-_.".contains(character))
        {
            return Err(ArgmaxError::service(
                self.invalid_code,
                format!(
                    "That doesn't look like a valid {}: it may only contain letters, digits, '-', '_' and '.'.",
                    self.name
                ),
            ));
        }
        Ok(api_key)
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Option<Option<String>>> {
        self.cache
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn run_security_script(&self, script: &str) -> ArgmaxResult<()> {
        if keychain_fenced() {
            return Err(ArgmaxError::service(
                self.failed_code,
                "The Keychain is disabled in verification mode.",
            ));
        }
        let keychain_error = |detail: String| {
            ArgmaxError::service(
                self.failed_code,
                format!("Could not save the {} to the Keychain: {detail}", self.name),
            )
        };
        let mut child = Command::new("security")
            .arg("-i")
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|error| keychain_error(error.to_string()))?;
        child
            .stdin
            .take()
            .ok_or_else(|| keychain_error("no stdin".to_string()))?
            .write_all(script.as_bytes())
            .map_err(|error| keychain_error(error.to_string()))?;
        let output = child
            .wait_with_output()
            .map_err(|error| keychain_error(error.to_string()))?;
        // `security -i` exits 0 even when a command fails; the failure is on stderr.
        let stderr = String::from_utf8_lossy(&output.stderr);
        if !output.status.success() || stderr.contains("error") {
            return Err(keychain_error(stderr.trim().to_string()));
        }
        Ok(())
    }
}

/// The last four characters, for Settings to show which key is saved.
pub fn key_hint(api_key: &str) -> String {
    let tail: String = api_key
        .chars()
        .rev()
        .take(4)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect();
    format!("…{tail}")
}

/// Verification builds must never reach the real Keychain, where saved keys
/// live. This is fail-closed like the usage and provider fences: any
/// `ARGMAX_VERIFICATION` value counts, a typo included.
fn keychain_fenced() -> bool {
    crate::providers::verification::requested()
}

fn keychain_account() -> String {
    std::env::var("ARGMAX_DATA_DIR")
        .ok()
        .filter(|dir| !dir.trim().is_empty())
        .unwrap_or_else(|| "default".to_string())
}

/// `None` when the read itself failed; `Some(None)` when the Keychain
/// answered that no item exists (`security` exits 44).
fn read_keychain(service: &str) -> Option<Option<String>> {
    let output = Command::new("security")
        .args(["find-generic-password", "-s", service, "-a"])
        .arg(keychain_account())
        .arg("-w")
        .output()
        .ok()?;
    if output.status.code() == Some(44) {
        return Some(None);
    }
    if !output.status.success() {
        return None;
    }
    let key = String::from_utf8(output.stdout).ok()?;
    let key = key.trim();
    Some((!key.is_empty()).then(|| key.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    static SECRET: KeychainSecret = KeychainSecret::new(
        "Argmax test key",
        "test key",
        "TEST_KEY_INVALID",
        "TEST_KEYCHAIN_FAILED",
    );

    #[test]
    fn format_check_rejects_short_keys_and_shell_characters() {
        assert!(SECRET.validate_format("ts_live_0123456789abcdef").is_ok());
        assert!(SECRET
            .validate_format("  ts_live_0123456789abcdef \n")
            .is_ok());
        assert!(SECRET.validate_format("short").is_err());
        assert!(SECRET
            .validate_format("ts_live_0123456789\"; rm -rf")
            .is_err());
        assert!(SECRET
            .validate_format("ts_live_0123456789\nabcdef")
            .is_err());
        let error = SECRET.validate_format("short").expect_err("too short");
        assert!(error.to_string().contains("a valid test key"));
    }

    #[test]
    fn hint_shows_only_the_last_four_characters() {
        assert_eq!(key_hint("ts_live_0123456789abcd"), "…abcd");
    }
}
