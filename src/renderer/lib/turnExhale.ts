/**
 * How much a finished turn produced, as one 0..1 number.
 *
 * The turn-end breath (components/TurnExhale.tsx) is sized by this: a one-line
 * reply barely glows at the left edge, a turn that rewrote forty files sweeps
 * the card. The intensity is the information — it is the only place in the chat
 * where the *size* of what just happened is legible before you read a word of
 * it — so the weights matter more than the exact curve.
 *
 * Written work dominates, because that is what the user is actually waiting
 * for. Tool count is the second signal: a turn that read thirty files and
 * answered a question did real work even though it wrote nothing. Prose length
 * comes last and is capped low, or a long-winded answer to a small question
 * outshines a quiet refactor.
 */
export interface TurnOutput {
  /** Distinct files the turn wrote. */
  files: number;
  /** Lines added plus deleted across those files. */
  lines: number;
  /** Tool calls (and tool groups) the turn ran. */
  tools: number;
  /** Characters of assistant prose in the turn's reply. */
  answerChars: number;
}

/** Where each signal saturates. Past these, more of it changes nothing. */
const FILES_FULL = 14;
const LINES_FULL = 500;
const TOOLS_FULL = 16;
const ANSWER_FULL = 2_500;

const WRITTEN_SHARE = 0.55;
const WORKED_SHARE = 0.28;
const SAID_SHARE = 0.17;

function saturate(value: number, full: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.min(1, value / full);
}

export function turnExhaleWeight(output: TurnOutput): number {
  // Files and lines measure the same thing at different resolutions — one
  // 400-line rewrite and twelve one-line edits are both a big turn — so they
  // take the larger of the two rather than stacking.
  const written = Math.max(saturate(output.files, FILES_FULL), saturate(output.lines, LINES_FULL));
  const worked = saturate(output.tools, TOOLS_FULL);
  const said = saturate(output.answerChars, ANSWER_FULL);
  return Math.min(1, WRITTEN_SHARE * written + WORKED_SHARE * worked + SAID_SHARE * said);
}
