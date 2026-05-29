import { useEffect, useRef, type JSX } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { tryFit } from "../lib/xtermFit.js";
import { resolveMonoFontStack } from "../lib/fonts.js";
import type { TerminalDataEvent, TerminalExitEvent } from "../../shared/types.js";
import { getXtermTheme, readActiveXtermTheme } from "../lib/xtermTheme.js";
import { themeAppearance } from "../lib/theme.js";
import { errorMessage } from "../../shared/error.js";
import "@xterm/xterm/css/xterm.css";

const DEFAULT_TERMINAL_COLS = 80;
const DEFAULT_TERMINAL_ROWS = 24;
const MIN_TERMINAL_COLS = 20;
const MAX_TERMINAL_COLS = 400;
const MIN_TERMINAL_ROWS = 5;
const MAX_TERMINAL_ROWS = 200;

function boundedTerminalSize(term: Terminal): { cols: number; rows: number } {
  return {
    cols: boundedDimension(term.cols, MIN_TERMINAL_COLS, MAX_TERMINAL_COLS, DEFAULT_TERMINAL_COLS),
    rows: boundedDimension(term.rows, MIN_TERMINAL_ROWS, MAX_TERMINAL_ROWS, DEFAULT_TERMINAL_ROWS)
  };
}

function boundedDimension(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(value)));
}

/**
 * One xterm instance bound to one PTY. Keyed by `instanceKey` (not workspaceId)
 * so a tabbed container can mount many of these per workspace and reorder/
 * remove individual tabs without churning the others. The container is
 * responsible for choosing keys (typically a stable tab id).
 */
export function TerminalInstance({
  instanceKey,
  workspaceId,
  visible
}: {
  instanceKey: string;
  workspaceId: string;
  visible: boolean;
}): JSX.Element {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const terminalIdRef = useRef<string | null>(null);
  const xtermRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);

  // Spawn + xterm wiring lives on a single effect keyed by instanceKey so
  // each tab owns one PTY for its lifetime. The `visible` prop only toggles
  // CSS so switching between tabs or collapsing the panel doesn't churn the
  // PTY. `workspaceId` is read at spawn time but not in the dep list —
  // changing workspace must remount the container (key on workspaceId there).
  useEffect(() => {
    const container = containerRef.current;
    if (!container || !window.argmax) return;

    const term = new Terminal({
      fontFamily: resolveMonoFontStack(),
      fontSize: 13,
      lineHeight: 1.2,
      cursorBlink: true,
      theme: readActiveXtermTheme(),
      allowProposedApi: true,
      scrollback: 5000
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(container);
    xtermRef.current = term;
    fitRef.current = fit;

    // Watch <html data-theme="..."> so the terminal palette flips live when
    // the user toggles theme in Settings (or the OS preference changes under
    // "System"). MutationObserver is the smallest hammer here.
    const themeObserver = new MutationObserver(() => {
      const attr = document.documentElement.getAttribute("data-theme");
      term.options.theme = getXtermTheme(themeAppearance(attr));
    });
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"]
    });

    // Initial fit before spawn so cols/rows match what the user will see.
    // ResizeObserver below retries once the container has dimensions.
    tryFit(fit);
    const { cols, rows } = boundedTerminalSize(term);

    let disposed = false;
    let localTerminalId: string | null = null;
    let unsubscribeData: (() => void) | null = null;
    let unsubscribeExit: (() => void) | null = null;
    let inputSub: { dispose: () => void } | null = null;
    const pendingData = new Map<string, string[]>();
    const pendingExits = new Map<string, TerminalExitEvent>();

    const dataSub = window.argmax.terminal.onData((event: TerminalDataEvent) => {
      const terminalId = terminalIdRef.current;
      if (!terminalId) {
        const chunks = pendingData.get(event.terminalId) ?? [];
        chunks.push(event.data);
        pendingData.set(event.terminalId, chunks);
        return;
      }
      if (event.terminalId !== terminalId) return;
      term.write(event.data);
    });
    unsubscribeData = dataSub;

    const exitSub = window.argmax.terminal.onExit((event: TerminalExitEvent) => {
      const terminalId = terminalIdRef.current;
      if (!terminalId) {
        pendingExits.set(event.terminalId, event);
        return;
      }
      if (event.terminalId !== terminalId) return;
      writeExitLine(term, event);
    });
    unsubscribeExit = exitSub;

    void Promise.all([dataSub.ready ?? Promise.resolve(), exitSub.ready ?? Promise.resolve()])
      .then(() => {
        if (disposed) return;
        return window.argmax!.terminal.spawn({ workspaceId, cols, rows });
      })
      .then((result) => {
        if (!result) return;
        const { terminalId } = result;
        if (disposed) {
          void window.argmax?.terminal.terminate(terminalId);
          return;
        }
        localTerminalId = terminalId;
        terminalIdRef.current = terminalId;

        for (const chunk of pendingData.get(terminalId) ?? []) {
          term.write(chunk);
        }
        pendingData.clear();

        const pendingExit = pendingExits.get(terminalId);
        pendingExits.clear();
        if (pendingExit) writeExitLine(term, pendingExit);

        inputSub = term.onData((data) => {
          void window.argmax?.terminal.write({ terminalId, data });
        });
      })
      .catch((error: unknown) => {
        const message = errorMessage(error) || "Unknown error";
        term.write(`\r\n\x1b[31m[failed to start terminal: ${message}]\x1b[0m\r\n`);
      });

    const ro = new ResizeObserver(() => {
      const fitAddon = fitRef.current;
      const xterm = xtermRef.current;
      const tid = terminalIdRef.current;
      if (!fitAddon || !xterm) return;
      if (!tryFit(fitAddon)) return;
      if (tid) {
        void window.argmax?.terminal.resize({ terminalId: tid, ...boundedTerminalSize(xterm) });
      }
    });
    ro.observe(container);

    return () => {
      disposed = true;
      ro.disconnect();
      themeObserver.disconnect();
      unsubscribeData?.();
      unsubscribeExit?.();
      inputSub?.dispose();
      if (localTerminalId) {
        void window.argmax?.terminal.terminate(localTerminalId);
      }
      term.dispose();
      xtermRef.current = null;
      fitRef.current = null;
      terminalIdRef.current = null;
    };
  }, [instanceKey, workspaceId]);

  // When the panel becomes visible after being hidden (collapsed via ⌘J or
  // because another tab was active), xterm's renderer can be out of sync
  // with the container size. Re-fit + focus on visibility flips.
  useEffect(() => {
    if (!visible) return;
    const fit = fitRef.current;
    const term = xtermRef.current;
    if (!fit || !term) return;
    if (!tryFit(fit)) return;
    const tid = terminalIdRef.current;
    if (tid) {
      void window.argmax?.terminal.resize({ terminalId: tid, ...boundedTerminalSize(term) });
    }
    term.focus();
  }, [visible]);

  return (
    <div
      ref={containerRef}
      className="terminal-panel-surface"
      role="region"
      aria-label="Integrated terminal"
    />
  );
}

function writeExitLine(term: Terminal, event: TerminalExitEvent): void {
  const exitLine = `\r\n\x1b[2m[process exited with code ${event.exitCode}]\x1b[0m\r\n`;
  term.write(exitLine);
}
