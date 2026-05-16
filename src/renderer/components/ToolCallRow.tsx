import { memo, useEffect, useRef, useState, type JSX } from "react";
import { describeToolAction, getToolTypeBucket, type ToolCall } from "../lib/toolCalls.js";
import { ToolCallDetail } from "./ToolCallDetail.js";

function splitVerbTarget(action: string): { verb: string; target: string } {
  const space = action.indexOf(" ");
  if (space === -1) return { verb: action, target: "" };
  return { verb: action.slice(0, space), target: action.slice(space + 1) };
}

function ToolCallRowInner({
  tool,
  workspaceCwd,
  defaultExpanded
}: {
  tool: ToolCall;
  workspaceCwd?: string | null;
  defaultExpanded?: boolean;
}): JSX.Element {
  // Auto-expand on error so the failure is visible without a click. We only
  // run this once per row — if the user manually collapses, we don't reopen.
  const [expanded, setExpanded] = useState<boolean>(
    tool.status === "error" || (defaultExpanded ?? false)
  );
  const autoExpandedOnErrorRef = useRef<boolean>(tool.status === "error");

  useEffect(() => {
    if (tool.status === "error" && !autoExpandedOnErrorRef.current) {
      autoExpandedOnErrorRef.current = true;
      setExpanded(true);
    }
  }, [tool.status]);

  const action = describeToolAction(tool);
  const { verb, target } = splitVerbTarget(action);

  return (
    <div className="tool-call-row" data-status={tool.status} data-tool-type={getToolTypeBucket(tool.name)}>
      <button
        className="tool-call-row-button"
        type="button"
        aria-expanded={expanded}
        aria-label={action}
        onClick={() => setExpanded((v) => !v)}
      >
        {tool.status !== "done" ? (
          <span
            className="tool-call-row-dot"
            data-status={tool.status}
            aria-hidden="true"
          />
        ) : null}
        <span className="tool-call-row-verb">{verb}</span>
        {target ? <span className="tool-call-row-target">{target}</span> : null}
      </button>
      {expanded ? <ToolCallDetail tool={tool} workspaceCwd={workspaceCwd ?? null} /> : null}
    </div>
  );
}

export const ToolCallRow = memo(ToolCallRowInner, (prev, next) => {
  if (prev.workspaceCwd !== next.workspaceCwd) return false;
  if (prev.defaultExpanded !== next.defaultExpanded) return false;
  if (prev.tool === next.tool) return true;
  return (
    prev.tool.id === next.tool.id &&
    prev.tool.status === next.tool.status &&
    prev.tool.error === next.tool.error &&
    prev.tool.completedAt === next.tool.completedAt &&
    prev.tool.inputPreview === next.tool.inputPreview
  );
});
