// Graceful child termination with SIGKILL escalation.
//
// `terminate_with_escalation` is the ONLY path that promises the timed
// SIGTERM → wait `GRACEFUL_TIMEOUT_MS` → SIGKILL escalation. It takes the
// child by `&mut` so it can `try_wait` it after each step and *reap* the
// zombie once the kernel marks the process as exited.
//
// The function is generic over a small `TermChild` trait so the same
// implementation can drive both `tokio::process::Child` (for direct
// shellouts) and `portable_pty::Child` (wrapped under providers/, where
// the PTY master keeps the child handle).
//
// The synchronous safety-net in `ProviderSessionHandle::Drop` (added
// later in providers/session_service.rs) does NOT call into this
// function — Drop cannot await `tokio::time::sleep`.

use std::time::Duration;
use tokio::time::sleep;

#[cfg(unix)]
use nix::sys::signal::{kill, Signal};
#[cfg(unix)]
use nix::unistd::Pid;

pub const GRACEFUL_TIMEOUT_MS: u64 = 1500;
const POLL_INTERVAL_MS: u64 = 50;

/// PID-based variant of `terminate_with_escalation`. Sends SIGTERM,
/// sleeps `GRACEFUL_TIMEOUT_MS`, then SIGKILL — no `try_wait` polling,
/// because callers that own the child handle behind a `wait()`-blocking
/// thread (PTYs via `portable_pty`, see `mcp::auth` and
/// `terminal::service`) can't safely share that handle with this
/// function.
///
/// Best-effort: signal failures are not bubbled — the caller has
/// already decided the process must die, and a separate exit watcher
/// reaps the child when its own `wait()` returns.
#[cfg(unix)]
pub async fn signal_term_then_kill(pid: u32) {
    let nix_pid = Pid::from_raw(pid as i32);
    let _ = kill(nix_pid, Signal::SIGTERM);
    sleep(Duration::from_millis(GRACEFUL_TIMEOUT_MS)).await;
    let _ = kill(nix_pid, Signal::SIGKILL);
}

/// Synchronous best-effort variant. Use from `Drop` (where awaiting a
/// sleep is unsafe) — sends SIGTERM and an immediate SIGKILL, no grace
/// window. Mirrors the `ProviderSessionHandle::Drop` shape.
#[cfg(unix)]
pub fn signal_term_and_kill_blocking(pid: u32) {
    let nix_pid = Pid::from_raw(pid as i32);
    let _ = kill(nix_pid, Signal::SIGTERM);
    let _ = kill(nix_pid, Signal::SIGKILL);
}

#[cfg(not(unix))]
pub async fn signal_term_then_kill(_pid: u32) {
    // Windows path is not supported in v1 — TerminalService/McpAuth will
    // own platform-specific kill logic here when added.
}

#[cfg(not(unix))]
pub fn signal_term_and_kill_blocking(_pid: u32) {}

#[derive(Debug, thiserror::Error)]
pub enum TerminateError {
    #[error("io error during termination: {0}")]
    Io(#[from] std::io::Error),
}

/// Minimal child-handle surface that `terminate_with_escalation` needs:
/// the PID (for signalling) and `try_wait` (for non-blocking reap).
pub trait TermChild {
    /// Returns the OS process id, or `None` if the child has already been
    /// reaped (in which case there's nothing to terminate).
    fn pid(&self) -> Option<u32>;

    /// Polls the child without blocking. Returns `Ok(Some(_))` when the
    /// process has exited and was reaped by this call, `Ok(None)` while
    /// the process is still running.
    fn try_wait(&mut self) -> std::io::Result<Option<i32>>;
}

impl TermChild for tokio::process::Child {
    fn pid(&self) -> Option<u32> {
        self.id()
    }

