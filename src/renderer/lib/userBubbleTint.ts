/**
 * Whether user message bubbles fill with the active accent or with a quiet
 * gray. Two states rather than a boolean so the stylesheet can key off
 * `<html data-user-bubble>` the same way it keys off `data-accent`.
 */
export type UserBubbleTint = "accent" | "neutral";

export const USER_BUBBLE_TINT_STORAGE_KEY = "argmax.chat.bubbleTint";
export const DEFAULT_USER_BUBBLE_TINT: UserBubbleTint = "accent";

export function isUserBubbleTint(value: unknown): value is UserBubbleTint {
  return value === "accent" || value === "neutral";
}

export function readStoredUserBubbleTint(): UserBubbleTint {
  if (typeof window === "undefined") return DEFAULT_USER_BUBBLE_TINT;
  const stored = window.localStorage.getItem(USER_BUBBLE_TINT_STORAGE_KEY);
  return isUserBubbleTint(stored) ? stored : DEFAULT_USER_BUBBLE_TINT;
}

export function writeStoredUserBubbleTint(tint: UserBubbleTint): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(USER_BUBBLE_TINT_STORAGE_KEY, tint);
}

export function applyUserBubbleTintToDocument(tint: UserBubbleTint): void {
  if (typeof document === "undefined") return;
  document.documentElement.dataset.userBubble = tint;
}
