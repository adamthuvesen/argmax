import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MASCOT_VISIBLE_STORAGE_KEY,
  resetMascotVisibilityForTests,
  setMascotVisible
} from "../lib/mascotVisibility.js";
import { Mascot } from "./Mascot.js";

describe("Mascot", () => {
  afterEach(() => {
    cleanup();
    window.localStorage.removeItem(MASCOT_VISIBLE_STORAGE_KEY);
    resetMascotVisibilityForTests();
  });

  it("draws no marks below the sprite", () => {
    render(<Mascot />);
    const svg = screen.getByRole("img", { name: "Fox mascot" });
    const below = [...svg.querySelectorAll("rect")].filter((rect) => {
      const y = Number(rect.getAttribute("y"));
      const height = Number(rect.getAttribute("height"));
      return y + height > 40;
    });
    expect(below).toHaveLength(0);
  });

  it("draws the sleepy sprite for the dozing mood", () => {
    render(<Mascot mood="sleepy" />);
    const svg = screen.getByRole("img", { name: "Fox mascot, dozing" });
    expect(svg.getAttribute("data-sprite")).toBe("sleepy");
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

  it("draws nothing once the mascot is turned off in Appearance", () => {
    window.localStorage.setItem(MASCOT_VISIBLE_STORAGE_KEY, "false");
    resetMascotVisibilityForTests();
    const { container } = render(<Mascot onClick={() => undefined} />);
    expect(container.querySelector("svg")).toBeNull();
    expect(screen.queryByRole("button", { name: "Fox mascot" })).toBeNull();
  });

  it("comes back when the setting is turned on again", () => {
    window.localStorage.setItem(MASCOT_VISIBLE_STORAGE_KEY, "false");
    resetMascotVisibilityForTests();
    render(<Mascot />);
    expect(screen.queryByRole("img")).toBeNull();

    act(() => {
      setMascotVisible(true);
    });
    expect(screen.getByRole("img", { name: "Fox mascot" })).toBeTruthy();
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
