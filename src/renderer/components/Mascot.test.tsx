import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Mascot } from "./Mascot.js";

describe("Mascot", () => {
  afterEach(() => {
    cleanup();
  });

  it("renders idle by default with role=img and data-mood=idle", () => {
    render(<Mascot />);
    const svg = screen.getByRole("img");
    expect(svg.getAttribute("data-mood")).toBe("idle");
    expect(svg.getAttribute("aria-label")).toBe("Cloud mascot");
  });

  it.each(["idle", "thinking", "happy", "sad", "working"] as const)(
    "renders mood=%s and sets matching data-mood + aria-label",
    (mood) => {
      render(<Mascot mood={mood} />);
      const svg = screen.getByRole("img");
      expect(svg.getAttribute("data-mood")).toBe(mood);
      expect(svg.getAttribute("aria-label")).toMatch(/^Cloud mascot/);
    }
  );

  it("applies the size prop to width and height", () => {
    render(<Mascot size={120} />);
    const svg = screen.getByRole("img");
    expect(svg.getAttribute("width")).toBe("120");
    expect(svg.getAttribute("height")).toBe("120");
  });

  it("uses the label override when provided", () => {
    render(<Mascot label="Custom mascot voice" mood="happy" />);
    const svg = screen.getByRole("img", { name: "Custom mascot voice" });
    expect(svg.getAttribute("data-mood")).toBe("happy");
  });

});
