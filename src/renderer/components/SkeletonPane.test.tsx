import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { SkeletonPane } from "./SkeletonPane.js";

describe("SkeletonPane", () => {
  afterEach(() => {
    cleanup();
  });

  it("renders a status region with aria-busy so assistive tech can announce the loading state", () => {
    render(<SkeletonPane />);
    const status = screen.getByRole("status", { name: "Loading workspace" });
    expect(status).toHaveAttribute("aria-busy", "true");
  });

  it("renders multiple shimmer placeholder rows", () => {
    const { container } = render(<SkeletonPane />);
    const rows = container.querySelectorAll(".skeleton-row");
    expect(rows.length).toBeGreaterThanOrEqual(3);
    const shimmer = container.querySelectorAll(".skeleton-shimmer");
    expect(shimmer.length).toBeGreaterThan(0);
  });
});
