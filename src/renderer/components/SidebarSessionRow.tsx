import { Archive, ChevronDown, ExternalLink, Pin, PinOff, Terminal } from "lucide-react";
import {
  memo,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
  type MouseEvent as ReactMouseEvent
} from "react";
import { createPortal } from "react-dom";
import type { DetectedIde, IdeId, WorkspaceSummary } from "../../shared/types.js";
import { formatTokens } from "../formatTokens.js";
import { useDismissOnOutsideOrEscape } from "../hooks/useDismissOnOutsideOrEscape.js";

export interface WorkspaceTokenBreakdown {
  input: number;
  output: number;
  cached: number;
}

type SidebarSessionRowProps = {
  workspace: WorkspaceSummary;
  workspaceTokens: WorkspaceTokenBreakdown | null;
  isSelected: boolean;
  onOpenWorkspaceChat: (workspaceId: string) => void;
  onArchiveWorkspace: (workspaceId: string) => void;
  onOpenInIde: (workspaceId: string, ide: IdeId, options?: { pinAsDefault?: boolean }) => void;
  onTogglePin?: (workspaceId: string, pinned: boolean) => void;
  detectedIdes: DetectedIde[];
  defaultIde: IdeId | null;
  showTokens: boolean;
};

function SidebarSessionRowInner({
  workspace,
  workspaceTokens,
  isSelected,
  onOpenWorkspaceChat,
  onArchiveWorkspace,
  onOpenInIde,
  onTogglePin,
  detectedIdes,
  defaultIde,
  showTokens
}: SidebarSessionRowProps): JSX.Element {
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
      </button>
      {showTokens ? (() => {
        const inputOutput = (workspaceTokens?.input ?? 0) + (workspaceTokens?.output ?? 0);
        const display = formatTokens(inputOutput);
        const cached = workspaceTokens?.cached ?? 0;
        const tooltip = workspaceTokens
          ? `Tokens so far — ${formatTokens(workspaceTokens.input)} in · ${formatTokens(workspaceTokens.output)} out${cached > 0 ? ` · ${formatTokens(cached)} cached` : ""}`
          : "No tokens recorded yet";
        return (
          <span
            className="session-tokens"
            aria-label={`Tokens: ${display}`}
            title={tooltip}
            data-zero={inputOutput === 0 ? "true" : undefined}
          >
            {display}
          </span>
        );
      })() : null}
      <div className="session-ide-cluster" ref={pickerRef}>
        <button
          className="session-row-action session-ide-btn"
          aria-label="Open in IDE"
          title={ideButtonTitle}
          type="button"
          disabled={buttonDisabled || !effectiveDefault}
          onClick={handlePrimaryClick}
        >
          <ExternalLink size={11} />
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
          <ChevronDown size={11} />
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
          {workspace.pinned ? <PinOff size={11} /> : <Pin size={11} />}
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
          <Archive size={11} />
        </button>
      )}
    </div>
  );
}

// Memoize on the per-row fields that actually affect rendering. The parent
// (Sidebar) re-creates a new `workspace` object on every `dashboard:delta`
// even when nothing on the row changed; without this comparator each row
// would re-render on every token tick (ralph C1).
//
// Callback identities (onOpenWorkspaceChat, etc.) flow from App.tsx via
// useCallback so === holds across renders unless the dep list shifts.
// `detectedIdes` and `defaultIde` are state values in App that only
// change when discovery runs, so === also holds during normal use.
// eslint-disable-next-line react-refresh/only-export-components
export function sidebarSessionRowEqual(
  prev: SidebarSessionRowProps,
  next: SidebarSessionRowProps
): boolean {
  if (prev.isSelected !== next.isSelected) return false;
  if (prev.showTokens !== next.showTokens) return false;
  if (prev.defaultIde !== next.defaultIde) return false;
  if (prev.detectedIdes !== next.detectedIdes) return false;
  if (prev.onOpenWorkspaceChat !== next.onOpenWorkspaceChat) return false;
  if (prev.onArchiveWorkspace !== next.onArchiveWorkspace) return false;
  if (prev.onOpenInIde !== next.onOpenInIde) return false;
  if (prev.onTogglePin !== next.onTogglePin) return false;
  const pw = prev.workspace;
  const nw = next.workspace;
  if (pw === nw) {
    // Reference equality short-circuit — happens when Sidebar's memo skips
    // recomputing the workspace array slice. Skip the per-field compare.
  } else if (
    pw.id !== nw.id ||
    pw.state !== nw.state ||
    pw.taskLabel !== nw.taskLabel ||
    pw.path !== nw.path ||
    pw.lastActivityAt !== nw.lastActivityAt ||
    pw.pinned !== nw.pinned
  ) {
    return false;
  }
  const pt = prev.workspaceTokens;
  const nt = next.workspaceTokens;
  if (pt === nt) return true;
  if (pt === null || nt === null) return false;
  return pt.input === nt.input && pt.output === nt.output && pt.cached === nt.cached;
}

export const SidebarSessionRow = memo(SidebarSessionRowInner, sidebarSessionRowEqual);
