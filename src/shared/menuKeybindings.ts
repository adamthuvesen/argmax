import type { MenuCommand } from "./types.js";

/**
 * Single source of truth for menu-routed keybindings.
 *
 * `app_menu_spec` (src-tauri/src/menu.rs) and `KEYBOARD_BINDINGS` (renderer
 * cheat sheet)
 * both derive from this list so a binding can never silently drift between
 * the macOS menu and the in-app cheat sheet. Each entry pairs:
 *
 * - `command`: the `MenuCommand` enum value that flows through the renderer's
 *   `menu:command` channel.
 * - `accelerator`: the menu accelerator accelerator string (`CmdOrCtrl+K`).
 *   Forwarded to the Tauri menu item's accelerator.
 * - `displayAccelerator`: the glyph form for the cheat sheet (`⌘K`). Kept
 *   independent of the menu string because the cheat sheet renders
 *   characters humans recognize, not Tauri's normalized identifiers.
 * - `label`: the menu and cheat-sheet copy.
 * - `menuLocation`: which submenu the entry lives under in the macOS menu.
 *   `null` means the binding exists in the cheat sheet but not the menu
 *   (e.g. renderer-only chords like `Esc`).
 */
export interface MenuKeybinding {
  command: MenuCommand;
  accelerator: string;
  displayAccelerator: string;
  label: string;
  menuLocation: "app" | "file" | "view" | "help" | null;
}

export const MENU_KEYBINDINGS: readonly MenuKeybinding[] = [
  {
    command: "open-command-palette",
    accelerator: "CmdOrCtrl+K",
    displayAccelerator: "⌘K",
    label: "Open command palette",
    menuLocation: "view"
  },
  {
    command: "open-settings",
    accelerator: "CmdOrCtrl+,",
    displayAccelerator: "⌘,",
    label: "Open Settings",
    menuLocation: "app"
  },
  {
    command: "check-for-updates",
    accelerator: "",
    displayAccelerator: "",
    label: "Check for Updates",
    menuLocation: "app"
  },
  {
    command: "new-session",
    accelerator: "CmdOrCtrl+N",
    displayAccelerator: "⌘N",
    label: "New chat",
    menuLocation: "file"
  },
  {
    command: "close-surface",
    accelerator: "CmdOrCtrl+W",
    displayAccelerator: "⌘W",
    label: "Close browser tab or chat pane",
    menuLocation: "file"
  },
  {
    command: "toggle-sidebar",
    accelerator: "CmdOrCtrl+B",
    displayAccelerator: "⌘B",
    label: "Toggle right sidebar",
    menuLocation: "view"
  },
  {
    command: "toggle-left-sidebar",
    accelerator: "CmdOrCtrl+Shift+B",
    displayAccelerator: "⌘⇧B",
    label: "Toggle left sidebar",
    menuLocation: "view"
  },
  {
    command: "toggle-debug-log",
    accelerator: "CmdOrCtrl+Shift+D",
    displayAccelerator: "⌘⇧D",
    label: "Toggle debug log",
    menuLocation: "view"
  },
  {
    command: "open-cheat-sheet",
    accelerator: "CmdOrCtrl+/",
    displayAccelerator: "⌘/",
    label: "Show keyboard shortcuts",
    menuLocation: "help"
  }
] as const;

/**
 * Renderer-only chords (no native-menu equivalent). Surfaced in the cheat
 * sheet alongside the menu-routed bindings. These never dispatch a menu
 * command — they're handled inside the renderer via `useGlobalKeybindings`
 * or pane-local effects — so the shape omits `command` and `accelerator`
 * to make that contract explicit (and prevent a future refactor from
 * silently wiring the wrong command).
 */
export interface RendererOnlyKeybinding {
  displayAccelerator: string;
  label: string;
}

export const RENDERER_ONLY_KEYBINDINGS: readonly RendererOnlyKeybinding[] = [
  { displayAccelerator: "⌘1 – ⌘9", label: "Jump to chat 1–9" },
  // ⌘P opens the same palette as ⌘K with the Files filter pre-selected.
  // Tab cycles filters once it is open, so neither chord is a dead end.
  { displayAccelerator: "⌘P", label: "Open command palette on Files" },
  { displayAccelerator: "⌘G", label: "Toggle file tree" },
  { displayAccelerator: "⌘F", label: "Open command palette on Messages" },
  { displayAccelerator: "⌘⇧F", label: "Open command palette on File Contents" },
  { displayAccelerator: "⌘J", label: "Toggle integrated terminal" },
  { displayAccelerator: "Esc", label: "Close the topmost overlay" }
] as const;
