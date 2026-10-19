// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { ACTIVITY_MARK_STORAGE_KEY, initActivityMark, resetActivityMarkForTests } from "./activityMark.js";
import { readStoredBackgroundIntensity } from "./backgroundIntensity.js";
import { applyFontHeavinessToDocument, FONT_HEAVINESS_STORAGE_KEY, readStoredFontHeaviness } from "./fontHeaviness.js";
import { readStoredSidebarIntensity } from "./sidebarIntensity.js";
import { readStoredUserBubbleTint, USER_BUBBLE_TINT_STORAGE_KEY } from "./userBubbleTint.js";

afterEach(() => {
  window.localStorage.clear();
  resetActivityMarkForTests();
  document.documentElement.removeAttribute("data-activity-mark");
  document.documentElement.removeAttribute("data-session-underline");
  document.documentElement.style.removeProperty("--font-weight-offset");
});

describe("first-install appearance", () => {
  it("uses the requested surfaces, quiet activity mark, and neutral bubbles without writing storage", () => {
    expect(readStoredBackgroundIntensity()).toBe(100);
    expect(readStoredSidebarIntensity()).toBe(60);
    expect(readStoredFontHeaviness()).toBe(4);
    expect(readStoredUserBubbleTint()).toBe("neutral");

    initActivityMark();

    expect(document.documentElement.dataset.activityMark).toBe("halo");
    expect(document.documentElement.dataset.sessionUnderline).toBe("off");
    expect(window.localStorage.length).toBe(0);
  });

  it("retains saved choices and the existing font-heaviness scale", () => {
    window.localStorage.setItem("argmax.background.level", "70");
    window.localStorage.setItem("argmax.sidebar.level", "85");
    window.localStorage.setItem(FONT_HEAVINESS_STORAGE_KEY, "5");
    window.localStorage.setItem(USER_BUBBLE_TINT_STORAGE_KEY, "accent");
    window.localStorage.setItem(ACTIVITY_MARK_STORAGE_KEY, "nest");

    expect(readStoredBackgroundIntensity()).toBe(70);
    expect(readStoredSidebarIntensity()).toBe(85);
    expect(readStoredUserBubbleTint()).toBe("accent");
    applyFontHeavinessToDocument(readStoredFontHeaviness());
    expect(document.documentElement.style.getPropertyValue("--font-weight-offset")).toBe("0");
    applyFontHeavinessToDocument(4);
    expect(document.documentElement.style.getPropertyValue("--font-weight-offset")).toBe("-25");
    initActivityMark();
    expect(document.documentElement.dataset.activityMark).toBe("nest");
  });
});
