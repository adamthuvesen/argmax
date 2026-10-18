// @vitest-environment node
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
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

function runPrePaint(saved: Record<string, string> = {}, systemDark = false) {
  const attributes: Record<string, string> = {};
  const properties: Record<string, string> = {};
  const script = indexHtml.match(/<script>([\s\S]*?)<\/script>/)?.[1];
  if (!script) throw new Error("Missing appearance pre-paint script");
  runInNewContext(script, {
    localStorage: { getItem: (key: string) => saved[key] ?? null },
    window: { matchMedia: () => ({ matches: systemDark }) },
    document: {
      documentElement: {
        setAttribute: (name: string, value: string) => { attributes[name] = value; },
        style: { setProperty: (name: string, value: string) => { properties[name] = value; } }
      }
    }
  });
  return { attributes, properties };
}

describe("index.html pre-paint script", () => {
  it.each([false, true])("paints first-install defaults with system dark=%s", (systemDark) => {
    const { attributes, properties } = runPrePaint({}, systemDark);
    expect(attributes["data-theme"]).toBe(systemDark ? "dark" : "light");
    expect(attributes["data-background-intensity"]).toBe("100");
    expect(properties["--background-intensity"]).toBe("100");
    expect(attributes["data-sidebar-intensity"]).toBe("60");
    expect(properties["--sidebar-intensity"]).toBe("60");
  });

  it("paints saved choices before React without replacing them with new defaults", () => {
    const { attributes, properties } = runPrePaint({
      [THEME_STORAGE_KEY]: "dark",
      [BACKGROUND_INTENSITY_STORAGE_KEY]: "70",
      [SIDEBAR_INTENSITY_STORAGE_KEY]: "85",
      [CONTRAST_STORAGE_KEY]: "80"
    });
    expect(attributes["data-theme"]).toBe("dark");
    expect(properties["--background-intensity"]).toBe("70");
    expect(properties["--sidebar-intensity"]).toBe("85");
    expect(properties["--contrast"]).toBe("80");
  });

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
