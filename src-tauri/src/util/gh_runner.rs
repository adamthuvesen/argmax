// Shared `gh` CLI invocation shape.
//
// Both `gh::service` (PR row refresh) and `git::ops` (PR create) shell
// out to the `gh` binary. They used to carry their own copy of the same
// closure type + default constructor — that drift was deliberate per
// the section-8 spec, but folding it into one helper closes the gap and
// gives both call sites the 15s timeout (which `git::ops`'s copy was
// previously missing — a latent hang on a slow `gh pr create`).
//
// Tests in either subsystem stub `GhRunner` directly; the production
// path goes through `default_gh_runner()`.

use std::{future::Future, pin::Pin, sync::Arc, time::Duration};

use crate::error::{ArgmaxError, ArgmaxResult};

/// `gh` is invoked via this closure so tests can stub the binary the
/// same way the TS code injects a fake `ghRunner`.
pub type GhRunner = Arc<
    dyn Fn(String, Vec<String>) -> Pin<Box<dyn Future<Output = ArgmaxResult<String>> + Send>>
        + Send
        + Sync,
>;

/// Default wall-clock cap for a single `gh` invocation. `gh pr view`
/// against a slow remote can take a few seconds; 15s leaves headroom
/// without letting the renderer stare at a frozen dropdown forever.
pub const DEFAULT_GH_TIMEOUT: Duration = Duration::from_secs(15);

/// Production constructor — runs the real `gh` binary under the
/// configured timeout, surfacing stderr on non-zero exit and rejecting
/// non-UTF-8 stdout.
pub fn default_gh_runner() -> GhRunner {
    default_gh_runner_with_timeout(DEFAULT_GH_TIMEOUT)
}

/// Like `default_gh_runner` but with a caller-supplied timeout — used
/// when a subsystem wants tighter or looser bounds (e.g. the poller's
/// per-tick budget).
pub fn default_gh_runner_with_timeout(timeout: Duration) -> GhRunner {
    Arc::new(move |cwd: String, args: Vec<String>| {
        Box::pin(async move {
            use std::process::Stdio;
            use tokio::process::Command;
            // `kill_on_drop` ensures the child is reaped if the timeout
            // fires (or the future is cancelled) — without it, a stuck
            // `gh` (bad creds, network hang) leaks a process per tick.
            // stdin is closed so a `gh` that prompts for input can't
            // block indefinitely before the timeout even starts ticking.
            let child = Command::new("gh")
                .current_dir(cwd)
                .args(&args)
                .stdin(Stdio::null())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .kill_on_drop(true)
                .spawn()
                .map_err(|error| {
                    ArgmaxError::service("GH_SPAWN_FAILED", format!("failed to run gh: {error}"))
                })?;
            let output = tokio::time::timeout(timeout, child.wait_with_output())
                .await
                .map_err(|_| {
                    ArgmaxError::service("GH_TIMEOUT", format!("gh timed out after {timeout:?}"))
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
