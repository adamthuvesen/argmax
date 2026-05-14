// @vitest-environment node
import { describe, expect, it } from "vitest";
import { isAllowedAppNavigation, rendererFileNavigationPrefix } from "./appNavigation.js";

describe("app navigation guards", () => {
  it("allows packaged file navigation only inside the bundled renderer directory", () => {
    const prefix = rendererFileNavigationPrefix("/Applications/Argmax.app/Contents/Resources/app.asar/renderer/index.html");

    expect(isAllowedAppNavigation(`${prefix}index.html`, prefix)).toBe(true);
    expect(isAllowedAppNavigation(`${prefix}assets/index.js`, prefix)).toBe(true);
    expect(isAllowedAppNavigation("file:///Users/adam/malicious.html", prefix)).toBe(false);
    expect(isAllowedAppNavigation("file:///Applications/Argmax.app/Contents/Resources/app.asar/renderer-evil.html", prefix)).toBe(
      false
    );
  });

  it("keeps dev navigation scoped to the configured dev-server origin", () => {
    expect(isAllowedAppNavigation("http://127.0.0.1:5173/src/App.tsx", "http://127.0.0.1:5173")).toBe(true);
    expect(isAllowedAppNavigation("http://localhost:5173/src/App.tsx", "http://127.0.0.1:5173")).toBe(false);
  });
});
