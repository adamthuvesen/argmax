import { CHAT_CYCLE_CODES, MENU_KEYBINDINGS } from "../../shared/menuKeybindings.js";
import { canonicalChord } from "./shortcutChord.js";

/**
 * Chords the app, the native menu or the platform's editing already answer. A
 * user shortcut on one of them would fire two actions on one press, and a
 * menu accelerator may never reach the page at all. The renderer-only list in
 * `menuKeybindings.ts` is display text (`⌘1 – ⌘9`), so the chords behind it
 * are spelled out here.
 */
const RENDERER_CHORDS: ReadonlyArray<readonly [string, string]> = [
  ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map((digit) => [`CmdOrCtrl+${digit}`, "Jump to chat"] as const),
  ["CmdOrCtrl+A", "Open command palette on Actions"],
  ["CmdOrCtrl+P", "Open command palette on Files"],
  ["CmdOrCtrl+G", "Toggle file tree"],
  ["CmdOrCtrl+F", "Open command palette on Messages"],
  ["CmdOrCtrl+Shift+F", "Open command palette on File Contents"],
  ["CmdOrCtrl+J", "Toggle integrated terminal"],
  ["CmdOrCtrl+Shift+M", "Open the model picker"],
  ["CmdOrCtrl+Shift+E", "Open the effort picker"],
  ["CmdOrCtrl+Shift+R", "Open the folder picker"],
  ["CmdOrCtrl+Shift+I", "Toggle browser panel"],
  ["CmdOrCtrl+Shift+O", "Open the chat reference at the caret"],
  ["CmdOrCtrl+Up", "Recall the last sent message"],
  // Panels with chords of their own: the browser, the review editor.
  ["CmdOrCtrl+L", "Focus the browser address bar"],
  ["CmdOrCtrl+T", "New browser tab"],
  ["CmdOrCtrl+Shift+T", "Reopen browser tab"],
  ["CmdOrCtrl+R", "Reload the browser page"],
  ["CmdOrCtrl+S", "Save the open file"],
  // The platform's own editing and window chords.
  ["CmdOrCtrl+Z", "Undo"],
  ["CmdOrCtrl+Shift+Z", "Redo"],
  ["CmdOrCtrl+Y", "Redo"],
  ["CmdOrCtrl+X", "Cut"],
  ["CmdOrCtrl+C", "Copy"],
  ["CmdOrCtrl+V", "Paste"],
  ["CmdOrCtrl+Q", "Quit"],
  ["CmdOrCtrl+H", "Hide"],
  ["CmdOrCtrl+M", "Minimize"],
  ["Alt+Up", "Move the caret"],
  ["Alt+Down", "Move the caret"],
  ["Alt+Left", "Move the caret by word"],
  ["Alt+Right", "Move the caret by word"]
];

/**
 * Chords that exist only in the native menu (`menu.rs`) and so are not in the
 * shared list above. `reservedChords.test.ts` reads the menu source and fails
 * when an accelerator there is neither listed nor covered by a key below.
 */
const NATIVE_MENU_CHORDS: ReadonlyArray<readonly [string, string]> = [
  ["CmdOrCtrl+Shift+V", "Paste and match style"],
  ["Alt+CmdOrCtrl+I", "Toggle developer tools"],
  ["CmdOrCtrl+0", "Reset zoom"],
  ["CmdOrCtrl+Shift+=", "Zoom in"],
  ["CmdOrCtrl+=", "Zoom in"],
  ["CmdOrCtrl+-", "Zoom out"]
];

const RESERVED = new Map<string, string>();
for (const [accelerator, label] of RENDERER_CHORDS) {
  const key = canonicalChord(accelerator);
  if (key) RESERVED.set(key, label);
}
for (const [accelerator, label] of NATIVE_MENU_CHORDS) {
  const key = canonicalChord(accelerator);
  if (key) RESERVED.set(key, label);
}
for (const binding of MENU_KEYBINDINGS) {
  const key = canonicalChord(binding.accelerator);
  if (key) RESERVED.set(key, binding.label);
}

// The chat-cycle handler answers either key under Esc, so an ISO keyboard's
// IntlBackslash is as taken as the ANSI Backquote the menu lists.
for (const code of CHAT_CYCLE_CODES) {
  RESERVED.set(`CmdOrCtrl+${code}`, "Cycle chats by recency");
  RESERVED.set(`CmdOrCtrl+Shift+${code}`, "Cycle chats by recency, back");
}

/**
 * Keys the app answers under ⌘/Ctrl in at least one combination. The global
 * handlers match a key under any extra modifier (⌘⇧K and ⌘⌥K open the palette
 * as ⌘K does, ⌘⌥F and ⌘⇧F search), and several do not check whether another
 * handler already took the press, so ⌘ plus one of these keys is taken
 * whichever extra modifiers ride along.
 */
const MOD_KEYS = new Map<string, string>();
for (const [chord, label] of RESERVED) {
  if (!chord.startsWith("CmdOrCtrl+")) continue;
  const key = chord.split("+").at(-1);
  if (key && !MOD_KEYS.has(key)) MOD_KEYS.set(key, label);
}

/** What already uses this chord, or null when it is free. */
export function chordInUse(accelerator: string): string | null {
  const canonical = canonicalChord(accelerator);
  if (!canonical) return null;
  const exact = RESERVED.get(canonical);
  if (exact) return exact;
  if (canonical.startsWith("CmdOrCtrl+")) {
    const key = canonical.split("+").at(-1) ?? "";
    const variantOf = MOD_KEYS.get(key);
    if (variantOf) return `${variantOf} (the app answers ⌘${key} with any extra modifier)`;
  }
  return null;
}
