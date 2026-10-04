import { describe, expect, it } from "vitest";
import { displayChord, recordChord } from "./windowSnapshotChord.js";

const press = (code: string, mods: Partial<Record<"metaKey" | "ctrlKey" | "altKey" | "shiftKey", boolean>> = {}) =>
  recordChord({ code, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...mods });

describe("recording a chord", () => {
  it("builds the host's string from the physical key and the modifiers", () => {
    expect(press("KeyS", { metaKey: true, altKey: true, shiftKey: true })).toEqual({
      kind: "chord",
      chord: "Command+Alt+Shift+S"
    });
    expect(press("Digit4", { ctrlKey: true })).toEqual({ kind: "chord", chord: "Control+4" });
    expect(press("F5", { metaKey: true })).toEqual({ kind: "chord", chord: "Command+F5" });
  });

  it("waits through a bare modifier and refuses a key that would swallow typing", () => {
    expect(press("MetaLeft", { metaKey: true })).toEqual({ kind: "modifier-only" });
    expect(press("KeyS")).toEqual({ kind: "needs-modifier" });
    expect(press("KeyS", { shiftKey: true })).toEqual({ kind: "needs-modifier" });
  });
});

describe("showing a chord", () => {
  it("uses macOS glyphs in macOS order", () => {
    expect(displayChord("CommandOrControl+Alt+Shift+S")).toBe("⌥⇧⌘S");
    expect(displayChord("Control+Alt+KeyK")).toBe("⌃⌥K");
    expect(displayChord("Command+Digit4")).toBe("⌘4");
  });
});
