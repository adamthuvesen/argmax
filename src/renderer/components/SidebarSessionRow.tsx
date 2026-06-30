import {
  Archive,
  CircleCheck,
  CircleX,
  ExternalLink,
  GitMerge,
  GitPullRequest,
  Pencil,
  Pin,
  PinOff,
  Terminal
} from "lucide-react";
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
  onRename?: (workspaceId: string, taskLabel: string) => void;
  onWorkspaceDragStart?: (workspaceId: string) => void;
  onWorkspaceDragEnd?: () => void;
  detectedIdes: DetectedIde[];
  defaultIde: IdeId | null;
  showTokens: boolean;
};

// Leading glyph for a session row. A live pull request takes precedence over
// session state: a merged PR shows a violet merge glyph, an open PR a green
// pull-request glyph. With no PR (or a closed one) it falls back to a red cross
// when the session failed and a calm check ring otherwise.
function StatusMarker({
  state,
  prState
}: {
  state: WorkspaceSummary["state"];
  prState?: WorkspaceSummary["prState"];
}): JSX.Element {
  if (prState === "MERGED") {
    return <GitMerge size={14} aria-hidden className="status-marker" data-pr="merged" />;
  }
  if (prState === "OPEN") {
    return <GitPullRequest size={14} aria-hidden className="status-marker" data-pr="open" />;
  }
  const props = { size: 14, "aria-hidden": true, className: "status-marker" } as const;
  return state === "failed" ? <CircleX {...props} /> : <CircleCheck {...props} />;
}

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
  onRename,
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

  // Right-click "Rename" → inline edit. The context menu is portaled at the
  // cursor; committing writes the new label through onRename.
  const [contextMenuPos, setContextMenuPos] = useState<{ top: number; left: number } | null>(null);
  const [isEditing, setIsEditing] = useState(false);
  const [draftLabel, setDraftLabel] = useState("");
  const contextMenuRef = useRef<HTMLUListElement | null>(null);
  const renameInputRef = useRef<HTMLInputElement | null>(null);
  const closeContextMenu = (): void => setContextMenuPos(null);
  useDismissOnOutsideOrEscape(contextMenuRef, contextMenuPos !== null, closeContextMenu);

  // Focus + select the input once it mounts so the user can type immediately.
  useEffect(() => {
    if (isEditing) {
      renameInputRef.current?.focus();
      renameInputRef.current?.select();
    }
  }, [isEditing]);

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
  // Surface the PR in the accessible row title so the marker icon has a name —
  // matched on by the sidebar tests and read aloud by screen readers.
  const prTitle =
    workspace.prState === "MERGED" && workspace.prNumber != null
      ? ` — merged pull request #${workspace.prNumber}`
      : workspace.prState === "OPEN" && workspace.prNumber != null
        ? ` — open pull request #${workspace.prNumber}`
        : "";
  const title = `${displayLabel} — ${workspace.state}${prTitle}${isOpenInGrid ? " — in view" : ""}`;

  const handleContextMenu = (event: ReactMouseEvent): void => {
    if (!onRename) return;
    event.preventDefault();
    event.stopPropagation();
    // Clamp to the viewport so a right-click near the bottom/right edge doesn't
    // push the menu off-screen. Sizes are the popover's min-width plus a small
    // single-item height estimate.
    const MENU_WIDTH = 150;
    const MENU_HEIGHT = 44;
    const left = Math.min(event.clientX, Math.max(8, window.innerWidth - MENU_WIDTH));
    const top = Math.min(event.clientY, Math.max(8, window.innerHeight - MENU_HEIGHT));
    setContextMenuPos({ top, left });
  };

  const startRename = (): void => {
    closeContextMenu();
    setDraftLabel(workspace.taskLabel.trim() || workspace.branch || "");
    setIsEditing(true);
  };

  const commitRename = (): void => {
    if (!isEditing) return;
    setIsEditing(false);
    const next = draftLabel.trim();
    // Skip empty or unchanged values — the label column is NOT NULL and the
    // backend rejects blanks anyway.
    if (next && next !== workspace.taskLabel.trim()) {
      onRename?.(workspace.id, next);
    }
  };

  const cancelRename = (): void => {
    setIsEditing(false);
  };

  const handleRenameKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>): void => {
    if (event.key === "Enter") {
      event.preventDefault();
      commitRename();
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      cancelRename();
    }
  };

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
      {isEditing ? (
        <input
          ref={renameInputRef}
          className="session-rename-input"
          value={draftLabel}
          aria-label="Rename session"
          maxLength={200}
          onChange={(event) => setDraftLabel(event.target.value)}
          onKeyDown={handleRenameKeyDown}
          onBlur={commitRename}
        />
      ) : (
        <>
          <button
            aria-current={isSelected ? "true" : undefined}
            className={isSelected ? "session-link active" : "session-link"}
            data-open={isOpenInGrid ? "true" : undefined}
            data-status={workspace.state}
            type="button"
            title={title}
            draggable={canDragToGrid}
            onKeyDown={handleSessionLinkKeyDown}
            onContextMenu={handleContextMenu}
            onClick={(event) =>
              onOpenWorkspaceChat(workspace.id, {
                ctrlOrMeta: event.metaKey || event.ctrlKey,
                alt: event.altKey
              })
            }
            onDragStart={handleWorkspaceDragStart}
            onDragEnd={handleWorkspaceDragEnd}
          >
            <StatusMarker state={workspace.state} prState={workspace.prState} />
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
          className="session-row-action session-ide-open"
          aria-label="Choose IDE"
          aria-haspopup="menu"
          aria-expanded={pickerOpen}
          title={disabledReason ?? "Choose IDE"}
          type="button"
          disabled={buttonDisabled}
          onClick={handleChevronClick}
        >
          <ExternalLink size={12} />
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
        </>
      )}
      {contextMenuPos && onRename
        ? createPortal(
            <ul
              ref={contextMenuRef}
              className="project-picker-popover session-context-menu"
              role="menu"
              aria-label="Session actions"
              style={{
                position: "fixed",
                top: contextMenuPos.top,
                left: contextMenuPos.left,
                right: "auto",
                bottom: "auto"
              }}
            >
              <li role="none">
                <button
                  type="button"
                  role="menuitem"
                  className="project-picker-item"
                  onClick={(event) => {
                    event.stopPropagation();
                    startRename();
                  }}
                >
                  <Pencil size={13} aria-hidden="true" />
                  Rename
                </button>
              </li>
            </ul>,
            document.body
          )
        : null}
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
  if (prev.onRename !== next.onRename) return false;
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
    pw.pinned !== nw.pinned ||
    pw.prState !== nw.prState ||
    pw.prNumber !== nw.prNumber
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
