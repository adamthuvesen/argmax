import { Loader2 } from "lucide-react";
import { memo, useMemo, useState, type JSX } from "react";
import {
  buildGroupRows,
  summarizeToolGroup,
  type ToolCallGroup
} from "../lib/toolCalls.js";
import type { FileChipOpenOptions } from "./FileChip.js";
import { ToolCallRow } from "./ToolCallRow.js";

type ToolCallGroupBubbleProps = {
  group: ToolCallGroup;
  defaultExpanded?: boolean;
  workspaceCwd?: string | null;
  onOpenFile?: (path: string, opts?: FileChipOpenOptions) => void;
};

type UserToggle = {
  value: boolean;
  defaultExpanded?: boolean;
};

function ToolCallGroupBubbleInner({
  group,
  defaultExpanded,
  workspaceCwd,
  onOpenFile
}: ToolCallGroupBubbleProps): JSX.Element {
  const [userToggle, setUserToggle] = useState<UserToggle | null>(null);
  const summary = useMemo(() => summarizeToolGroup(group.tools), [group.tools]);
  const rows = useMemo(() => buildGroupRows(group.tools), [group.tools]);
  // Collapsed by default to match Codex — the user clicks the chevron to
  // reveal per-tool rows. defaultExpanded (from Settings) overrides. The
  // error case used to auto-expand; that made groups inconsistent (failed
  // groups open, successful groups closed) which read as noisy, so the
  // error state now just colors the chevron + status dot on the header.
  const localExpanded =
    userToggle && userToggle.defaultExpanded === defaultExpanded ? userToggle.value : null;
  const expanded = localExpanded ?? (defaultExpanded ?? false);

  // While collapsed and still running, show the current action ("Read foo.ts")
  // in place of the slash-joined input preview so the user has a live signal.
  const previewText =
    !expanded && summary.status === "running" && summary.currentAction
      ? summary.currentAction
      : summary.preview;

  return (
    <div
      className="tool-call-group"
      data-status={summary.status}
      data-has-errors={summary.hasErrors ? "true" : undefined}
      data-expanded={expanded}
    >
      <button
        className="tool-call-group-header"
        type="button"
        aria-expanded={expanded}
        aria-label={`${summary.headline}${previewText ? ": " + previewText : ""}`}
        onClick={() => setUserToggle({ value: !expanded, defaultExpanded })}
      >
        <span className="tool-call-group-eyebrow" aria-hidden="true">
          <span className="tool-call-group-eyebrow-label">{summary.headline}</span>
        </span>
        {previewText ? (
          <span className="tool-call-group-preview" aria-hidden="true">{previewText}</span>
        ) : null}
        {summary.status === "running" ? (
          <span className="tool-call-group-running" aria-label="running" title="Running">
            <Loader2 size={11} className="tool-call-spinner" aria-hidden="true" />
          </span>
        ) : null}
      </button>
      {expanded ? (
        <div className="tool-call-group-body">
          {rows.map(({ tool, children }, index) => (
            <div
              className="tool-call-group-row"
              key={tool.id}
              style={{ animationDelay: `${Math.min(index, 8) * 28}ms` }}
            >
              <ToolCallRow tool={tool} workspaceCwd={workspaceCwd ?? null} onOpenFile={onOpenFile} />
              {children.length > 0 ? (
                <div className="tool-call-agent-children">
                  {children.map((child, childIndex) => (
                    <div
                      className="tool-call-group-row"
                      key={child.id}
                      style={{ animationDelay: `${Math.min(childIndex, 8) * 28}ms` }}
                    >
                      <ToolCallRow tool={child} workspaceCwd={workspaceCwd ?? null} onOpenFile={onOpenFile} />
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

export const ToolCallGroupBubble = memo(ToolCallGroupBubbleInner, (prev, next) => {
  if (prev.defaultExpanded !== next.defaultExpanded) return false;
  if (prev.workspaceCwd !== next.workspaceCwd) return false;
  if (prev.onOpenFile !== next.onOpenFile) return false;
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
    // parentToolUseId drives sub-agent row grouping — both must be compared.
    if (
      a.id !== b.id ||
      a.status !== b.status ||
      a.completedAt !== b.completedAt ||
      a.inputPreview !== b.inputPreview ||
      a.parentToolUseId !== b.parentToolUseId
    ) {
      return false;
    }
  }
  return true;
});
