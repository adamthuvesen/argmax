import { ChevronRight } from "lucide-react";
import { useState, type JSX } from "react";
import { codenameForTool } from "../lib/agentNames.js";
import {
  agentLaunchAriaLabel,
  agentLaunchStatusHint,
  agentLaunchTitle
} from "../lib/agentLaunch.js";
import type { ToolCall } from "../lib/toolCalls.js";
import type { FileChipOpenOptions } from "./FileChip.js";
import { ToolCallDetail } from "./ToolCallDetail.js";
import { WorkingNest } from "./WorkingNest.js";

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
  const expanded = localExpanded ?? (tool.status === "error" || (defaultExpanded ?? false));
  const title = agentLaunchTitle(agentCodename);
  const statusHint = agentLaunchStatusHint(tool.status);
  const action = agentLaunchAriaLabel(tool, agentCodename);
  const toggleExpanded = (): void => {
    setUserToggle({ value: !expanded, defaultExpanded });
  };
  const opensAgentPane = onOpenAgent !== undefined;

  return (
    <div className="agent-launch-row" data-status={tool.status}>
      <div className="agent-launch-row-main">
        <WorkingNest
          active={tool.status === "running"}
          className="agent-launch-nest"
          size={14}
          phaseKey={tool.toolUseId}
        />
        <button
          type="button"
          className="agent-launch-row-button"
          aria-label={action}
          onClick={opensAgentPane ? () => onOpenAgent(tool) : toggleExpanded}
        >
          <span className="agent-launch-headline">
            <span className="agent-launch-title">{title}</span>
            {statusHint ? <span className="agent-launch-status">{statusHint}</span> : null}
          </span>
        </button>
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
