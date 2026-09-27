import type { Terminal } from "@xterm/xterm";
import type { FitAddon } from "@xterm/addon-fit";

/**
 * Fit the terminal to its host, but only when the host is laid out.
 *
 * `FitAddon.fit()` reads the parent's computed height and width. Under a
 * `display: none` ancestor (a hidden panel mode, an inactive tab) WebKit
 * reports those as the specified `100%`, which the addon parses as 100px, and
 * a zero-height container parses as 0 — either way it shrinks xterm to a
 * handful of cells instead of bailing. That grid reaches the PTY, zsh redraws
 * its prompt wrapped at 20 columns, and when the terminal is shown again the
 * wrapped rows are left as blank lines above the prompt. A host with no box
 * is "size unknown": skip, and let the next observer tick fit it.
 *
 * Returns `true` when the fit ran, `false` when it bailed (so the caller can
 * short-circuit work that depends on the new size).
 */
export function tryFit(term: Terminal, fit: FitAddon): boolean {
  const host = term.element?.parentElement;
  if (!host || host.clientWidth === 0 || host.clientHeight === 0) return false;
  try {
    fit.fit();
    return true;
  } catch {
    return false;
  }
}
