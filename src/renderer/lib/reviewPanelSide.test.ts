// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_REVIEW_PANEL_SIDE,
  REVIEW_PANEL_SIDE_KEY,
  readStoredReviewPanelSide
} from "./reviewPanelSide.js";

afterEach(() => {
  window.localStorage.removeItem(REVIEW_PANEL_SIDE_KEY);
});

describe("reviewPanelSide", () => {
  it("defaults to right when nothing is stored", () => {
    expect(DEFAULT_REVIEW_PANEL_SIDE).toBe("right");
    expect(readStoredReviewPanelSide()).toBe("right");
  });

  it("reads a previously stored side", () => {
    window.localStorage.setItem(REVIEW_PANEL_SIDE_KEY, "left");
    expect(readStoredReviewPanelSide()).toBe("left");
  });

  it("falls back to right when storage holds an unknown value", () => {
    window.localStorage.setItem(REVIEW_PANEL_SIDE_KEY, "top");
    expect(readStoredReviewPanelSide()).toBe("right");
  });
});
