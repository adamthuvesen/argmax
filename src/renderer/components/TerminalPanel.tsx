import { useEffect, useRef, type JSX } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { tryFit } from "../lib/xtermFit.js";
import type { TerminalDataEvent, TerminalExitEvent } from "../../shared/types.js";
import "@xterm/xterm/css/xterm.css";

const LIGHT_THEME = {
  background: "#fbfbfa",
  foreground: "#1c1b18",
  cursor: "#1c1b18",
  cursorAccent: "#fbfbfa",
  selectionBackground: "rgba(90, 143, 114, 0.28)",
  selectionForeground: "#1c1b18",
  black: "#1c1b18",
  red: "#b85763",
  green: "#3d6a52",
  yellow: "#b08039",
  blue: "#406789",
  magenta: "#8a4577",
  cyan: "#3f7a85",
  white: "#5d594f",
  brightBlack: "#3a3833",
  brightRed: "#cc6873",
  brightGreen: "#5a8f72",
  brightYellow: "#c89653",
  brightBlue: "#5687a8",
  brightMagenta: "#a55c92",
  brightCyan: "#5b95a1",
  brightWhite: "#8a857b"
};

export function TerminalPanel({
  workspaceId,
  visible
}: {
  workspaceId: string;
  visible: boolean;
}): JSX.Element {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const terminalIdRef = useRef<string | null>(null);
  const xtermRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);

  // Spawn + xterm wiring lives on a single effect keyed by workspaceId so
  // switching sessions tears down the old PTY and starts a fresh one in the
  // new worktree. The `visible` prop only toggles CSS so reopening the panel
  // doesn't churn the PTY.
  useEffect(() => {
    const container = containerRef.current;
    if (!container || !window.argmax) return;

    const term = new Terminal({
      fontFamily: '"Lilex Nerd Font", "Lilex Nerd Font Mono", ui-monospace, monospace',
      fontSize: 13,
      lineHeight: 1.2,
      cursorBlink: true,
      theme: LIGHT_THEME,
      allowProposedApi: true,
      scrollback: 5000
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(container);
    xtermRef.current = term;
    fitRef.current = fit;

    // Initial fit before spawn so cols/rows match what the user will see.
    // ResizeObserver below retries once the container has dimensions.
    tryFit(fit);
    const { cols, rows } = term;

    let disposed = false;
    let localTerminalId: string | null = null;
    let unsubscribeData: (() => void) | null = null;
    let unsubscribeExit: (() => void) | null = null;

    void window.argmax.terminal
      .spawn({ workspaceId, cols, rows })
      .then(({ terminalId }) => {
        if (disposed) {
          void window.argmax?.terminal.terminate(terminalId);
          return;
        }
        localTerminalId = terminalId;
        terminalIdRef.current = terminalId;

        unsubscribeData = window.argmax!.terminal.onData((event: TerminalDataEvent) => {
          if (event.terminalId !== terminalId) return;
          term.write(event.data);
        });

        unsubscribeExit = window.argmax!.terminal.onExit((event: TerminalExitEvent) => {
          if (event.terminalId !== terminalId) return;
          const exitLine = `\r\n\x1b[2m[process exited with code ${event.exitCode}]\x1b[0m\r\n`;
          term.write(exitLine);
        });

        const dataSub = term.onData((data) => {
          void window.argmax?.terminal.write({ terminalId, data });
        });

        // Stash on the xterm instance for cleanup; xterm has no dedicated
        // disposer registry exposed here, so we attach to the cleanup closure.
        (term as unknown as { __argmaxInputSub: { dispose: () => void } }).__argmaxInputSub = dataSub;
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : "Unknown error";
        term.write(`\r\n\x1b[31m[failed to start terminal: ${message}]\x1b[0m\r\n`);
      });

    const ro = new ResizeObserver(() => {
      const fitAddon = fitRef.current;
      const xterm = xtermRef.current;
      const tid = terminalIdRef.current;
      if (!fitAddon || !xterm) return;
      if (!tryFit(fitAddon)) return;
      if (tid) {
        void window.argmax?.terminal.resize({ terminalId: tid, cols: xterm.cols, rows: xterm.rows });
      }
    });
    ro.observe(container);

    return () => {
      disposed = true;
      ro.disconnect();
      unsubscribeData?.();
      unsubscribeExit?.();
      const inputSub = (term as unknown as { __argmaxInputSub?: { dispose: () => void } }).__argmaxInputSub;
      inputSub?.dispose();
      if (localTerminalId) {
        void window.argmax?.terminal.terminate(localTerminalId);
      }
      term.dispose();
      xtermRef.current = null;
      fitRef.current = null;
      terminalIdRef.current = null;
    };
  }, [workspaceId]);

  // When the panel becomes visible after being hidden, xterm's renderer can
  // be out of sync with the container size. Re-fit on visibility flips.
  useEffect(() => {
    if (!visible) return;
    const fit = fitRef.current;
    const term = xtermRef.current;
    if (!fit || !term) return;
    if (!tryFit(fit)) return;
    const tid = terminalIdRef.current;
    if (tid) {
      void window.argmax?.terminal.resize({ terminalId: tid, cols: term.cols, rows: term.rows });
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
