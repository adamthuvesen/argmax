import { memo, useEffect, useMemo, useRef, useState, type JSX } from "react";
import { interpretFileChange, type FileChange } from "../lib/fileChange.js";
import { shortenPathsInText } from "../lib/pathDisplay.js";
import { describeToolAction, getToolIcon, getToolTypeBucket, type ToolCall } from "../lib/toolCalls.js";
import type { FileChipOpenOptions } from "./FileChip.js";
import { ToolCallDetail } from "./ToolCallDetail.js";

function splitVerbTarget(action: string): { verb: string; target: string } {
  const space = action.indexOf(" ");
  if (space === -1) return { verb: action, target: "" };
  return { verb: action.slice(0, space), target: action.slice(space + 1) };
}

function summarizeChanges(changes: FileChange[]): { adds: number; dels: number; files: number } {
  let adds = 0;
  let dels = 0;
  for (const c of changes) {
    if (c.kind === "delete") continue;
    adds += c.addCount;
    if (c.kind === "edit") dels += c.delCount;
  }
  return { adds, dels, files: changes.length };
}

function verbForChanges(changes: FileChange[]): string | null {
  let creates = 0;
  let edits = 0;
  let deletes = 0;
  for (const c of changes) {
    if (c.kind === "create") creates += 1;
    else if (c.kind === "edit") edits += 1;
    else deletes += 1;
  }
  if (creates > 0 && edits === 0 && deletes === 0) return "Created";
  if (deletes > 0 && creates === 0 && edits === 0) return "Deleted";
  if (edits > 0 && creates === 0 && deletes === 0) return "Edited";
  return "Changed";
}

type UserToggle = {
  value: boolean;
  defaultExpanded?: boolean;
};

function ToolCallRowInner({
  tool,
  workspaceCwd,
  defaultExpanded,
  onOpenFile
}: {
  tool: ToolCall;
  workspaceCwd?: string | null;
  defaultExpanded?: boolean;
  onOpenFile?: (path: string, opts?: FileChipOpenOptions) => void;
}): JSX.Element {
  // Follow the parent turn's expanded state until the user manually toggles
  // this row. That keeps the turn chip authoritative for single-tool rows
  // (including MCP calls) while preserving per-row overrides.
  const [userToggle, setUserToggle] = useState<UserToggle | null>(null);
  // Auto-expand on error so the failure is visible without a click. We only
  // run this once per row — if the user manually collapses, we don't reopen.
  const [autoExpandedOnError, setAutoExpandedOnError] = useState<boolean>(tool.status === "error");
  const autoExpandedOnErrorRef = useRef<boolean>(tool.status === "error");

  useEffect(() => {
    const hasLocalOverride = userToggle?.defaultExpanded === defaultExpanded;
    if (tool.status === "error" && !autoExpandedOnErrorRef.current && !hasLocalOverride) {
      autoExpandedOnErrorRef.current = true;
      setAutoExpandedOnError(true);
    }
  }, [defaultExpanded, tool.status, userToggle]);

  const localExpanded =
    userToggle && userToggle.defaultExpanded === defaultExpanded ? userToggle.value : null;
  const expanded = localExpanded ?? (autoExpandedOnError || (defaultExpanded ?? false));

  const action = describeToolAction(tool);
  const baseSplit = splitVerbTarget(action);

  const changes = useMemo(
    () => interpretFileChange(tool.name, tool.inputFull),
    [tool.name, tool.inputFull]
  );
  const counts = changes && changes.length > 0 ? summarizeChanges(changes) : null;
  const overrideVerb = changes && changes.length > 0 ? verbForChanges(changes) : null;
  const verb = overrideVerb ?? baseSplit.verb;
  const target = baseSplit.target;
  const toolTypeBucket = getToolTypeBucket(tool.name);

  return (
    <div className="tool-call-row" data-status={tool.status} data-tool-type={toolTypeBucket}>
      <button
        className="tool-call-row-button"
        type="button"
        aria-expanded={expanded}
        aria-label={action}
        onClick={() => setUserToggle({ value: !expanded, defaultExpanded })}
      >
        <span className="tool-call-row-icon" aria-hidden="true">
          {getToolIcon(tool.name)}
        </span>
        <span className="tool-call-row-verb">{verb}</span>
        {target ? (
          <span className="tool-call-row-target">{shortenPathsInText(target)}</span>
        ) : null}
        {counts && (counts.adds > 0 || counts.dels > 0) ? (
          <span className="tool-call-row-counts" aria-hidden="true">
            {counts.adds > 0 ? <span className="adds">+{counts.adds}</span> : null}
            {counts.dels > 0 ? <span className="dels">−{counts.dels}</span> : null}
            {counts.files > 1 ? <span className="files">· {counts.files} files</span> : null}
          </span>
        ) : null}
      </button>
      {expanded ? (
        <ToolCallDetail tool={tool} workspaceCwd={workspaceCwd ?? null} onOpenFile={onOpenFile} />
      ) : null}
    </div>
  );
}

export const ToolCallRow = memo(ToolCallRowInner, (prev, next) => {
  if (prev.workspaceCwd !== next.workspaceCwd) return false;
  if (prev.defaultExpanded !== next.defaultExpanded) return false;
  if (prev.onOpenFile !== next.onOpenFile) return false;
  if (prev.tool === next.tool) return true;
  return (
    prev.tool.id === next.tool.id &&
    prev.tool.status === next.tool.status &&
    prev.tool.error === next.tool.error &&
    prev.tool.completedAt === next.tool.completedAt &&
    prev.tool.inputPreview === next.tool.inputPreview
  );
});
