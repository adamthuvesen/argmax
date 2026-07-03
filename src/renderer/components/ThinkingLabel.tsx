import type { CSSProperties, JSX } from "react";

const THINKING_LABEL = "Thinking";

export function ThinkingLabel(): JSX.Element {
  return (
    <article
      className="chat-bubble assistant thinking-indicator"
      aria-live="polite"
      aria-label="Thinking"
    >
      <div className="thinking-label-stream" data-testid="thinking-label" aria-hidden="true">
        <span className="thinking-label" aria-hidden="true">
          {THINKING_LABEL.split("").map((letter, index) => (
            <span
              key={`${letter}-${index}`}
              className="thinking-label-letter"
              style={{ "--thinking-letter-index": index } as CSSProperties}
            >
              {letter}
            </span>
          ))}
        </span>
      </div>
    </article>
  );
}
