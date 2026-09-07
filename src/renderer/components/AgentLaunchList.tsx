import { ChevronRight } from "lucide-react";
import { useState, type JSX } from "react";
import { codenameForTool, fallbackCodename } from "../lib/agentNames.js";
import { emblemForCodename, type Emblem } from "../lib/agentEmblems.js";
import {
  agentLaunchAriaLabel,
  agentLaunchLabel,
  agentStatusLabel
} from "../lib/agentLaunch.js";
import { useSettleHold } from "../hooks/useSettleHold.js";
import type { ToolCall } from "../lib/toolCalls.js";
import { AgentEmblem } from "./AgentEmblem.js";
import type { FileChipOpenOptions } from "./FileChip.js";
import { ToolCallDetail, toolCallHasExpandableDetail } from "./ToolCallDetail.js";
import { WORKING_NEST_SETTLE_MS, WorkingNest } from "./WorkingNest.js";

/**
 * A running agent gets the animated nest; a settled one gets its emblem. The
 * finished state is carried by the word "Completed" on the row's own status
 * line, so a check glyph would only say it twice — and the emblem occupies the
 * nest's box, so the text edge does not shift when an agent lands.
 *
 * The swap waits for the nest's landing (useSettleHold): the mark's four dots
 * gather, pulse once and open back out, and only then does the emblem take
 * over. An agent that *errored* skips it — a landing is the app saying the work
 * arrived, and it must never say that about work that didn't.
 */
function AgentLaunchMark({
  status,
  emblem,
  phaseKey
}: {
  status: ToolCall["status"];
  emblem: Emblem;
  phaseKey: string;
}): JSX.Element {
  const phase = useSettleHold(status === "running", WORKING_NEST_SETTLE_MS);
  // Same element in the same slot across the flip, so React keeps the instance
  // and the nest can see `active` go true → false. Returning a different node
  // for the finished state would unmount it mid-landing.
  if (status !== "error" && phase !== "done") {
    return (
      <WorkingNest
        active={phase === "running"}
        className="agent-launch-mark"
        size={14}
        phaseKey={phaseKey}
      />
    );
  }
  return (
    <span
      className="agent-launch-mark agent-launch-emblem"
      aria-hidden="true"
      data-launch-mark={status === "error" ? "error" : "done"}
    >
      <AgentEmblem
        shape={emblem.shape}
        hue={emblem.hue}
        size={14}
        status={status === "error" ? "error" : "done"}
      />
    </span>
  );
}

type UserToggle = {
  value: boolean;
  defaultExpanded?: boolean;
};

function AgentLaunchRow({
  tool,
  agentCodename,
  defaultExpanded,
  workspaceCwd,
  onOpenFile,
  onOpenAgent
}: {
  tool: ToolCall;
  agentCodename?: string;
  defaultExpanded?: boolean;
  workspaceCwd?: string | null;
  onOpenFile?: (path: string, opts?: FileChipOpenOptions) => void;
  onOpenAgent?: (tool: ToolCall) => void;
}): JSX.Element {
  const [userToggle, setUserToggle] = useState<UserToggle | null>(null);
  const localExpanded =
    userToggle && userToggle.defaultExpanded === defaultExpanded ? userToggle.value : null;
  const hasDetail = toolCallHasExpandableDetail(tool);
  const expanded =
    hasDetail && (localExpanded ?? (tool.status === "error" || (defaultExpanded ?? false)));
  const { title, identity } = agentLaunchLabel(tool, agentCodename);
  const action = agentLaunchAriaLabel(tool, agentCodename);
  const emblem = emblemForCodename(agentCodename ?? fallbackCodename(tool.toolUseId));
  const toggleExpanded = (): void => {
    if (!hasDetail) return;
    setUserToggle({ value: !expanded, defaultExpanded });
  };
  // The row's click opens the run in the pane's Agents view. A surface with no
  // dock to host that view — the phone — keeps the row as a record of the
  // delegated work: same mark, name and status, nothing to press.
  const opensAgentPane = onOpenAgent !== undefined;
  const headline = (
    <>
      <span className="agent-launch-headline">
        <span className="agent-launch-title">{title}</span>
        {identity ? <span className="agent-launch-identity">{identity}</span> : null}
      </span>
      <span className="agent-launch-status">{agentStatusLabel(tool.status)}</span>
    </>
  );

  return (
    // The hue rides the row so the working nest lands in this agent's colour
    // before its emblem takes the slot.
    <div
      className="agent-launch-row agent-emblem-tint"
      data-status={tool.status}
      data-hue={emblem.hue}
    >
      <div className="agent-launch-row-main">
        <AgentLaunchMark status={tool.status} emblem={emblem} phaseKey={tool.toolUseId} />
        {opensAgentPane ? (
          <button
            type="button"
            className="agent-launch-row-button"
            aria-label={action}
            onClick={() => onOpenAgent(tool)}
          >
            {headline}
          </button>
        ) : (
          <div className="agent-launch-row-button">{headline}</div>
        )}
        {opensAgentPane && hasDetail ? (
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
      {expanded ? (
        <ToolCallDetail
          tool={tool}
          workspaceCwd={workspaceCwd ?? null}
          onOpenFile={onOpenFile}
        />
      ) : null}
    </div>
  );
}

export function AgentLaunchList({
  tools,
  defaultExpanded,
  workspaceCwd,
  agentCodenames,
  onOpenFile,
  onOpenAgent
}: {
  tools: ToolCall[];
  defaultExpanded?: boolean;
  workspaceCwd?: string | null;
  agentCodenames?: Map<string, string>;
  onOpenFile?: (path: string, opts?: FileChipOpenOptions) => void;
  onOpenAgent?: (tool: ToolCall) => void;
}): JSX.Element {
  return (
    <div className="agent-launch-list">
      {tools.map((tool) => (
        <AgentLaunchRow
          key={tool.id}
          tool={tool}
          agentCodename={codenameForTool(tool, agentCodenames)}
          defaultExpanded={defaultExpanded}
          workspaceCwd={workspaceCwd}
          onOpenFile={onOpenFile}
          onOpenAgent={onOpenAgent}
        />
      ))}
    </div>
  );
}
