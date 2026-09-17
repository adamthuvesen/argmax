import { ChevronRight } from "lucide-react";
import { memo, useCallback, useMemo, useRef, useState, type JSX } from "react";
import { interpretFileChange, summarizeFileChanges, type FileChange } from "../lib/fileChange.js";
import { shortenPathsInText } from "../lib/pathDisplay.js";
import { commandIconServer } from "../lib/commandIcons.js";
import {
  describeToolAction,
  getToolTypeBucket,
  isWebToolName,
  parseMcpToolName,
  splitLeadingVerb,
  type ToolCall
} from "../lib/toolCalls.js";
import { ActivityStat } from "./ActivityStat.js";
import type { FileChipOpenOptions } from "./FileChip.js";
import { ToolCallDetail } from "./ToolCallDetail.js";
import { toolCallHasExpandableDetail } from "./toolCallDetailLogic.js";
import { ServerIcon } from "./ServerIcon.js";
import { useReadingWave } from "../lib/readingWave.js";
import { useOwnsActivityBeat } from "../lib/activityBeat.js";
import { ToolActivityIcon } from "./ToolActivityIcon.js";

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
  childTools,
  workspaceCwd,
  defaultExpanded,
  expandedOverride,
  onExpandedChange,
  agentCodename,
  onOpenFile,
  onOpenAgent
}: {
  tool: ToolCall;
  childTools?: ToolCall[];
  workspaceCwd?: string | null;
  defaultExpanded?: boolean;
  expandedOverride?: boolean;
  onExpandedChange?: (expanded: boolean) => void;
  agentCodename?: string;
  onOpenFile?: (path: string, opts?: FileChipOpenOptions) => void;
  onOpenAgent?: (tool: ToolCall) => void;
}): JSX.Element {
  // Follow the parent turn's expanded state until the user manually toggles
  // this row. That keeps the turn chip authoritative for single-tool rows
  // (including MCP calls) while preserving per-row overrides.
  const [userToggle, setUserToggle] = useState<UserToggle | null>(null);
  const localExpanded =
    userToggle && userToggle.defaultExpanded === defaultExpanded ? userToggle.value : null;

  // Agent rows get a deterministic codename so the same spawn is recognizable
  // across the chat row, its tab, and its activity pane. Keep the verb "Started
  // agent" and fold the codename (plus any task preview) into the target.
  const action = agentCodename
    ? tool.inputPreview
      ? `Started agent ${agentCodename} — ${tool.inputPreview}`
      : `Started agent ${agentCodename}`
    : describeToolAction(tool);
  const baseSplit = splitLeadingVerb(action);

  const changes = useMemo(
    () => interpretFileChange(tool.name, tool.inputFull),
    [tool.name, tool.inputFull]
  );
  const counts = tool.status === "done" && !tool.cancelled && tool.completionObserved !== false && changes && changes.length > 0
    ? summarizeFileChanges(changes)
    : null;
  const overrideVerb = !tool.activity && counts && changes && changes.length > 0 ? verbForChanges(changes) : null;
  const verb = overrideVerb ?? baseSplit.verb;
  const target = baseSplit.rest;
  const toolTypeBucket = getToolTypeBucket(tool.name);
  const mcpServer = parseMcpToolName(tool.name)?.server ?? null;
  const iconServer = tool.activity?.kind === "computer" ? null : mcpServer ?? commandIconServer(tool);
  const iconKind = tool.activity?.kind ?? "tool";
  // A delete is a file change, not a failure: it keeps the edit colour so red
  // stays the mark of work that did not finish.
  const iconIsDanger = tool.status === "error"
    || tool.cancelled === true
    || iconKind === "agent-stop";
  const hasLeadingContent = Boolean(childTools && childTools.length > 0);
  const hasDetail = toolCallHasExpandableDetail(tool, { hasLeadingContent });
  // A backgrounded launch is marked running by inference, not by evidence:
  // no completion ever arrives for it, so a band would travel its words for
  // the rest of the session. It keeps the nest, the way the launch row does.
  const ownsBeat = useOwnsActivityBeat(useMemo(() => [tool.id], [tool.id]));
  // A settled row keeps the beat while the cue waits out its gap, which is the
  // only live line a provider that reports a call atomically ever has.
  const isRunning =
    (tool.status === "running" || ownsBeat) && tool.backgroundLaunch !== true;
  const rowButtonRef = useRef<HTMLElement | null>(null);
  const setRowButton = useCallback((node: HTMLElement | null) => {
    rowButtonRef.current = node;
  }, []);
  useReadingWave(rowButtonRef, isRunning, `${verb}\u0000${target ?? ""}`);
  const expanded =
    hasDetail && (expandedOverride ?? localExpanded ?? defaultExpanded ?? false);
  // An agent row exists to open its run in the pane's Agents view. A surface
  // with no dock to host that view — the phone — keeps the row as a record:
  // same icon, verb and target, no control, since expanding the launch input
  // in place says nothing the line does not already.
  const opensAgentPane = toolTypeBucket === "agent" && onOpenAgent !== undefined;
  const inertAgentRow = toolTypeBucket === "agent" && onOpenAgent === undefined;
  const toggleExpanded = (): void => {
    if (!hasDetail) return;
    setUserToggle({ value: !expanded, defaultExpanded });
    onExpandedChange?.(!expanded);
  };
  const childToolRows =
    childTools && childTools.length > 0 ? (
      <div className="tool-call-section tool-call-agent-activity">
        <div className="tool-call-agent-child-list">
          {childTools.map((child) => (
            <ToolCallRow
              key={child.id}
              tool={child}
              defaultExpanded={false}
              workspaceCwd={workspaceCwd ?? null}
              onOpenFile={onOpenFile}
              onOpenAgent={onOpenAgent}
            />
          ))}
        </div>
      </div>
    ) : null;
  const rowContent = (
    <>
      <span className="activity-icon-slot">
        {iconServer || (!tool.activity && isWebToolName(tool.name)) ? <ServerIcon server={iconServer} web={isWebToolName(tool.name)} />
          : <ToolActivityIcon kind={iconKind} danger={iconIsDanger} />}
      </span>
      <span className="tool-call-row-verb reading-wave-text">{verb}</span>
      {target ? (
        <span className="tool-call-row-target reading-wave-text">{shortenPathsInText(target)}</span>
      ) : null}
      {counts ? <ActivityStat counts={counts} /> : null}
      {opensAgentPane || inertAgentRow || !hasDetail ? null : (
        <ChevronRight size={11} className="tool-call-row-chevron" aria-hidden="true" />
      )}
    </>
  );
  // Every shape of the row carries the wave on the element that holds its words.
  const rowButtonProps = {
    ref: setRowButton,
    className: "tool-call-row-button",
    "data-reading-wave": isRunning ? "true" : undefined
  };
  const rowButton = opensAgentPane ? (
    <button
      {...rowButtonProps}
      type="button"
      aria-label={action}
      onClick={() => onOpenAgent(tool)}
    >
      {rowContent}
    </button>
  ) : inertAgentRow ? (
    <div {...rowButtonProps}>{rowContent}</div>
  ) : hasDetail ? (
    <button
      {...rowButtonProps}
      type="button"
      aria-expanded={expanded}
      aria-label={action}
      onClick={toggleExpanded}
    >
      {rowContent}
    </button>
  ) : (
    <div {...rowButtonProps}>{rowContent}</div>
  );

  return (
    <div className="tool-call-row" data-status={tool.status} data-tool-type={toolTypeBucket}>
      {opensAgentPane ? (
        <div className="tool-call-row-main">
          {rowButton}
          {hasDetail ? (
            <button
              className="tool-call-row-disclosure"
              type="button"
              aria-expanded={expanded}
              aria-label={`Toggle details for ${action}`}
              title="Toggle details"
              onClick={toggleExpanded}
            >
              <ChevronRight size={14} aria-hidden="true" />
            </button>
          ) : null}
        </div>
      ) : (
        rowButton
      )}
      {expanded ? (
        <ToolCallDetail
          tool={tool}
          workspaceCwd={workspaceCwd ?? null}
          onOpenFile={onOpenFile}
          leadingContent={childToolRows}
        />
      ) : null}
    </div>
  );
}

