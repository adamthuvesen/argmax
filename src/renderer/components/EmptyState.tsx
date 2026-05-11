import { AlertTriangle } from "lucide-react";
import type { JSX } from "react";

export function EmptyState({
  message,
  onRetry
}: {
  message?: string | null;
  onRetry?: () => void;
}): JSX.Element {
  return (
    <section className="empty-state">
      <AlertTriangle size={24} />
      <h2>Local state could not be loaded</h2>
      <p>
        {message ??
          "Argmax keeps working from local storage, but the database needs attention before the dashboard can render."}
      </p>
      {onRetry ? (
        <button className="empty-state-retry" type="button" onClick={onRetry}>
          Retry
        </button>
      ) : null}
    </section>
  );
}
