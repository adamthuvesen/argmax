// Shared `gh` CLI runner for PR refresh and PR creation. Production calls go
// through `default_gh_runner()`; tests stub `GhRunner` directly.

use std::{future::Future, pin::Pin, sync::Arc, time::Duration};

use crate::error::{ArgmaxError, ArgmaxResult};

fn gh_command(cwd: String, args: Vec<String>) -> tokio::process::Command {
    let mut command = tokio::process::Command::new("gh");
    command.current_dir(cwd).args(args);
    // Finder and Dock launches omit Homebrew paths from the inherited PATH.
    #[cfg(unix)]
    command.env("PATH", crate::util::login_shell::path());
    command
}

/// `gh` is invoked via this closure so tests can stub the binary.
pub type GhRunner = Arc<
    dyn Fn(String, Vec<String>) -> Pin<Box<dyn Future<Output = ArgmaxResult<String>> + Send>>
        + Send
        + Sync,
>;

/// Default wall-clock cap for a single `gh` invocation. `gh pr view`
/// against a slow remote can take a few seconds; 15s leaves headroom
/// without letting the renderer stare at a frozen dropdown forever.
pub const DEFAULT_GH_TIMEOUT: Duration = Duration::from_secs(15);

/// Production constructor — runs the real `gh` binary under
/// `DEFAULT_GH_TIMEOUT`, surfacing stderr on non-zero exit and rejecting
/// non-UTF-8 stdout.
pub fn default_gh_runner() -> GhRunner {
    Arc::new(move |cwd: String, args: Vec<String>| {
        Box::pin(async move {
            use std::process::Stdio;
            // `kill_on_drop` ensures the child is reaped if the timeout
            // fires (or the future is cancelled) — without it, a stuck
            // `gh` (bad creds, network hang) leaks a process per tick.
            // stdin is closed so a `gh` that prompts for input can't
            // block indefinitely before the timeout even starts ticking.
            let child = gh_command(cwd, args)
                .stdin(Stdio::null())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .kill_on_drop(true)
                .spawn()
                .map_err(|error| {
                    ArgmaxError::service("GH_SPAWN_FAILED", format!("failed to run gh: {error}"))
                })?;
            let output = tokio::time::timeout(DEFAULT_GH_TIMEOUT, child.wait_with_output())
                .await
                .map_err(|_| {
                    ArgmaxError::service(
                        "GH_TIMEOUT",
                        format!("gh timed out after {DEFAULT_GH_TIMEOUT:?}"),
                    )
                })?
                .map_err(|error| {
                    ArgmaxError::service("GH_WAIT_FAILED", format!("gh wait failed: {error}"))
                })?;
            if !output.status.success() {
                let stderr = String::from_utf8_lossy(&output.stderr);
                return Err(ArgmaxError::service(
                    "GH_NON_ZERO_EXIT",
                    format!("gh failed: {}", stderr.trim()),
                ));
            }
            String::from_utf8(output.stdout).map_err(|error| {
                ArgmaxError::service(
                    "GH_STDOUT_NOT_UTF8",
                    format!("gh stdout was not valid UTF-8: {error}"),
                )
            })
        })
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    #[test]
    fn gh_command_hydrates_path_for_packaged_app() {
        let command = gh_command(".".to_string(), vec!["--version".to_string()]);
        let path = command
            .as_std()
            .get_envs()
            .find_map(|(key, value)| (key == "PATH").then_some(value).flatten())
            .expect("gh command PATH");
        let entries = std::env::split_paths(path).collect::<Vec<_>>();

        assert!(entries.contains(&std::path::PathBuf::from("/opt/homebrew/bin")));
        assert!(entries.contains(&std::path::PathBuf::from("/usr/local/bin")));
    }
}
