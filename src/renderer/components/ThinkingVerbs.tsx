import { useEffect, useState, type JSX } from "react";
import { pickNextVerb } from "../lib/thinkingVerbs.js";

const ROTATION_INTERVAL_MS = 1400;

export function ThinkingVerbs(): JSX.Element {
  const [verb, setVerb] = useState<string>(() => pickNextVerb(null));

  useEffect(() => {
    const timer = window.setInterval(() => {
      setVerb((prev) => pickNextVerb(prev));
    }, ROTATION_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, []);

  return (
    <article
      className="chat-bubble assistant thinking-indicator"
      aria-live="polite"
      aria-label="Thinking"
    >
      <div className="command-stream" data-testid="thinking-verbs">
        <span className="thinking-pulse" aria-hidden="true" />
        <span className="thinking-verb" key={verb}>
          {verb}…
        </span>
      </div>
    </article>
  );
}
