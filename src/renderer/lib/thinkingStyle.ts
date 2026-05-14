/**
 * User preference for the chat "Thinking" affordance.
 *
 * - `terminal`: types out `argmax run --model <slug>` with a pulsing prompt
 *   (default — see ThinkingTranscript).
 * - `verbs`: replaces the terminal command with a single playful verb that
 *   rotates every few seconds, à la Claude Code's "Gusting…", "Pondering…".
 *
 * Persisted to localStorage. Reads tolerate missing/corrupt values by
 * returning the safe default.
 */
export type ThinkingStyle = "terminal" | "verbs";

export const THINKING_STYLE_KEY = "argmax.thinkingStyle";
export const DEFAULT_THINKING_STYLE: ThinkingStyle = "terminal";

export function isThinkingStyle(value: unknown): value is ThinkingStyle {
  return value === "terminal" || value === "verbs";
}

export function readStoredThinkingStyle(): ThinkingStyle {
  if (typeof window === "undefined") {
    return DEFAULT_THINKING_STYLE;
  }
  const stored = window.localStorage.getItem(THINKING_STYLE_KEY);
  return isThinkingStyle(stored) ? stored : DEFAULT_THINKING_STYLE;
}
