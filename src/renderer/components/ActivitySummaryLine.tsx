import { ChevronRight } from "lucide-react";
import { useMemo, useState, type JSX } from "react";
import { codenameForTool } from "../lib/agentNames.js";
import {
  buildGroupRows,
  splitLeadingVerb,
  summarizeToolChangeCounts,
  summarizeToolGroup,
  type ToolCall
} from "../lib/toolCalls.js";
import { ActivityStat } from "./ActivityStat.js";
import type { FileChipOpenOptions } from "./FileChip.js";
import { ToolCallRow } from "./ToolCallRow.js";
import { WorkingNest } from "./WorkingNest.js";

/**
 * One quiet line summarizing a whole run of tool activity ("Explored 2 files,
 * edited 1 file"). The parent re-renders it with a longer tool list as work
 * streams in; the stable element + keyed headline retrigger the fade so the
 * line visibly *updates* in place instead of new rows appearing. Click it to
 * temporarily reveal the per-tool rows underneath.
 */
export function ActivitySummaryLine({
  tools,
  workspaceCwd,
  agentCodenames,
  onOpenFile,
  onOpenAgent
}: {
  tools: ToolCall[];
  workspaceCwd?: string | null;
  agentCodenames?: Map<string, string>;
  onOpenFile?: (path: string, opts?: FileChipOpenOptions) => void;
  onOpenAgent?: (tool: ToolCall) => void;
}): JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const summary = useMemo(() => summarizeToolGroup(tools), [tools]);
  const headline = useMemo(() => splitLeadingVerb(summary.headline), [summary.headline]);
  const changeCounts = useMemo(() => summarizeToolChangeCounts(tools), [tools]);
  const rows = useMemo(() => buildGroupRows(tools), [tools]);
  const previewText =
    !expanded && summary.status === "running" && summary.currentAction
      ? summary.currentAction
      : null;

  return (
    <div
      className="tool-call-group activity-summary-line"
      data-status={summary.status}
      data-has-errors={summary.hasErrors ? "true" : undefined}
      data-expanded={expanded}
    >
      <button
        type="button"
        className="tool-call-group-header"
        aria-expanded={expanded}
        aria-label={`${summary.headline}${previewText ? ": " + previewText : ""}`}
        onClick={() => setExpanded((value) => !value)}
      >
        <span
          key={summary.headline}
          className="tool-call-group-eyebrow activity-summary-headline"
          aria-hidden="true"
        >
          <span className="tool-call-group-eyebrow-label">{headline.verb}</span>
          {headline.rest ? (
            <span className="tool-call-group-eyebrow-detail"> {headline.rest}</span>
          ) : null}
        </span>
        {changeCounts ? <ActivityStat counts={changeCounts} /> : null}
        {previewText ? (
          <span key={previewText} className="tool-call-group-preview" aria-hidden="true">
            {previewText}
          </span>
        ) : null}
        {summary.status === "running" ? (
          <span className="tool-call-group-running" aria-label="running" title="Running">
            <WorkingNest active size={13} />
          </span>
        ) : (
          <ChevronRight size={11} className="tool-call-row-chevron" aria-hidden="true" />
        )}
      </button>
      {expanded ? (
        <div className="tool-call-group-body">
          {rows.map(({ tool, children }, index) => (
            <div
              className="tool-call-group-row"
              key={tool.id}
              style={{ animationDelay: `${Math.min(index, 8) * 28}ms` }}
            >
              <ToolCallRow
                tool={tool}
                workspaceCwd={workspaceCwd ?? null}
                agentCodename={codenameForTool(tool, agentCodenames)}
                onOpenFile={onOpenFile}
                onOpenAgent={onOpenAgent}
              />
              {children.length > 0 ? (
                <div className="tool-call-agent-children">
                  {children.map((child) => (
                    <div className="tool-call-group-row" key={child.id}>
                      <ToolCallRow
                        tool={child}
                        workspaceCwd={workspaceCwd ?? null}
                        onOpenFile={onOpenFile}
                        onOpenAgent={onOpenAgent}
                      />
                    </div>
                  ))}
                </div>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
