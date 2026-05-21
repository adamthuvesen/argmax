import { useEffect, useRef, useState, type JSX } from "react";
import { createPortal } from "react-dom";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { AlertCircle } from "lucide-react";
import { tryFit } from "../lib/xtermFit.js";
import { resolveMonoFontStack } from "../lib/fonts.js";
import { useDismissOnOutsideOrEscape } from "../hooks/useDismissOnOutsideOrEscape.js";
import type { McpAuthDataEvent, McpAuthExitEvent } from "../../shared/types.js";
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

/**
 * Modal that hosts an interactive `claude` PTY for completing MCP OAuth via
 * the `/mcp` slash command. Mirrors TerminalPanel's xterm wiring but lives
 * inside a dismissable dialog. Closing the dialog (Escape, backdrop click,
 * Close button) terminates the PTY; when the PTY exits on its own (user types
 * `/quit` or Ctrl-C), the dialog reports the exit and stays open so the user
 * can read any trailing output before dismissing.
 */
export function McpAuthDialog({
  open,
  onClose,
  onCompleted
}: {
  open: boolean;
  onClose: () => void;
  onCompleted?: () => void;
}): JSX.Element | null {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const previousActiveElementRef = useRef<HTMLElement | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const xtermRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const completedFiredRef = useRef<boolean>(false);
  // Hold the latest onCompleted in a ref so this prop can change without
  // re-triggering the spawn effect. SettingsPanel passes a fresh lambda on
  // every render — without this guard, the effect would tear down and
  // re-spawn the PTY in a tight loop, flooding posix_spawnp errors.
  const onCompletedRef = useRef<(() => void) | undefined>(onCompleted);
  useEffect(() => {
    onCompletedRef.current = onCompleted;
  }, [onCompleted]);

  const [startError, setStartError] = useState<string | null>(null);
  const [exited, setExited] = useState<boolean>(false);

  // Document-level Esc + outside-click via the shared hook. Listening at the
  // document level keeps Esc working once xterm has captured key events.
  useDismissOnOutsideOrEscape(dialogRef, open, onClose, undefined, { trapFocus: true });

  // Capture the previously focused element on open so the trigger gets focus
  // back on close — matches CommandPalette/SearchOverlay/CommitDialog.
  useEffect(() => {
    if (!open) {
      const previous = previousActiveElementRef.current;
      previousActiveElementRef.current = null;
      if (previous && document.contains(previous)) {
        previous.focus();
      }
      return;
    }
    previousActiveElementRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const container = containerRef.current;
    if (!container || !window.argmax) return;

    setStartError(null);
    setExited(false);
    completedFiredRef.current = false;

    const term = new Terminal({
      fontFamily: resolveMonoFontStack(),
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
    // Focus the terminal so the user can start typing immediately. Without
    // this xterm captures input only after a click; the user typically has to
    // mouse into the dialog before keyboard input takes effect.
    term.focus();
    xtermRef.current = term;
    fitRef.current = fit;

    // ResizeObserver below retries once the container has dimensions.
    tryFit(fit);
    const { cols, rows } = term;

    let disposed = false;
    let localSessionId: string | null = null;
    let unsubscribeData: (() => void) | null = null;
    let unsubscribeExit: (() => void) | null = null;

    void window.argmax.mcp.auth
      .start({ cols, rows })
      .then(({ sessionId }) => {
        if (disposed) {
          void window.argmax?.mcp.auth.terminate(sessionId);
          return;
        }
        localSessionId = sessionId;
        sessionIdRef.current = sessionId;

        unsubscribeData = window.argmax!.mcp.auth.onData((event: McpAuthDataEvent) => {
          if (event.sessionId !== sessionId) return;
          term.write(event.data);
        });

        unsubscribeExit = window.argmax!.mcp.auth.onExit((event: McpAuthExitEvent) => {
          if (event.sessionId !== sessionId) return;
          const exitLine = `\r\n\x1b[2m[claude exited with code ${event.exitCode}]\x1b[0m\r\n`;
          term.write(exitLine);
          setExited(true);
          if (!completedFiredRef.current) {
            completedFiredRef.current = true;
            onCompletedRef.current?.();
          }
        });

        const dataSub = term.onData((data) => {
          void window.argmax?.mcp.auth.write({ sessionId, data });
        });

        (term as unknown as { __argmaxInputSub: { dispose: () => void } }).__argmaxInputSub = dataSub;
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : "Could not start Claude.";
        setStartError(message);
      });

    const ro = new ResizeObserver(() => {
      const fitAddon = fitRef.current;
      const xterm = xtermRef.current;
      const sid = sessionIdRef.current;
      if (!fitAddon || !xterm) return;
      if (!tryFit(fitAddon)) return;
      if (sid) {
        void window.argmax?.mcp.auth.resize({ sessionId: sid, cols: xterm.cols, rows: xterm.rows });
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
      if (localSessionId) {
        void window.argmax?.mcp.auth.terminate(localSessionId);
      }
      // Fire onCompleted on close even if the PTY didn't exit cleanly — the
      // user may have authenticated successfully and just closed the dialog.
      if (!completedFiredRef.current) {
        completedFiredRef.current = true;
        onCompletedRef.current?.();
      }
      term.dispose();
      xtermRef.current = null;
      fitRef.current = null;
      sessionIdRef.current = null;
    };
  }, [open]);

  if (!open) return null;

  // Portal into document.body so the modal escapes any parent stacking
  // context (Settings overlay, scroll containers, etc.). Without the portal,
  // a Settings-scoped containing block can swallow position: fixed children
  // and the dialog renders behind the page.
  const dialog = (
    <div
      className="mcp-auth-dialog-overlay"
      role="dialog"
      aria-label="Authenticate MCP via Claude"
      aria-modal="true"
    >
      <div className="mcp-auth-dialog" ref={dialogRef}>
        <header className="mcp-auth-dialog-header">
          <div>
            <h2>Authenticate MCP servers</h2>
            <p>
              Running <code>claude</code> with <code>/mcp</code>. Pick a server in the panel and follow
              its OAuth flow. Type <code>/quit</code> or close this dialog when finished.
            </p>
          </div>
          <button type="button" aria-label="Close authenticate dialog" onClick={onClose}>
            ×
          </button>
        </header>

        {startError ? (
          <p className="mcp-auth-dialog-error" role="alert">
            <AlertCircle size={14} aria-hidden="true" />
            <span>{startError}</span>
          </p>
        ) : null}

        <div
          ref={containerRef}
          className="mcp-auth-dialog-terminal"
          role="region"
          aria-label="MCP auth terminal"
        />

        <footer className="mcp-auth-dialog-actions">
          <button type="button" onClick={onClose}>
            {exited ? "Done" : "Close"}
          </button>
        </footer>
      </div>
    </div>
  );

  return createPortal(dialog, document.body);
}
