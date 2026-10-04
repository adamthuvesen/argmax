// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { chordFromEvent, formatChord, matchesChord, parseChord } from "./shortcutChord.js";

function key(init: Partial<KeyboardEvent> & { key: string }): KeyboardEvent {
  return new KeyboardEvent("keydown", { code: "", ...init });
}

describe("shortcut chords", () => {
  it("needs a modifier that is not Shift, and a key a person can bind", () => {
    expect(parseChord("Alt+Enter")).toEqual({ mod: false, alt: true, shift: false, key: "Enter" });
    expect(parseChord("CmdOrCtrl+Shift+k")).toMatchObject({ mod: true, shift: true, key: "K" });
    expect(parseChord("Enter")).toBeNull();
    expect(parseChord("Shift+Enter")).toBeNull();
    expect(parseChord("CmdOrCtrl+Tab")).toBeNull();
    expect(parseChord("CmdOrCtrl+Escape")).toBeNull();
    expect(parseChord("Hyper+Enter")).toBeNull();
    expect(parseChord("")).toBeNull();
  });

  it("matches the exact modifier set and ignores key case", () => {
    expect(matchesChord(key({ key: "Enter", altKey: true }), "Alt+Enter")).toBe(true);
    expect(matchesChord(key({ key: "Enter", altKey: true, shiftKey: true }), "Alt+Enter")).toBe(false);
    expect(matchesChord(key({ key: "Enter" }), "Alt+Enter")).toBe(false);
    expect(matchesChord(key({ key: "k", metaKey: true }), "CmdOrCtrl+K")).toBe(true);
    expect(matchesChord(key({ key: "k", ctrlKey: true }), "CmdOrCtrl+K")).toBe(true);
  });

  it("names a letter by its physical key when Option has changed what it types", () => {
    const optionA = key({ key: "å", code: "KeyA", altKey: true });

    expect(chordFromEvent(optionA)).toBe("Alt+A");
    expect(matchesChord(optionA, "Alt+A")).toBe(true);
  });

  it("reads a chord off an event only when it is a valid one", () => {
    expect(chordFromEvent(key({ key: "Shift", shiftKey: true }))).toBeNull();
    expect(chordFromEvent(key({ key: "Enter" }))).toBeNull();
    expect(chordFromEvent(key({ key: "Enter", metaKey: true, altKey: true }))).toBe("CmdOrCtrl+Alt+Enter");
    expect(chordFromEvent(key({ key: "ArrowUp", altKey: true }))).toBe("Alt+Up");
  });

  it("names the key above Tab by its position, so ⌘` and ⌘§ are the same chord", () => {
    const us = key({ key: "`", code: "Backquote", metaKey: true });
    const iso = key({ key: "§", code: "IntlBackslash", metaKey: true });

    expect(chordFromEvent(us)).toBe("CmdOrCtrl+Backquote");
    expect(chordFromEvent(iso)).toBe("CmdOrCtrl+IntlBackslash");
    expect(parseChord("CmdOrCtrl+Backquote")).toMatchObject({ mod: true, key: "Backquote" });
    expect(matchesChord(us, "CmdOrCtrl+Backquote")).toBe(true);
    expect(formatChord("CmdOrCtrl+Backquote", true)).toBe("⌘`");
  });

  it("spells a chord for each platform", () => {
    expect(formatChord("CmdOrCtrl+Alt+Enter", true)).toBe("⌘⌥↵");
    expect(formatChord("CmdOrCtrl+Alt+Enter", false)).toBe("Ctrl+Alt+Enter");
    expect(formatChord("Alt+K", true)).toBe("⌥K");
  });
});
