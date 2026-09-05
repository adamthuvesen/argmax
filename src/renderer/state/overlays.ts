import { useEffect, useSyncExternalStore } from "react";
import type { PaletteScope } from "../components/CommandPalette.js";
import type { SettingsNavigationTarget } from "../components/SettingsPanel.js";
import { DEFAULT_SETTINGS_GROUP, type SettingsGroupId } from "../components/settings/settingsMeta.js";
import { isTypingTarget } from "../lib/typingTarget.js";
import { hideFullLauncher } from "./launcherSurface.js";

// What is stacked over the shell: a full-screen page, the command palette, or
// the keyboard cheat sheet.
//
// Settings, Scheduled tasks, and Usage occupy the same slot in the workspace
// column, so one field holds whichever is showing and every close path clears
// it — a navigation site cannot leave one stranded over the grid. The palette
// and the cheat sheet float above that slot and open independently.
//
// Sidebar rows, the Argmax menu, the command palette, and the app menu all
// open the same pages. They call the mutators here rather than being handed a
// callback per page.

export type StandalonePage = "settings" | "schedule" | "usage";

export interface OverlaysSnapshot {
  /** Which full-screen page owns the workspace column, if any. */
  standalonePage: StandalonePage | null;
  /** The settings group the rail highlights and the panel renders. */
  settingsGroup: SettingsGroupId;
  /** The last navigation request, carrying a section to scroll to. */
  settingsNavigation: SettingsNavigationTarget | null;
  paletteOpen: boolean;
  paletteScope: PaletteScope;
  cheatSheetOpen: boolean;
}

const INITIAL: OverlaysSnapshot = {
  standalonePage: null,
  settingsGroup: DEFAULT_SETTINGS_GROUP.id,
  settingsNavigation: null,
  paletteOpen: false,
  paletteScope: "all",
  cheatSheetOpen: false
};

let state: OverlaysSnapshot = INITIAL;
// Monotonic so the settings panel can tell a repeat request for the same
// section from the one it already scrolled to.
let navigationRequests = 0;
const listeners = new Set<() => void>();

function publish(next: OverlaysSnapshot): void {
  state = next;
  for (const listener of listeners) listener();
}

/**
 * Opens Settings on `group`, optionally scrolled to one of its sections.
 * Re-entering while it is already open re-navigates rather than toggling.
 */
export function showSettings(group: SettingsGroupId = "general", sectionId?: string): void {
  navigationRequests += 1;
  hideFullLauncher();
  publish({
    ...state,
    standalonePage: "settings",
    settingsGroup: group,
    settingsNavigation: {
      group,
      ...(sectionId ? { sectionId } : {}),
      requestId: navigationRequests
    },
    paletteOpen: false
  });
}

export function showSchedulePage(): void {
  hideFullLauncher();
  publish({ ...state, standalonePage: "schedule", paletteOpen: false });
}

export function showUsagePage(): void {
  hideFullLauncher();
  publish({ ...state, standalonePage: "usage", paletteOpen: false });
}

/** Returns the workspace column to the grid, whichever page held it. */
export function hideStandalonePage(): void {
  if (state.standalonePage === null) return;
  publish({ ...state, standalonePage: null });
}

export function showCommandPalette(scope: PaletteScope): void {
  publish({ ...state, paletteOpen: true, paletteScope: scope });
}

export function hideCommandPalette(): void {
  if (!state.paletteOpen) return;
  publish({ ...state, paletteOpen: false });
}

export function showKeyboardCheatSheet(): void {
  if (state.cheatSheetOpen) return;
  publish({ ...state, cheatSheetOpen: true });
}

export function hideKeyboardCheatSheet(): void {
  if (!state.cheatSheetOpen) return;
  publish({ ...state, cheatSheetOpen: false });
}

/**
 * Closes one overlay, topmost first: palette → cheat sheet → standalone page.
 * Returns whether anything was open to close.
 */
export function dismissTopOverlay(): boolean {
  if (state.paletteOpen) {
    publish({ ...state, paletteOpen: false });
    return true;
  }
  if (state.cheatSheetOpen) {
    publish({ ...state, cheatSheetOpen: false });
    return true;
  }
  if (state.standalonePage !== null) {
    publish({ ...state, standalonePage: null });
    return true;
  }
  return false;
}

export function subscribeOverlays(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Stable between mutations, so `useSyncExternalStore` does not loop. */
export function overlaysSnapshot(): OverlaysSnapshot {
  return state;
}

export function useOverlays(): OverlaysSnapshot {
  return useSyncExternalStore(subscribeOverlays, overlaysSnapshot, overlaysSnapshot);
}

/**
 * Esc closes the topmost overlay, one per press. The typing-target guard keeps
 * Esc inside a textarea / contenteditable / role=textbox in the input, where it
 * cancels an inline edit instead of dismissing chrome.
 */
export function useOverlayEscape(): void {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      if (isTypingTarget(event.target)) return;
      if (dismissTopOverlay()) event.preventDefault();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);
}

export function resetOverlaysForTests(): void {
  navigationRequests = 0;
  publish(INITIAL);
}
