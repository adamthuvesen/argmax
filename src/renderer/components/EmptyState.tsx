import type { JSX } from "react";
import { Mascot } from "./Mascot.js";

export function EmptyState({
  message,
  onRetry
}: {
  message?: string | null;
  onRetry?: () => void;
}): JSX.Element {
  return (
    <section className="empty-state">
      <Mascot mood="sad" size={72} />
      <h2>Argmax couldn't open your data</h2>
      <p>
        {message ??
          "Your projects and chats are still on this Mac. Try again — if this keeps happening, Settings → Advanced can copy a diagnostics report."}
      </p>
      {onRetry ? (
        <button className="empty-state-retry" type="button" onClick={onRetry}>
          Retry
        </button>
      ) : null}
    </section>
  );
}
