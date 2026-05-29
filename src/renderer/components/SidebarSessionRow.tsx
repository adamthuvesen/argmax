import { Archive, ChevronDown, ExternalLink, Pin, PinOff, Terminal } from "lucide-react";
import {
  memo,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent as ReactDragEvent,
  type JSX,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent
} from "react";
import { createPortal } from "react-dom";
import type { DetectedIde, IdeId, WorkspaceSummary } from "../../shared/types.js";
import { formatTokens } from "../formatTokens.js";
import { useDismissOnOutsideOrEscape } from "../hooks/useDismissOnOutsideOrEscape.js";
import { WORKSPACE_DRAG_MIME } from "../lib/gridState.js";

export interface WorkspaceTokenBreakdown {
  input: number;
  output: number;
  cached: number;
}

export interface WorkspaceClickModifiers {
  ctrlOrMeta: boolean;
  alt: boolean;
}

type SidebarSessionRowProps = {
  workspace: WorkspaceSummary;
  workspaceTokens: WorkspaceTokenBreakdown | null;
  isSelected: boolean;
  isOpenInGrid: boolean;
  canDragToGrid: boolean;
  onOpenWorkspaceChat: (workspaceId: string, modifiers: WorkspaceClickModifiers) => void;
  onArchiveWorkspace: (workspaceId: string) => void;
  onOpenInIde: (workspaceId: string, ide: IdeId, options?: { pinAsDefault?: boolean }) => void;
  onTogglePin?: (workspaceId: string, pinned: boolean) => void;
  onWorkspaceDragStart?: (workspaceId: string) => void;
  onWorkspaceDragEnd?: () => void;
  detectedIdes: DetectedIde[];
  defaultIde: IdeId | null;
  showTokens: boolean;
};