function sameChildTools(a: ToolCall[] | undefined, b: ToolCall[] | undefined): boolean {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const left = a[i];
    const right = b[i];
    if (
      !left ||
      !right ||
      left.name !== right.name ||
      left.inputFull !== right.inputFull ||
      left.id !== right.id ||
      left.status !== right.status ||
      left.activity !== right.activity ||
      left.cancelled !== right.cancelled ||
      left.completionObserved !== right.completionObserved ||
      left.error !== right.error ||
      left.completedAt !== right.completedAt ||
      left.output !== right.output ||
      left.inputPreview !== right.inputPreview
    ) {
      return false;
    }
  }
  return true;
}

export const ToolCallRow = memo(ToolCallRowInner, (prev, next) => {
  if (prev.workspaceCwd !== next.workspaceCwd) return false;
  if (prev.defaultExpanded !== next.defaultExpanded) return false;
  if (prev.expandedOverride !== next.expandedOverride) return false;
  if (prev.onExpandedChange !== next.onExpandedChange) return false;
  if (prev.onOpenFile !== next.onOpenFile) return false;
  if (prev.onOpenAgent !== next.onOpenAgent) return false;
  if (prev.agentCodename !== next.agentCodename) return false;
  if (!sameChildTools(prev.childTools, next.childTools)) return false;
  if (prev.tool === next.tool) return true;
  return (
    prev.tool.name === next.tool.name &&
    prev.tool.inputFull === next.tool.inputFull &&
    prev.tool.id === next.tool.id &&
    prev.tool.status === next.tool.status &&
    prev.tool.activity === next.tool.activity &&
    prev.tool.cancelled === next.tool.cancelled &&
    prev.tool.error === next.tool.error &&
    prev.tool.completedAt === next.tool.completedAt &&
    prev.tool.completionObserved === next.tool.completionObserved &&
    prev.tool.output === next.tool.output &&
    prev.tool.inputPreview === next.tool.inputPreview
  );
});
