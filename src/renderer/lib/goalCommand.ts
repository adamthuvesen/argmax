/**
 * `/goal` typed into the session composer.
 *
 * A goal is one free-text completion condition: after every turn a cheap
 * evaluator reads the transcript and decides whether it holds, and the session
 * keeps working until it does. So the command carries the whole configuration
 * on one line — there is no form behind it.
 *
 * `/goal <condition>` sets one, `/goal clear` ends it. A bare `/goal` returns
 * null and stays an ordinary draft: the person is still typing the condition.
 * The active goal is already on screen, so there is nothing a status form would
 * add.
 */
export type GoalCommand = { kind: "set"; condition: string } | { kind: "clear" };

/** What Claude Code accepts for `/goal clear`, so muscle memory carries over. */
const CLEAR_WORDS = new Set(["clear", "stop", "off", "reset", "none", "cancel"]);

/** Matches the longest condition the evaluator will read. */
export const MAX_GOAL_CONDITION_CHARS = 4000;

export function parseGoalCommand(input: string): GoalCommand | null {
  const match = /^\/goal\s+([\s\S]+)$/i.exec(input.trim());
  const rest = match?.[1]?.trim();
  if (!rest) return null;
  if (CLEAR_WORDS.has(rest.toLowerCase())) return { kind: "clear" };
  return { kind: "set", condition: rest.slice(0, MAX_GOAL_CONDITION_CHARS) };
}
