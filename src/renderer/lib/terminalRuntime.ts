// Persistent xterm + PTY runtimes for the integrated terminal, keyed by tab
// id from `terminalTabs.ts`.
//
// Each runtime owns a detached host <div> that xterm renders into. Mounting a
// `TerminalInstance` reparents the host into the pane; unmounting removes it
// again but leaves the terminal, its subscriptions, and the PTY untouched —
// that is what keeps scrollback and running processes alive across session
// switches. A runtime is only torn down (PTY terminated, xterm disposed) when
// its tab is closed or its workspace is LRU-evicted by the store.
//
// This module imports @xterm/xterm and must only be imported from the lazy
// terminal chunk (TerminalPanel / TerminalTabsPanel), never from the main
// bundle.

import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { tryFit } from "./xtermFit.js";
import { resolveMonoFontStack, resolveTerminalFontSize } from "./fonts.js";
import type { TerminalDataEvent, TerminalExitEvent } from "../../shared/types.js";
import { getXtermTheme, readActiveXtermTheme } from "./xtermTheme.js";
import { themeAppearance } from "./theme.js";
import { errorMessage } from "../../shared/error.js";
import { registerTerminalTabDisposer } from "./terminalTabs.js";
import "@xterm/xterm/css/xterm.css";

const DEFAULT_TERMINAL_COLS = 80;
const DEFAULT_TERMINAL_ROWS = 24;
const MIN_TERMINAL_COLS = 20;
const MAX_TERMINAL_COLS = 400;
const MIN_TERMINAL_ROWS = 5;
const MAX_TERMINAL_ROWS = 200;

export function boundedTerminalSize(term: Terminal): { cols: number; rows: number } {
  return {
    cols: boundedDimension(term.cols, MIN_TERMINAL_COLS, MAX_TERMINAL_COLS, DEFAULT_TERMINAL_COLS),
    rows: boundedDimension(term.rows, MIN_TERMINAL_ROWS, MAX_TERMINAL_ROWS, DEFAULT_TERMINAL_ROWS)
  };
}

function boundedDimension(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(value)));
}

function syncTerminalAppearance(term: Terminal): void {
  const attr = document.documentElement.getAttribute("data-theme");
  term.options.theme = getXtermTheme(themeAppearance(attr));
  term.options.fontFamily = resolveMonoFontStack();
  term.options.fontSize = resolveTerminalFontSize();
}

export interface TerminalTabRuntime {
  term: Terminal;
  fit: FitAddon;
  /** Set once the spawn resolves; resize/write calls before that are skipped. */
  terminalId: string | null;
}

interface RuntimeEntry extends TerminalTabRuntime {
  host: HTMLDivElement;
  disposed: boolean;
  cleanups: Array<() => void>;
}

const runtimes = new Map<string, RuntimeEntry>();

/**
 * Reparent the tab's terminal into `container`, creating the xterm instance
 * and spawning its PTY on first attach.
 */
