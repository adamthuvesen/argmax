import { Check, ChevronRight, Loader2, X } from "lucide-react";
import { useMemo, useState, type JSX } from "react";
import { formatElapsed } from "../formatElapsed.js";
import {
  BUCKET_ICON_NAME,
  buildGroupIconBuckets,
  getToolIcon,
  summarizeToolGroup,
  type ToolCall,
  type ToolCallGroup
} from "../lib/toolCalls.js";
import { ToolCallBubble } from "./ToolCallBubble.js";

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
  const elapsedText = formatElapsed(elapsedMs);
  const chipLabel =
    summary.worstStatus === "running"
      ? `running, ${elapsedText}`
      : summary.worstStatus === "error"
        ? `failed, ${elapsedText}`
        : `done, ${elapsedText}`;

  return (
    <div className="tool-call-group" data-status={summary.worstStatus}>
      <button
        className="tool-call-group-header"
        type="button"
        aria-expanded={expanded}
        aria-label={`${summary.headline}${summary.preview ? ": " + summary.preview : ""}`}
        onClick={() => setUserToggle(!expanded)}
      >
        <span className="tool-call-group-stack" aria-hidden="true">
          {buildGroupIconBuckets(group.tools).map(({ bucket }) => (
            <span key={bucket} className="tool-call-group-stack-icon">
              {getToolIcon(BUCKET_ICON_NAME[bucket])}
            </span>
          ))}
        </span>
        <span className="tool-call-group-headline">{summary.headline}</span>
        {summary.preview ? <span className="tool-call-group-preview">· {summary.preview}</span> : null}
        <span className="tool-call-status-chip" aria-label={chipLabel} title={chipLabel}>
          <span className="tool-call-status-glyph" aria-hidden="true">
            {summary.worstStatus === "running" ? (
              <Loader2 size={11} className="tool-call-spinner" />
            ) : summary.worstStatus === "error" ? (
              <X size={11} />
            ) : (
              <Check size={11} />
            )}
          </span>
          {elapsedText ? (
            <span className="tool-call-status-time" aria-hidden="true">{elapsedText}</span>
          ) : null}
        </span>
        <ChevronRight size={11} className={`tool-call-chevron${expanded ? " expanded" : ""}`} />
      </button>
      {expanded ? (
        <div className="tool-call-group-body">
          {group.tools.map((tool) => (
            <ToolCallBubble
              key={tool.id}
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
          ))}
        </div>
      ) : null}
    </div>
  );
}
