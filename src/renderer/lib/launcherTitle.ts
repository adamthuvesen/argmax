/**
 * The line under the fox on the new-session surface. It does not rotate: a
 * screen opened dozens of times a day should be the same place every time, so
 * the personality lives in the mascot and the copy holds still. Desktop and
 * mobile read the same constants so the two can't drift.
 */
export const LAUNCHER_TITLE = "What are we building?";

/** Side chat has no repository, so it asks for a subject instead of a build. */
export const SIDE_CHAT_TITLE = "What's on your mind?";

/** Prompt placeholder for a side chat, on both the desktop and mobile launchers. */
export const SIDE_CHAT_PLACEHOLDER = "Ask anything — no repository attached";
