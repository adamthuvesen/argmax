import {
  Archive,
  CircleEllipsis,
  CircleX,
  ExternalLink,
  GitMerge,
  GitPullRequest,
  ListChecks,
  ListPlus,
  Palette,
  Pencil,
  Pin,
  PinOff,
  Terminal
} from "lucide-react";
import {
  memo,
  useCallback,
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
import type { PriorityAttention } from "../lib/priority.js";
import { resolveSessionIcon, resolveSessionIconColor } from "../lib/sessionIcons.js";
import {
  SESSION_ICON_PICKER_HEIGHT,
  SESSION_ICON_PICKER_WIDTH,
  SessionIconPicker
} from "./SessionIconPicker.js";
import { WorkingNest } from "./WorkingNest.js";

// Human phrasing appended to the row title when the row sits in the sidebar's
// Priority section, so screen readers (and tests) hear why it floated up.
const PRIORITY_TITLE: Record<PriorityAttention, string> = {
  "approval-needed": "needs approval",
  blocked: "waiting for input",
  failed: "failed",
  "review-ready": "ready for review"
};

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
  /**
   * Second row line under the label — the owning project's name. Set on rows
   * whose group doesn't already name the project (Priority, Pinned, date
   * view) while the Priority section is enabled.
   */
  subtitle?: string | null;
  /** Set when the row renders inside the Priority section: why it floated up. */
  priorityAttention?: PriorityAttention;
  /** Priority rows only — right-click "Remove from priority" dismisses the row. */
  onRemoveFromPriority?: (workspaceId: string) => void;
  /** Non-priority rows — right-click "Add to priority" floats the row manually. */
  onAddToPriority?: (workspaceId: string) => void;
  /** Right-click "Edit Icon" — both values null clears the custom glyph. */
  onSetIcon?: (workspaceId: string, icon: string | null, iconColor: string | null) => void;
};

const IDE_POPOVER_WIDTH = 200;
const IDE_POPOVER_MAX_HEIGHT = 260;
const IDE_POPOVER_GUTTER = 8;
const IDE_POPOVER_DISMISS_DELAY_MS = 120;

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(value, max));
}

