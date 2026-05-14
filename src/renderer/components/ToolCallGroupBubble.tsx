import { useMemo, useState, type JSX } from "react";
import {
  summarizeToolGroup,
  type ToolCall,
  type ToolCallGroup
} from "../lib/toolCalls.js";
import { ToolCallBubble } from "./ToolCallBubble.js";
import { ToolStatusChip } from "./ToolStatusChip.js";

export function ToolCallGroupBubble({
  group,
  now,
  isFreshTool,
  defaultExpanded,
  workspaceCwd
}: {
  group: ToolCallGroup;
  now: number;
  isFreshTool: (tool: ToolCall) => boolean;
  defaultExpanded?: boolean;
  workspaceCwd?: string | null;
}): JSX.Element {
  const [userToggle, setUserToggle] = useState<boolean | null>(null);
  const summary = useMemo(() => summarizeToolGroup(group.tools), [group.tools]);
  // Default to expanded so users can see what the agent did, even after the
  // turn completes. The user can manually collapse to free up vertical space.
  const expanded = userToggle ?? (defaultExpanded ?? true);
  const earliestStart = useMemo(
    () => Math.min(...group.tools.map((t) => Date.parse(t.createdAt))),
    [group.tools]
  );
  // No useMemo: `now` ticks every 250 ms while a tool is running, so the
  // memo never hit. Direct computation is the same cost as the dep-check.
  const latestEnd = Math.max(...group.tools.map((t) => (t.completedAt ? Date.parse(t.completedAt) : now)));
  const elapsedMs = Number.isFinite(earliestStart) ? Math.max(0, latestEnd - earliestStart) : 0;

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
        <ToolStatusChip status={summary.worstStatus} elapsedMs={elapsedMs} />
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
                now={now}
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
