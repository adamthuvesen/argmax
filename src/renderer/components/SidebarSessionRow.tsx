import { Archive, ChevronDown, ExternalLink, Pin, PinOff, Terminal } from "lucide-react";
import {
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
  type MouseEvent as ReactMouseEvent
} from "react";
import { createPortal } from "react-dom";
import type { DetectedIde, IdeId, WorkspaceSummary } from "../../shared/types.js";
import { formatCostUsd } from "../formatCost.js";
import { formatElapsed } from "../formatElapsed.js";
import { useDismissOnOutsideOrEscape } from "../hooks/useDismissOnOutsideOrEscape.js";

export function SidebarSessionRow({
  workspace,
  workspaceCost,
  isSelected,
  now,
  onOpenWorkspaceChat,
  onArchiveWorkspace,
  onOpenInIde,
  onTogglePin,
  detectedIdes,
  defaultIde
}: {
  workspace: WorkspaceSummary;
  workspaceCost: number;
  isSelected: boolean;
  now?: number;
  onOpenWorkspaceChat: (workspaceId: string) => void;
  onArchiveWorkspace: (workspaceId: string) => void;
  onOpenInIde: (workspaceId: string, ide: IdeId, options?: { pinAsDefault?: boolean }) => void;
  onTogglePin?: (workspaceId: string, pinned: boolean) => void;
  detectedIdes: DetectedIde[];
  defaultIde: IdeId | null;
}): JSX.Element {
  const [pickerOpen, setPickerOpen] = useState(false);
  const [popoverPos, setPopoverPos] = useState<{ top: number; right: number } | null>(null);
  const pickerRef = useRef<HTMLDivElement | null>(null);
  const popoverRef = useRef<HTMLUListElement | null>(null);
  useDismissOnOutsideOrEscape(pickerRef, pickerOpen, () => setPickerOpen(false), popoverRef);

  useLayoutEffect(() => {
    if (!pickerOpen) {
      setPopoverPos(null);
      return;
    }
    const cluster = pickerRef.current;
    if (!cluster) return;
    const rect = cluster.getBoundingClientRect();
    setPopoverPos({
      top: rect.bottom + 6,
      right: Math.max(8, window.innerWidth - rect.right)
    });
  }, [pickerOpen]);

  const showArchive =
    workspace.state === "complete" ||
    workspace.state === "failed" ||
    workspace.state === "cancelled" ||
    workspace.state === "kept";

  const hasPath = Boolean(workspace.path);
  const guiIdes = useMemo(
    () => detectedIdes.filter((entry) => entry.id !== "terminal" && entry.id !== "iterm"),
    [detectedIdes]
  );
  const hasIdes = detectedIdes.length > 0;
  const effectiveDefault: IdeId | null =
    defaultIde && detectedIdes.some((entry) => entry.id === defaultIde)
      ? defaultIde
      : guiIdes.length === 1 && guiIdes[0]
        ? guiIdes[0].id
        : null;

  const buttonDisabled = !hasPath || !hasIdes;
  const lastActivityMs = workspace.lastActivityAt ? Date.parse(workspace.lastActivityAt) : NaN;
  const elapsedLabel = Number.isFinite(lastActivityMs) && now
    ? formatElapsed(Math.max(0, now - lastActivityMs))
    : null;
  const ideButtonTitle = !hasPath
    ? "Worktree not ready yet"
    : !hasIdes
      ? "No supported IDEs found. Install VS Code, Cursor, Windsurf, or Zed."
      : effectiveDefault
        ? `Open in ${detectedIdes.find((e) => e.id === effectiveDefault)?.label ?? effectiveDefault}`
        : "Open in IDE";

  const handlePrimaryClick = (event: ReactMouseEvent): void => {
    event.stopPropagation();
    if (buttonDisabled || !effectiveDefault) return;
    onOpenInIde(workspace.id, effectiveDefault, {
      pinAsDefault: defaultIde === null
    });
  };

  const handleChevronClick = (event: ReactMouseEvent): void => {
    event.stopPropagation();
    if (buttonDisabled) return;
    setPickerOpen((open) => !open);
  };

  return (
    <div className="session-row">
      <button
        aria-pressed={isSelected}
        className={isSelected ? "session-link active" : "session-link"}
        data-status={workspace.state}
        type="button"
        title={`${workspace.taskLabel} — ${workspace.state}`}
        onClick={() => onOpenWorkspaceChat(workspace.id)}
      >
        <span className="status-dot" aria-hidden="true" />
        <span>{workspace.taskLabel}</span>
        {elapsedLabel ? (
          <span
            className="session-row-elapsed"
            aria-hidden="true"
            title={`Last activity ${elapsedLabel} ago`}
          >
            {elapsedLabel}
          </span>
        ) : null}
      </button>
      <span
        className="session-cost"
        aria-label={`Cost: ${formatCostUsd(workspaceCost)}`}
        title={`Session cost so far: ${formatCostUsd(workspaceCost)}`}
        data-zero={workspaceCost === 0 ? "true" : undefined}
      >
        {formatCostUsd(workspaceCost)}
      </span>
      <div className="session-ide-cluster" ref={pickerRef}>
        <button
          className="session-row-action session-ide-btn"
          aria-label="Open in IDE"
          title={ideButtonTitle}
          type="button"
          disabled={buttonDisabled || !effectiveDefault}
          onClick={handlePrimaryClick}
        >
          <ExternalLink size={12} />
        </button>
        <button
          className="session-row-action session-ide-chevron"
          aria-label="Choose IDE"
          aria-haspopup="menu"
          aria-expanded={pickerOpen}
          title="Choose IDE"
          type="button"
          disabled={buttonDisabled}
          onClick={handleChevronClick}
        >
          <ChevronDown size={12} />
        </button>
        {pickerOpen && popoverPos && createPortal(
          <ul
            ref={popoverRef}
            className="project-picker-popover session-ide-popover"
            role="menu"
            aria-label="Open this worktree in"
            style={{
              position: "fixed",
              top: popoverPos.top,
              right: popoverPos.right,
              left: "auto",
              bottom: "auto"
            }}
          >
            {detectedIdes.map((entry) => {
              const isShell = entry.id === "terminal" || entry.id === "iterm";
              return (
                <li key={entry.id} role="none">
                  <button
                    type="button"
                    className="project-picker-item"
                    role="menuitem"
                    aria-pressed={effectiveDefault === entry.id}
                    onClick={(event) => {
                      event.stopPropagation();
                      setPickerOpen(false);
                      onOpenInIde(workspace.id, entry.id, {
                        pinAsDefault: defaultIde === null && effectiveDefault === null
                      });
                    }}
                  >
                    {isShell ? <Terminal size={13} aria-hidden="true" /> : <ExternalLink size={13} aria-hidden="true" />}
                    {entry.label}
                  </button>
                </li>
              );
            })}
          </ul>,
          document.body
        )}
      </div>
      {onTogglePin ? (
        <button
          className="session-row-action session-pin-btn"
          title={workspace.pinned ? "Unpin session" : "Pin session"}
          aria-label={workspace.pinned ? "Unpin session" : "Pin session"}
          aria-pressed={workspace.pinned}
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onTogglePin(workspace.id, !workspace.pinned);
          }}
        >
          {workspace.pinned ? <PinOff size={12} /> : <Pin size={12} />}
        </button>
      ) : null}
      {showArchive && (
        <button
          className="session-archive-btn"
          title="Archive session"
          aria-label="Archive session"
          type="button"
          onClick={(e) => { e.stopPropagation(); onArchiveWorkspace(workspace.id); }}
        >
          <Archive size={12} />
        </button>
      )}
    </div>
  );
}
