import { useCallback, useEffect, useRef, useState } from "react";

const DEFAULT_FLASH_MS = 1500;

/**
 * Shared "copy to clipboard with brief 'Copied!' flash" helper.
 *
 * Returns `[copied, copy]`. The boolean flips to true on success and back to
 * false after `flashMs`. The callback returns a promise that resolves true on
 * success or false on permission/focus failure so callers can show failure
 * state when the paste buffer rejects the write.
 */
export function useCopyToClipboard(flashMs: number = DEFAULT_FLASH_MS): [boolean, (text: string) => Promise<boolean>] {
  const [copied, setCopied] = useState(false);
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
      if (typeof navigator === "undefined" || !navigator.clipboard) {
        return false;
      }
      try {
        await navigator.clipboard.writeText(text);
        setCopied(true);
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => setCopied(false), flashMs);
        return true;
      } catch {
        // Permission denied, no document focus, secure-context mismatch — fail
        // silently from the user's perspective but don't lie about copied:true.
        return false;
      }
    },
    [flashMs]
  );

  return [copied, copy];
}
