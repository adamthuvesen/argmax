/**
 * Greeting shown above the launcher composer. One line is drawn each time the
 * new-session surface appears, so the app doesn't repeat itself all day.
 *
 * The last line shown is remembered in localStorage purely to avoid drawing it
 * twice in a row. It is not a user setting and nothing else reads it.
 */
export const LAUNCHER_HEADINGS = [
  "Coffee and code?",
  "What's the move?",
  "Where's the focus?",
  "What's cooking?",
  "Set the target",
  "What are we building?",
  "Pick the play",
  "Name the goal",
  "Ready when you are",
  "Let's crack this"
] as const;

export type LauncherHeading = (typeof LAUNCHER_HEADINGS)[number];

export const LAUNCHER_HEADING_KEY = "argmax.launcher.lastHeading";

function readLastHeading(): string | null {
  if (typeof window === "undefined") return null;
  return window.localStorage.getItem(LAUNCHER_HEADING_KEY);
}

function writeLastHeading(heading: LauncherHeading): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(LAUNCHER_HEADING_KEY, heading);
}

export function pickLauncherHeading(): LauncherHeading {
  const last = readLastHeading();
  const candidates = LAUNCHER_HEADINGS.filter((heading) => heading !== last);
  const pool = candidates.length > 0 ? candidates : LAUNCHER_HEADINGS;
  const heading = pool[Math.floor(Math.random() * pool.length)];
  writeLastHeading(heading);
  return heading;
}
