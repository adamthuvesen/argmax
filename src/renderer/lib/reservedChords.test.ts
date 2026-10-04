import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CHAT_CYCLE_CODES, MENU_KEYBINDINGS } from "../../shared/menuKeybindings.js";
import { chordInUse } from "./reservedChords.js";
import { parseChord } from "./shortcutChord.js";

describe("reservedChords", () => {
  it("covers every accelerator the native menu declares", () => {
    const source = readFileSync(new URL("../../../src-tauri/src/menu.rs", import.meta.url), "utf8");
    const accelerators = [...source.matchAll(/Some\("((?:Alt\+|Shift\+|CmdOrCtrl\+)+[^"]+)"\)/g)].map(
      (match) => match[1]
    );
    expect(accelerators.length).toBeGreaterThan(10);
    for (const accelerator of accelerators) {
      expect(parseChord(accelerator), `${accelerator} must be a chord the recorder can read`).not.toBeNull();
      expect(chordInUse(accelerator), `${accelerator} is a menu accelerator`).not.toBeNull();
    }
  });

  it("covers the shared menu list, including the keys named by position", () => {
    for (const binding of MENU_KEYBINDINGS) {
      if (!binding.accelerator) continue;
      expect(chordInUse(binding.accelerator), binding.accelerator).not.toBeNull();
    }
    expect(chordInUse("CmdOrCtrl+Backquote")).toBe("Cycle chats by recency");
  });

  it("reserves the chat-cycle key on an ISO keyboard as it does on an ANSI one, with and without ⇧ or ⌥", () => {
    for (const code of CHAT_CYCLE_CODES) {
      for (const chord of [
        `CmdOrCtrl+${code}`,
        `CmdOrCtrl+Shift+${code}`,
        `CmdOrCtrl+Alt+${code}`,
        `CmdOrCtrl+Shift+Alt+${code}`
      ]) {
        expect(chordInUse(chord), chord).not.toBeNull();
      }
    }
    expect(chordInUse("CmdOrCtrl+IntlBackslash")).toBe("Cycle chats by recency");
    expect(chordInUse("CmdOrCtrl+Shift+IntlBackslash")).toBe("Cycle chats by recency, back");
  });

  it("refuses ⌘ plus any key the app answers, with whatever extra modifier the handlers accept", () => {
    for (const chord of [
      "CmdOrCtrl+Shift+K",
      "CmdOrCtrl+Alt+K",
      "CmdOrCtrl+Alt+F",
      "CmdOrCtrl+Alt+P",
      "CmdOrCtrl+Shift+,",
      "CmdOrCtrl+L",
      "CmdOrCtrl+T",
      "CmdOrCtrl+R",
      "CmdOrCtrl+S",
      "CmdOrCtrl+Alt+Backquote",
      "CmdOrCtrl+N"
    ]) {
      expect(chordInUse(chord), chord).not.toBeNull();
    }
  });

  it("leaves free the chords nothing answers", () => {
    for (const chord of ["Alt+Enter", "CmdOrCtrl+Enter", "CmdOrCtrl+Alt+Enter", "Alt+B", "CmdOrCtrl+Shift+Enter"]) {
      expect(chordInUse(chord), chord).toBeNull();
    }
  });
});
