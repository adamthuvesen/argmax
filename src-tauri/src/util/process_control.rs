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

use std::{
    sync::atomic::{AtomicBool, Ordering},
    time::Duration,
};
use tokio::time::sleep;

#[cfg(unix)]
use nix::sys::signal::{kill, Signal};
#[cfg(unix)]
use nix::unistd::{getpgid, getsid, Pid};
#[cfg(unix)]
use std::{collections::BTreeMap, process::Command, time::Instant};

pub const GRACEFUL_TIMEOUT_MS: u64 = 1500;
const POLL_INTERVAL_MS: u64 = 50;

/// PID-based variant of `terminate_with_escalation`. Sends SIGTERM,
/// sleeps `GRACEFUL_TIMEOUT_MS`, then SIGKILL — no `try_wait` polling,
/// because callers that own the child handle behind a `wait()`-blocking
/// thread (PTYs via `portable_pty`, see `terminal::service`) can't safely
/// share that handle with this
/// function.
///
/// Best-effort: signal failures are not bubbled — the caller has
/// already decided the process must die, and a separate exit watcher
/// reaps the child when its own `wait()` returns.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SignalTarget {
    Process(u32),
    ProcessGroup(u32),
}

#[cfg(unix)]
impl SignalTarget {
    fn nix_pid(self) -> Pid {
        match self {
            SignalTarget::Process(pid) => Pid::from_raw(pid as i32),
            SignalTarget::ProcessGroup(pgid) => Pid::from_raw(-(pgid as i32)),
        }
    }
}

fn is_reaped(reaped: Option<&AtomicBool>) -> bool {
    reaped
        .map(|flag| flag.load(Ordering::Acquire))
        .unwrap_or(false)
}

#[cfg(unix)]
pub(crate) fn signal_target(target: SignalTarget, signal: Signal) {
    let _ = kill(target.nix_pid(), signal);
}

#[cfg(unix)]
pub async fn signal_target_term_then_kill(target: SignalTarget, reaped: Option<&AtomicBool>) {
    if is_reaped(reaped) {
        return;
    }
    signal_target(target, Signal::SIGTERM);
    sleep(Duration::from_millis(GRACEFUL_TIMEOUT_MS)).await;
    if is_reaped(reaped) {
        return;
    }
    signal_target(target, Signal::SIGKILL);
}

#[cfg(unix)]
pub async fn signal_term_then_kill(pid: u32) {
    signal_target_term_then_kill(SignalTarget::Process(pid), None).await;
}

/// Synchronous best-effort variant. Use from `Drop` (where awaiting a
/// sleep is unsafe) — sends SIGTERM and an immediate SIGKILL, no grace
/// window. Mirrors the `ProviderSessionHandle::Drop` shape.
#[cfg(unix)]
pub fn signal_target_term_and_kill_blocking(target: SignalTarget, reaped: Option<&AtomicBool>) {
    if is_reaped(reaped) {
        return;
    }
    signal_target(target, Signal::SIGTERM);
    if is_reaped(reaped) {
        return;
    }
    signal_target(target, Signal::SIGKILL);
}

#[cfg(unix)]
pub fn signal_term_and_kill_blocking(pid: u32) {
    signal_target_term_and_kill_blocking(SignalTarget::Process(pid), None);
}

#[cfg(unix)]
#[derive(Debug, Clone, Copy)]
struct SessionProcessGroup {
    process_group: u32,
    representative: u32,
}

#[cfg(unix)]
struct SessionSignalStage {
    signaled: usize,
    enumeration_error: Option<String>,
}

/// Enumerates process groups that still belong to a portable-pty session.
/// `/bin/ps` supplies only candidate PIDs. Kernel `getsid` and `getpgid`
/// checks define membership, so platform-specific `ps` session columns and
/// their differing semantics are not involved.
#[cfg(unix)]
fn session_process_groups(session_id: u32) -> std::io::Result<Vec<SessionProcessGroup>> {
    let output = Command::new("/bin/ps")
        .args(["-e", "-o", "pid="])
        .output()?;
    if !output.status.success() {
        return Err(std::io::Error::other(format!(
            "/bin/ps exited with {}",
            output.status
        )));
    }

    let session = Pid::from_raw(session_id as i32);
    let mut groups = BTreeMap::<u32, u32>::new();
    for candidate in String::from_utf8_lossy(&output.stdout).split_whitespace() {
        let Ok(raw_pid) = candidate.parse::<i32>() else {
            continue;
        };
        if raw_pid <= 1 {
            continue;
        }
        let pid = Pid::from_raw(raw_pid);
        let Ok(candidate_session) = getsid(Some(pid)) else {
            continue;
        };
        if candidate_session != session {
            continue;
        }
        let Ok(process_group) = getpgid(Some(pid)) else {
            continue;
        };
        let raw_group = process_group.as_raw();
        if raw_group <= 1 {
            continue;
        }
        let process_group = raw_group as u32;
        let pid = raw_pid as u32;
        groups
            .entry(process_group)
            .and_modify(|representative| {
                if pid == process_group {
                    *representative = pid;
                }
            })
            .or_insert(pid);
    }
    Ok(groups
        .into_iter()
        .map(|(process_group, representative)| SessionProcessGroup {
            process_group,
            representative,
        })
        .collect())
}

