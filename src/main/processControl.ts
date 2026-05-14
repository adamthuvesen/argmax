/** Default grace window between SIGTERM and SIGKILL. */
export const DEFAULT_KILL_GRACE_MS = 2_000;

interface SigkillEscalationOptions {
  graceMs?: number;
}

/** `process.kill(pid, sig)` throws this code when the target is already dead. */
function isAlreadyExitedError(error: unknown): boolean {
  return Boolean(
    error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "ESRCH"
  );
}

/**
 * Best-effort kill for a PTY (or anything with a sync `kill()` method). Swallows
 * the throw if the child already exited (`onExit` will or has already cleaned
 * up the owning map). Used by terminal + mcp-auth services where the kill is
 * triggered by user actions / shutdown and the underlying process may have
 * raced ahead of us into exit.
 */
export function safeKill(target: { kill: () => void }): void {
  try {
    target.kill();
  } catch {
    /* PTY/process already exited; owner's onExit handler cleans up. */
  }
}

/**
 * SIGTERM the child, schedule a SIGKILL fallback, and return `cancel()` to call
 * from the exit listener so the SIGKILL doesn't fire after the child has gone.
 *
 * Both kills can throw ESRCH if the process is already gone — that's the only
 * error we expect and tolerate. Any other error (EPERM, EINVAL, …) propagates
 * so it stays visible rather than being silently swallowed.
 */
export function scheduleSigkillEscalation(
  killTerm: () => void,
  killKill: () => void,
  options: SigkillEscalationOptions = {}
): { cancel: () => void } {
  try {
    killTerm();
  } catch (error) {
    if (!isAlreadyExitedError(error)) throw error;
  }
  const timer = setTimeout(() => {
    try {
      killKill();
    } catch (error) {
      if (!isAlreadyExitedError(error)) throw error;
    }
  }, options.graceMs ?? DEFAULT_KILL_GRACE_MS);
  if (typeof timer.unref === "function") {
    timer.unref();
  }
  return {
    cancel: () => clearTimeout(timer)
  };
}
