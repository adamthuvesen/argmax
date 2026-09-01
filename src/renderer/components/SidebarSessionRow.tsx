import {
  Archive,
  Check,
  CircleEllipsis,
  CircleX,
  ExternalLink,
  GitMerge,
  GitPullRequest,
  ListPlus,
  Palette,
  Pencil,
  Pin,
  PinOff,
  RefreshCw,
  Terminal
} from "lucide-react";
import {
  memo,
  useCallback,
  useEffect,
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
import { useAnchoredPopover, type AnchorPoint } from "../hooks/useAnchoredPopover.js";
import { useDismissOnOutsideOrEscape } from "../hooks/useDismissOnOutsideOrEscape.js";
import { WORKSPACE_DRAG_MIME } from "../lib/gridState.js";
import type { PriorityAttention } from "../lib/priority.js";
import { resolveSessionIcon, resolveSessionIconColor } from "../lib/sessionIcons.js";
import { SessionIconPicker } from "./SessionIconPicker.js";
import { WorkingNest } from "./WorkingNest.js";

// Human phrasing appended to the row title when the row sits in the sidebar's
// Priority section, so screen readers (and tests) hear why it floated up.
const PRIORITY_TITLE: Record<PriorityAttention, string> = {
  "approval-needed": "needs approval",
  blocked: "waiting for input",
  failed: "failed",
  "review-ready": "ready for review"
};

export interface WorkspaceClickModifiers {
  ctrlOrMeta: boolean;
  alt: boolean;
}

type SidebarSessionRowProps = {
  workspace: WorkspaceSummary;
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
  /**
   * Second row line under the label — the owning project's name. Set on rows
   * whose group doesn't already name the project (Priority, Pinned, date
   * view) while the Priority section is enabled.
   */
  subtitle?: string | null;
  /** Provider name shown as a small marker when this session was synced from
   *  that agent's own history rather than started in Argmax. */
  importedProvider?: string | null;
  /** Set when the row renders inside the Priority section: why it floated up. */
  priorityAttention?: PriorityAttention;
  /** Priority rows only — right-click "Done" drops the row back to its group. */
  onRemoveFromPriority?: (workspaceId: string) => void;
  /** Non-priority rows — right-click "Add to priority" floats the row manually. */
  onAddToPriority?: (workspaceId: string) => void;
  /** Right-click "Edit Icon" — both values null clears the custom glyph. */
  onSetIcon?: (workspaceId: string, icon: string | null, iconColor: string | null) => void;
  /** Right-click "Sync now" on an imported row — runs one session-sync sweep
   *  so continuations made in the provider CLI appear immediately. */
  onSyncNow?: () => void;
};


// Leading glyph for a session row, rendered only when the row carries a live
// signal (see statusOverlayFor). A turn in flight takes precedence over
// everything: the marker becomes a nest of four dots cycling out of phase so
// live agent activity reads at a glance, then reverts to the icons below when
// the turn ends. Otherwise a live pull request wins over session state: a
// merged PR shows a violet merge glyph, an open PR a green pull-request glyph.
// With no PR (or a closed one) a failed session shows a red cross.
function StatusMarker({
  state,
  prState,
  priorityAttention,
  phaseKey
}: {
  state: WorkspaceSummary["state"];
  prState?: WorkspaceSummary["prState"];
  priorityAttention?: PriorityAttention;
  phaseKey: string;
}): JSX.Element {
  // In the Priority section an input-starved session outranks everything —
  // the whole point of the row is "the agent is stalled on you". The "…"
  // ring (a typing indicator's idiom: the conversation awaits your reply, no
  // alarm implied) wins even over the working ring, since approvals arrive
  // mid-turn. It keeps the default muted marker color on purpose — the
  // fallback check ring would read "done", but this isn't a warning either.
  if (priorityAttention === "approval-needed" || priorityAttention === "blocked") {
    return <CircleEllipsis size={14} aria-hidden className="status-marker" data-attention={priorityAttention} />;
  }
  if (state === "running") {
    // The shared working nest, sized to the 14px marker box. It is the same mark and
    // motion an agent tab and a sub-agent launch row show while they run.
    return <WorkingNest active className="status-marker" size={14} phaseKey={phaseKey} />;
  }
  if (prState === "MERGED") {
    return <GitMerge size={14} aria-hidden className="status-marker" data-pr="merged" />;
  }
  if (prState === "OPEN") {
    return <GitPullRequest size={14} aria-hidden className="status-marker" data-pr="open" />;
  }
  return <CircleX size={14} aria-hidden className="status-marker" />;
}

/**
 * Which live signal the row has to keep showing, in the same precedence order
 * StatusMarker uses. `null` means the row is calm: a custom icon stands alone,
 * and a row without one shows no leading glyph at all.
 */
type StatusOverlay = "awaiting" | "working" | "pr-merged" | "pr-open" | "failed";

function statusOverlayFor({
  state,
  prState,
  priorityAttention
}: {
  state: WorkspaceSummary["state"];
  prState?: WorkspaceSummary["prState"];
  priorityAttention?: PriorityAttention;
}): StatusOverlay | null {
  if (priorityAttention === "approval-needed" || priorityAttention === "blocked") return "awaiting";
  if (state === "running") return "working";
  if (prState === "MERGED") return "pr-merged";
  if (prState === "OPEN") return "pr-open";
  // "archive-failed" borrows the failed cross: the row survived an archive
  // attempt (a process refused to terminate) and needs a retry.
  return state === "failed" || state === "archive-failed" ? "failed" : null;
}

/**
 * A user-chosen icon replaces the status marker as the row's leading glyph, so
 * live state moves to a small corner dot on the icon. Nothing is lost: the dot
 * carries the same awaiting / failed / PR signal in the same colors. A turn in
 * flight is the exception. The row hands the cell back to StatusMarker's
 * working nest rather than stacking a pulsing dot on the glyph.
 */
function CustomIconMarker({
  icon,
  iconColor,
  overlay
}: {
  icon: string;
  iconColor: string | null | undefined;
  overlay: Exclude<StatusOverlay, "working"> | null;
}): JSX.Element | null {
  const Glyph = resolveSessionIcon(icon);
  if (!Glyph) return null;
  return (
    <span
      className="session-custom-icon"
      data-icon-color={resolveSessionIconColor(iconColor)}
      aria-hidden="true"
    >
      <Glyph size={14} />
      {overlay ? (
        <span className="session-custom-icon-overlay" data-overlay={overlay} />
      ) : null}
    </span>
  );
}

function SidebarSessionRowInner({
  workspace,
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
  subtitle,
  importedProvider,
  priorityAttention,
  onRemoveFromPriority,
  onAddToPriority,
  onSetIcon,
  onSyncNow
}: SidebarSessionRowProps): JSX.Element {
  // Right-click "Open in IDE" → the IDE list replaces the menu at the same
  // point, the way "Edit Icon" hands off to the icon picker.
  const [idePickerPoint, setIdePickerPoint] = useState<AnchorPoint | null>(null);
  const idePicker = useAnchoredPopover({
    open: idePickerPoint !== null,
    gutter: 0,
    capHeight: true
  });
  const { anchorToPoint: anchorIdePicker } = idePicker;
  // Keep direct refs to every menuitem so ↑/↓ keyboard nav can move focus.
  // The map is rebuilt every render from the `detectedIdes` list; reading
  // `current` after layout is fine because the popover only mounts while
  // the picker is open.
  const menuItemRefs = useRef(new Map<string, HTMLButtonElement | null>());
  const closePicker = useCallback((): void => setIdePickerPoint(null), []);
  useDismissOnOutsideOrEscape(idePicker.popoverRef, idePickerPoint !== null, closePicker);

  useEffect(() => {
    anchorIdePicker(idePickerPoint);
  }, [anchorIdePicker, idePickerPoint]);

  // Right-click "Rename" → inline edit. The context menu is portaled at the
  // cursor; committing writes the new label through onRename.
  const [contextMenuPoint, setContextMenuPoint] = useState<AnchorPoint | null>(null);
  const [isEditing, setIsEditing] = useState(false);
  const [draftLabel, setDraftLabel] = useState("");
  const renameInputRef = useRef<HTMLInputElement | null>(null);
  const contextMenu = useAnchoredPopover({
    open: contextMenuPoint !== null,
    gutter: 0,
    capHeight: true
  });
  const { anchorToPoint: anchorContextMenu } = contextMenu;
  const closeContextMenu = (): void => setContextMenuPoint(null);
  useDismissOnOutsideOrEscape(contextMenu.popoverRef, contextMenuPoint !== null, closeContextMenu);

  useEffect(() => {
    anchorContextMenu(contextMenuPoint);
  }, [anchorContextMenu, contextMenuPoint]);

  // Right-click "Edit Icon" → the icon picker replaces the menu at the same
  // point. The picker positions itself against it.
  const [iconPickerPoint, setIconPickerPoint] = useState<AnchorPoint | null>(null);
  const closeIconPicker = useCallback((): void => setIconPickerPoint(null), []);

  // Focus + select the input once it mounts so the user can type immediately.
  useEffect(() => {
    if (isEditing) {
      renameInputRef.current?.focus();
      renameInputRef.current?.select();
    }
  }, [isEditing]);

  // Focus the first menuitem, preferring the current default IDE. The popover
  // mounts in the same render that opens it, so by the time this effect runs
  // its menuitems are in the DOM and the refs are populated.
  useEffect(() => {
    if (idePickerPoint === null) return;
    const preferredId =
      detectedIdes.find((entry) => entry.id === defaultIde)?.id ?? detectedIdes[0]?.id;
    if (!preferredId) return;
    menuItemRefs.current.get(preferredId)?.focus();
  }, [idePickerPoint, detectedIdes, defaultIde]);

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

  const ideDisabled = !hasPath || !hasIdes;
  // Surfaced on the (disabled) menu item so the user learns why it's inert.
  const disabledReason = !hasPath
    ? "Worktree not ready yet"
    : !hasIdes
      ? "No supported IDEs found. Install VS Code, Cursor, Windsurf, or Zed."
      : null;

  const displayLabel = workspace.taskLabel.trim() || workspace.branch || "Untitled session";
  // Surface the PR in the accessible row title so the marker icon has a name —
  // matched on by the sidebar tests and read aloud by screen readers.
  const prTitle =
    workspace.prState === "MERGED" && workspace.prNumber != null
      ? ` — merged pull request #${workspace.prNumber}`
      : workspace.prState === "OPEN" && workspace.prNumber != null
        ? ` — open pull request #${workspace.prNumber}`
        : "";
  const priorityTitle = priorityAttention ? ` — ${PRIORITY_TITLE[priorityAttention]}` : "";
  const title = `${displayLabel} — ${workspace.state}${priorityTitle}${prTitle}${isOpenInGrid ? " — in view" : ""}`;

  // "Sync now" only makes sense on a row imported from a provider store —
  // Argmax-owned sessions have nothing to re-read.
  const canSyncNow = Boolean(onSyncNow && importedProvider);
  const handleContextMenu = (event: ReactMouseEvent): void => {
    event.preventDefault();
    event.stopPropagation();
    setContextMenuPoint({ x: event.clientX, y: event.clientY });
  };

  const startOpenInIde = (): void => {
    const point = contextMenuPoint;
    closeContextMenu();
    if (!point) return;
    setIdePickerPoint(point);
  };

  const startEditIcon = (): void => {
    const point = contextMenuPoint;
    closeContextMenu();
    if (!point) return;
    setIconPickerPoint(point);
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

  // A custom icon replaces the status marker. The remaining live state moves to
  // its overlay dot. While the turn runs the working nest takes the cell back,
  // so the animation stands alone and the icon returns the moment it ends.
  // Without a custom icon, a calm row stays text-only and only a live signal
  // (running, awaiting input, failed, open or merged PR) earns a glyph. The
  // marker column stays reserved either way so every title lines up.
  const statusOverlay = statusOverlayFor({
    state: workspace.state,
    prState: workspace.prState,
    priorityAttention
  });
  const leadingGlyph =
    workspace.icon && statusOverlay !== "working" ? (
      <CustomIconMarker
        icon={workspace.icon}
        iconColor={workspace.iconColor}
        overlay={statusOverlay}
      />
    ) : statusOverlay ? (
      <StatusMarker
        state={workspace.state}
        prState={workspace.prState}
        priorityAttention={priorityAttention}
        phaseKey={workspace.id}
      />
    ) : null;

  return (
    // The workspace id is on the row so ⌘1..9 can read the on-screen order
    // straight off the list (lib/sidebarOrder.ts).
    <div className="session-row" data-workspace-id={workspace.id}>
      {isEditing ? (
        // The row keeps its glyph, layout, and subtitle; only the title text
        // swaps for an unboxed input, so renaming edits the label in place
        // instead of replacing the row with a form field.
        <div
          className={`session-link session-link-renaming${subtitle ? " session-link-stacked" : ""}`}
          data-status={workspace.state}
        >
          {leadingGlyph ?? <span className="session-link-lead-spacer" aria-hidden="true" />}
          <span className={subtitle ? "session-link-text" : undefined}>
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
            {subtitle ? <span className="session-link-subtitle">{subtitle}</span> : null}
          </span>
        </div>
      ) : (
        <>
          <button
            aria-current={isSelected ? "true" : undefined}
            className={`session-link${isSelected ? " active" : ""}${subtitle || importedProvider ? " session-link-stacked" : ""}`}
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
            {leadingGlyph ?? <span className="session-link-lead-spacer" aria-hidden="true" />}
            {subtitle || importedProvider ? (
              <span className="session-link-text">
                <span>{displayLabel}</span>
                <span className="session-link-subtitle">
                  {subtitle}
                  {importedProvider ? (
                    <span className="session-imported-badge" title={`Synced from ${importedProvider}`}>
                      {importedProvider}
                    </span>
                  ) : null}
                </span>
              </span>
            ) : (
              <span>{displayLabel}</span>
            )}
          </button>
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
      {contextMenuPoint
        ? createPortal(
            <ul
              ref={contextMenu.setPopover}
              className="project-picker-popover session-context-menu"
              role="menu"
              aria-label="Session actions"
              style={contextMenu.floatingStyles}
            >
              {onRename ? (
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
              ) : null}
              {onSetIcon ? (
                <li role="none">
                  <button
                    type="button"
                    role="menuitem"
                    className="project-picker-item"
                    onClick={(event) => {
                      event.stopPropagation();
                      startEditIcon();
                    }}
                  >
                    <Palette size={13} aria-hidden="true" />
                    Edit Icon
                  </button>
                </li>
              ) : null}
              <li role="none">
                <button
                  type="button"
                  role="menuitem"
                  className="project-picker-item"
                  disabled={ideDisabled}
                  title={disabledReason ?? undefined}
                  onClick={(event) => {
                    event.stopPropagation();
                    startOpenInIde();
                  }}
                >
                  <ExternalLink size={13} aria-hidden="true" />
                  Open in IDE
                </button>
              </li>
              {canSyncNow && onSyncNow ? (
                <li role="none">
                  <button
                    type="button"
                    role="menuitem"
                    className="project-picker-item"
                    onClick={(event) => {
                      event.stopPropagation();
                      closeContextMenu();
                      onSyncNow();
                    }}
                  >
                    <RefreshCw size={13} aria-hidden="true" />
                    Sync now
                  </button>
                </li>
              ) : null}
              {/* After Rename, which keeps its long-standing first slot — a
                  mis-click here moves the row immediately. */}
              {onRemoveFromPriority ? (
                <li role="none">
                  <button
                    type="button"
                    role="menuitem"
                    className="project-picker-item"
                    onClick={(event) => {
                      event.stopPropagation();
                      closeContextMenu();
                      onRemoveFromPriority(workspace.id);
                    }}
                  >
                    <Check size={13} aria-hidden="true" />
                    Done
                  </button>
                </li>
              ) : null}
              {onAddToPriority ? (
                <li role="none">
                  <button
                    type="button"
                    role="menuitem"
                    className="project-picker-item"
                    onClick={(event) => {
                      event.stopPropagation();
                      closeContextMenu();
                      onAddToPriority(workspace.id);
                    }}
                  >
                    <ListPlus size={13} aria-hidden="true" />
                    Add to priority
                  </button>
                </li>
              ) : null}
            </ul>,
            document.body
          )
        : null}
      {idePickerPoint
        ? createPortal(
            <ul
              ref={idePicker.setPopover}
              className="project-picker-popover session-ide-popover"
              role="menu"
              aria-label="Open this worktree in"
              style={idePicker.floatingStyles}
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
                        closePicker();
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
          )
        : null}
      {iconPickerPoint && onSetIcon
        ? createPortal(
            <SessionIconPicker
              icon={workspace.icon ?? null}
              iconColor={workspace.iconColor ?? null}
              anchorPoint={iconPickerPoint}
              onApply={(icon, iconColor) => onSetIcon(workspace.id, icon, iconColor)}
              onClose={closeIconPicker}
            />,
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
  if (prev.defaultIde !== next.defaultIde) return false;
  if (prev.detectedIdes !== next.detectedIdes) return false;
  if (prev.onOpenWorkspaceChat !== next.onOpenWorkspaceChat) return false;
  if (prev.onArchiveWorkspace !== next.onArchiveWorkspace) return false;
  if (prev.onOpenInIde !== next.onOpenInIde) return false;
  if (prev.onTogglePin !== next.onTogglePin) return false;
  if (prev.onRename !== next.onRename) return false;
  if (prev.onWorkspaceDragStart !== next.onWorkspaceDragStart) return false;
  if (prev.onWorkspaceDragEnd !== next.onWorkspaceDragEnd) return false;
  if (prev.subtitle !== next.subtitle) return false;
  if (prev.importedProvider !== next.importedProvider) return false;
  if (prev.priorityAttention !== next.priorityAttention) return false;
  if (prev.onRemoveFromPriority !== next.onRemoveFromPriority) return false;
  if (prev.onAddToPriority !== next.onAddToPriority) return false;
  if (prev.onSetIcon !== next.onSetIcon) return false;
  if (prev.onSyncNow !== next.onSyncNow) return false;
  const pw = prev.workspace;
  const nw = next.workspace;
  if (pw === nw) {
    // Reference equality short-circuit — happens when Sidebar's memo skips
    // recomputing the workspace array slice. Skip the per-field compare.
  } else if (
    pw.id !== nw.id ||
    pw.state !== nw.state ||
    pw.taskLabel !== nw.taskLabel ||
    pw.branch !== nw.branch ||
    pw.path !== nw.path ||
    pw.lastActivityAt !== nw.lastActivityAt ||
    pw.pinned !== nw.pinned ||
    pw.prState !== nw.prState ||
    pw.prNumber !== nw.prNumber ||
    pw.icon !== nw.icon ||
    pw.iconColor !== nw.iconColor
  ) {
    return false;
  }
  return true;
}

export const SidebarSessionRow = memo(SidebarSessionRowInner, sidebarSessionRowEqual);
