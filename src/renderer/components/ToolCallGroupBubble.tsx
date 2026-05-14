import { useMemo, useState, type JSX } from "react";
import {
  summarizeToolGroup,
  type ToolCall,
  type ToolCallGroup
} from "../lib/toolCalls.js";
import { LiveElapsedChip } from "./LiveElapsedChip.js";
import { ToolCallBubble } from "./ToolCallBubble.js";

export function ToolCallGroupBubble({
  group,
  isFreshTool,
  defaultExpanded,
  workspaceCwd
}: {
  group: ToolCallGroup;
  isFreshTool: (tool: ToolCall) => boolean;
  defaultExpanded?: boolean;
  workspaceCwd?: string | null;
}): JSX.Element {
  const [userToggle, setUserToggle] = useState<boolean | null>(null);
  const summary = useMemo(() => summarizeToolGroup(group.tools), [group.tools]);
  // Default to expanded so users can see what the agent did, even after the
  // turn completes. The user can manually collapse to free up vertical space.
  const expanded = userToggle ?? (defaultExpanded ?? true);
  const { startedAtMs, completedAtMs } = useMemo(() => {
    const start = Math.min(...group.tools.map((t) => Date.parse(t.createdAt)));
    const anyRunning = group.tools.some((t) => !t.completedAt);
    if (anyRunning) return { startedAtMs: start, completedAtMs: null };
    const end = Math.max(
      ...group.tools.map((t) => (t.completedAt ? Date.parse(t.completedAt) : 0))
    );
    return { startedAtMs: start, completedAtMs: end };
  }, [group.tools]);

  return (
    <div className="tool-call-group" data-status={summary.worstStatus} data-expanded={expanded}>
      <button
        className="tool-call-group-header"
        type="button"
        aria-expanded={expanded}
        aria-label={`${summary.headline}${summary.preview ? ": " + summary.preview : ""}`}
        onClick={() => setUserToggle(!expanded)}
      >
        <span className="tool-call-group-eyebrow" aria-hidden="true">
          <span className="tool-call-group-eyebrow-label">{summary.headline}</span>
        </span>
        {summary.preview ? (
          <span className="tool-call-group-preview" aria-hidden="true">{summary.preview}</span>
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
              <ToolCallBubble
                tool={tool}
                fresh={isFreshTool(tool)}
                nested
                workspaceCwd={workspaceCwd ?? null}
                {...(group.parallelPositions.get(tool.id)
                  ? { parallelPosition: group.parallelPositions.get(tool.id)! }
                  : {})}
                {...(group.parallelGroupId.get(tool.id)
                  ? { parallelGroupId: group.parallelGroupId.get(tool.id)! }
                  : {})}
              />
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
