import { useCallback, useEffect, useRef, useState } from "react";

const DEFAULT_FLASH_MS = 1500;

/** Transient outcome of the last copy attempt, cleared back to idle. */
export type CopyFlash = "idle" | "copied" | "failed";

/**
 * The pre-async-clipboard path: select a detached textarea and run the copy
 * command. It is the only one left when `navigator.clipboard` is missing —
 * the chat served over the remote bridge's plain HTTP is not a secure
 * context, and there the async API is simply not defined — and it is worth a
 * second attempt when the async write is refused.
 *
 * The selection and the focused element are put back: the reader's highlight
 * feeds the chat's selection actions (side chat, annotate), and a click on a
 * button does not move focus in WebKit, so the composer is usually still the
 * active element while this runs.
 */
function copyWithCommand(text: string): boolean {
  if (typeof document === "undefined" || !document.body) return false;
  const activeElement = document.activeElement;
  const selection = document.getSelection();
  const selectedRange = selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null;
  const holder = document.createElement("textarea");
  holder.value = text;
  holder.setAttribute("readonly", "");
  // Off-screen rather than hidden: `display: none` cannot hold a selection.
  holder.style.position = "fixed";
  holder.style.top = "0";
  holder.style.left = "-9999px";
  document.body.appendChild(holder);
  let copied = false;
  try {
    holder.select();
    copied = document.execCommand("copy");
  } catch {
    copied = false;
  }
  holder.remove();
  if (selectedRange) {
    selection?.removeAllRanges();
    selection?.addRange(selectedRange);
  }
  if (activeElement instanceof HTMLElement) activeElement.focus();
  return copied;
}

/**
 * Shared "copy to clipboard with brief flash" helper.
 *
 * Returns `[flash, copy]`. `flash` flips to "copied" or "failed" for
 * `flashMs`, then back to "idle" — a denied clipboard write (permission,
 * focus loss) must not leave the button looking inert, or worse, claim
 * success. The callback also resolves the boolean outcome for callers that
 * branch on it directly.
 *
 * "failed" means both the async Clipboard API and `copyWithCommand` refused
 * the write, so nothing reached the clipboard.
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
      if (typeof navigator !== "undefined" && typeof navigator.clipboard?.writeText === "function") {
        try {
          await navigator.clipboard.writeText(text);
          settle("copied");
          return true;
        } catch {
          // Permission denied, no document focus, secure-context mismatch —
          // fall through to the command below rather than reporting a failure
          // the reader can do nothing about.
        }
      }
      const copied = copyWithCommand(text);
      settle(copied ? "copied" : "failed");
      return copied;
    },
    [flashMs]
  );

  return [flash, copy];
}
