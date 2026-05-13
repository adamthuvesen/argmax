import type { MenuCommand } from "./types.js";

/**
 * Single source of truth for menu-routed keybindings.
 *
 * `buildAppMenuTemplate` (main) and `KEYBOARD_BINDINGS` (renderer cheat sheet)
 * both derive from this list so a binding can never silently drift between
 * the macOS menu and the in-app cheat sheet. Each entry pairs:
 *
 * - `command`: the `MenuCommand` enum value that flows through the renderer's
 *   `menu:command` channel.
 * - `accelerator`: the Electron-style accelerator string (`CmdOrCtrl+K`).
 *   Forwarded to `MenuItemConstructorOptions.accelerator`.
 * - `displayAccelerator`: the glyph form for the cheat sheet (`⌘K`). Kept
 *   independent of the Electron string because the cheat sheet renders
 *   characters humans recognize, not Electron's normalized identifiers.
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
    command: "new-session",
    accelerator: "CmdOrCtrl+N",
    displayAccelerator: "⌘N",
    label: "New session",
    menuLocation: "file"
  },
  {
    command: "toggle-sidebar",
    accelerator: "CmdOrCtrl+B",
    displayAccelerator: "⌘B",
    label: "Toggle sidebar",
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
 * sheet alongside the menu-routed bindings. Use the same shape so the cheat
 * sheet can render them with a single component path.
 */
export const RENDERER_ONLY_KEYBINDINGS: ReadonlyArray<Omit<MenuKeybinding, "menuLocation"> & { menuLocation: null }> = [
  {
    command: "new-session",
    accelerator: "",
    displayAccelerator: "⌘1 – ⌘9",
    label: "Jump to session 1–9",
    menuLocation: null
  },
  {
    command: "new-session",
    accelerator: "",
    displayAccelerator: "⌘F",
    label: "Global search",
    menuLocation: null
  },
  {
    command: "new-session",
    accelerator: "",
    displayAccelerator: "⌘J",
    label: "Toggle integrated terminal",
    menuLocation: null
  },
  {
    command: "new-session",
    accelerator: "",
    displayAccelerator: "Esc",
    label: "Close the topmost overlay",
    menuLocation: null
  }
] as const;

export function findMenuKeybinding(command: MenuCommand): MenuKeybinding | undefined {
  return MENU_KEYBINDINGS.find((entry) => entry.command === command);
}
