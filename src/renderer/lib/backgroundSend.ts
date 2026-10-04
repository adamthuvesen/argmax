import { chordInUse } from "./reservedChords.js";
import { parseChord } from "./shortcutChord.js";

/**
 * The chord that starts the New chat draft without leaving it: the launcher
 * sends the prompt, stays where it is, and clears itself for the next one.
 * Stored as an accelerator string (see `shortcutChord.ts`). ⌥↵ is free in the
 * composer: Enter sends, ⇧↵ breaks the line, and nothing else answers ⌥↵.
 */
export const BACKGROUND_SEND_SHORTCUT_KEY = "argmax.shortcuts.backgroundSend";
export const DEFAULT_BACKGROUND_SEND_SHORTCUT = "Alt+Enter";

/** The chord in effect: the stored one when it is a valid chord, else the default. */
export function readBackgroundSendShortcut(): string {
  try {
    const stored = window.localStorage.getItem(BACKGROUND_SEND_SHORTCUT_KEY);
    // A stored chord the app has since claimed for itself is not used.
    if (stored && parseChord(stored) && !chordInUse(stored)) return stored;
  } catch {
    // Unreadable storage keeps the default.
  }
  return DEFAULT_BACKGROUND_SEND_SHORTCUT;
}

export function writeBackgroundSendShortcut(accelerator: string): void {
  if (!parseChord(accelerator)) throw new Error(`Not a usable shortcut: ${accelerator}`);
  const owner = chordInUse(accelerator);
  if (owner) throw new Error(`${accelerator} is already used for: ${owner}`);
  try {
    window.localStorage.setItem(BACKGROUND_SEND_SHORTCUT_KEY, accelerator);
  } catch {
    // A quota failure costs the remap, never the app.
  }
  window.dispatchEvent(new Event(BACKGROUND_SEND_SHORTCUT_EVENT));
}

export function resetBackgroundSendShortcut(): void {
  try {
    window.localStorage.removeItem(BACKGROUND_SEND_SHORTCUT_KEY);
  } catch {
    // Nothing stored to remove.
  }
  window.dispatchEvent(new Event(BACKGROUND_SEND_SHORTCUT_EVENT));
}

/** Fired on this window after a remap, so a mounted launcher re-reads the chord. */
export const BACKGROUND_SEND_SHORTCUT_EVENT = "argmax:background-send-shortcut";

/** The problem with a chord offered for background send, or null if it can be used. */
export function backgroundSendChordProblem(accelerator: string): string | null {
  const owner = chordInUse(accelerator);
  return owner ? `Already used for: ${owner}.` : null;
}
