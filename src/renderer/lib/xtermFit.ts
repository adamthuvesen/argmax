import type { FitAddon } from "@xterm/addon-fit";

/**
 * `FitAddon.fit()` throws when the terminal's container has no dimensions
 * (first mount, hidden tab, race against ResizeObserver). The xterm contract
 * is "size is unknown until the wrapper has measurable width" — every call
 * site treats the throw as "retry on the next observer tick", so wrap once
 * here instead of repeating the try/catch at every fit point.
 *
 * Returns `true` when the fit succeeded, `false` when it bailed (so the
 * caller can short-circuit work that depends on the new size).
 */
export function tryFit(fit: FitAddon): boolean {
  try {
    fit.fit();
    return true;
  } catch {
    return false;
  }
}
