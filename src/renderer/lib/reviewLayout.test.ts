import { describe, expect, it } from "vitest";
import {
  activateReviewMode,
  closeReviewPane,
  createReviewLayout,
  normalizeReviewLayout,
  parseReviewLayout,
  setReviewPaneMode,
  setReviewSplitRatio,
  splitReviewMode
} from "./reviewLayout.js";

describe("review layout", () => {
  it("focuses an existing mode and replaces only the active pane for a new mode", () => {
    const split = splitReviewMode(createReviewLayout("changes"), "files", "bottom");

    expect(activateReviewMode(split, "changes")).toMatchObject({
      modes: ["changes", "files"],
      activeIndex: 0
    });
    expect(activateReviewMode(split, "browser")).toMatchObject({
      modes: ["changes", "browser"],
      activeIndex: 1
    });
  });

  it("swaps panes instead of duplicating a mode", () => {
    const split = splitReviewMode(createReviewLayout("changes"), "files", "bottom");

    expect(setReviewPaneMode(split, 0, "files")).toMatchObject({
      modes: ["files", "changes"],
      activeIndex: 0
    });
    expect(splitReviewMode(split, "changes", "bottom")).toMatchObject({
      modes: ["files", "changes"],
      activeIndex: 1
    });
  });

  it("uses a distinct useful fallback when splitting the visible mode", () => {
    expect(splitReviewMode(createReviewLayout("changes"), "changes", "bottom")).toMatchObject({
      modes: ["changes", "files"],
      activeIndex: 1
    });
    expect(splitReviewMode(createReviewLayout("browser"), "browser", "top")).toMatchObject({
      modes: ["changes", "browser"],
      activeIndex: 0
    });
  });

  it("promotes the surviving pane and retains the split ratio", () => {
    const split = setReviewSplitRatio(
      splitReviewMode(createReviewLayout("changes"), "files", "bottom"),
      0.65
    );

    expect(closeReviewPane(split, 0)).toEqual({
      modes: ["files"],
      activeIndex: 0,
      ratio: 0.65
    });
    expect(setReviewSplitRatio(split, 0.95).ratio).toBe(0.8);
    expect(setReviewSplitRatio(split, 0.05).ratio).toBe(0.2);
  });

  it("restores valid layouts and rejects duplicate or malformed panes", () => {
    expect(parseReviewLayout('{"modes":["changes","files"],"activeIndex":1,"ratio":0.6}')).toEqual({
      modes: ["changes", "files"],
      activeIndex: 1,
      ratio: 0.6
    });
    expect(parseReviewLayout('{"modes":["files","files"],"activeIndex":0,"ratio":0.5}')).toBeNull();
    expect(parseReviewLayout('{"modes":["files"],"activeIndex":1,"ratio":0.5}')).toBeNull();
  });

  it("replaces unavailable restored modes with distinct available modes", () => {
    expect(normalizeReviewLayout(
      { modes: ["terminal", "agents"], activeIndex: 1, ratio: 0.7 },
      ["changes", "files", "browser"]
    )).toEqual({
      modes: ["changes", "files"],
      activeIndex: 0,
      ratio: 0.7
    });
  });
});
