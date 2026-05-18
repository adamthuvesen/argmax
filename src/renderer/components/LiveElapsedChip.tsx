import { useEffect, useRef, type JSX } from "react";
import { formatElapsed } from "../formatElapsed.js";
import { registerLiveTimer } from "../lib/liveTimer.js";
import type { ToolCall } from "../lib/toolCalls.js";
import { ToolStatusChip, ToolStatusChipLive } from "./ToolStatusChip.js";

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

function RunningElapsedChip({ status, startedAtMs }: Props): JSX.Element {
  const ref = useRef<HTMLSpanElement | null>(null);

  useEffect(() => {
    const node = ref.current;
    if (!node || !Number.isFinite(startedAtMs)) return;
    return registerLiveTimer(node, () => Date.now() - startedAtMs, formatElapsed);
  }, [startedAtMs]);

  // Screen readers don't need 60fps updates; a static "running" label is plenty.
  return <ToolStatusChipLive status={status} ariaLabel="running" timeRef={ref} />;
}
