import { Check, Loader2, X } from "lucide-react";
import type { JSX, Ref } from "react";
import { formatElapsed } from "../formatElapsed.js";
import type { ToolCall } from "../lib/toolCalls.js";

type ChipShellProps = {
  status: ToolCall["status"];
  ariaLabel: string;
  children: JSX.Element | string | null;
  timeRef?: Ref<HTMLSpanElement>;
  hideTime?: boolean;
};

// Renders the glyph + a slot for the elapsed text. The slot can be either a
// static string (completed timers) or a ref-owned span the live timer registry
// writes into imperatively (running timers). Both paths share the same DOM
// shape so CSS is identical.
function ChipShell({ status, ariaLabel, children, timeRef, hideTime }: ChipShellProps): JSX.Element {
  return (
    <span className="tool-call-status-chip" aria-label={ariaLabel} title={ariaLabel}>
      <span className="tool-call-status-glyph" aria-hidden="true">
        {status === "running" ? (
          <Loader2 size={11} className="tool-call-spinner" />
        ) : status === "error" ? (
          <X size={11} />
        ) : (
          <Check size={11} />
        )}
      </span>
      {hideTime ? null : (
        <span className="tool-call-status-time" aria-hidden="true" ref={timeRef}>
          {children}
        </span>
      )}
    </span>
  );
}

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
  const fastFailure = showFastFailureText && status === "error" && elapsedMs < 100;
  const displayText = fastFailure ? "failed" : elapsedText;

  return (
    <ChipShell status={status} ariaLabel={chipLabel} hideTime={!displayText}>
      {displayText || null}
    </ChipShell>
  );
}

export function ToolStatusChipLive({
  status,
  ariaLabel,
  timeRef
}: {
  status: ToolCall["status"];
  ariaLabel: string;
  timeRef: Ref<HTMLSpanElement>;
}): JSX.Element {
  return (
    <ChipShell status={status} ariaLabel={ariaLabel} timeRef={timeRef}>
      {null}
    </ChipShell>
  );
}
