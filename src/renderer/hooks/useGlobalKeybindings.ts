import { useEffect } from "react";
import { isTypingTarget } from "../lib/typingTarget.js";
import type { MenuCommand, SessionSummary } from "../../shared/types.js";

interface GlobalKeybindingArgs {
  /** Most-recently-known sessions list. Cmd+1..9 jumps to the nth. */
  sessions: SessionSummary[];
  /** Re-uses the menu-command dispatcher so keypresses share behavior with the native menu. */
  onMenuCommand: (command: MenuCommand) => void;
  /** Cmd+F opens the global search overlay. */
  onOpenSearch: () => void;
  /** Cmd+1..9 selects the nth session and closes the settings panel. */
  onSelectSession: (session: SessionSummary) => void;
  /** Cmd+1..9 also closes the settings panel. */
  onCloseSettings: () => void;
}

/**
 * Document-level keybinding handler for the app shell.
 *
 * Bindings:
 *   Cmd/Ctrl+1..9 → jump to the nth visible session
 *   Cmd/Ctrl+,    → open-settings (menu command)
 *   Cmd/Ctrl+N    → new-session (menu command)
 *   Cmd/Ctrl+K    → open-command-palette (menu command)
 *   Cmd/Ctrl+/    → open-cheat-sheet (menu command)
 *   Cmd/Ctrl+F    → open global search
 *
 * Typing-target guard: any keypress while focus is in
 * contenteditable / textarea / role=textbox is left alone. The Esc
 * dismissal lives in `useOverlays`; this hook is open-only.
 */
export function useGlobalKeybindings({
  sessions,
  onMenuCommand,
  onOpenSearch,
  onSelectSession,
  onCloseSettings
}: GlobalKeybindingArgs): void {
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (!(event.metaKey || event.ctrlKey)) return;
      if (isTypingTarget(event.target)) return;
      const digit = parseInt(event.key, 10);
      if (Number.isFinite(digit) && digit >= 1 && digit <= 9) {
        const targetSession = sessions[digit - 1];
        if (!targetSession) return;
        event.preventDefault();
        onCloseSettings();
        onSelectSession(targetSession);
        return;
      }
      if (event.key === ",") {
        event.preventDefault();
        onMenuCommand("open-settings");
        return;
      }
      if (event.key.toLowerCase() === "n" && !event.shiftKey) {
        event.preventDefault();
        onMenuCommand("new-session");
        return;
      }
      if (event.key.toLowerCase() === "k") {
        event.preventDefault();
        onMenuCommand("open-command-palette");
        return;
      }
      if (event.key === "/") {
        event.preventDefault();
        onMenuCommand("open-cheat-sheet");
        return;
      }
      if (event.key.toLowerCase() === "f") {
        event.preventDefault();
        onOpenSearch();
        return;
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [sessions, onMenuCommand, onOpenSearch, onSelectSession, onCloseSettings]);

  // Bind to the main-process menu-command channel separately so the same
  // shortcut works whether the renderer or the native menu has focus.
  useEffect(() => {
    if (typeof window === "undefined" || !window.argmax) return;
    return window.argmax.menu.onCommand(onMenuCommand);
  }, [onMenuCommand]);
}
