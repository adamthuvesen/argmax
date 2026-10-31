import { afterEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { appearanceBootstrapScript, type AppearanceSurface } from "./appearanceBootstrap.js";
import { readStoredAccent } from "./accent.js";
import { readStoredBackgroundIntensity } from "./backgroundIntensity.js";
import { readStoredContrast } from "./contrast.js";
import { readStoredSidebarIntensity } from "./sidebarIntensity.js";
import { readStoredTheme, resolveTheme } from "./theme.js";

function runScript(surface: AppearanceSurface): void {
  // oxlint-disable-next-line no-eval -- indirect eval runs the shipped bootstrap script in global scope
  (0, eval)(appearanceBootstrapScript(surface));
}

const root = document.documentElement;

afterEach(() => {
  window.localStorage.clear();
  for (const name of [...root.getAttributeNames()]) if (name !== "lang") root.removeAttribute(name);
});

describe("appearanceBootstrapScript", () => {
  it.each([
    [{}],
    [{ "argmax.theme.mode": "light" }],
    [
      {
        "argmax.theme.mode": "dark",
        "argmax.background.level": "42",
        "argmax.contrast.level": "75",
        "argmax.sidebar.level": "10",
      },
    ],
    [
      {
        "argmax.theme.mode": "nonsense",
        "argmax.background.level": "101",
        "argmax.contrast.level": "x",
        "argmax.sidebar.level": "-1",
      },
    ],
    [{ "argmax.background.intensity": "7" }],
    [{ "argmax.background.intensity": "11" }],
  ])("paints what the desktop modules read for %j", (stored) => {
    for (const [key, value] of Object.entries(stored)) window.localStorage.setItem(key, value);
    runScript("desktop");
    expect(root.getAttribute("data-theme")).toBe(resolveTheme(readStoredTheme()));
    expect(root.getAttribute("data-background-intensity")).toBe(
      String(readStoredBackgroundIntensity()),
    );
    expect(root.style.getPropertyValue("--background-intensity")).toBe(
      String(readStoredBackgroundIntensity()),
    );
    expect(root.getAttribute("data-sidebar-intensity")).toBe(String(readStoredSidebarIntensity()));
    if (root.hasAttribute("data-contrast")) {
      expect(root.getAttribute("data-contrast")).toBe(String(readStoredContrast()));
    }
  });

  it.each(["green", "teal", "black", "coral", "not-an-accent"])(
    "paints the phone accent the module reads for %s",
    (accent) => {
      window.localStorage.setItem("argmax.accent.tint", accent);
      runScript("mobile");
      expect(root.getAttribute("data-accent")).toBe(readStoredAccent());
    },
  );

  it("paints the phone's dark default and accent bubble", () => {
    runScript("mobile");
    expect(root.getAttribute("data-theme")).toBe("dark");
    expect(root.getAttribute("data-user-bubble")).toBe("accent");
  });

  it.each([
    ["index.html", "desktop"],
    ["mobile.html", "mobile"],
  ] as const)("is inlined in %s", (html, surface) => {
    const page = readFileSync(resolve(process.cwd(), html), "utf8");
    const inlined = page.replace(/^ {6}/gm, "");
    expect(inlined).toContain(appearanceBootstrapScript(surface));
  });
});
