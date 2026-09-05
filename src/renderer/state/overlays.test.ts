import { afterEach, describe, expect, it } from "vitest";
import {
  dismissTopOverlay,
  hideStandalonePage,
  overlaysSnapshot,
  resetOverlaysForTests,
  showCommandPalette,
  showKeyboardCheatSheet,
  showSchedulePage,
  showSettings,
  showUsagePage
} from "./overlays.js";

afterEach(() => {
  resetOverlaysForTests();
});

describe("overlays", () => {
  it("keeps the full-screen pages mutually exclusive", () => {
    showSchedulePage();
    expect(overlaysSnapshot().standalonePage).toBe("schedule");

    showSettings();
    expect(overlaysSnapshot().standalonePage).toBe("settings");

    showUsagePage();
    expect(overlaysSnapshot().standalonePage).toBe("usage");
  });

  // Every navigation site in the shell dismisses the page before showing a
  // session, project, or launcher. Whichever page holds the slot must ride
  // along, or it stays stranded over the grid it was supposed to hand back.
  it("hands the workspace column back whichever page held it", () => {
    showSchedulePage();
    hideStandalonePage();
    expect(overlaysSnapshot().standalonePage).toBeNull();
  });

  it("re-navigating settings issues a new request for the same section", () => {
    showSettings("advanced", "settings-about");
    const first = overlaysSnapshot().settingsNavigation;
    showSettings("advanced", "settings-about");
    const second = overlaysSnapshot().settingsNavigation;

    expect(first?.requestId).toBeDefined();
    expect(second?.requestId).toBe((first?.requestId ?? 0) + 1);
  });

  it("dismisses one overlay per Esc, topmost first", () => {
    showSettings();
    showKeyboardCheatSheet();
    showCommandPalette("files");

    expect(dismissTopOverlay()).toBe(true);
    expect(overlaysSnapshot().paletteOpen).toBe(false);
    // The scope survives the close, so reopening on ⌘K is what changes it.
    expect(overlaysSnapshot().paletteScope).toBe("files");

    expect(dismissTopOverlay()).toBe(true);
    expect(overlaysSnapshot().cheatSheetOpen).toBe(false);

    expect(dismissTopOverlay()).toBe(true);
    expect(overlaysSnapshot().standalonePage).toBeNull();

    expect(dismissTopOverlay()).toBe(false);
  });

  it("returns one snapshot reference until something changes", () => {
    const first = overlaysSnapshot();
    expect(overlaysSnapshot()).toBe(first);
    showCommandPalette("all");
    expect(overlaysSnapshot()).not.toBe(first);
  });
});
