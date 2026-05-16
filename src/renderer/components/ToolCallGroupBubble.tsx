import { memo, useMemo, useState, type JSX } from "react";
import { summarizeToolGroup, type ToolCall, type ToolCallGroup } from "../lib/toolCalls.js";
import { LiveElapsedChip } from "./LiveElapsedChip.js";
import { ToolCallRow } from "./ToolCallRow.js";

type ToolCallGroupBubbleProps = {
  group: ToolCallGroup;
  isFreshTool: (tool: ToolCall) => boolean;
  defaultExpanded?: boolean;
  workspaceCwd?: string | null;
};

function ToolCallGroupBubbleInner({
  group,
  defaultExpanded,
  workspaceCwd
}: ToolCallGroupBubbleProps): JSX.Element {
  const [userToggle, setUserToggle] = useState<boolean | null>(null);
  const summary = useMemo(() => summarizeToolGroup(group.tools), [group.tools]);
  // Collapsed by default to match Codex — the user clicks the chevron to
  // reveal per-tool rows. defaultExpanded (from Settings) still wins when set.
  const expanded = userToggle ?? (defaultExpanded ?? false);
  const { startedAtMs, completedAtMs } = useMemo(() => {
    const start = Math.min(...group.tools.map((t) => Date.parse(t.createdAt)));
    const anyRunning = group.tools.some((t) => !t.completedAt);
    if (anyRunning) return { startedAtMs: start, completedAtMs: null };
    const end = Math.max(
      ...group.tools.map((t) => (t.completedAt ? Date.parse(t.completedAt) : 0))
    );
    return { startedAtMs: start, completedAtMs: end };
  }, [group.tools]);

  // While collapsed and still running, show the current action ("Read foo.ts")
  // in place of the slash-joined input preview so the user has a live signal.
  const previewText =
    !expanded && summary.worstStatus === "running" && summary.currentAction
      ? summary.currentAction
      : summary.preview;

  return (
    <div className="tool-call-group" data-status={summary.worstStatus} data-expanded={expanded}>
      <button
        className="tool-call-group-header"
        type="button"
        aria-expanded={expanded}
        aria-label={`${summary.headline}${previewText ? ": " + previewText : ""}`}
        onClick={() => setUserToggle(!expanded)}
      >
        <span className="tool-call-group-eyebrow" aria-hidden="true">
          <span className="tool-call-group-eyebrow-label">{summary.headline}</span>
        </span>
        {previewText ? (
          <span className="tool-call-group-preview" aria-hidden="true">{previewText}</span>
        ) : null}
        <LiveElapsedChip
          status={summary.worstStatus}
          startedAtMs={startedAtMs}
          completedAtMs={completedAtMs}
        />
        <span className={`tool-call-group-toggle${expanded ? " expanded" : ""}`} aria-hidden="true">
          {expanded ? "−" : "+"}
        </span>
      </button>
      {expanded ? (
        <div className="tool-call-group-body">
          {group.tools.map((tool, index) => (
            <div
              className="tool-call-group-row"
              key={tool.id}
              style={{ animationDelay: `${Math.min(index, 8) * 28}ms` }}
            >
              <ToolCallRow tool={tool} workspaceCwd={workspaceCwd ?? null} />
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export const ToolCallGroupBubble = memo(ToolCallGroupBubbleInner, (prev, next) => {
  if (prev.defaultExpanded !== next.defaultExpanded) return false;
  if (prev.workspaceCwd !== next.workspaceCwd) return false;
  if (prev.isFreshTool !== next.isFreshTool) return false;
  if (prev.group === next.group) return true;
  if (prev.group.id !== next.group.id) return false;
  const pt = prev.group.tools;
  const nt = next.group.tools;
  if (pt === nt) return true;
  if (pt.length !== nt.length) return false;
  for (let i = 0; i < pt.length; i++) {
    const a = pt[i];
    const b = nt[i];
    if (a.id !== b.id || a.status !== b.status || a.completedAt !== b.completedAt) {
      return false;
    }
  }
  return true;
});
