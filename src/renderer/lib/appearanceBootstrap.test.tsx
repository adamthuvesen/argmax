import { afterEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { appearanceBootstrapScript } from "./appearanceBootstrap.js";
import { readStoredBackgroundIntensity } from "./backgroundIntensity.js";
import { readStoredContrast } from "./contrast.js";
import { readStoredSidebarIntensity } from "./sidebarIntensity.js";
import { readStoredTheme, resolveTheme } from "./theme.js";

function runScript(): void {
  // oxlint-disable-next-line no-eval -- indirect eval runs the shipped bootstrap script in global scope
  (0, eval)(appearanceBootstrapScript());
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
    runScript();
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

  it("is inlined in index.html", () => {
    const page = readFileSync(resolve(process.cwd(), "index.html"), "utf8");
    const inlined = page.replace(/^ {6}/gm, "");
    expect(inlined).toContain(appearanceBootstrapScript());
  });
});
