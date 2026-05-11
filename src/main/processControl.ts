/** Default grace window between SIGTERM and SIGKILL. */
export const DEFAULT_KILL_GRACE_MS = 2_000;

interface SigkillEscalationOptions {
  graceMs?: number;
}

/**
 * SIGTERM the child, schedule a SIGKILL fallback, and return `cancel()` to call
 * from the exit listener so the SIGKILL doesn't fire after the child has gone.
 * Both kills can throw ESRCH if the process is already gone — that's expected.
 */
export function scheduleSigkillEscalation(
  killTerm: () => void,
  killKill: () => void,
  options: SigkillEscalationOptions = {}
): { cancel: () => void } {
  try {
    killTerm();
  } catch {
    // ESRCH: child already exited.
  }
  const timer = setTimeout(() => {
    try {
      killKill();
    } catch {
      // ESRCH: child already exited.
    }
  }, options.graceMs ?? DEFAULT_KILL_GRACE_MS);
  if (typeof timer.unref === "function") {
    timer.unref();
  }
  return {
    cancel: () => clearTimeout(timer)
  };
}
