/** Default grace window between SIGTERM and SIGKILL. */
export const DEFAULT_KILL_GRACE_MS = 2_000;

interface SigkillEscalationOptions {
  graceMs?: number;
}

/**
 * Schedule a SIGKILL fallback after the SIGTERM call. Returns a `cancel()` to
 * call from an exit listener so we don't fire the SIGKILL after the child has
 * already exited.
 *
 * Both `killTerm` and `killKill` are wrapped in try/catch — racing exits and
 * "process group already gone" errors are normal during teardown.
 */
export function scheduleSigkillEscalation(
  killTerm: () => void,
  killKill: () => void,
  options: SigkillEscalationOptions = {}
): { cancel: () => void } {
  try {
    killTerm();
  } catch {
    /* already gone */
  }
  const timer = setTimeout(() => {
    try {
      killKill();
    } catch {
      /* already gone */
    }
  }, options.graceMs ?? DEFAULT_KILL_GRACE_MS);
  if (typeof timer.unref === "function") {
    timer.unref();
  }
  return {
    cancel: () => clearTimeout(timer)
  };
}
