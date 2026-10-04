/**
 * A keyboard chord as a Tauri accelerator string (`CmdOrCtrl+Alt+Enter`).
 *
 * Stored in the same form the native layer takes, so a chord set in Settings
 * can be handed to a menu item or a global shortcut as written. This module
 * is the renderer's half: read a chord from a key event, match one against a
 * key event, and spell one for people.
 *
 * A chord needs a modifier (⌘/Ctrl or ⌥). Shift alone does not count: it types
 * capitals and newlines, and a chord a person can set by accident while
 * typing is one that sends a prompt they did not mean to send.
 */

interface Chord {
  /** ⌘ on macOS, Ctrl elsewhere. */
  mod: boolean;
  alt: boolean;
  shift: boolean;
  key: string;
}

const NAMED_KEYS: Record<string, string> = {
  " ": "Space",
  ArrowUp: "Up",
  ArrowDown: "Down",
  ArrowLeft: "Left",
  ArrowRight: "Right",
  Enter: "Enter",
  Tab: "Tab",
  Backspace: "Backspace",
  Delete: "Delete",
  Home: "Home",
  End: "End",
  PageUp: "PageUp",
  PageDown: "PageDown"
};

/**
 * Keys named by their physical position, because what they type depends on the
 * layout: the key above Tab is ` on a US board and § on an ISO one, and the
 * app's chat-cycle chord (⌘`) lives on it.
 */
const POSITIONAL_KEYS = new Set(["Backquote", "IntlBackslash"]);

/** Keys a chord cannot use: the ones text entry and dismissal depend on. */
const RESERVED_KEYS = new Set(["Tab", "Escape", "Backspace", "Delete"]);

const GLYPHS: Record<string, string> = {
  Enter: "↵",
  Up: "↑",
  Down: "↓",
  Left: "←",
  Right: "→",
  Space: "Space",
  Backspace: "⌫",
  Delete: "⌦",
  Backquote: "`",
  IntlBackslash: "§"
};

const MODIFIER_KEYS = new Set(["Meta", "Control", "Alt", "Shift", "AltGraph", "OS"]);

/** The key name a chord stores for an event, or null for a bare modifier. */
function keyName(event: Pick<KeyboardEvent, "key" | "code">): string | null {
  if (MODIFIER_KEYS.has(event.key)) return null;
  // With ⌥ held, `key` is the composed character (⌥A types å); the chord names
  // the physical letter or digit instead.
  if (/^Key[A-Z]$/.test(event.code)) return event.code.slice(3);
  if (/^Digit[0-9]$/.test(event.code)) return event.code.slice(5);
  if (POSITIONAL_KEYS.has(event.code)) return event.code;
  const named = NAMED_KEYS[event.key];
  if (named) return named;
  if (/^F([1-9]|1[0-2])$/.test(event.key)) return event.key;
  if (event.key.length === 1) return event.key.toUpperCase();
  return null;
}

export function parseChord(accelerator: string): Chord | null {
  const parts = accelerator.split("+");
  const key = parts.pop();
  if (!key || (key.length > 1 && !isNamedKey(key))) return null;
  const chord: Chord = { mod: false, alt: false, shift: false, key: key.length === 1 ? key.toUpperCase() : key };
  for (const part of parts) {
    switch (part) {
      case "CmdOrCtrl":
        chord.mod = true;
        break;
      case "Alt":
        chord.alt = true;
        break;
      case "Shift":
        chord.shift = true;
        break;
      default:
        return null;
    }
  }
  if (!chord.mod && !chord.alt) return null;
  if (RESERVED_KEYS.has(chord.key)) return null;
  return chord;
}

function isNamedKey(key: string): boolean {
  return (
    Object.values(NAMED_KEYS).includes(key) ||
    POSITIONAL_KEYS.has(key) ||
    /^F([1-9]|1[0-2])$/.test(key)
  );
}

/** A canonical accelerator for the chord a key event makes, or null if it is not a valid chord. */
export function chordFromEvent(
  event: Pick<KeyboardEvent, "key" | "code" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey">
): string | null {
  const key = keyName(event);
  if (!key) return null;
  const parts: string[] = [];
  if (event.metaKey || event.ctrlKey) parts.push("CmdOrCtrl");
  if (event.altKey) parts.push("Alt");
  if (event.shiftKey) parts.push("Shift");
  const accelerator = [...parts, key].join("+");
  return parseChord(accelerator) ? accelerator : null;
}

export function matchesChord(
  event: Pick<KeyboardEvent, "key" | "code" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey">,
  accelerator: string
): boolean {
  const chord = parseChord(accelerator);
  if (!chord) return false;
  return (
    keyName(event) === chord.key &&
    (event.metaKey || event.ctrlKey) === chord.mod &&
    event.altKey === chord.alt &&
    event.shiftKey === chord.shift
  );
}

/** One spelling per chord (`CmdOrCtrl+Alt+Shift+Key`), for comparing two. */
export function canonicalChord(accelerator: string): string | null {
  const chord = parseChord(accelerator);
  if (!chord) return null;
  return [chord.mod ? "CmdOrCtrl" : "", chord.alt ? "Alt" : "", chord.shift ? "Shift" : "", chord.key]
    .filter(Boolean)
    .join("+");
}

/** The chord as the cheat sheet spells it: `⌘⌥↵`. */
export function formatChord(accelerator: string, mac = isMacPlatform()): string {
  const chord = parseChord(accelerator);
  if (!chord) return accelerator;
  if (mac) {
    const key = GLYPHS[chord.key] ?? chord.key;
    return `${chord.mod ? "⌘" : ""}${chord.alt ? "⌥" : ""}${chord.shift ? "⇧" : ""}${key}`;
  }
  return [chord.mod ? "Ctrl" : "", chord.alt ? "Alt" : "", chord.shift ? "Shift" : "", chord.key]
    .filter(Boolean)
    .join("+");
}

function isMacPlatform(): boolean {
  return typeof navigator !== "undefined" && /Mac/i.test(navigator.platform);
}
