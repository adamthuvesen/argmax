import { ChevronRight } from "lucide-react";
import { memo, useLayoutEffect, useMemo, useRef, useState, type JSX } from "react";
import {
  buildGroupRows,
  parseMcpToolName,
  splitLeadingVerb,
  summarizeToolChangeCounts,
  summarizeToolGroup,
  type ToolCall,
  type ToolCallGroup
} from "../lib/toolCalls.js";
import { codenameForTool } from "../lib/agentNames.js";
import type { ActivityMember } from "../lib/turnChildren.js";
import { ActivityStat } from "./ActivityStat.js";
import type { FileChipOpenOptions } from "./FileChip.js";
import { ToolCallRow } from "./ToolCallRow.js";
import { WorkingNest } from "./WorkingNest.js";
import { ToolActivityIcon } from "./ToolActivityIcon.js";
import { ServerIcon } from "./ServerIcon.js";

type ToolCallGroupBubbleProps = {
  group: ToolCallGroup;
  /** Ordered thoughts and tool runs for Compact's mixed activity disclosure. */
  activityMembers?: readonly ActivityMember[];
  /** Optional namespace so simultaneously mounted surfaces get unique ids. */
  disclosureId?: string;
  compact?: boolean;
  defaultExpanded?: boolean;
  defaultToolsExpanded?: boolean;
  workspaceCwd?: string | null;
  agentCodenames?: Map<string, string>;
  onOpenFile?: (path: string, opts?: FileChipOpenOptions) => void;
  onOpenAgent?: (tool: ToolCall) => void;
};

type UserToggle = {
  value: boolean;
  defaultExpanded?: boolean;
};

const PREVIEW_DWELL_MS = 600;

function stableDisclosureId(prefix: string, groupId: string): string {
  return `${prefix}-${groupId}`.replace(/[^a-zA-Z0-9_-]/g, "-");
}