function SidebarSessionRowInner({
  workspace,
  workspaceTokens,
  isSelected,
  isOpenInGrid,
  canDragToGrid,
  onOpenWorkspaceChat,
  onArchiveWorkspace,
  onOpenInIde,
  onTogglePin,
  onWorkspaceDragStart,
  onWorkspaceDragEnd,
  detectedIdes,
  defaultIde,
  showTokens
}: SidebarSessionRowProps): JSX.Element {
  const [pickerOpen, setPickerOpen] = useState(false);
  const [popoverPos, setPopoverPos] = useState<{ top: number; right: number } | null>(null);
  const pickerRef = useRef<HTMLDivElement | null>(null);
  const popoverRef = useRef<HTMLUListElement | null>(null);
  // Keep direct refs to every menuitem so ↑/↓ keyboard nav can move focus.
  // The map is rebuilt every render from the `detectedIdes` list; reading
  // `current` after layout is fine because the popover only mounts when
  // `pickerOpen && popoverPos`.
  const menuItemRefs = useRef(new Map<string, HTMLButtonElement | null>());
  useDismissOnOutsideOrEscape(pickerRef, pickerOpen, () => setPickerOpen(false), popoverRef);

  // Focus the first menuitem (preferring the current default IDE) once the
  // popover has been positioned and its menuitems have mounted into the DOM.
  // The useLayoutEffect that sets popoverPos triggers a second render — this
  // effect runs after that render commits, so the refs are populated.
  useEffect(() => {
    if (!pickerOpen || !popoverPos) return;
    const preferredId =
      detectedIdes.find((entry) => entry.id === defaultIde)?.id ?? detectedIdes[0]?.id;
    if (!preferredId) return;
    menuItemRefs.current.get(preferredId)?.focus();
  }, [pickerOpen, popoverPos, detectedIdes, defaultIde]);

  const handleMenuKeyDown = (
    entryId: IdeId
  ) => (event: ReactKeyboardEvent<HTMLButtonElement>): void => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp" && event.key !== "Home" && event.key !== "End") {
      return;
    }
    event.preventDefault();
    const ids = detectedIdes.map((entry) => entry.id);
    const currentIndex = ids.indexOf(entryId);
    let nextIndex = currentIndex;
    if (event.key === "ArrowDown") {
      nextIndex = (currentIndex + 1) % ids.length;
    } else if (event.key === "ArrowUp") {
      nextIndex = (currentIndex - 1 + ids.length) % ids.length;
    } else if (event.key === "Home") {
      nextIndex = 0;
    } else if (event.key === "End") {
      nextIndex = ids.length - 1;
    }
    const nextId = ids[nextIndex];
    if (!nextId) return;
    menuItemRefs.current.get(nextId)?.focus();
  };

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
  // Surfaced on the (disabled) chooser so the user learns why it's inert.
  const disabledReason = !hasPath
    ? "Worktree not ready yet"
    : !hasIdes
      ? "No supported IDEs found. Install VS Code, Cursor, Windsurf, or Zed."
      : null;

  const handleChevronClick = (event: ReactMouseEvent): void => {
    event.stopPropagation();
    if (buttonDisabled) return;
    setPickerOpen((open) => !open);
  };

  const displayLabel = workspace.taskLabel.trim() || workspace.branch || "Untitled session";
  const title = `${displayLabel} — ${workspace.state}${isOpenInGrid ? " — in view" : ""}`;

  const handleWorkspaceDragStart = (event: ReactDragEvent<HTMLButtonElement>): void => {
    event.stopPropagation();
    if (!canDragToGrid) {
      event.preventDefault();
      return;
    }
    event.dataTransfer.setData(WORKSPACE_DRAG_MIME, workspace.id);
    event.dataTransfer.effectAllowed = "copyMove";
    // Use the row button itself as the drag image so the OS preview shows
    // the workspace label instead of the default button rendering with
    // its sibling action chrome stripped.
    if (event.currentTarget instanceof HTMLElement) {
      const rect = event.currentTarget.getBoundingClientRect();
      event.dataTransfer.setDragImage(
        event.currentTarget,
        Math.max(0, event.clientX - rect.left),
        Math.max(0, event.clientY - rect.top)
      );
    }
    onWorkspaceDragStart?.(workspace.id);
  };

  const handleWorkspaceDragEnd = (event: ReactDragEvent<HTMLButtonElement>): void => {
    event.stopPropagation();
    onWorkspaceDragEnd?.();
  };

  const handleSessionLinkKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>): void => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp" && event.key !== "Home" && event.key !== "End") {
      return;
    }
    event.preventDefault();
    // Walk the live DOM rather than threading focus state through the
    // parent. ".session-link" is the per-row button across every project
    // group; ordering follows visual order. Hidden (collapsed-project) rows
    // are not in the DOM so they're naturally skipped.
    const allLinks = Array.from(
      document.querySelectorAll<HTMLButtonElement>(".session-link")
    );
    const currentIndex = allLinks.indexOf(event.currentTarget);
    if (currentIndex === -1 || allLinks.length === 0) return;
    let nextIndex = currentIndex;
    if (event.key === "ArrowDown") {
      nextIndex = Math.min(currentIndex + 1, allLinks.length - 1);
    } else if (event.key === "ArrowUp") {
      nextIndex = Math.max(currentIndex - 1, 0);
    } else if (event.key === "Home") {
      nextIndex = 0;
    } else if (event.key === "End") {
      nextIndex = allLinks.length - 1;
    }
    allLinks[nextIndex]?.focus();
  };

  return (
    <div className="session-row">
      <button
        aria-current={isSelected ? "true" : undefined}
        className={isSelected ? "session-link active" : "session-link"}
        data-open={isOpenInGrid ? "true" : undefined}
        data-status={workspace.state}
        type="button"
        title={title}
        draggable={canDragToGrid}
        onKeyDown={handleSessionLinkKeyDown}
        onClick={(event) =>
          onOpenWorkspaceChat(workspace.id, {
            ctrlOrMeta: event.metaKey || event.ctrlKey,
            alt: event.altKey
          })
        }
        onDragStart={handleWorkspaceDragStart}
        onDragEnd={handleWorkspaceDragEnd}
      >
        <span className="status-dot" aria-hidden="true" />
        <span>{displayLabel}</span>
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
          className="session-row-action session-ide-chevron"
          aria-label="Choose IDE"
          aria-haspopup="menu"
          aria-expanded={pickerOpen}
          title={disabledReason ?? "Choose IDE"}
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
                    ref={(node) => {
                      if (node === null) {
                        menuItemRefs.current.delete(entry.id);
                      } else {
                        menuItemRefs.current.set(entry.id, node);
                      }
                    }}
                    type="button"
                    className="project-picker-item"
                    role="menuitem"
                    aria-pressed={effectiveDefault === entry.id}
                    onKeyDown={handleMenuKeyDown(entry.id)}
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
  if (prev.isOpenInGrid !== next.isOpenInGrid) return false;
  if (prev.canDragToGrid !== next.canDragToGrid) return false;
  if (prev.showTokens !== next.showTokens) return false;
  if (prev.defaultIde !== next.defaultIde) return false;
  if (prev.detectedIdes !== next.detectedIdes) return false;
  if (prev.onOpenWorkspaceChat !== next.onOpenWorkspaceChat) return false;
  if (prev.onArchiveWorkspace !== next.onArchiveWorkspace) return false;
  if (prev.onOpenInIde !== next.onOpenInIde) return false;
  if (prev.onTogglePin !== next.onTogglePin) return false;
  if (prev.onWorkspaceDragStart !== next.onWorkspaceDragStart) return false;
  if (prev.onWorkspaceDragEnd !== next.onWorkspaceDragEnd) return false;
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
