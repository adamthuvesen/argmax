import { ChevronRight, Loader2 } from "lucide-react";
import { Fragment, useEffect, useMemo, useRef, useState, type JSX, type ReactNode } from "react";
import { formatElapsed } from "../formatElapsed.js";
import { registerLiveTimer } from "../lib/liveTimer.js";
import type { ToolCall, ToolCallGroup } from "../lib/toolCalls.js";

export type TurnToolItem =
  | { kind: "tool"; tool: ToolCall }
  | { kind: "tool-group"; group: ToolCallGroup };

export type TurnBodyChild = {
  kind: "assistant" | "tool";
  id: string;
  node: ReactNode;
};

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

// Group consecutive tool children into a single .turn-block-tools wrapper so
// adjacent tools share the tight 8px gap, while assistant text and tool runs
// keep the looser 18px body gap. When collapsed, tool children are dropped
// entirely and only assistant children render.
function renderBody(children: TurnBodyChild[], expanded: boolean): ReactNode {
  const visible = expanded ? children : children.filter((c) => c.kind === "assistant");
  const fragments: ReactNode[] = [];
  let toolRun: TurnBodyChild[] = [];
  const flushTools = (): void => {
    if (toolRun.length === 0) return;
    const first = toolRun[0];
    if (!first) {
      toolRun = [];
      return;
    }
    fragments.push(
      <div key={`tools-${first.id}`} className="turn-block-tools">
        {toolRun.map((t) => (
          <Fragment key={t.id}>{t.node}</Fragment>
        ))}
      </div>
    );
    toolRun = [];
  };
  for (const child of visible) {
    if (child.kind === "tool") {
      toolRun.push(child);
    } else {
      flushTools();
      fragments.push(<Fragment key={child.id}>{child.node}</Fragment>);
    }
  }
  flushTools();
  return fragments;
}

export function TurnBlock({
  toolItems,
  assistantTimestamps,
  body,
  providerLabel: providerLabelText,
  modelLabel,
  defaultExpanded
}: {
  toolItems: TurnToolItem[];
  assistantTimestamps: number[];
  body: TurnBodyChild[];
  providerLabel?: string;
  modelLabel?: string;
  defaultExpanded?: boolean;
}): JSX.Element {
  const running = useMemo(() => toolItems.some(isToolRunning), [toolItems]);
  const bounds = useMemo(() => turnBounds(toolItems, assistantTimestamps), [toolItems, assistantTimestamps]);
  const elapsedMs = bounds.endedAt !== null ? Math.max(0, bounds.endedAt - bounds.startedAt) : 0;

  // Expanded while running so users see live progress; when done, falls back
  // to defaultExpanded. The user's manual toggle wins in both directions and
  // sticks for the lifetime of the turn.
  const [userToggle, setUserToggle] = useState<boolean | null>(null);
  const autoExpanded = running || (defaultExpanded ?? false);
  const expanded = userToggle ?? autoExpanded;

  const subtitleParts = [providerLabelText, modelLabel].filter((v): v is string => Boolean(v));
  const subtitle = subtitleParts.join(" · ");
  const elapsedLabel = formatElapsed(elapsedMs);
  const staticChipLabel = running ? "Working" : elapsedLabel ? `Worked for ${elapsedLabel}` : "Worked";
  const hasTools = toolItems.length > 0;

  const liveStartMs = running && bounds.startedAt > 0 ? bounds.startedAt : null;
  const liveRef = useRef<HTMLSpanElement | null>(null);
  useEffect(() => {
    const node = liveRef.current;
    if (!node || liveStartMs === null) return;
    return registerLiveTimer(node, () => Date.now() - liveStartMs, formatElapsed);
  }, [liveStartMs]);

  return (
    <div className="turn-block" data-running={running ? "true" : undefined}>
      <div className="turn-block-header">
        {subtitle ? <span className="turn-block-subtitle">{subtitle}</span> : null}
        {hasTools ? (
          <button
            type="button"
            className="turn-block-chip"
            aria-expanded={expanded}
            aria-label={staticChipLabel}
            title={staticChipLabel}
            onClick={() => setUserToggle(!expanded)}
          >
            {running ? (
              <Loader2 size={11} className="turn-block-spinner" aria-hidden="true" />
            ) : null}
            {liveStartMs !== null ? (
              <span>
                Working for <span ref={liveRef} />
              </span>
            ) : (
              <span>{staticChipLabel}</span>
            )}
            <ChevronRight
              size={11}
              className={`turn-block-chevron${expanded ? " expanded" : ""}`}
              aria-hidden="true"
            />
          </button>
        ) : null}
      </div>
      <div className="turn-block-body">{renderBody(body, expanded)}</div>
    </div>
  );
}