export function attachTerminalTab(
  tabId: string,
  workspaceId: string,
  container: HTMLElement
): TerminalTabRuntime {
  const existing = runtimes.get(tabId);
  if (existing) {
    if (existing.host.parentElement !== container) {
      container.appendChild(existing.host);
    }
    // Theme/font may have changed while detached without a repaint.
    syncTerminalAppearance(existing.term);
    tryFit(existing.fit);
    return existing;
  }

  const host = document.createElement("div");
  host.style.width = "100%";
  host.style.height = "100%";
  container.appendChild(host);

  const term = new Terminal({
    fontFamily: resolveMonoFontStack(),
    fontSize: resolveTerminalFontSize(),
    lineHeight: 1.2,
    cursorBlink: true,
    theme: readActiveXtermTheme(),
    // Shell prompts often emit truecolor picked for another terminal's
    // background (e.g. a starship palette synced to the OS theme, not ours),
    // so the theme palette alone can't guarantee readable text. Let xterm
    // lift any foreground that lands below WCAG-ish contrast.
    minimumContrastRatio: 4.5,
    allowProposedApi: true,
    scrollback: 5000
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.open(host);

  const entry: RuntimeEntry = { term, fit, terminalId: null, host, disposed: false, cleanups: [] };
  runtimes.set(tabId, entry);

  // Watch <html data-theme="..."> so the terminal palette flips live when
  // the user toggles theme in Settings. data-font/data-font-size also feed
  // xterm because it renders text outside normal CSS inheritance. The
  // observer belongs to the runtime, not the component, so a detached
  // terminal picks up theme changes too.
  const appearanceObserver = new MutationObserver(() => {
    syncTerminalAppearance(term);
    tryFit(fit);
    if (entry.terminalId) {
      void window.argmax?.terminal.resize({ terminalId: entry.terminalId, ...boundedTerminalSize(term) });
    }
  });
  appearanceObserver.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-theme", "data-font", "data-font-size"]
  });
  entry.cleanups.push(() => appearanceObserver.disconnect());

  // Initial fit before spawn so cols/rows match what the user will see.
  // The component's ResizeObserver retries once the container has dimensions.
  tryFit(fit);
  const { cols, rows } = boundedTerminalSize(term);

  const pendingData = new Map<string, string[]>();
  const pendingExits = new Map<string, TerminalExitEvent>();

  const dataSub = window.argmax!.terminal.onData((event: TerminalDataEvent) => {
    if (!entry.terminalId) {
      const chunks = pendingData.get(event.terminalId) ?? [];
      chunks.push(event.data);
      pendingData.set(event.terminalId, chunks);
      return;
    }
    if (event.terminalId !== entry.terminalId) return;
    term.write(event.data);
  });
  entry.cleanups.push(dataSub);

  const exitSub = window.argmax!.terminal.onExit((event: TerminalExitEvent) => {
    if (!entry.terminalId) {
      pendingExits.set(event.terminalId, event);
      return;
    }
    if (event.terminalId !== entry.terminalId) return;
    writeExitLine(term, event);
  });
  entry.cleanups.push(exitSub);

  void Promise.all([dataSub.ready ?? Promise.resolve(), exitSub.ready ?? Promise.resolve()])
    .then(() => {
      if (entry.disposed) return;
      return window.argmax!.terminal.spawn({ workspaceId, cols, rows });
    })
    .then((result) => {
      if (!result) return;
      const { terminalId } = result;
      if (entry.disposed) {
        void window.argmax?.terminal.terminate(terminalId);
        return;
      }
      entry.terminalId = terminalId;

      for (const chunk of pendingData.get(terminalId) ?? []) {
        term.write(chunk);
      }
      pendingData.clear();

      const pendingExit = pendingExits.get(terminalId);
      pendingExits.clear();
      if (pendingExit) writeExitLine(term, pendingExit);

      const inputSub = term.onData((data) => {
        void window.argmax?.terminal.write({ terminalId, data });
      });
      entry.cleanups.push(() => inputSub.dispose());
    })
    .catch((error: unknown) => {
      const message = errorMessage(error) || "Unknown error";
      term.write(`\r\n\x1b[31m[failed to start terminal: ${message}]\x1b[0m\r\n`);
    });

  return entry;
}

/** Remove the tab's terminal from the DOM but keep it (and its PTY) alive. */
export function detachTerminalTab(tabId: string): void {
  runtimes.get(tabId)?.host.remove();
}

/** Full teardown: unsubscribe, terminate the PTY, dispose xterm. */
export function disposeTerminalTab(tabId: string): void {
  const entry = runtimes.get(tabId);
  if (!entry) return;
  runtimes.delete(tabId);
  entry.disposed = true;
  for (const cleanup of entry.cleanups) cleanup();
  if (entry.terminalId) {
    void window.argmax?.terminal.terminate(entry.terminalId);
  }
  entry.term.dispose();
  entry.host.remove();
}

registerTerminalTabDisposer(disposeTerminalTab);

/** Re-register after `resetTerminalTabsForTests` wiped module state. */
export function resetTerminalRuntimesForTests(): void {
  for (const tabId of [...runtimes.keys()]) disposeTerminalTab(tabId);
  registerTerminalTabDisposer(disposeTerminalTab);
}

function writeExitLine(term: Terminal, event: TerminalExitEvent): void {
  const exitLine = `\r\n\x1b[2m[process exited with code ${event.exitCode}]\x1b[0m\r\n`;
  term.write(exitLine);
}
