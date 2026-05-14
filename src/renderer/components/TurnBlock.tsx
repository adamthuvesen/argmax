import { ChevronRight, Loader2 } from "lucide-react";
import { useEffect, useMemo, useState, type JSX, type ReactNode } from "react";
import { formatElapsed } from "../formatElapsed.js";
import type { ToolCall, ToolCallGroup } from "../lib/toolCalls.js";

export type TurnToolItem =
  | { kind: "tool"; tool: ToolCall }
  | { kind: "tool-group"; group: ToolCallGroup };

interface Bounds {
  startedAt: number;
  endedAt: number | null;
}

function readToolBounds(item: TurnToolItem): Bounds {
  const tools = item.kind === "tool" ? [item.tool] : item.group.tools;
  let started = Number.POSITIVE_INFINITY;
  let ended: number | null = 0;
  for (const t of tools) {
    const s = Date.parse(t.createdAt);
    if (Number.isFinite(s)) started = Math.min(started, s);
    if (!t.completedAt) {
      ended = null;
    } else if (ended !== null) {
      const e = Date.parse(t.completedAt);
      if (Number.isFinite(e)) ended = Math.max(ended, e);
    }
  }
  return { startedAt: Number.isFinite(started) ? started : 0, endedAt: ended };
}

function turnBounds(toolItems: TurnToolItem[], assistantTimestamps: number[]): Bounds {
  let startedAt = Number.POSITIVE_INFINITY;
  let endedAt: number | null = 0;
  let sawAny = false;

  for (const item of toolItems) {
    sawAny = true;
    const b = readToolBounds(item);
    if (Number.isFinite(b.startedAt)) startedAt = Math.min(startedAt, b.startedAt);
    if (b.endedAt === null) {
      endedAt = null;
    } else if (endedAt !== null) {
      endedAt = Math.max(endedAt, b.endedAt);
    }
  }
  for (const ts of assistantTimestamps) {
    if (!Number.isFinite(ts)) continue;
    sawAny = true;
    startedAt = Math.min(startedAt, ts);
    if (endedAt !== null) endedAt = Math.max(endedAt, ts);
  }
  return {
    startedAt: sawAny && Number.isFinite(startedAt) ? startedAt : 0,
    endedAt
  };
}

function isToolRunning(item: TurnToolItem): boolean {
  if (item.kind === "tool") return item.tool.status === "running";
  return item.group.tools.some((t) => t.status === "running");
}

export function TurnBlock({
  toolItems,
  assistantTimestamps,
  toolsNode,
  assistantNode,
  providerLabel: providerLabelText,
  modelLabel,
  defaultExpanded
}: {
  toolItems: TurnToolItem[];
  assistantTimestamps: number[];
  toolsNode: ReactNode;
  assistantNode: ReactNode;
  providerLabel?: string;
  modelLabel?: string;
  defaultExpanded?: boolean;
}): JSX.Element {
  const running = useMemo(() => toolItems.some(isToolRunning), [toolItems]);
  const bounds = useMemo(() => turnBounds(toolItems, assistantTimestamps), [toolItems, assistantTimestamps]);
  // When running, the chip shows "Working…" and elapsedMs is unused; when
  // not running, bounds.endedAt is guaranteed non-null.
  const elapsedMs = bounds.endedAt !== null ? Math.max(0, bounds.endedAt - bounds.startedAt) : 0;

  // Expanded while running so users see live progress; auto-collapse on
  // completion. The user's manual toggle (userToggle) wins after that.
  const [userToggle, setUserToggle] = useState<boolean | null>(null);
  const autoExpanded = running || (defaultExpanded ?? false);
  const expanded = userToggle ?? autoExpanded;

  // When a turn transitions from running → done, reset userToggle so the
  // auto-collapse fires once. Subsequent user clicks then stick.
  useEffect(() => {
    if (!running && userToggle === true) {
      // user had explicitly expanded a still-running turn; once it finishes,
      // we don't yank it closed under them.
      return;
    }
    if (!running) setUserToggle(null);
  }, [running, userToggle]);

  const subtitleParts = [providerLabelText, modelLabel].filter((v): v is string => Boolean(v));
  const subtitle = subtitleParts.join(" · ");
  const elapsedLabel = formatElapsed(elapsedMs);
  const chipLabel = running
    ? "Working…"
    : elapsedLabel
      ? `Worked for ${elapsedLabel}`
      : "Worked";
  const hasTools = toolItems.length > 0;

  return (
    <div className="turn-block" data-running={running ? "true" : undefined}>
      <div className="turn-block-header">
        {subtitle ? <span className="turn-block-subtitle">{subtitle}</span> : null}
        {hasTools ? (
          <button
            type="button"
            className="turn-block-chip"
            aria-expanded={expanded}
            aria-label={running ? "Working" : `Worked for ${elapsedLabel || "a moment"}`}
            title={chipLabel}
            onClick={() => setUserToggle(!expanded)}
          >
            {running ? (
              <Loader2 size={11} className="turn-block-spinner" aria-hidden="true" />
            ) : null}
            <span>{chipLabel}</span>
            <ChevronRight
              size={11}
              className={`turn-block-chevron${expanded ? " expanded" : ""}`}
              aria-hidden="true"
            />
          </button>
        ) : null}
      </div>
      <div className="turn-block-body">
        {assistantNode}
        {hasTools && expanded ? <div className="turn-block-tools">{toolsNode}</div> : null}
      </div>
    </div>
  );
}
