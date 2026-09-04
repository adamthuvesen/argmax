import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Mascot } from "./Mascot.js";

describe("Mascot", () => {
  afterEach(() => {
    cleanup();
  });

  it("renders idle by default with role=img and data-mood=idle", () => {
    render(<Mascot />);
    const svg = screen.getByRole("img");
    expect(svg.getAttribute("data-mood")).toBe("idle");
    expect(svg.getAttribute("aria-label")).toBe("Fox mascot");
  });

  it.each(["idle", "thinking", "sleepy", "sad"] as const)(
    "renders mood=%s and sets matching data-mood + aria-label",
    (mood) => {
      render(<Mascot mood={mood} />);
      const svg = screen.getByRole("img");
      expect(svg.getAttribute("data-mood")).toBe(mood);
      expect(svg.getAttribute("aria-label")).toMatch(/^Fox mascot/);
    }
  );

  it("applies the size prop to width and height", () => {
    render(<Mascot size={120} />);
    const svg = screen.getByRole("img");
    expect(svg.getAttribute("width")).toBe("120");
    expect(svg.getAttribute("height")).toBe("120");
  });

  it("uses the label override when provided", () => {
    render(<Mascot label="Custom mascot voice" mood="thinking" />);
    const svg = screen.getByRole("img", { name: "Custom mascot voice" });
    expect(svg.getAttribute("data-mood")).toBe("thinking");
  });

  it("draws the sleepy sprite for the dozing mood", () => {
    render(<Mascot mood="sleepy" />);
    const svg = screen.getByRole("img", { name: "Fox mascot, dozing" });
    expect(svg.getAttribute("data-sprite")).toBe("sleepy");
  });

  it("renders a clickable button when onClick is provided and fires the handler", () => {
    const onClick = vi.fn();
    render(<Mascot onClick={onClick} />);
    const button = screen.getByRole("button", { name: "Fox mascot" });
    fireEvent.click(button);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("applies data-pet during the hop window and clears it after the timeout", () => {
    vi.useFakeTimers();
    try {
      render(<Mascot onClick={() => undefined} />);
      const button = screen.getByRole("button");
      const svg = button.querySelector("svg");
      expect(svg?.getAttribute("data-pet")).toBeNull();

      act(() => {
        fireEvent.click(button);
      });
      expect(svg?.getAttribute("data-pet")).toBe("true");

      act(() => {
        vi.advanceTimersByTime(700);
      });
      expect(svg?.getAttribute("data-pet")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("winks while being petted and goes back to the base sprite after the hop", () => {
    vi.useFakeTimers();
    try {
      render(<Mascot onClick={() => undefined} />);
      const button = screen.getByRole("button");
      const svg = button.querySelector("svg");
      expect(svg?.getAttribute("data-sprite")).toBe("base");

      act(() => {
        fireEvent.click(button);
      });
      expect(svg?.getAttribute("data-sprite")).toBe("wink");

      act(() => {
        vi.advanceTimersByTime(700);
      });
      expect(svg?.getAttribute("data-sprite")).toBe("base");
    } finally {
      vi.useRealTimers();
    }
  });

  it("wears the sunglasses sprite and says so in the label", () => {
    render(<Mascot shades />);
    const svg = screen.getByRole("img", { name: "Fox mascot, in sunglasses" });
    expect(svg.getAttribute("data-sprite")).toBe("shades");
  });

  it("keeps the sunglasses on through a pet instead of winking", () => {
    vi.useFakeTimers();
    try {
      render(<Mascot shades onClick={() => undefined} />);
      const button = screen.getByRole("button");
      const svg = button.querySelector("svg");

      act(() => {
        fireEvent.click(button);
      });
      expect(svg?.getAttribute("data-pet")).toBe("true");
      expect(svg?.getAttribute("data-sprite")).toBe("shades");
    } finally {
      vi.useRealTimers();
    }
  });
});
