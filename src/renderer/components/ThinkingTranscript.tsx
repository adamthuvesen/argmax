import { useEffect, useState, type JSX } from "react";

const MIN_PER_CHAR_MS = 18;
const TOTAL_BUDGET_MS = 620;

export function ThinkingTranscript({ command }: { command: string }): JSX.Element {
  const [revealed, setRevealed] = useState(0);

  useEffect(() => {
    setRevealed(0);
    if (command.length === 0) return;
    const perChar = Math.max(MIN_PER_CHAR_MS, Math.floor(TOTAL_BUDGET_MS / command.length));
    let cancelled = false;
    let index = 0;
    // Track the latest timer handle so cleanup actually cancels it. The
    // previous shape only cleared the initial timer; each chained tick scheduled
    // a fresh handle the cleanup never saw (R-037).
    let handle: number | null = null;
    const tick = (): void => {
      if (cancelled) return;
      index += 1;
      setRevealed(index);
      if (index < command.length) {
        handle = window.setTimeout(tick, perChar);
      }
    };
    handle = window.setTimeout(tick, perChar);
    return () => {
      cancelled = true;
      if (handle !== null) window.clearTimeout(handle);
    };
  }, [command]);

  const visible = command.slice(0, revealed);
  const done = revealed >= command.length;

  return (
    <article
      className="chat-bubble assistant thinking-indicator"
      aria-live="polite"
      aria-label="Thinking"
    >
      <div className="command-stream" data-testid="command-stream" aria-hidden="true">
        <span className="thinking-pulse" />
        <span className="thinking-line">
          <span className="thinking-prompt">argmax</span>
          <span className="thinking-text">{visible}</span>
          <span className={`thinking-caret${done ? " settled" : ""}`} />
        </span>
      </div>
    </article>
  );
}
