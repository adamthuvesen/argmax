// @vitest-environment node
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { BACKGROUND_INTENSITY_STORAGE_KEY } from "./backgroundIntensity.js";
import { CONTRAST_STORAGE_KEY } from "./contrast.js";
import { SIDEBAR_INTENSITY_STORAGE_KEY } from "./sidebarIntensity.js";
import { THEME_STORAGE_KEY } from "./theme.js";

const indexHtml = readFileSync(new URL("../../../index.html", import.meta.url), "utf8");
const appearanceHook = readFileSync(
  new URL("../hooks/useLauncherAppearance.ts", import.meta.url),
  "utf8"
);

// Keys the inline script in index.html restores before React mounts.
const PRE_PAINTED: Record<string, string> = {
  THEME_STORAGE_KEY,
  BACKGROUND_INTENSITY_STORAGE_KEY,
  CONTRAST_STORAGE_KEY,
  SIDEBAR_INTENSITY_STORAGE_KEY
};

// Keys the hook persists that only React applies today.
const REACT_ONLY = new Set([
  "FONT_STORAGE_KEY",
  "FONT_SIZE_STORAGE_KEY",
  "CHAT_FONT_SIZE_STORAGE_KEY",
  "FONT_HEAVINESS_STORAGE_KEY",
  "INK_STRENGTH_STORAGE_KEY"
]);

describe("index.html pre-paint script", () => {
  it("classifies every storage key useLauncherAppearance persists", () => {
    const hookKeys = new Set(appearanceHook.match(/\b[A-Z_]+_STORAGE_KEY\b/g) ?? []);
    const unclassified = [...hookKeys].filter((name) => !(name in PRE_PAINTED) && !REACT_ONLY.has(name));
    // A new appearance key must be restored in index.html (PRE_PAINTED) or
    // knowingly left to React (REACT_ONLY). Forgetting both is how a saved
    // setting paints the default and then snaps on mount.
    expect(unclassified).toEqual([]);
  });

  it.each(Object.entries(PRE_PAINTED))("restores %s (%s) before React mounts", (_name, key) => {
    expect(indexHtml).toContain(`localStorage.getItem("${key}")`);
  });
});
