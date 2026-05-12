import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppErrorBoundary } from "./AppErrorBoundary.js";

function ExplodingChild(): never {
  throw new Error("Synthetic renderer crash");
}

describe("AppErrorBoundary", () => {
  afterEach(() => cleanup());

  it("renders children when no error is thrown", () => {
    render(
      <AppErrorBoundary>
        <p>Healthy tree</p>
      </AppErrorBoundary>
    );
    expect(screen.getByText("Healthy tree")).toBeInTheDocument();
  });

  it("renders a recovery surface when a child throws", () => {
    // Silence React's expected console.error from boundary capture.
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      render(
        <AppErrorBoundary>
          <ExplodingChild />
        </AppErrorBoundary>
      );
    } catch {
      // React 19's StrictMode-free mode lets the boundary catch; outer throw should not bubble.
    }
    expect(screen.getByRole("alert", { name: "Argmax encountered an error" })).toBeInTheDocument();
    expect(screen.getByText("Synthetic renderer crash")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reload renderer" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open data folder" })).toBeInTheDocument();
    errSpy.mockRestore();
  });
});
