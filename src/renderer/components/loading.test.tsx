import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { LinesSkeleton } from "./LinesSkeleton.js";
import { LoadingLine } from "./LoadingLine.js";
import { SkeletonPane } from "./SkeletonPane.js";
import { UsageSkeleton } from "./usage/UsageSkeleton.js";

describe("loading shapes", () => {
  afterEach(() => {
    cleanup();
  });

  it("announces every shape as a busy status naming what is loading", () => {
    render(
      <>
        <SkeletonPane label="Loading settings" />
        <LinesSkeleton rows={4} label="Loading diff" />
        <UsageSkeleton />
        <LoadingLine label="Loading files…" />
      </>
    );

    for (const label of ["Loading settings", "Loading diff", "Loading usage", "Loading files…"]) {
      expect(screen.getByRole("status", { name: label })).toHaveAttribute("aria-busy", "true");
    }
  });

  it("builds every skeleton out of the one shimmering block", () => {
    // The shapes drifted apart once before, each with its own fill and its own
    // `skeleton-shimmer` keyframes — two rules of the same name in two
    // stylesheets, so the later one silently redefined the earlier one's
    // motion. One class, one sweep, or that comes back.
    const pane = render(<SkeletonPane label="Loading workspace" />);
    expect(pane.container.querySelectorAll(".skeleton-row").length).toBeGreaterThanOrEqual(3);
    expect(pane.container.querySelectorAll(".loading-block").length).toBeGreaterThan(0);

    const lines = render(<LinesSkeleton rows={6} label="Loading file" />);
    expect(lines.container.querySelectorAll(".loading-block").length).toBe(6);

    const usage = render(<UsageSkeleton />);
    expect(usage.container.querySelectorAll(".loading-block").length).toBeGreaterThan(0);
    const usageSpans = usage.container.querySelectorAll("span");
    expect(usageSpans.length).toBeGreaterThan(0);
    for (const span of usageSpans) expect(span).toHaveClass("loading-block");
  });

  it("puts the working nest beside the phrase, so a wait never reads as content", () => {
    const { container } = render(<LoadingLine label="Reading remaining usage." />);

    expect(screen.getByRole("status", { name: "Reading remaining usage." })).toBeInTheDocument();
    expect(container.querySelector(".working-nest")).toHaveAttribute("data-active", "true");
  });
});
