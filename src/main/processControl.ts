import { logger } from "../shared/logger.js";

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
 * SIGTERM errors other than ESRCH propagate to the caller. The SIGKILL fallback
 * runs inside a timer — any throw there becomes an uncaught exception that
 * crashes the Electron main process, so we log non-ESRCH failures and swallow.
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
      if (isAlreadyExitedError(error)) return;
      logger.error("processControl", "SIGKILL escalation failed", {
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }, options.graceMs ?? DEFAULT_KILL_GRACE_MS);
  if (typeof timer.unref === "function") {
    timer.unref();
  }
  return {
    cancel: () => clearTimeout(timer)
  };
}
