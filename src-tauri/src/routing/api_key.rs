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

/// Verification builds must never reach the real Keychain, where the saved Jev
/// key lives. This is fail-closed like the usage and provider fences: any
/// `ARGMAX_VERIFICATION` value counts, a typo included. The app reads its
/// routing settings on every start, so without it each disposable app would
/// ask the host Keychain for a key.
fn keychain_fenced() -> bool {
    crate::providers::verification::requested()
}

pub fn stored_key() -> Option<String> {
    // No key is the definite answer here, so Auto stays off and nothing retries.
    if keychain_fenced() {
        return None;
    }
    let mut cache = CACHE
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if cache.is_none() {
        // A failed read (locked keychain, `security` unavailable) is not
        // "no key". Leave the cache empty so the next call retries; caching
        // it would hide every Router row until the app restarted.
        match read_keychain() {
            Some(found) => *cache = Some(found),
            None => return None,
        }
    }
    cache.clone().flatten()
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
    if keychain_fenced() {
        return Ok(());
    }
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

/// `None` when the read itself failed; `Some(None)` when the Keychain
/// answered that no item exists (`security` exits 44).
fn read_keychain() -> Option<Option<String>> {
    let output = Command::new("security")
        .args(["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a"])
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

fn run_security_script(script: &str) -> ArgmaxResult<()> {
    if keychain_fenced() {
        return Err(ArgmaxError::service(
            "ROUTING_KEYCHAIN_FAILED",
            "The Keychain is disabled in verification mode.",
        ));
    }
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

    const VERIFICATION_CHILD_ENV: &str = "ARGMAX_VERIFICATION_KEYCHAIN_TEST_CHILD";

    // `security` is the only way in to the Keychain, so a stand-in on PATH that
    // logs each call proves none happens. The child runs with a clean
    // environment because the fence reads it, and a test must not set it here.
    #[cfg(target_os = "macos")]
    #[test]
    fn verification_never_reaches_the_keychain() {
        if std::env::var_os(VERIFICATION_CHILD_ENV).is_some() {
            assert_eq!(stored_key(), None);
            assert!(clear_key().is_ok());
            let error = store_key("ts_live_0123456789abcdef").expect_err("store is fenced");
            assert!(error.to_string().contains("verification mode"));
            assert!(!std::path::Path::new(
                &std::env::var("ARGMAX_VERIFICATION_KEYCHAIN_TEST_LOG").expect("fixture log")
            )
            .exists());
            return;
        }

        use std::os::unix::fs::PermissionsExt;

        let profile = tempfile::tempdir().expect("isolated profile");
        let bin = profile.path().join("bin");
        std::fs::create_dir(&bin).expect("fixture bin");
        let security = bin.join("security");
        std::fs::write(
            &security,
            "#!/bin/sh\nprintf '%s\\n' invoked >> \"$ARGMAX_VERIFICATION_KEYCHAIN_TEST_LOG\"\nexit 44\n",
        )
        .expect("fixture executable");
        std::fs::set_permissions(&security, std::fs::Permissions::from_mode(0o755))
            .expect("executable permissions");

        for mode in ["1", "malformed"] {
            let output = std::process::Command::new(std::env::current_exe().expect("test binary"))
                .args([
                    "--exact",
                    "routing::api_key::tests::verification_never_reaches_the_keychain",
                    "--nocapture",
                ])
                .env_clear()
                .env(VERIFICATION_CHILD_ENV, "1")
                .env(crate::providers::verification::MODE_ENV, mode)
                .env("HOME", profile.path())
                .env("PATH", format!("{}:/usr/bin:/bin", bin.display()))
                .env(
                    "ARGMAX_VERIFICATION_KEYCHAIN_TEST_LOG",
                    profile.path().join("invocations.log"),
                )
                .output()
                .expect("verification child");
            assert!(
                output.status.success(),
                "verification child ({mode}) failed:\nstdout:\n{}\nstderr:\n{}",
                String::from_utf8_lossy(&output.stdout),
                String::from_utf8_lossy(&output.stderr)
            );
            // `--exact` matching no test also exits 0, so a renamed test must
            // not pass silently: the child has to report that it ran.
            assert!(
                String::from_utf8_lossy(&output.stdout).contains("test result: ok. 1 passed"),
                "verification child ({mode}) ran no test:\nstdout:\n{}",
                String::from_utf8_lossy(&output.stdout)
            );
        }
    }
}
