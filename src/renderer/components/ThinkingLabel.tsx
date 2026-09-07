import { useLayoutEffect, useRef, useState, type JSX } from "react";
import { formatElapsedSeconds } from "../formatElapsed.js";
import { registerLiveTimer } from "../lib/liveTimer.js";
import { WorkingNest } from "./WorkingNest.js";

/** Below this the count is noise: a normal beat between two tool calls is over
 *  before it would read, and a number that flickers in and out on every short
 *  gap is worse than no number. Past it the wait is long enough that the reader
 *  wants to know whether anything is still happening — a relaunched provider
 *  can take ten to thirty seconds to say its first word. */
const ELAPSED_VISIBLE_AFTER_MS = 3_000;

// One word per silent beat, so the set has to be big enough that a long turn
// never repeats itself into looking stuck. US spelling throughout, gerunds
// only, and each one names work the agent actually does — nothing that
// advertises guessing. The rare draws sit at the end: Argmaxing, the
// signature, then the jokes.
export const THINKING_WORDS = [
  "Brainstorming",
  "Disentangling",
  "Sanity-checking",
  "Theorizing",
  "Deciphering",
  "Synthesizing",
  "Deconstructing",
  "Distilling",
  "Reconciling",
  "Refining",
  "Calculating",
  "Thinking",
  "Computing",
  "Analyzing",
  "Philosophizing",
  "Reasoning",
  "Deducing",
  "Inferring",
  "Extrapolating",
  "Hypothesizing",
  "Deliberating",
  "Contemplating",
  "Dissecting",
  "Unpacking",
  "Parsing",
  "Triangulating",
  "Cross-referencing",
  "Correlating",
  "Diagnosing",
  "Investigating",
  "Excavating",
  "Spelunking",
  "Retracing",
  "Surveying",
  "Sleuthing",
  "Formulating",
  "Composing",
  "Drafting",
  "Assembling",
  "Consolidating",
  "Architecting",
  "Scrutinizing",
  "Second-guessing",
  "Stress-testing",
  "Interrogating",
  "Falsifying",
  "Auditing",
  "Verifying",
  "Optimizing",
  "Converging",
  "Approximating",
  "Quantifying",
  "Simulating",
  "Enumerating",
  "Backpropagating",
  "Condensing",
  "Sharpening",
  "Tightening",
  "Weighing",
  "Prioritizing",
  "Argmaxing",
  "Yak-shaving",
  "Tail-chasing",
  "Overthinking",
  "Gradient-descending"
] as const;

/** The jokes only work while they stay surprises, so they are drawn from their
 *  own band rather than earning a regular slot. They also read as honest on a
 *  long wait, which is exactly when the label is being stared at. */
const EASTER_EGG_WORDS = ["Yak-shaving", "Tail-chasing", "Overthinking", "Gradient-descending"] as const;
const RARE_THINKING_WORDS: readonly string[] = ["Argmaxing", ...EASTER_EGG_WORDS];
const REGULAR_THINKING_WORDS = THINKING_WORDS.filter((word) => !RARE_THINKING_WORDS.includes(word));
// Draws per hundred. Integers, because the seeded path buckets its hash into a
// hundred and a float sum (0.06 + 0.02) misses the bucket edge by an ulp.
const ARGMAXING_DRAWS = 6;
const EASTER_EGG_DRAWS = 2;

function chooseThinkingWord(seed: string | undefined): (typeof THINKING_WORDS)[number] {
  // No stable seed (a caller without an anchor) keeps the old random pick.
  if (seed === undefined) {
    const roll = Math.floor(Math.random() * 100);
    if (roll < ARGMAXING_DRAWS) return "Argmaxing";
    if (roll < ARGMAXING_DRAWS + EASTER_EGG_DRAWS) {
      const egg = Math.floor(Math.random() * EASTER_EGG_WORDS.length);
      return EASTER_EGG_WORDS[egg] ?? "Argmaxing";
    }
    const index = Math.floor(Math.random() * REGULAR_THINKING_WORDS.length);
    return REGULAR_THINKING_WORDS[index] ?? "Refining";
  }
  // A remount of the same silent gap must not reroll the word: the label
  // unmounts whenever the reader navigates away and back, and a fresh random
  // pick there reads as the wait restarting. Seeding on the gap's identity
  // (phase + when silence began) keeps the word stable across remounts while
  // every new beat still draws a fresh one.
  let hash = 0x811c9dc5;
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  hash >>>= 0;
  const bucket = hash % 100;
  if (bucket < ARGMAXING_DRAWS) return "Argmaxing";
  if (bucket < ARGMAXING_DRAWS + EASTER_EGG_DRAWS) {
    // Not `hash % length`: the band is two buckets wide and 100 divides by four,
    // so the bucket would fix the remainder and half the jokes would never be
    // drawn. The digits above the bucket are free to vary.
    return EASTER_EGG_WORDS[Math.floor(hash / 100) % EASTER_EGG_WORDS.length] ?? "Argmaxing";
  }
  return REGULAR_THINKING_WORDS[hash % REGULAR_THINKING_WORDS.length] ?? "Refining";
}

export function ThinkingLabel({
  phaseKey,
  startedAtMs,
}: {
  phaseKey?: string | undefined;
  /** When this silent stretch began (epoch ms), so a remount mid-gap keeps
   *  counting the real wait instead of restarting it. Falls back to mount
   *  time when the caller has no timestamp to anchor to. */
  startedAtMs?: number | undefined;
}): JSX.Element {
  const [word] = useState(() =>
    chooseThinkingWord(startedAtMs === undefined ? undefined : `${phaseKey ?? ""}:${startedAtMs}`)
  );
  // The label mounts when the wait starts and unmounts when it ends, so its own
  // lifetime *is* the gap being counted. Each new silent stretch counts from
  // zero, which is the honest number: how long this beat has had nothing to
  // show, not how long the turn has run. Anchoring on the caller's timestamp
  // keeps that number truthful across remounts: navigation unmounts the chat,
  // and counting from the new mount would present a five-minute wait as a
  // fresh one. Without an anchor the fallback stays mount-stable (the same
  // lifetime rule, clocked off performance.now like the tests that pin it).
  const [mountAnchor] = useState(() => performance.now());
  const elapsedRef = useRef<HTMLSpanElement | null>(null);
  // Commit phase, as in TurnBlock: the span renders empty and the timer fills
  // it, so a passive effect would paint an empty span first and shift the line.
  useLayoutEffect(() => {
    const node = elapsedRef.current;
    if (!node) return;
    const getMs =
      startedAtMs === undefined
        ? () => performance.now() - mountAnchor
        : () => Date.now() - startedAtMs;
    return registerLiveTimer(
      node,
      getMs,
      (ms) => (ms < ELAPSED_VISIBLE_AFTER_MS ? "" : formatElapsedSeconds(ms))
    );
  }, [startedAtMs, mountAnchor]);

  return (
    <article
      className="chat-bubble assistant thinking-indicator"
      aria-live="polite"
      aria-label="Thinking"
    >
      <div className="thinking-label-stream" data-testid="thinking-label" aria-hidden="true">
        <WorkingNest active size={12} className="thinking-working-nest" phaseKey={phaseKey} />
        <span className="thinking-label">{word}</span>
        <span className="thinking-elapsed" ref={elapsedRef} />
      </div>
    </article>
  );
}
