import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ACTIVITY_MARK_OPTIONS,
  ACTIVITY_MARK_PART_COUNT,
  ACTIVITY_MARK_STORAGE_KEY,
  DEFAULT_SESSION_UNDERLINE,
  initActivityMark,
  resetActivityMarkForTests,
  SESSION_UNDERLINE_STORAGE_KEY,
  sessionUnderlineSnapshot,
  setSessionUnderline
} from "../lib/activityMark.js";
import { stableHash32 } from "../lib/stableHash.js";
import { WorkingNest } from "./WorkingNest.js";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  window.localStorage.clear();
  resetActivityMarkForTests();
  Reflect.deleteProperty(Element.prototype, "getAnimations");
});

describe("<WorkingNest />", () => {
  it("derives a stable quarter-cycle phase from the entity key", () => {
    const { container, rerender } = render(
      <WorkingNest active size={11} phaseKey="agent-charon" />
    );
    const expectedPhase = String(stableHash32("agent-charon") % 4);
    const nest = container.querySelector(".working-nest");

    expect(nest).toHaveAttribute("data-phase", expectedPhase);
    expect(nest).toHaveStyle({ "--working-nest-phase": expectedPhase });

    rerender(<WorkingNest active={false} size={14} phaseKey="agent-charon" />);
    expect(container.querySelector(".working-nest")).toHaveAttribute("data-phase", expectedPhase);
  });

  it("offsets separate jobs without randomizing during render", () => {
    const phases = ["session-alpha", "session-beta", "session-gamma", "session-delta"]
      .map((phaseKey) => stableHash32(phaseKey) % 4);

    expect(new Set(phases).size).toBeGreaterThan(1);
  });

  it("anchors every animated part to the document timeline", () => {
    const animations = Array.from({ length: 4 }, () => ({ startTime: 900 }));
    const getAnimations = vi.fn(function (this: Element) {
      const dot = Number(this.getAttribute("data-dot"));
      return [animations[dot - 1]];
    });
    Object.defineProperty(Element.prototype, "getAnimations", {
      configurable: true,
      value: getAnimations
    });

    render(<WorkingNest active phaseKey="session-alpha" />);

    expect(getAnimations).toHaveBeenCalledTimes(4);
    expect(animations.every((animation) => animation.startTime === 0)).toBe(true);
  });

  it("keeps a still nest out of the relay", () => {
    const getAnimations = vi.fn(() => []);
    Object.defineProperty(Element.prototype, "getAnimations", {
      configurable: true,
      value: getAnimations
    });

    const { container } = render(<WorkingNest active still size={13} />);

    expect(container.querySelector(".working-nest")).toHaveAttribute("data-still", "true");
    // Nothing to anchor: the CSS pins the dots, so the timeline pass is skipped.
    expect(getAnimations).not.toHaveBeenCalled();
  });

  it("keeps the settle state through rerenders after active work completes", () => {
    Object.defineProperty(Element.prototype, "getAnimations", {
      configurable: true,
      value: () => []
    });
    const { container, rerender } = render(
      <WorkingNest active phaseKey="session-alpha" />
    );

    rerender(<WorkingNest active={false} phaseKey="session-alpha" />);
    rerender(<WorkingNest active={false} size={12} phaseKey="session-alpha" />);

    expect(container.querySelector(".working-nest")).toHaveAttribute("data-settling", "true");
  });

  // Every style has to reach the stylesheet as `[data-mark]` and bring the exact
  // number of parts its rules position — a style that renders four parts against
  // nine cell positions draws a broken grid rather than failing loudly.
  it.each(ACTIVITY_MARK_OPTIONS.map((option) => option.id))(
    "renders the parts %s styles",
    (markId) => {
      const { container } = render(<WorkingNest active markId={markId} />);
      const nest = container.querySelector(".working-nest");

      expect(nest).toHaveAttribute("data-mark", markId);
      expect(container.querySelectorAll(".working-nest-part")).toHaveLength(
        ACTIVITY_MARK_PART_COUNT[markId]
      );
    }
  );

  it("carries the orbit trail inside the single rotating part", () => {
    const { container } = render(<WorkingNest active markId="orbit" />);
    const part = container.querySelector(".working-nest-part");

    // One animation for the whole comet: the five trail dots never animate.
    expect(container.querySelectorAll(".working-nest-part")).toHaveLength(1);
    expect(part?.children).toHaveLength(5);
  });

  it("follows the stored style when no override is given", () => {
    window.localStorage.setItem(ACTIVITY_MARK_STORAGE_KEY, "meter");
    resetActivityMarkForTests();

    const { container } = render(<WorkingNest active />);

    expect(container.querySelector(".working-nest")).toHaveAttribute("data-mark", "meter");
  });

  it("falls back to the nest when the stored style is not one we ship", () => {
    window.localStorage.setItem(ACTIVITY_MARK_STORAGE_KEY, "trace");
    resetActivityMarkForTests();

    const { container } = render(<WorkingNest active />);

    expect(container.querySelector(".working-nest")).toHaveAttribute("data-mark", "nest");
  });

  // The size arrives as a custom property rather than an inline width, so a
  // stylesheet can still resize the mark (`.thinking-working-nest` tracks the
  // chat type scale). An inline width would outrank every rule that tried.
  it("passes its size as a custom property, not an inline dimension", () => {
    const { container } = render(<WorkingNest active size={18} />);
    const nest = container.querySelector<HTMLElement>(".working-nest");

    expect(nest).toHaveStyle({ "--working-nest-size": "18px" });
    expect(nest?.style.width).toBe("");
  });

  // The underline is a stylesheet-only effect keyed off `<html>`, so the
  // attribute is the whole contract — nothing renders it and nothing else can
  // catch a regression here.
  describe("running row underline", () => {
    it("stays off until asked for", () => {
      expect(sessionUnderlineSnapshot()).toBe(DEFAULT_SESSION_UNDERLINE);
      expect(DEFAULT_SESSION_UNDERLINE).toBe("off");
    });

    it("puts the choice on the document and persists it", () => {
      setSessionUnderline("sweep");

      expect(document.documentElement.dataset.sessionUnderline).toBe("sweep");
      expect(window.localStorage.getItem(SESSION_UNDERLINE_STORAGE_KEY)).toBe("sweep");
    });

    it("restores both choices onto the document at boot", () => {
      window.localStorage.setItem(ACTIVITY_MARK_STORAGE_KEY, "orbit");
      window.localStorage.setItem(SESSION_UNDERLINE_STORAGE_KEY, "sweep");
      resetActivityMarkForTests();

      initActivityMark();

      expect(document.documentElement.dataset.activityMark).toBe("orbit");
      expect(document.documentElement.dataset.sessionUnderline).toBe("sweep");
    });

    it("ignores a stored value it does not ship", () => {
      window.localStorage.setItem(SESSION_UNDERLINE_STORAGE_KEY, "ember");
      resetActivityMarkForTests();

      expect(sessionUnderlineSnapshot()).toBe("off");
    });
  });
});
