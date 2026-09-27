// The Jev API key the user saves in Settings → Agents. It is the only switch
// for Auto routing: no key, no Auto. Stored in the macOS Keychain through
// `security`, the tool Argmax already reads Claude's credentials with. The key
// travels on stdin (`security -i`), never in an argv another process could
// read. Each profile gets its own item, so a scratch instance started with
// ARGMAX_DATA_DIR never reads or overwrites the real app's key.

use std::{
    io::Write,
    process::{Command, Stdio},
    sync::Mutex,
};

use crate::error::{ArgmaxError, ArgmaxResult};

const KEYCHAIN_SERVICE: &str = "Argmax Jev API key";

/// `None` until first read; then the stored key, or `Some(None)` for none.
/// Spawning `security` per launch would cost a process each time.
static CACHE: Mutex<Option<Option<String>>> = Mutex::new(None);

pub fn stored_key() -> Option<String> {
    let mut cache = CACHE
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    cache.get_or_insert_with(read_keychain).clone()
}

pub fn store_key(api_key: &str) -> ArgmaxResult<()> {
    let api_key = validate_format(api_key)?;
    run_security_script(&format!(
        "add-generic-password -U -s \"{KEYCHAIN_SERVICE}\" -a \"{}\" -w \"{api_key}\"\n",
        keychain_account()
    ))?;
    *CACHE
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(Some(api_key.to_string()));
    Ok(())
}

pub fn clear_key() -> ArgmaxResult<()> {
    // A missing item is already the state we want, so the exit code is moot.
    let _ = Command::new("security")
        .args(["delete-generic-password", "-s", KEYCHAIN_SERVICE, "-a"])
        .arg(keychain_account())
        .output();
    *CACHE
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(None);
    Ok(())
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

/// Rejects anything but the token characters API keys use, loudly: the key is
/// written into a `security` command line on stdin, so a quote or newline
/// must never reach it.
pub(crate) fn validate_format(api_key: &str) -> ArgmaxResult<&str> {
    let api_key = api_key.trim();
    if api_key.len() < 16 || api_key.len() > 512 {
        return Err(ArgmaxError::service(
            "ROUTING_KEY_INVALID",
            "That doesn't look like a Jev API key: it should be 16 to 512 characters.",
        ));
    }
    if !api_key
        .chars()
        .all(|character| character.is_ascii_alphanumeric() || "-_.".contains(character))
    {
        return Err(ArgmaxError::service(
            "ROUTING_KEY_INVALID",
            "That doesn't look like a Jev API key: it may only contain letters, digits, '-', '_' and '.'.",
        ));
    }
    Ok(api_key)
}

fn keychain_account() -> String {
    std::env::var("ARGMAX_DATA_DIR")
        .ok()
        .filter(|dir| !dir.trim().is_empty())
        .unwrap_or_else(|| "default".to_string())
}

fn read_keychain() -> Option<String> {
    let output = Command::new("security")
        .args(["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a"])
        .arg(keychain_account())
        .arg("-w")
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let key = String::from_utf8(output.stdout).ok()?;
    let key = key.trim();
    (!key.is_empty()).then(|| key.to_string())
}

fn run_security_script(script: &str) -> ArgmaxResult<()> {
    let keychain_error = |detail: String| {
        ArgmaxError::service(
            "ROUTING_KEYCHAIN_FAILED",
            format!("Could not save the Jev API key to the Keychain: {detail}"),
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn format_check_rejects_short_keys_and_shell_characters() {
        assert!(validate_format("ts_live_0123456789abcdef").is_ok());
        assert!(validate_format("  ts_live_0123456789abcdef \n").is_ok());
        assert!(validate_format("short").is_err());
        assert!(validate_format("ts_live_0123456789\"; rm -rf").is_err());
        assert!(validate_format("ts_live_0123456789\nabcdef").is_err());
    }

    #[test]
    fn hint_shows_only_the_last_four_characters() {
        assert_eq!(key_hint("ts_live_0123456789abcd"), "…abcd");
    }
}
