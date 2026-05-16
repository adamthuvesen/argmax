/**
 * The playful-verb roster for the "Thinking" indicator when the user has
 * opted into the verbs style. Mix of Claude-Code-ish classics and a few
 * Argmax-flavored ones — keep entries short, gerund form, lightly witty.
 */
export const THINKING_VERBS: readonly string[] = [
  "Gusting",
  "Elaborating",
  "Pondering",
  "Cogitating",
  "Marinating",
  "Brewing",
  "Untangling",
  "Mulling",
  "Noodling",
  "Ruminating",
  "Percolating",
  "Whittling",
  "Tinkering",
  "Wrangling",
  "Conjuring",
  "Fiddling",
  "Massaging",
  "Crunching",
  "Brainstorming",
  "Distilling",
  "Polishing",
  "Rummaging",
  "Sleuthing",
  "Decoding",
  "Squinting",
  "Stewing",
  "Argmaxing",
  "Optimizing",
  "Plotting",
  "Scheming",
  "Spelunking",
  "Yak-shaving",
  "Bikeshedding",
  "Sharpening",
  "Forging",
  "Whisking",
  "Kneading",
  "Steeping",
  "Composing",
  "Curating",
  "Sussing",
  "Vibing",
  "Calibrating",
  "Triangulating",
  "Synthesizing",
  "Confabulating",
  "Annotating",
  "Caffeinating",
  "Crystallizing",
  "Schlepping"
];

/**
 * Pick the next verb, avoiding the previous one so the rotation never
 * stutters on the same word twice in a row.
 */
export function pickNextVerb(prev: string | null): string {
  if (THINKING_VERBS.length === 0) return "Thinking";
  if (THINKING_VERBS.length === 1) return THINKING_VERBS[0];
  const prevIdx = prev ? THINKING_VERBS.indexOf(prev) : -1;
  if (prevIdx < 0) {
    return THINKING_VERBS[Math.floor(Math.random() * THINKING_VERBS.length)];
  }
  const offset = 1 + Math.floor(Math.random() * (THINKING_VERBS.length - 1));
  return THINKING_VERBS[(prevIdx + offset) % THINKING_VERBS.length];
}