    fn try_wait(&mut self) -> std::io::Result<Option<i32>> {
        match tokio::process::Child::try_wait(self)? {
            Some(status) => Ok(Some(status.code().unwrap_or(-1))),
            None => Ok(None),
        }
    }
}

/// Sends SIGTERM, polls `try_wait` for up to `GRACEFUL_TIMEOUT_MS`, then
/// escalates to SIGKILL and reaps the child. Best-effort: signal failures
/// are not bubbled — the caller has already decided the process must die,
/// and the OS will surface any post-termination state via `try_wait`.
#[cfg(unix)]
pub async fn terminate_with_escalation<C: TermChild>(
    child: &mut C,
) -> Result<TerminateOutcome, TerminateError> {
    let raw_pid = match child.pid() {
        Some(p) => p,
        None => return Ok(TerminateOutcome::AlreadyReaped),
    };
    let pid = Pid::from_raw(raw_pid as i32);

    // Polite ask.
    let _ = kill(pid, Signal::SIGTERM);

    // Poll until the grace window elapses. If the child exits on its own
    // during the window, we reap it via `try_wait` and return early —
    // no SIGKILL needed.
    let deadline_ms = GRACEFUL_TIMEOUT_MS;
    let mut waited_ms = 0u64;
    while waited_ms < deadline_ms {
        sleep(Duration::from_millis(POLL_INTERVAL_MS)).await;
        waited_ms += POLL_INTERVAL_MS;
        if child.try_wait()?.is_some() {
            return Ok(TerminateOutcome::ExitedGracefully);
        }
    }

    // Force.
    let _ = kill(pid, Signal::SIGKILL);

    // SIGKILL is synchronous-ish but the kernel still needs a moment to
    // mark the process as exited and waitpid()-reapable. Poll briefly.
    for _ in 0..20 {
        sleep(Duration::from_millis(POLL_INTERVAL_MS)).await;
        if child.try_wait()?.is_some() {
            return Ok(TerminateOutcome::KilledAndReaped);
        }
    }

    // Couldn't observe the reap — return Killed so the caller knows we
    // sent SIGKILL but the child handle may still be holding state.
    Ok(TerminateOutcome::KilledNotReaped)
}

#[cfg(not(unix))]
pub async fn terminate_with_escalation<C: TermChild>(
    _child: &mut C,
) -> Result<TerminateOutcome, TerminateError> {
    Err(TerminateError::Io(std::io::Error::new(
        std::io::ErrorKind::Unsupported,
        "process termination not implemented for this platform",
    )))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TerminateOutcome {
    /// The child was already gone before we tried to signal it.
    AlreadyReaped,
    /// Process exited within the SIGTERM grace window and was reaped.
    ExitedGracefully,
    /// SIGKILL was needed; the child was reaped after escalation.
    KilledAndReaped,
    /// SIGKILL was sent but reap wasn't observed before we gave up
    /// polling. The OS will reap eventually; the handle may be stale.
    KilledNotReaped,
}

#[cfg(test)]
#[cfg(unix)]
mod tests {
    use super::*;
    use tokio::process::Command;

    #[tokio::test]
    async fn long_running_sleep_is_terminated_and_reaped() {
        let mut child = Command::new("sleep")
            .arg("60")
            .spawn()
            .expect("spawn sleep");
        let outcome = terminate_with_escalation(&mut child)
            .await
            .expect("terminate ok");
        assert!(
            matches!(
                outcome,
                TerminateOutcome::ExitedGracefully | TerminateOutcome::KilledAndReaped
            ),
            "unexpected outcome: {outcome:?}",
        );
        // Second try_wait must agree the child is gone.
        assert!(child.try_wait().expect("try_wait").is_some());
    }

    #[tokio::test]
    async fn already_reaped_child_is_a_noop() {
        let mut child = Command::new("true").spawn().expect("spawn true");
        // Reap eagerly so .pid() returns None.
        let _ = child.wait().await;
        let outcome = terminate_with_escalation(&mut child)
            .await
            .expect("terminate ok");
        assert_eq!(outcome, TerminateOutcome::AlreadyReaped);
    }
}
