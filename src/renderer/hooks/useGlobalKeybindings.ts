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
  /** Cmd+Shift+F opens the workspace content search overlay (git grep). */
  onOpenContentSearch: () => void;
  /** Cmd+1..9 selects the nth session and closes the settings panel. */
  onSelectSession: (session: SessionSummary) => void;
  /** Cmd+1..9 also closes the settings panel. */
  onCloseSettings: () => void;
  /**
   * Cmd+W closes the focused session pane. Returns `true` if a pane was
   * closed (suppresses the browser/Tauri default of closing the window).
   * No-ops when the grid is empty.
   */
  onCloseFocusedPane?: () => boolean;
}

/**
 * Document-level keybinding handler for the app shell.
 *
 * Bindings:
 *   Cmd/Ctrl+1..9 → jump to the nth visible session
 *   Cmd/Ctrl+,    → open-settings (menu command)
 *   Cmd/Ctrl+N    → new-session (menu command)
 *   Cmd/Ctrl+K    → open-command-palette (menu command)
 *   Cmd/Ctrl+P    → open-command-palette (alias of ⌘K — context-aware
 *                   Files group surfaces in the palette when a workspace
 *                   or project is the active surface)
 *   Cmd/Ctrl+/    → open-cheat-sheet (menu command)
 *   Cmd/Ctrl+F    → open global search (session messages)
 *   Cmd/Ctrl+Shift+F → open workspace content search (git grep)
 *
 * Typing-target guard: any keypress while focus is in
 * contenteditable / textarea / role=textbox is left alone. The Esc
 * dismissal lives in `useOverlays`; this hook is open-only.
 */
export function useGlobalKeybindings({
  sessions,
  onMenuCommand,
  onOpenSearch,
  onOpenContentSearch,
  onSelectSession,
  onCloseSettings,
  onCloseFocusedPane
}: GlobalKeybindingArgs): void {
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (!(event.metaKey || event.ctrlKey)) return;
      // Cmd+W closes the focused pane — fires regardless of typing context so
      // the shortcut works while the user is in a composer textarea. Skip
      // during IME composition (some Linux IMEs send `w` while modifying)
      // and on autorepeat so holding Cmd+W doesn't close every pane in a
      // burst.
      if (event.key.toLowerCase() === "w" && !event.shiftKey && !event.altKey) {
        if (event.isComposing || event.repeat) return;
        if (onCloseFocusedPane?.()) {
          event.preventDefault();
        }
        return;
      }
      // Cmd+N fires even when focus is in the composer — "new" is an
      // OS-level reflex and no native textarea action binds Cmd+N.
      if (event.key.toLowerCase() === "n" && !event.shiftKey && !event.altKey) {
        if (event.isComposing || event.repeat) return;
        event.preventDefault();
        onMenuCommand("new-session");
        return;
      }
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
      if (event.key.toLowerCase() === "k") {
        event.preventDefault();
        onMenuCommand("open-command-palette");
        return;
      }
      if (event.key.toLowerCase() === "p" && !event.shiftKey) {
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
        if (event.shiftKey) {
          onOpenContentSearch();
        } else {
          onOpenSearch();
        }
        return;
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [
    sessions,
    onMenuCommand,
    onOpenSearch,
    onOpenContentSearch,
    onSelectSession,
    onCloseSettings,
    onCloseFocusedPane
  ]);

  // Bind to the main-process menu-command channel separately so the same
  // shortcut works whether the renderer or the native menu has focus.
  useEffect(() => {
    if (typeof window === "undefined" || !window.argmax) return;
    return window.argmax.menu.onCommand(onMenuCommand);
  }, [onMenuCommand]);
}
