import { createContext, useContext } from "react";

/**
 * Which line owns the turn's beat when no tool is running.
 *
 * Providers do not agree on how long a tool call *appears* to take. Measured
 * over a week of this app's own event log (median time from `command.started`
 * to `command.completed`): OpenCode 0ms, Grok 4ms, Codex 54ms, Cursor 252ms,
 * Claude 610ms. Keying the live line on a running tool therefore gave three of
 * five providers no live line at all — nothing ever waved on their tool lines,
 * and the Thinking cue owned every gap, which is exactly what an OpenCode turn
 * looked like.
 *
 * So the line that *just did the work* keeps the beat until the cue's own wait
 * elapses and the cue takes over. The value is the id of the tool call that
 * holds it; a group or row owns the beat when it contains that call.
 */
export const ActivityBeatContext = createContext<string | null>(null);

/** True when this line holds the beat between calls. */
export function useOwnsActivityBeat(toolIds: readonly string[]): boolean {
  const beat = useContext(ActivityBeatContext);
  return beat !== null && toolIds.includes(beat);
}
