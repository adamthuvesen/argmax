import type { JSX } from "react";
import { useLiveNow } from "../hooks/nowContext.js";
import type { ToolCall } from "../lib/toolCalls.js";
import { ToolStatusChip } from "./ToolStatusChip.js";

type Props = {
  status: ToolCall["status"];
  startedAtMs: number;
  completedAtMs: number | null;
  showFastFailureText?: boolean;
};

export function LiveElapsedChip(props: Props): JSX.Element {
  if (props.completedAtMs !== null) {
    return <StaticElapsedChip {...props} completedAtMs={props.completedAtMs} />;
  }
  return <RunningElapsedChip {...props} />;
}

function StaticElapsedChip({
  status,
  startedAtMs,
  completedAtMs,
  showFastFailureText
}: Props & { completedAtMs: number }): JSX.Element {
  const elapsedMs = Number.isFinite(startedAtMs) ? Math.max(0, completedAtMs - startedAtMs) : 0;
  return (
    <ToolStatusChip
      status={status}
      elapsedMs={elapsedMs}
      {...(showFastFailureText ? { showFastFailureText: true } : {})}
    />
  );
}

function RunningElapsedChip({ status, startedAtMs, showFastFailureText }: Props): JSX.Element {
  const now = useLiveNow();
  const elapsedMs = Number.isFinite(startedAtMs) ? Math.max(0, now - startedAtMs) : 0;
  return (
    <ToolStatusChip
      status={status}
      elapsedMs={elapsedMs}
      {...(showFastFailureText ? { showFastFailureText: true } : {})}
    />
  );
}
