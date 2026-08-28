import { DEFAULT_SCALE_LEVEL, readStoredScaleLevel, type ScaleLevel } from "./scaleLevel.js";

/** Agent-window content width, 1 (narrowest) to 5 (widest). See `ScaleLevel`. */
export type ChatWidth = ScaleLevel;

export const CHAT_WIDTH_KEY = "argmax.chat.width";
export const DEFAULT_CHAT_WIDTH: ChatWidth = DEFAULT_SCALE_LEVEL;

/** Widths stored by the three-way setting the 1–5 scale replaced. */
const LEGACY_CHAT_WIDTHS: Readonly<Record<string, ChatWidth>> = {
  narrow: 2,
  standard: 3,
  wide: 4
};

/** Caption under the width control, one per level. */
export const CHAT_WIDTH_HINTS: Readonly<Record<ChatWidth, string>> = {
  1: "Narrowest column.",
  2: "Narrow.",
  3: "Argmax's default column.",
  4: "Wide.",
  5: "Widest. Fills the pane."
};

export function readStoredChatWidth(): ChatWidth {
  return readStoredScaleLevel(CHAT_WIDTH_KEY, LEGACY_CHAT_WIDTHS) ?? DEFAULT_CHAT_WIDTH;
}
