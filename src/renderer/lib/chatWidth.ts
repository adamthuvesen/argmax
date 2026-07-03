export type ChatWidth = "narrow" | "standard" | "wide";

export const CHAT_WIDTH_KEY = "argmax.chat.width";
export const DEFAULT_CHAT_WIDTH: ChatWidth = "standard";

export function isChatWidth(value: unknown): value is ChatWidth {
  return value === "narrow" || value === "standard" || value === "wide";
}

export function readStoredChatWidth(): ChatWidth {
  if (typeof window === "undefined") {
    return DEFAULT_CHAT_WIDTH;
  }
  const stored = window.localStorage.getItem(CHAT_WIDTH_KEY);
  return isChatWidth(stored) ? stored : DEFAULT_CHAT_WIDTH;
}