function idePopoverPosition(rect: Pick<DOMRect, "bottom" | "right">): { top: number; left: number } {
  const maxLeft = Math.max(IDE_POPOVER_GUTTER, window.innerWidth - IDE_POPOVER_WIDTH - IDE_POPOVER_GUTTER);
  const maxTop = Math.max(IDE_POPOVER_GUTTER, window.innerHeight - IDE_POPOVER_MAX_HEIGHT - IDE_POPOVER_GUTTER);
  return {
    top: clamp(rect.bottom + 6, IDE_POPOVER_GUTTER, maxTop),
    left: clamp(rect.right - IDE_POPOVER_WIDTH, IDE_POPOVER_GUTTER, maxLeft)
  };
}

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
  priorityAttention
}: {
  state: WorkspaceSummary["state"];
  prState?: WorkspaceSummary["prState"];
  priorityAttention?: PriorityAttention;
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
    return <WorkingNest active className="status-marker" size={14} />;
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
  showTokens,
  subtitle,
  priorityAttention,
  onRemoveFromPriority,
  onAddToPriority,
  onSetIcon
}: SidebarSessionRowProps): JSX.Element {
  const [pickerOpen, setPickerOpen] = useState(false);
  const [popoverPos, setPopoverPos] = useState<{ top: number; left: number } | null>(null);
  const pickerRef = useRef<HTMLDivElement | null>(null);
  const popoverRef = useRef<HTMLUListElement | null>(null);
  const pickerCloseTimerRef = useRef<number | null>(null);
  // Keep direct refs to every menuitem so ↑/↓ keyboard nav can move focus.
  // The map is rebuilt every render from the `detectedIdes` list; reading
  // `current` after layout is fine because the popover only mounts when
  // `pickerOpen && popoverPos`.
  const menuItemRefs = useRef(new Map<string, HTMLButtonElement | null>());
  const clearPickerCloseTimer = useCallback((): void => {
    if (pickerCloseTimerRef.current === null) return;
    window.clearTimeout(pickerCloseTimerRef.current);
    pickerCloseTimerRef.current = null;
  }, []);
  const closePicker = useCallback((): void => {
    clearPickerCloseTimer();
    setPickerOpen(false);
  }, [clearPickerCloseTimer]);
  const schedulePickerClose = useCallback((): void => {
    clearPickerCloseTimer();
    pickerCloseTimerRef.current = window.setTimeout(() => {
      pickerCloseTimerRef.current = null;
      setPickerOpen(false);
    }, IDE_POPOVER_DISMISS_DELAY_MS);
  }, [clearPickerCloseTimer]);
  useDismissOnOutsideOrEscape(pickerRef, pickerOpen, closePicker, popoverRef);

  useEffect(() => clearPickerCloseTimer, [clearPickerCloseTimer]);

  // Right-click "Rename" → inline edit. The context menu is portaled at the
  // cursor; committing writes the new label through onRename.
  const [contextMenuPos, setContextMenuPos] = useState<{ top: number; left: number } | null>(null);
  const [isEditing, setIsEditing] = useState(false);
  const [draftLabel, setDraftLabel] = useState("");
  const contextMenuRef = useRef<HTMLUListElement | null>(null);
  const renameInputRef = useRef<HTMLInputElement | null>(null);
  const closeContextMenu = (): void => setContextMenuPos(null);
  useDismissOnOutsideOrEscape(contextMenuRef, contextMenuPos !== null, closeContextMenu);

  // Right-click "Edit Icon" → the icon picker replaces the menu at the same
  // anchor point, clamped so a right-click near an edge stays on screen.
  const [iconPickerPos, setIconPickerPos] = useState<{ top: number; left: number } | null>(null);
  const closeIconPicker = useCallback((): void => setIconPickerPos(null), []);

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
    setPopoverPos(idePopoverPosition(rect));
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
    clearPickerCloseTimer();
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
  const priorityTitle = priorityAttention ? ` — ${PRIORITY_TITLE[priorityAttention]}` : "";
  const title = `${displayLabel} — ${workspace.state}${priorityTitle}${prTitle}${isOpenInGrid ? " — in view" : ""}`;

  const hasContextMenu = Boolean(onRename || onRemoveFromPriority || onAddToPriority || onSetIcon);
  const handleContextMenu = (event: ReactMouseEvent): void => {
    if (!hasContextMenu) return;
    event.preventDefault();
    event.stopPropagation();
    // Clamp to the viewport so a right-click near the bottom/right edge doesn't
    // push the menu off-screen. Sizes are the popover's min-width plus a small
    // per-item height estimate.
    const MENU_WIDTH = 150;
    const itemCount =
      (onRename ? 1 : 0) +
      (onSetIcon ? 1 : 0) +
      (onRemoveFromPriority ? 1 : 0) +
      (onAddToPriority ? 1 : 0);
    const MENU_HEIGHT = 8 + itemCount * 30;
    const left = Math.min(event.clientX, Math.max(8, window.innerWidth - MENU_WIDTH));
    const top = Math.min(event.clientY, Math.max(8, window.innerHeight - MENU_HEIGHT));
    setContextMenuPos({ top, left });
  };

  const startEditIcon = (): void => {
    const anchor = contextMenuPos;
    closeContextMenu();
    if (!anchor) return;
    setIconPickerPos({
      top: clamp(
        anchor.top,
        IDE_POPOVER_GUTTER,
        Math.max(
          IDE_POPOVER_GUTTER,
          window.innerHeight - SESSION_ICON_PICKER_HEIGHT - IDE_POPOVER_GUTTER
        )
      ),
      left: clamp(
        anchor.left,
        IDE_POPOVER_GUTTER,
        Math.max(
          IDE_POPOVER_GUTTER,
          window.innerWidth - SESSION_ICON_PICKER_WIDTH - IDE_POPOVER_GUTTER
        )
      )
    });
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
      />
    ) : null;

  return (
    <div className="session-row">
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
            className={`session-link${isSelected ? " active" : ""}${subtitle ? " session-link-stacked" : ""}`}
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
            {subtitle ? (
              <span className="session-link-text">
                <span>{displayLabel}</span>
                <span className="session-link-subtitle">{subtitle}</span>
              </span>
            ) : (
              <span>{displayLabel}</span>
            )}
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
      <div
        className="session-ide-cluster"
        ref={pickerRef}
        onMouseEnter={clearPickerCloseTimer}
        onMouseLeave={schedulePickerClose}
      >
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
            onMouseEnter={clearPickerCloseTimer}
            onMouseLeave={schedulePickerClose}
            style={{
              position: "fixed",
              top: popoverPos.top,
              left: popoverPos.left,
              right: "auto",
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
      {contextMenuPos && hasContextMenu
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
                    <ListChecks size={13} aria-hidden="true" />
                    Remove from priority
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
      {iconPickerPos && onSetIcon
        ? createPortal(
            <SessionIconPicker
              icon={workspace.icon ?? null}
              iconColor={workspace.iconColor ?? null}
              position={iconPickerPos}
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
  if (prev.subtitle !== next.subtitle) return false;
  if (prev.priorityAttention !== next.priorityAttention) return false;
  if (prev.onRemoveFromPriority !== next.onRemoveFromPriority) return false;
  if (prev.onAddToPriority !== next.onAddToPriority) return false;
  if (prev.onSetIcon !== next.onSetIcon) return false;
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
    pw.prNumber !== nw.prNumber ||
    pw.icon !== nw.icon ||
    pw.iconColor !== nw.iconColor
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
