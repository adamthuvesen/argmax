// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import {
  LAUNCHER_HEADINGS,
  LAUNCHER_HEADING_KEY,
  pickLauncherHeading
} from "./launcherHeadings.js";

afterEach(() => {
  window.localStorage.clear();
});

describe("launcher headings", () => {
  it("picks a heading from the catalog and remembers it", () => {
    const heading = pickLauncherHeading();
    expect(LAUNCHER_HEADINGS).toContain(heading);
    expect(window.localStorage.getItem(LAUNCHER_HEADING_KEY)).toBe(heading);
  });

  it("never repeats the previous heading", () => {
    let previous = pickLauncherHeading();
    for (let i = 0; i < 50; i += 1) {
      const next = pickLauncherHeading();
      expect(next).not.toBe(previous);
      previous = next;
    }
  });

  it("still picks a heading when the stored value is unknown", () => {
    window.localStorage.setItem(LAUNCHER_HEADING_KEY, "Something else entirely");
    expect(LAUNCHER_HEADINGS).toContain(pickLauncherHeading());
  });
});
