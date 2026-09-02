import { ChevronRight, Copy, GitFork } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type JSX } from "react";
import { formatElapsedSeconds } from "../formatElapsed.js";
import { useCopyToClipboard } from "../hooks/useCopyToClipboard.js";
import { registerLiveTimer } from "../lib/liveTimer.js";
import type { TurnToolItem } from "../lib/toolCalls.js";
import { groupToolRuns, type TurnBodyChild } from "../lib/turnChildren.js";

export type { TurnToolItem, TurnBodyChild };

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
  body,
  turnStartedAtMs,
  isTurnActive,
  toolsExpanded,
  onToggleTools,
  hideWorkingWhenCollapsed,
  headerTimestampIso,
  turnMarkdown,
  changes,
  onFork
}: {
  toolItems: TurnToolItem[];
  assistantTimestamps: number[];
  body: TurnBodyChild[];
  // When provided, the live ticker anchors here instead of the earliest
  // tool/assistant timestamp. The parent passes the preceding user.message
  // timestamp so the chip starts ticking from the moment the turn began —
  // including the thinking phase before any tools fire.
  turnStartedAtMs?: number;
  // Authoritative "agent is still working" signal from the parent. The parent
  // knows about session state and user-input pauses (PlanCard, QuestionCard),
  // including thinking-only phases without active tools.
  isTurnActive?: boolean;
  // Whether this turn's tool groups are expanded. Owned by the parent (which
  // builds the tool nodes) so the chip and the per-group toggles share one
  // source of truth; the chip reflects it and flips it via `onToggleTools`.
  // Collapsing usually folds groups to their headers. In minimal verbosity
  // (`hideWorkingWhenCollapsed`) a finished turn hides the working rows
  // entirely, leaving the chip and the answer.
  toolsExpanded?: boolean;
  onToggleTools?: () => void;
  hideWorkingWhenCollapsed?: boolean;
  // The canonical timestamp shown in the turn header (typically the earliest
  // assistant event in the turn). Per-paragraph timestamps inside the body
  // are visually suppressed once a turn-level one is available.
  headerTimestampIso?: string;
  // The turn's assistant prose, for the hover footer's Copy action. The
  // footer renders only after the turn finishes and only while hovered.
  turnMarkdown?: string;
  // Summary of the files this turn wrote, rendered under the body once the
  // turn settles. A summary of a turn still in progress would be a moving
  // number, so the parent only supplies it for a finished turn.
  changes?: JSX.Element | null;
  // Fork the session this turn belongs to (provider-gated by the parent).
  onFork?: () => void;
}): JSX.Element {
  const toolRunning = useMemo(() => toolItems.some(isToolRunning), [toolItems]);
  // `running` controls the chip's "Working" label and live ticker —
  // the parent's isTurnActive flag is authoritative because it also knows
  // about thinking phases and user-input pauses (PlanCard / QuestionCard).
  // Fall back to tool status for isolated component tests and narrow callers.
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
  // and flips it. Collapsing folds groups to their headers, except in minimal
  // verbosity where a finished turn drops the working rows from the body.
  const toolsAreExpanded = toolsExpanded ?? true;
  const visibleBody =
    hideWorkingWhenCollapsed && !running && !toolsAreExpanded
      ? body.filter((child) => child.kind !== "tool")
      : body;

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
  // Show a quiet turn marker for every assistant turn so long chats get the
  // same visual reset as Codex. Tool turns remain clickable/collapsible; pure
  // text turns render static metadata.
  const showChip = running || hasTools || body.length > 0;
  const interactiveChip = running || hasTools;

  const liveStartMs = running && startedAtMs > 0 ? startedAtMs : null;
  const liveRef = useRef<HTMLSpanElement | null>(null);
  // Layout effect, not a passive one: the ticker's span renders empty and the
  // timer fills it. After a passive effect the browser has already painted the
  // empty span once, so the chip and its adjacent header hairline visibly
  // jump sideways every time the pane
  // mounts. Writing it in the commit phase means the first paint is correct.
  useLayoutEffect(() => {
    const node = liveRef.current;
    if (!node || liveStartMs === null) return;
    return registerLiveTimer(node, () => Date.now() - liveStartMs, formatElapsedSeconds);
  }, [liveStartMs]);

  // Thinking → answered transition. The very first time this turn's body
  // gains content (an assistant token or tool row), set `data-just-revealed`
  // for 280ms so the first child animates "landing" instead of popping in.
  // Subsequent additions stream normally — the animation is reserved for the
  // moment the indeterminate "Thinking" state becomes determinate.
  // Seeded from the body this turn mounts with: a reopened session remounts
  // every turn with its content already in place, and that is a restore, not
  // the thinking → answered moment this animation marks.
  const wasEmptyRef = useRef<boolean>(body.length === 0);
  const [justRevealed, setJustRevealed] = useState(false);
  // Keyed on `hasBody`, not `body.length`: a second child arriving inside the
  // 280ms window would re-run the effect, clear the pending reset timer, and
  // then bail on the ref guard — leaving `data-just-revealed` stuck on for the
  // rest of the turn and replaying the fade every time the first child is
  // replaced. `hasBody` flips false → true exactly once.
  const hasBody = body.length > 0;
  useEffect(() => {
    if (!wasEmptyRef.current) return;
    if (!hasBody) return;
    wasEmptyRef.current = false;
    setJustRevealed(true);
    const id = setTimeout(() => setJustRevealed(false), 280);
    return () => clearTimeout(id);
  }, [hasBody]);

  return (
    <div className="turn-block" data-running={running ? "true" : undefined}>
      <div className="turn-block-header">
        {headerTimestampLabel ? (
          <span
            className="turn-block-timestamp"
            title={headerTimestampIso ? new Date(headerTimestampIso).toISOString() : undefined}
          >
            {headerTimestampLabel}
          </span>
        ) : null}
        {showChip && interactiveChip ? (
          <button
            type="button"
            className="turn-block-chip"
            aria-label={staticChipLabel}
            title={staticChipLabel}
            {...(hasTools ? { "aria-expanded": toolsAreExpanded } : {})}
            {...(hasTools && onToggleTools ? { onClick: onToggleTools } : {})}
          >
            {liveStartMs !== null ? (
              <span>
                Working for <span className="turn-block-elapsed" ref={liveRef} />
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
        ) : showChip ? (
          <span className="turn-block-chip turn-block-chip-static">{staticChipLabel}</span>
        ) : null}
      </div>
      {visibleBody.length > 0 ? (
        <div
          className="turn-block-body"
          data-just-revealed={justRevealed ? "true" : undefined}
        >
          {groupToolRuns(visibleBody)}
        </div>
      ) : null}
      {!running ? changes ?? null : null}
      {!running && (turnMarkdown || onFork) ? (
        <TurnFooter {...(turnMarkdown ? { turnMarkdown } : {})} {...(onFork ? { onFork } : {})} />
      ) : null}
    </div>
  );
}

/** Hover-revealed actions under a finished turn: copy the reply, fork the session. */
function TurnFooter({
  turnMarkdown,
  onFork
}: {
  turnMarkdown?: string;
  onFork?: () => void;
}): JSX.Element {
  const [copyFlash, copy] = useCopyToClipboard();
  return (
    <div className="turn-block-footer">
      {turnMarkdown ? (
        <button
          type="button"
          className="turn-block-footer-action"
          aria-label="Copy reply"
          title={
            copyFlash === "copied" ? "Copied!" : copyFlash === "failed" ? "Couldn't copy" : "Copy reply"
          }
          onClick={() => void copy(turnMarkdown)}
        >
          <Copy size={13} aria-hidden />
        </button>
      ) : null}
      {onFork ? (
        <button
          type="button"
          className="turn-block-footer-action"
          aria-label="Fork chat"
          // Not a fork from THIS turn: `fork_session` copies the whole
          // transcript and resumes the session's latest conversation, so
          // "from here" would be a promise the backend does not keep.
          title="Fork chat — copy it into a new chat and continue there"
          onClick={onFork}
        >
          <GitFork size={13} aria-hidden />
        </button>
      ) : null}
    </div>
  );
}
