import { useState, type JSX } from "react";
import { WorkingNest } from "./WorkingNest.js";

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

  return (
    <article
      className="chat-bubble assistant thinking-indicator"
      aria-live="polite"
      aria-label="Thinking"
    >
      <div className="thinking-label-stream" data-testid="thinking-label" aria-hidden="true">
        <WorkingNest active size={12} className="thinking-working-nest" phaseKey={phaseKey} />
        <span className="thinking-label">{word}</span>
      </div>
    </article>
  );
}
