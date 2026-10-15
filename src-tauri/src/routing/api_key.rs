// The Jev API key the user saves in Settings → Agents. It is the only switch
// for Auto routing: no key, no Auto. Stored in the macOS Keychain; see
// `util::keychain` for how the key is kept off argv and apart per profile.

use crate::error::ArgmaxResult;
use crate::util::keychain::KeychainSecret;

static JEV_KEY: KeychainSecret = KeychainSecret::new(
    "Argmax Jev API key",
    "Jev API key",
    "ROUTING_KEY_INVALID",
    "ROUTING_KEYCHAIN_FAILED",
);

pub fn stored_key() -> Option<String> {
    JEV_KEY.stored()
}

pub fn store_key(api_key: &str) -> ArgmaxResult<()> {
    JEV_KEY.store(api_key)
}

pub fn clear_key() -> ArgmaxResult<()> {
    JEV_KEY.clear()
}

pub use crate::util::keychain::key_hint;

pub(crate) fn validate_format(api_key: &str) -> ArgmaxResult<&str> {
    JEV_KEY.validate_format(api_key)
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
