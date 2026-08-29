import { useCallback, useEffect, useRef, useState } from "react";

const DEFAULT_FLASH_MS = 1500;

/** Transient outcome of the last copy attempt, cleared back to idle. */
export type CopyFlash = "idle" | "copied" | "failed";

/**
 * Shared "copy to clipboard with brief flash" helper.
 *
 * Returns `[flash, copy]`. `flash` flips to "copied" or "failed" for
 * `flashMs`, then back to "idle" — a denied clipboard write (permission,
 * focus loss) must not leave the button looking inert, or worse, claim
 * success. The callback also resolves the boolean outcome for callers that
 * branch on it directly.
 */
export function useCopyToClipboard(
  flashMs: number = DEFAULT_FLASH_MS
): [CopyFlash, (text: string) => Promise<boolean>] {
  const [flash, setFlash] = useState<CopyFlash>("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Clear the pending flash on unmount so React doesn't warn about a state
  // update after unmount and the timeout callback doesn't fire against a
  // gone component.
  useEffect(() => {
    return () => {
      if (timer.current) {
        clearTimeout(timer.current);
        timer.current = null;
      }
    };
  }, []);

  const copy = useCallback(
    async (text: string): Promise<boolean> => {
      const settle = (state: CopyFlash): void => {
        setFlash(state);
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => setFlash("idle"), flashMs);
      };
      if (typeof navigator === "undefined" || !navigator.clipboard) {
        settle("failed");
        return false;
      }
      try {
        await navigator.clipboard.writeText(text);
        settle("copied");
        return true;
      } catch {
        // Permission denied, no document focus, secure-context mismatch.
        settle("failed");
        return false;
      }
    },
    [flashMs]
  );

  return [flash, copy];
}
