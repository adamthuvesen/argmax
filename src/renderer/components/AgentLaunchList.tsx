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

type UserToggle = {
  value: boolean;
  defaultExpanded?: boolean;
};

/**
 * The nest marker: four dots in a 2x2. Hand-rolled as SVG rather than a "::"
 * text glyph so each dot can carry its own opacity while the launch is
 * running. The clockwise sequence lives in CSS (.agent-launch-nest-dot) so
 * prefers-reduced-motion can pin it and a settled row rests unanimated.
 */
function AgentLaunchNest(): JSX.Element {
  return (
    <svg
      className="agent-launch-nest"
      width={10}
      height={10}
      viewBox="0 0 10 10"
      aria-hidden="true"
    >
      <circle className="agent-launch-nest-dot" data-dot="1" cx="3" cy="3" r="1.3" />
      <circle className="agent-launch-nest-dot" data-dot="2" cx="7" cy="3" r="1.3" />
      <circle className="agent-launch-nest-dot" data-dot="3" cx="7" cy="7" r="1.3" />
      <circle className="agent-launch-nest-dot" data-dot="4" cx="3" cy="7" r="1.3" />
    </svg>
  );
}

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
        <AgentLaunchNest />
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
