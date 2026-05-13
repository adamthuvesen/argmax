import { MENU_KEYBINDINGS, RENDERER_ONLY_KEYBINDINGS } from "../../shared/menuKeybindings.js";

export interface KeyBinding {
  accelerator: string;
  label: string;
}

/**
 * Derived from `src/shared/menuKeybindings.ts` so the native macOS menu and
 * the in-app cheat sheet can never drift. Order: menu-routed bindings first
 * (top-of-cheat-sheet matches top-of-menu ordering in
 * `buildAppMenuTemplate`), then renderer-only chords (`⌘1..9`, `⌘F`, `⌘J`,
 * `Esc`).
 */
export const KEYBOARD_BINDINGS: readonly KeyBinding[] = [
  ...MENU_KEYBINDINGS.map((entry) => ({ accelerator: entry.displayAccelerator, label: entry.label })),
  ...RENDERER_ONLY_KEYBINDINGS.map((entry) => ({
    accelerator: entry.displayAccelerator,
    label: entry.label
  }))
] as const;
