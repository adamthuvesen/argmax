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

function chooseThinkingWord(): (typeof THINKING_WORDS)[number] {
  if (Math.random() < ARGMAXING_FREQUENCY) return "Argmaxing";

  const index = Math.floor(Math.random() * REGULAR_THINKING_WORDS.length);
  return REGULAR_THINKING_WORDS[index] ?? "Refining";
}

export function ThinkingLabel({ phaseKey }: { phaseKey?: string | undefined }): JSX.Element {
  const [word] = useState(chooseThinkingWord);
  // The label mounts when the wait starts and unmounts when it ends, so its own
  // lifetime *is* the gap being counted. Each new silent stretch counts from
  // zero, which is the honest number: how long this beat has had nothing to
  // show, not how long the turn has run.
  const [startedAt] = useState(() => performance.now());
  const elapsedRef = useRef<HTMLSpanElement | null>(null);
  // Commit phase, as in TurnBlock: the span renders empty and the timer fills
  // it, so a passive effect would paint an empty span first and shift the line.
  useLayoutEffect(() => {
    const node = elapsedRef.current;
    if (!node) return;
    return registerLiveTimer(
      node,
      () => performance.now() - startedAt,
      (ms) => (ms < ELAPSED_VISIBLE_AFTER_MS ? "" : formatElapsedSeconds(ms))
    );
  }, [startedAt]);

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
