import { cleanup, render, screen, within } from "@testing-library/react";
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
      </>,
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
    render(<SkeletonPane label="Loading workspace" />);
    const pane = screen.getByRole("status", { name: "Loading workspace" });
    expect(within(pane).getAllByTestId("skeleton-row").length).toBeGreaterThanOrEqual(3);
    expect(within(pane).getAllByTestId("loading-block").length).toBeGreaterThan(0);
    for (const block of within(pane).getAllByTestId("loading-block")) {
      expect(block).toHaveClass("loading-block");
    }

    render(<LinesSkeleton rows={6} label="Loading file" />);
    const lines = screen.getByRole("status", { name: "Loading file" });
    expect(within(lines).getAllByTestId("loading-block")).toHaveLength(6);
    for (const block of within(lines).getAllByTestId("loading-block")) {
      expect(block).toHaveClass("loading-block");
    }

    render(<UsageSkeleton />);
    const usage = screen.getByRole("status", { name: "Loading usage" });
    expect(within(usage).getAllByTestId("loading-block").length).toBeGreaterThan(0);
    // Every span in the usage skeleton is a block: a span with its own fill is
    // the drift this test exists to catch, and it would carry no test id.
    const usageSpanTags = usage.innerHTML.match(/<span\b[^>]*>/g) ?? [];
    expect(usageSpanTags.length).toBeGreaterThan(0);
    for (const tag of usageSpanTags) expect(tag).toMatch(/class="[^"]*\bloading-block\b/);
  });

  it("shows only the working nest, naming the wait for assistive tech", () => {
    render(<LoadingLine label="Reading remaining usage." />);

    const status = screen.getByRole("status", { name: "Reading remaining usage." });
    expect(status).not.toHaveTextContent(/\S/);
    expect(within(status).getByTestId("working-nest")).toHaveAttribute("data-active", "true");
  });
});
