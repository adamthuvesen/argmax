import { ChevronRight } from "lucide-react";
import { memo, useEffect, useRef, useState, type JSX } from "react";
import {
  getToolIcon,
  getToolTypeBucket,
  type ParallelPosition,
  type ToolCall
} from "../lib/toolCalls.js";
import { LiveElapsedChip } from "./LiveElapsedChip.js";
import { ToolCallDetail } from "./ToolCallDetail.js";

function ToolCallBubbleInner({
  tool,
  fresh,
  parallelPosition,
  parallelGroupId,
  nested,
  defaultExpanded,
  workspaceCwd
}: {
  tool: ToolCall;
  fresh: boolean;
  parallelPosition?: ParallelPosition;
  parallelGroupId?: string;
  nested?: boolean;
  defaultExpanded?: boolean;
  workspaceCwd?: string | null;
}): JSX.Element {
  // Standalone errors expand themselves so the message is visible without a
  // click. When nested in a group the group is the entry point — let the user
  // open individual error rows on demand so a bursty turn doesn't unfold into
  // a wall of stack traces.
  const shouldAutoExpandOnError = !nested;
  const [expanded, setExpanded] = useState<boolean>(
    (shouldAutoExpandOnError && tool.status === "error") || (defaultExpanded ?? false)
  );
  const autoExpandedOnErrorRef = useRef<boolean>(shouldAutoExpandOnError && tool.status === "error");
  const [didFlash, setDidFlash] = useState<boolean>(false);

  useEffect(() => {
    if (!shouldAutoExpandOnError) return;
    if (tool.status === "error" && !autoExpandedOnErrorRef.current) {
      autoExpandedOnErrorRef.current = true;
      setExpanded(true);
    }
  }, [tool.status, shouldAutoExpandOnError]);

  const startedAtMs = Date.parse(tool.createdAt);
  const completedAtMs = tool.completedAt ? Date.parse(tool.completedAt) : null;

  const showFlash = fresh && !didFlash;
  const rootClass = [
    "tool-call-item",
    `tool-call-${tool.status}`,
    nested ? "tool-call-item--nested" : null
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div
      className={rootClass}
      data-status={tool.status}
      data-tool-type={getToolTypeBucket(tool.name)}
      {...(parallelPosition ? { "data-parallel-position": parallelPosition } : {})}
      {...(parallelGroupId ? { "data-parallel-group": parallelGroupId } : {})}
    >
      {showFlash ? (
        <span
          className="tool-call-flash"
          aria-hidden="true"
          onAnimationEnd={() => setDidFlash(true)}
        />
      ) : null}
      <button
        className="tool-call-header"
        type="button"
        aria-expanded={expanded}
        aria-label={`${tool.name}${tool.inputPreview ? ": " + tool.inputPreview : ""}`}
        onClick={() => setExpanded((v) => !v)}
      >
        <span className="tool-call-icon" aria-hidden="true">{getToolIcon(tool.name)}</span>
        <span className="tool-call-name">{tool.name}</span>
        {tool.inputPreview ? <code className="tool-call-preview">{tool.inputPreview}</code> : null}
        <LiveElapsedChip
          status={tool.status}
          startedAtMs={startedAtMs}
          completedAtMs={completedAtMs}
          showFastFailureText
        />
        <ChevronRight size={11} className={`tool-call-chevron${expanded ? " expanded" : ""}`} />
      </button>
      {expanded ? <ToolCallDetail tool={tool} workspaceCwd={workspaceCwd ?? null} /> : null}
    </div>
  );
}

// Memoize on tool identity + status + fresh-flag (ralph C2). The `tool`
// object is rebuilt by SessionConversation's `toolCalls` memo per render,
// so a referential check on tool would always miss — compare its id and
// the rendered-status fields (status, error, completedAt) instead.
export const ToolCallBubble = memo(ToolCallBubbleInner, (prev, next) => {
  if (prev.fresh !== next.fresh) return false;
  if (prev.parallelPosition !== next.parallelPosition) return false;
  if (prev.parallelGroupId !== next.parallelGroupId) return false;
  if (prev.nested !== next.nested) return false;
  if (prev.defaultExpanded !== next.defaultExpanded) return false;
  if (prev.workspaceCwd !== next.workspaceCwd) return false;
  if (prev.tool === next.tool) return true;
  return (
    prev.tool.id === next.tool.id &&
    prev.tool.status === next.tool.status &&
    prev.tool.error === next.tool.error &&
    prev.tool.completedAt === next.tool.completedAt
  );
});