#[cfg(unix)]
fn is_current_session_group(session_id: u32, group: SessionProcessGroup) -> bool {
    let representative = Pid::from_raw(group.representative as i32);
    getsid(Some(representative)).is_ok_and(|session| session.as_raw() == session_id as i32)
        && getpgid(Some(representative))
            .is_ok_and(|process_group| process_group.as_raw() == group.process_group as i32)
}

#[cfg(unix)]
fn signal_session_stage(
    session_id: u32,
    fallback_process_groups: &[u32],
    signal: Signal,
) -> SessionSignalStage {
    let (mut groups, enumeration_error) = match session_process_groups(session_id) {
        Ok(groups) => (groups, None),
        Err(error) => (Vec::new(), Some(error.to_string())),
    };
    for &process_group in fallback_process_groups {
        if process_group > 1
            && !groups
                .iter()
                .any(|group| group.process_group == process_group)
        {
            groups.push(SessionProcessGroup {
                process_group,
                representative: process_group,
            });
        }
    }

    let mut signaled = 0;
    for group in groups {
        // PIDs and process-group IDs can be reused. Revalidate one live member
        // immediately before each signal rather than trusting the ps snapshot.
        if is_current_session_group(session_id, group) {
            signal_target(SignalTarget::ProcessGroup(group.process_group), signal);
            signaled += 1;
        }
    }
    SessionSignalStage {
        signaled,
        enumeration_error,
    }
}

#[cfg(unix)]
fn session_signal_result(errors: Vec<String>) -> std::io::Result<()> {
    if errors.is_empty() {
        Ok(())
    } else {
        Err(std::io::Error::other(errors.join("; ")))
    }
}

/// Terminates every process group still in one portable-pty session. The
/// blocking ps snapshots run off the async executor, and SIGKILL uses a fresh
/// snapshot so groups whose leaders exited after SIGTERM are still found.
#[cfg(unix)]
pub async fn signal_pty_session_term_then_kill(
    session_id: u32,
    fallback_process_groups: Vec<u32>,
) -> std::io::Result<()> {
    let term_fallback = fallback_process_groups.clone();
    let term = tokio::task::spawn_blocking(move || {
        signal_session_stage(session_id, &term_fallback, Signal::SIGTERM)
    })
    .await
    .unwrap_or_else(|error| SessionSignalStage {
        signaled: 0,
        enumeration_error: Some(format!("blocking SIGTERM task failed: {error}")),
    });

    if term.signaled > 0 {
        sleep(Duration::from_millis(GRACEFUL_TIMEOUT_MS)).await;
    }
    let kill = tokio::task::spawn_blocking(move || {
        signal_session_stage(session_id, &fallback_process_groups, Signal::SIGKILL)
    })
    .await
    .unwrap_or_else(|error| SessionSignalStage {
        signaled: 0,
        enumeration_error: Some(format!("blocking SIGKILL task failed: {error}")),
    });
    let mut errors = Vec::new();
    if let Some(error) = term.enumeration_error {
        errors.push(format!("SIGTERM session enumeration failed: {error}"));
    }
    if let Some(error) = kill.enumeration_error {
        errors.push(format!("SIGKILL session enumeration failed: {error}"));
    }
    session_signal_result(errors)
}

/// Immediate synchronous cleanup for Drop. Both stages enumerate afresh and
/// retain verified shell/foreground groups as a fallback if ps fails.
#[cfg(unix)]
pub fn signal_pty_session_term_and_kill_blocking(
    session_id: u32,
    fallback_process_groups: &[u32],
) -> std::io::Result<()> {
    let term = signal_session_stage(session_id, fallback_process_groups, Signal::SIGTERM);
    let kill = signal_session_stage(session_id, fallback_process_groups, Signal::SIGKILL);
    let errors = [
        term.enumeration_error
            .map(|error| format!("SIGTERM session enumeration failed: {error}")),
        kill.enumeration_error
            .map(|error| format!("SIGKILL session enumeration failed: {error}")),
    ]
    .into_iter()
    .flatten()
    .collect();
    session_signal_result(errors)
}

