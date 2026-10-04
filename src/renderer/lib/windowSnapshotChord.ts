/**
 * Global-shortcut strings, the form `window-snapshot:configure` takes
 * (`Command+Alt+Shift+S`), from a key press, and as the glyphs Settings shows.
 */

const MODIFIER_CODES = new Set([
  "MetaLeft", "MetaRight", "ControlLeft", "ControlRight", "AltLeft", "AltRight", "ShiftLeft", "ShiftRight"
]);

/** The host reads physical key names, so `Alt+S` is the S key, not "ß". */
function keyName(code: string): string | null {
  const letter = /^Key([A-Z])$/.exec(code);
  if (letter) return letter[1] ?? null;
  const digit = /^Digit([0-9])$/.exec(code);
  if (digit) return digit[1] ?? null;
  if (MODIFIER_CODES.has(code) || code === "" || code === "Unidentified") return null;
  return code;
}

export type ChordRecording =
  | { kind: "chord"; chord: string }
  | { kind: "modifier-only" }
  | { kind: "needs-modifier" };

/** Reads one keydown while the user is recording a new chord. */
export function recordChord(event: Pick<KeyboardEvent, "code" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey">): ChordRecording {
  const key = keyName(event.code);
  if (key === null) return { kind: "modifier-only" };
  // Shift alone makes a capital letter, which would fire while typing.
  if (!event.metaKey && !event.ctrlKey && !event.altKey) return { kind: "needs-modifier" };
  const parts = [
    event.metaKey ? "Command" : null,
    event.ctrlKey ? "Control" : null,
    event.altKey ? "Alt" : null,
    event.shiftKey ? "Shift" : null,
    key
  ].filter((part): part is string => part !== null);
  return { kind: "chord", chord: parts.join("+") };
}

const GLYPHS: Readonly<Record<string, string>> = {
  command: "⌘", commandorcontrol: "⌘", cmdorctrl: "⌘", cmd: "⌘", super: "⌘", meta: "⌘",
  control: "⌃", ctrl: "⌃", alt: "⌥", option: "⌥", shift: "⇧"
};

/** `Command+Alt+Shift+S` as ⌘⌥⇧S, in the macOS order ⌃⌥⇧⌘. */
export function displayChord(chord: string): string {
  const tokens = chord.split("+").map((token) => token.trim()).filter(Boolean);
  const glyphs = new Set<string>();
  let key = "";
  for (const token of tokens) {
    const glyph = GLYPHS[token.toLowerCase()];
    if (glyph) glyphs.add(glyph);
    else key = token.replace(/^Key/, "").replace(/^Digit/, "").toUpperCase();
  }
  const order = ["⌃", "⌥", "⇧", "⌘"];
  return `${order.filter((glyph) => glyphs.has(glyph)).join("")}${key}`;
}
