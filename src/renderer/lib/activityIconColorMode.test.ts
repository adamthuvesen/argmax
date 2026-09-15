// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";
import {
  ACTIVITY_ICON_COLOR_MODE_STORAGE_KEY,
  activityIconColorModeSnapshot,
  initActivityIconColorMode,
  resetActivityIconColorModeForTests,
  setActivityIconColorMode
} from "./activityIconColorMode.js";

afterEach(() => {
  window.localStorage.clear();
  document.documentElement.removeAttribute("data-activity-icon-color");
  resetActivityIconColorModeForTests();
});

describe("activity icon color mode", () => {
  it("keeps semantic color as the default", () => {
    expect(activityIconColorModeSnapshot()).toBe("color");
  });

  it("puts monochrome mode on the document and persists it", () => {
    setActivityIconColorMode("monochrome");

    expect(document.documentElement.dataset.activityIconColor).toBe("monochrome");
    expect(window.localStorage.getItem(ACTIVITY_ICON_COLOR_MODE_STORAGE_KEY)).toBe(
      "monochrome"
    );
  });

  it("restores the persisted mode at boot", () => {
    window.localStorage.setItem(ACTIVITY_ICON_COLOR_MODE_STORAGE_KEY, "monochrome");
    resetActivityIconColorModeForTests();

    initActivityIconColorMode();

    expect(document.documentElement.dataset.activityIconColor).toBe("monochrome");
  });

  it("ignores a stored value it does not ship", () => {
    window.localStorage.setItem(ACTIVITY_ICON_COLOR_MODE_STORAGE_KEY, "duotone");
    resetActivityIconColorModeForTests();

    expect(activityIconColorModeSnapshot()).toBe("color");
  });
});