/// Cleans up ordinary background jobs after the session leader exits
/// naturally. Polling avoids delaying exit notification when every descendant
/// accepts SIGTERM. A process that called setsid is no longer a member and is
/// deliberately left alone.
#[cfg(unix)]
pub fn cleanup_pty_session_after_leader_exit(session_id: u32) -> std::io::Result<()> {
    let term = signal_session_stage(session_id, &[], Signal::SIGTERM);
    let mut errors = term
        .enumeration_error
        .map(|error| vec![format!("SIGTERM session enumeration failed: {error}")])
        .unwrap_or_default();
    if term.signaled == 0 {
        return session_signal_result(errors);
    }

    let deadline = Instant::now() + Duration::from_millis(GRACEFUL_TIMEOUT_MS);
    loop {
        std::thread::sleep(Duration::from_millis(POLL_INTERVAL_MS));
        match session_process_groups(session_id) {
            Ok(groups) if groups.is_empty() => return session_signal_result(errors),
            Ok(_) if Instant::now() < deadline => continue,
            Ok(_) => break,
            Err(error) => {
                errors.push(format!("session cleanup poll failed: {error}"));
                if Instant::now() >= deadline {
                    break;
                }
            }
        }
    }
    let kill = signal_session_stage(session_id, &[], Signal::SIGKILL);
    if let Some(error) = kill.enumeration_error {
        errors.push(format!("SIGKILL session enumeration failed: {error}"));
    }
    session_signal_result(errors)
}

#[cfg(not(unix))]
pub async fn signal_term_then_kill(_pid: u32) {
    // Windows path is not supported in v1 — TerminalService will own
    // platform-specific kill logic here when added.
}

#[cfg(not(unix))]
pub async fn signal_target_term_then_kill(_target: SignalTarget, _reaped: Option<&AtomicBool>) {}

#[cfg(not(unix))]
pub fn signal_term_and_kill_blocking(_pid: u32) {}

#[cfg(not(unix))]
pub fn signal_target_term_and_kill_blocking(_target: SignalTarget, _reaped: Option<&AtomicBool>) {}

#[cfg(not(unix))]
pub async fn signal_pty_session_term_then_kill(
    _session_id: u32,
    _fallback_process_groups: Vec<u32>,
) -> std::io::Result<()> {
    Ok(())
}

#[cfg(not(unix))]
pub fn signal_pty_session_term_and_kill_blocking(
    _session_id: u32,
    _fallback_process_groups: &[u32],
) -> std::io::Result<()> {
    Ok(())
}

#[cfg(not(unix))]
pub fn cleanup_pty_session_after_leader_exit(_session_id: u32) -> std::io::Result<()> {
    Ok(())
}

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

#[cfg(unix)]
pub async fn terminate_process_group_with_escalation<C: TermChild>(
    child: &mut C,
) -> Result<TerminateOutcome, TerminateError> {
    let raw_pid = match child.pid() {
        Some(p) => p,
        None => return Ok(TerminateOutcome::AlreadyReaped),
    };
    let target = SignalTarget::ProcessGroup(raw_pid);

    signal_target(target, Signal::SIGTERM);

    let mut waited_ms = 0u64;
    let mut leader_exited = false;
    while waited_ms < GRACEFUL_TIMEOUT_MS {
        sleep(Duration::from_millis(POLL_INTERVAL_MS)).await;
        waited_ms += POLL_INTERVAL_MS;
        if child.try_wait()?.is_some() {
            leader_exited = true;
            break;
        }
    }

    // The group leader exiting does not prove the group is gone. Shell checks
    // can leave background descendants alive with inherited stdout/stderr
    // pipes, which keeps stream readers open and makes cancellation hang until
    // those descendants naturally exit. The process group id remains occupied
    // while any member survives; ESRCH is ignored when the group is already
    // empty.
    signal_target(target, Signal::SIGKILL);

    if leader_exited {
        return Ok(TerminateOutcome::ExitedGracefully);
    }

    for _ in 0..20 {
        sleep(Duration::from_millis(POLL_INTERVAL_MS)).await;
        if child.try_wait()?.is_some() {
            return Ok(TerminateOutcome::KilledAndReaped);
        }
    }

    Ok(TerminateOutcome::KilledNotReaped)
}

#[cfg(not(unix))]
pub async fn terminate_process_group_with_escalation<C: TermChild>(
    _child: &mut C,
) -> Result<TerminateOutcome, TerminateError> {
    Err(TerminateError::Io(std::io::Error::new(
        std::io::ErrorKind::Unsupported,
        "process-group termination not implemented for this platform",
    )))
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
