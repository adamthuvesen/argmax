import { Check, Loader2, X } from "lucide-react";
import type { JSX } from "react";
import { formatElapsed } from "../formatElapsed.js";
import type { ToolCall } from "../lib/toolCalls.js";

export function ToolStatusChip({
  elapsedMs,
  showFastFailureText,
  status
}: {
  elapsedMs: number;
  showFastFailureText?: boolean;
  status: ToolCall["status"];
}): JSX.Element {
  const elapsedText = formatElapsed(elapsedMs);
  const statusWord = status === "running" ? "running" : status === "error" ? "failed" : "done";
  const chipLabel = elapsedText ? `${statusWord}, ${elapsedText}` : statusWord;
  const displayText = showFastFailureText && status === "error" && elapsedMs < 100 ? "failed" : elapsedText;

  return (
    <span className="tool-call-status-chip" aria-label={chipLabel} title={chipLabel}>
      <span className="tool-call-status-glyph" aria-hidden="true">
        {status === "running" ? (
          <Loader2 size={11} className="tool-call-spinner" />
        ) : status === "error" ? (
          <X size={11} />
        ) : (
          <Check size={11} />
        )}
      </span>
      {displayText ? (
        <span className="tool-call-status-time" aria-hidden="true">
          {displayText}
        </span>
      ) : null}
    </span>
  );
}
