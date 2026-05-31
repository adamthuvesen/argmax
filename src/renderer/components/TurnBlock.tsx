import { ChevronRight, Loader2 } from "lucide-react";
import { Fragment, useEffect, useMemo, useRef, useState, type JSX, type ReactNode } from "react";
import { formatElapsedSeconds } from "../formatElapsed.js";
import { registerLiveTimer } from "../lib/liveTimer.js";
import type { TurnToolItem } from "../lib/toolCalls.js";

export type { TurnToolItem };

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
function renderPhaseChildren(children: TurnBodyChild[]): ReactNode {
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
  for (const child of children) {
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

// Render the turn body as a plain stream of children. Every child always
// renders — tool calls are NEVER removed when "collapsed". Collapsing a turn
// folds each tool group to its header (the group's own `defaultExpanded`,
// driven by the parent), so the work the agent did stays in the chat. We
// previously split into Plan / Work / Result phases with a left rail, but the
// rail read as noisy chrome rather than helpful navigation.
function renderBody(children: TurnBodyChild[]): ReactNode {
  return renderPhaseChildren(children);
}

export function TurnBlock({
  toolItems,
  assistantTimestamps,
  body,
  modelLabel,
  turnStartedAtMs,
  isTurnActive,
  toolsExpanded,
  onToggleTools,
  headerTimestampIso
}: {
  toolItems: TurnToolItem[];
  assistantTimestamps: number[];
  body: TurnBodyChild[];
  modelLabel?: string;
  // When provided, the live ticker anchors here instead of the earliest
  // tool/assistant timestamp. The parent passes the preceding user.message
  // timestamp so the chip starts ticking from the moment the turn began —
  // including the thinking phase before any tools fire.
  turnStartedAtMs?: number;
  // Authoritative "agent is still working" signal from the parent. The parent
  // knows about session state and any user-input pauses (PlanCard,
  // QuestionCard); we used to infer this purely from tool status, which
  // missed the thinking-only phase.
  isTurnActive?: boolean;
  // Whether this turn's tool groups are expanded. Owned by the parent (which
  // builds the tool nodes) so the chip and the per-group toggles share one
  // source of truth; the chip reflects it and flips it via `onToggleTools`.
  // Collapsing only folds groups to their headers — tools are never removed.
  toolsExpanded?: boolean;
  onToggleTools?: () => void;
  // The canonical timestamp shown in the turn header (typically the earliest
  // assistant event in the turn). Per-paragraph timestamps inside the body
  // are visually suppressed once a turn-level one is available.
  headerTimestampIso?: string;
}): JSX.Element {
  const toolRunning = useMemo(() => toolItems.some(isToolRunning), [toolItems]);
  // `running` controls the chip's "Working" label, spinner and live ticker —
  // the parent's isTurnActive flag is authoritative because it also knows
  // about thinking phases and user-input pauses (PlanCard / QuestionCard).
  // Fall back to tool status so back-compat callers without the prop still
  // get a "Working" chip while their tools are mid-flight.
  const running = isTurnActive ?? toolRunning;
  const bounds = useMemo(() => turnBounds(toolItems, assistantTimestamps), [toolItems, assistantTimestamps]);
  const startedAtMs =
    typeof turnStartedAtMs === "number" && turnStartedAtMs > 0 && Number.isFinite(turnStartedAtMs)
      ? turnStartedAtMs
      : bounds.startedAt;
  const elapsedMs =
    bounds.endedAt !== null && startedAtMs > 0 ? Math.max(0, bounds.endedAt - startedAtMs) : 0;

  // Tool-group expansion is owned by the parent (it builds the tool nodes), so
  // the chip and the per-group chevrons stay in sync. The chip just reflects it
  // and flips it; collapsing folds groups to their headers — never removes them.
  const toolsAreExpanded = toolsExpanded ?? true;

  const subtitle = modelLabel ?? "";
  const elapsedLabel = formatElapsedSeconds(elapsedMs);
  const staticChipLabel = running ? "Working" : elapsedLabel ? `Worked for ${elapsedLabel}` : "Worked";
  const hasTools = toolItems.length > 0;
  const headerTimestampLabel = useMemo(() => {
    if (!headerTimestampIso) return "";
    const ms = Date.parse(headerTimestampIso);
    if (!Number.isFinite(ms)) return "";
    const d = new Date(ms);
    const now = new Date();
    const sameDay =
      d.getFullYear() === now.getFullYear() &&
      d.getMonth() === now.getMonth() &&
      d.getDate() === now.getDate();
    if (sameDay) {
      return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    }
    return d.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  }, [headerTimestampIso]);
  // Show the chip whenever the turn is in flight (so the ticker is visible
  // during pure-thinking phases too) or after completion if there was tool
  // work worth labelling. Pure-text completed turns stay chip-less.
  const showChip = running || hasTools;

  const liveStartMs = running && startedAtMs > 0 ? startedAtMs : null;
  const liveRef = useRef<HTMLSpanElement | null>(null);
  useEffect(() => {
    const node = liveRef.current;
    if (!node || liveStartMs === null) return;
    return registerLiveTimer(node, () => Date.now() - liveStartMs, formatElapsedSeconds);
  }, [liveStartMs]);

  // Thinking → answered transition. The very first time this turn's body
  // gains content (an assistant token or tool row), set `data-just-revealed`
  // for 280ms so the first child animates "landing" instead of popping in.
  // Subsequent additions stream normally — the animation is reserved for the
  // moment the indeterminate "Thinking" state becomes determinate.
  const wasEmptyRef = useRef<boolean>(true);
  const [justRevealed, setJustRevealed] = useState(false);
  useEffect(() => {
    if (!wasEmptyRef.current) return;
    if (body.length === 0) return;
    wasEmptyRef.current = false;
    setJustRevealed(true);
    const id = setTimeout(() => setJustRevealed(false), 280);
    return () => clearTimeout(id);
  }, [body.length]);

  return (
    <div className="turn-block" data-running={running ? "true" : undefined}>
      <div className="turn-block-header">
        {subtitle ? <span className="turn-block-subtitle">{subtitle}</span> : null}
        {headerTimestampLabel ? (
          <span
            className="turn-block-timestamp"
            title={headerTimestampIso ? new Date(headerTimestampIso).toISOString() : undefined}
          >
            {headerTimestampLabel}
          </span>
        ) : null}
        {showChip ? (
          <button
            type="button"
            className="turn-block-chip"
            aria-label={staticChipLabel}
            title={staticChipLabel}
            {...(hasTools ? { "aria-expanded": toolsAreExpanded } : {})}
            {...(hasTools && onToggleTools ? { onClick: onToggleTools } : {})}
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
            {hasTools ? (
              <ChevronRight
                size={11}
                className={`turn-block-chevron${toolsAreExpanded ? " expanded" : ""}`}
                aria-hidden="true"
              />
            ) : null}
          </button>
        ) : null}
      </div>
      <div
        className="turn-block-body"
        data-just-revealed={justRevealed ? "true" : undefined}
      >
        {renderBody(body)}
      </div>
    </div>
  );
}
