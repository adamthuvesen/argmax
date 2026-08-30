import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { stableHash32 } from "../lib/stableHash.js";
import { WorkingNest } from "./WorkingNest.js";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
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

  it("anchors each relay animation to the document timeline", () => {
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
});