function ToolCallGroupBubbleInner({
  group,
  activityMembers,
  disclosureId,
  compact = false,
  defaultExpanded,
  defaultToolsExpanded,
  workspaceCwd,
  agentCodenames,
  onOpenFile,
  onOpenAgent
}: ToolCallGroupBubbleProps): JSX.Element {
  const [userToggle, setUserToggle] = useState<UserToggle | null>(null);
  const [singletonDisclosure, setSingletonDisclosure] = useState<{
    toolId: string;
    expanded: boolean;
  } | null>(null);
  const [, setPreviewRevision] = useState(0);
  const lastPreviewRef = useRef<{ toolId: string; text: string; shownAt: number } | null>(null);
  const summary = useMemo(() => summarizeToolGroup(group.tools), [group.tools]);
  const firstTool = group.tools[0];
  const iconServer = firstTool && firstTool.activity?.kind !== "computer"
    ? parseMcpToolName(firstTool.name)?.server : null;
  const hasActivityMembers = Boolean(activityMembers && activityMembers.length > 0);
  const activityIsLive = activityMembers?.some(
    (member) => member.kind === "thought" && member.live
  ) ?? false;
  const activityHeadline = group.tools.length > 0
    ? summary.headline
    : activityIsLive
      ? "Thinking"
      : "Thought";
  const headline = useMemo(() => splitLeadingVerb(activityHeadline), [activityHeadline]);
  const changeCounts = useMemo(() => summarizeToolChangeCounts(group.tools), [group.tools]);
  const rows = useMemo(() => buildGroupRows(group.tools), [group.tools]);
  const firstActivityMember = activityMembers?.[0];
  const detailsId = stableDisclosureId(
    disclosureId ?? "activity-details",
    firstActivityMember?.id ?? group.id
  );
  // Collapsed by default to match Codex. The user clicks the chevron to reveal
  // per-tool rows. defaultExpanded (from Settings) overrides. Error state colors
  // the chevron + status dot on the header without changing expansion.
  const localExpanded =
    userToggle && userToggle.defaultExpanded === defaultExpanded ? userToggle.value : null;
  const expanded = localExpanded ?? (defaultExpanded ?? false);
  const toggleExpanded = (value: boolean): void => setUserToggle({ value, defaultExpanded });

  const directTool = !hasActivityMembers && !compact && group.tools.length === 1
    ? group.tools[0]
    : undefined;
  let runningTool: ToolCall | null = null;
  for (const tool of group.tools) {
    if (tool.status === "running") runningTool = tool;
  }
  const livePreviewToolId =
    !compact && !directTool && !expanded && runningTool && summary.currentAction
      ? runningTool.id
      : null;
  const livePreviewText = livePreviewToolId ? summary.currentAction : null;
  const retainedPreview = lastPreviewRef.current;
  const previewText = livePreviewText ?? (
    !compact && !directTool && !expanded && retainedPreview && Date.now() - retainedPreview.shownAt < PREVIEW_DWELL_MS
      ? retainedPreview.text
      : null
  );

  useLayoutEffect(() => {
    if (compact || directTool || expanded) {
      lastPreviewRef.current = null;
      return;
    }
    if (livePreviewToolId && livePreviewText) {
      if (
        lastPreviewRef.current?.toolId !== livePreviewToolId ||
        lastPreviewRef.current.text !== livePreviewText
      ) {
        lastPreviewRef.current = {
          toolId: livePreviewToolId,
          text: livePreviewText,
          shownAt: Date.now()
        };
      }
      return;
    }
    const lastPreview = lastPreviewRef.current;
    if (!lastPreview) return;
    const remaining = PREVIEW_DWELL_MS - (Date.now() - lastPreview.shownAt);
    if (remaining <= 0) {
      lastPreviewRef.current = null;
      return;
    }
    const timer = window.setTimeout(() => {
      if (lastPreviewRef.current === lastPreview) {
        lastPreviewRef.current = null;
        setPreviewRevision((revision) => revision + 1);
      }
    }, remaining);
    return () => window.clearTimeout(timer);
  }, [compact, directTool, expanded, livePreviewText, livePreviewToolId]);

  const handleSingletonExpanded = (value: boolean): void => {
    if (!directTool) return;
    setSingletonDisclosure({ toolId: directTool.id, expanded: value });
    toggleExpanded(value);
  };

  const renderRows = (toolRows: ReturnType<typeof buildGroupRows>): JSX.Element[] =>
    toolRows.map(({ tool, children }) => (
      <div key={tool.id}>
        <ToolCallRow
          tool={tool}
          defaultExpanded={
            singletonDisclosure?.toolId === tool.id
              ? singletonDisclosure.expanded
              : defaultToolsExpanded
          }
          workspaceCwd={workspaceCwd ?? null}
          agentCodename={codenameForTool(tool, agentCodenames)}
          onOpenFile={onOpenFile}
          onOpenAgent={onOpenAgent}
        />
        {children.length > 0 ? (
          <div className="tool-call-agent-children">
            {children.map((child) => (
              <ToolCallRow
                key={child.id}
                tool={child}
                defaultExpanded={defaultToolsExpanded}
                workspaceCwd={workspaceCwd ?? null}
                onOpenFile={onOpenFile}
                onOpenAgent={onOpenAgent}
              />
            ))}
          </div>
        ) : null}
      </div>
    ));

  const activityBody = hasActivityMembers
    ? activityMembers?.map((member) => member.kind === "thought"
      ? <div key={member.id}>{member.node}</div>
      : <div key={member.id}>{renderRows(buildGroupRows(member.tools))}</div>)
    : renderRows(rows);
  const activityStatus = activityIsLive ? "running" : summary.status;

  // A thought already owns its disclosure. Only tool work needs an outer one.
  if (hasActivityMembers && group.tools.length === 0) return <>{activityBody}</>;

  return (
    <div
      className="tool-call-group activity-summary-line"
      data-status={activityStatus}
      data-expanded={directTool ? undefined : expanded}
    >
      {directTool ? (
        <ToolCallRow
          tool={directTool}
          defaultExpanded={defaultToolsExpanded ?? defaultExpanded}
          expandedOverride={localExpanded ?? undefined}
          onExpandedChange={handleSingletonExpanded}
          workspaceCwd={workspaceCwd ?? null}
          agentCodename={codenameForTool(directTool, agentCodenames)}
          onOpenFile={onOpenFile}
          onOpenAgent={onOpenAgent}
        />
      ) : (
        <>
          <button
            className="tool-call-group-header"
            type="button"
            aria-expanded={expanded}
            aria-controls={detailsId}
            aria-label={`${activityHeadline}${previewText ? ": " + previewText : ""}`}
            onClick={() => toggleExpanded(!expanded)}
          >
            {group.tools.length > 0 ? (
              <span className="activity-icon-slot">
                {iconServer ? <ServerIcon server={iconServer} />
                  : <ToolActivityIcon kind={summary.iconKind ?? "tool"} />}
              </span>
            ) : null}
            <span className="tool-call-group-eyebrow activity-summary-headline" aria-hidden="true">
              <span className="tool-call-group-eyebrow-label">{headline.verb}</span>
              {headline.rest ? (
                <span className="tool-call-group-eyebrow-detail"> {headline.rest}</span>
              ) : null}
            </span>
            <ChevronRight size={11} className="tool-call-row-chevron" aria-hidden="true" />
            {previewText ? (
              <span className="tool-call-group-preview" aria-hidden="true">{previewText}</span>
            ) : null}
            {/* One trailing slot, not two. While the group is working the nest
                owns the end of the line; the running total arrives when it
                stops. Showing both put a live animation mid-row — each claimed
                `margin-left: auto` and split the gap between them — and gave a
                still-growing count the finality of a result. */}
            {activityStatus === "running" ? (
              <span className="tool-call-group-running" aria-label="running" title="Running">
                <WorkingNest active size={13} />
              </span>
            ) : changeCounts ? (
              <span
                className="tool-call-group-stat"
                role="img"
                aria-label={`Group edits: ${changeCounts.adds} lines added, ${changeCounts.dels} lines removed`}
              >
                <ActivityStat counts={changeCounts} showFiles={false} />
              </span>
            ) : null}
          </button>
          {expanded ? (
            <div id={detailsId} className="tool-call-group-body">
              {activityBody}
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}

export const ToolCallGroupBubble = memo(ToolCallGroupBubbleInner, (prev, next) => {
  if (prev.activityMembers !== next.activityMembers) return false;
  if (prev.disclosureId !== next.disclosureId) return false;
  if (prev.compact !== next.compact) return false;
  if (prev.defaultExpanded !== next.defaultExpanded) return false;
  if (prev.defaultToolsExpanded !== next.defaultToolsExpanded) return false;
  if (prev.workspaceCwd !== next.workspaceCwd) return false;
  if (prev.agentCodenames !== next.agentCodenames) return false;
  if (prev.onOpenFile !== next.onOpenFile) return false;
  if (prev.onOpenAgent !== next.onOpenAgent) return false;
  if (prev.group === next.group) return true;
  if (prev.group.id !== next.group.id) return false;
  const pt = prev.group.tools;
  const nt = next.group.tools;
  if (pt === nt) return true;
  if (pt.length !== nt.length) return false;
  for (let i = 0; i < pt.length; i++) {
    const a = pt[i];
    const b = nt[i];
    // inputPreview drives the live "current action" header while running;
    // parentToolUseId drives sub-agent row grouping. Both must be compared.
    if (
      a.id !== b.id ||
      a.status !== b.status ||
      a.completionObserved !== b.completionObserved ||
      a.completedAt !== b.completedAt ||
      a.inputPreview !== b.inputPreview ||
      a.inputFull !== b.inputFull ||
      a.output !== b.output ||
      a.error !== b.error ||
      a.parentToolUseId !== b.parentToolUseId
    ) {
      return false;
    }
  }
  return true;
});
