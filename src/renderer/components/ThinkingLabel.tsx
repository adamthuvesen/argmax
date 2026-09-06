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
  "Argmaxing"
] as const;

const REGULAR_THINKING_WORDS = THINKING_WORDS.filter((word) => word !== "Argmaxing");
const ARGMAXING_FREQUENCY = 0.06;

function chooseThinkingWord(seed: string | undefined): (typeof THINKING_WORDS)[number] {
  // No stable seed (a caller without an anchor) keeps the old random pick.
  if (seed === undefined) {
    if (Math.random() < ARGMAXING_FREQUENCY) return "Argmaxing";
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
  if (hash % 100 < ARGMAXING_FREQUENCY * 100) return "Argmaxing";
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
