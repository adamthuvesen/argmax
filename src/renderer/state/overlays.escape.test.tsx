import { cleanup, fireEvent, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  overlaysSnapshot,
  resetOverlaysForTests,
  showSettings,
  useOverlayEscape
} from "./overlays.js";

describe("useOverlayEscape", () => {
  afterEach(() => {
    cleanup();
    resetOverlaysForTests();
  });

  it("closes Settings from a typing target and consumes the press", () => {
    renderHook(() => useOverlayEscape());
    showSettings();
    const input = document.createElement("textarea");
    document.body.appendChild(input);
    try {
      const event = new KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true,
        cancelable: true
      });
      input.dispatchEvent(event);

      expect(overlaysSnapshot().standalonePage).toBeNull();
      expect(event.defaultPrevented).toBe(true);
    } finally {
      input.remove();
    }
  });

  it("leaves already-consumed, repeated, composing, and modified Escape alone", () => {
    renderHook(() => useOverlayEscape());
    showSettings();

    const consumed = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    consumed.preventDefault();
    document.dispatchEvent(consumed);
    fireEvent.keyDown(document, { key: "Escape", repeat: true });
    fireEvent.keyDown(document, { key: "Escape", isComposing: true });
    fireEvent.keyDown(document, { key: "Escape", ctrlKey: true });

    expect(overlaysSnapshot().standalonePage).toBe("settings");
  });
});
