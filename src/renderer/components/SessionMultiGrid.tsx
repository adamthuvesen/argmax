import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent as ReactDragEvent,
  type CSSProperties,
  type JSX,
  type MouseEvent as ReactMouseEvent
} from "react";
import type { FontSize } from "../lib/fonts.js";
import type { QueuedMessageDelivery } from "../../shared/types.js";
import type { ModelPickerSelection } from "../lib/models.js";
import type { NewSessionSeed } from "./SessionComposer.js";
import type {
  AgentMode,
  AgentReference,
  ApprovalRequest,
  CheckRun,
  ComposerAttachment,
  DetectedIde,
  IdeId,
  NativeAgentIdentity,
  PendingMessage,
  ProjectSummary,
  ProviderId,
  SessionSummary,
  WorkspaceSummary
} from "../../shared/types.js";
import type { GridCell, GridCoord, GridState, SplitPosition } from "../lib/gridState.js";
import type { MultitaskChild } from "../lib/multitask.js";
import { findWorkspaceCell, isSessionCell, MAX_CELLS, MAX_COLS, MAX_ROWS } from "../lib/gridState.js";
import { CHAT_PANE_MIN_WIDTH_PX, SESSION_CELL_MIN_WIDTH_PX } from "../lib/layoutConstants.js";
import type { ThinkingDisplay, ToolCallsDisplay } from "../lib/uiPreferences.js";
import type { TerminateSessionOptions } from "../hooks/useSessionCommands.js";
import { SessionPane } from "./SessionPane.js";

/** Minimum pane width for side-by-side grid splits and divider drags. */
export const MIN_RESIZABLE_CELL_WIDTH_PX = SESSION_CELL_MIN_WIDTH_PX;
type EdgeDropPosition = Exclude<SplitPosition, "replace">;

function totalCells(grid: GridState): number {
  return grid.rows.reduce((sum, row) => sum + row.length, 0);
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function gridCellKey(cell: GridCell, rowIndex: number, colIndex: number): string {
  if (cell.kind === "launcher") return `launcher-${cell.projectId}-${rowIndex}-${colIndex}`;
  return `${cell.sessionId}-${rowIndex}-${colIndex}`;
}

function balancedRowWeights(cellCount: number): number[] {
  return Array.from({ length: Math.max(1, cellCount) }, () => 1);
}

interface SessionMultiGridProps {
  grid: GridState;
  /** Agent-window type scale. Set as `data-font-size` on the grid root so the
      chat subtree resolves the type tokens independently of app chrome. */
  chatFontSize?: FontSize;
  approvals: ApprovalRequest[];
  checks?: CheckRun[];
  projectsById: Map<string, ProjectSummary>;
  workspacesById: Map<string, WorkspaceSummary>;
  sessionsById: Map<string, SessionSummary>;
  /** Multitasks grouped by the session that dispatched them; each pane's dock
   *  hosts its own. */
  multitasksByParent?: Map<string, MultitaskChild[]>;
  defaultToolCallsDisplay?: ToolCallsDisplay;
  defaultToolCallGroupsExpanded?: boolean;
  thinkingDisplay?: ThinkingDisplay;
  defaultTurnChangesExpanded?: boolean;
  goalEnabled?: boolean;
  goalMaxTurns?: number;
  revertEnabled?: boolean;
  fastModeEnabled?: boolean;
  workspaceCardVisible?: boolean;
  onWorkspaceCardVisibleChange?: (visible: boolean) => void;
  maxColumnsPerRow?: number;
  rightPanelToggleSignal?: number;
  debugLogToggleSignal?: number;
  renderLauncher: (project: ProjectSummary | null, isFocused: boolean) => JSX.Element;
  /** Which workspace is currently being dragged from the sidebar. The drop
      handlers use this directly instead of round-tripping through
      dataTransfer — Tauri's synthetic-event path occasionally returns
      empty `getData()` even when the payload was set on `dragstart`. */
  dragSourceWorkspaceId: string | null;
  onFocusPane: (coord: GridCoord) => void;
  onClosePane: (coord: GridCoord) => void;
  onDropWorkspace: (workspaceId: string, target: GridCoord & { position: SplitPosition }) => void;
  onFastModeEnabledChange?: (enabled: boolean) => void;
  onLoadSessionEvents: (sessionId: string) => Promise<void>;
  onLoadAgentEvents: (sessionId: string, parentToolUseId: string, identity?: NativeAgentIdentity) => Promise<void | { hasMore: boolean }>;
  /** Opens a launcher cell beside the focused pane. */
  onNewSession: (seed?: NewSessionSeed) => void;
  /** Launches a repo-less side chat seeded with the given first message. */
  onOpenSideChat?: (seedPrompt: string) => Promise<void>;
  onOpenSession?: (sessionId: string) => void;
  onOpenDetails?: (
    seedPrompt: string,
    context?: { attachToChat?: () => void }
  ) => Promise<void>;
  defaultIde?: IdeId | null;
  detectedIdes?: DetectedIde[];
  onOpenWorkspaceInIde?: (workspaceId: string, ide: IdeId) => void;
  onWorkspaceMinWidthChange?: (width: number) => void;
  onResolveApproval: (approvalId: string, status: "approved" | "rejected") => Promise<void>;
  onSendSessionInput: (
    sessionId: string,
    input: string,
    model: ModelPickerSelection,
    agentMode: AgentMode,
    attachments?: ComposerAttachment[],
    agentReferences?: AgentReference[]
  ) => Promise<void>;
  onCancelQueuedMessage: (sessionId: string, messageId: string) => Promise<void>;
  onSendQueuedMessageNow: (
    sessionId: string,
    messageId: string,
    delivery?: QueuedMessageDelivery
  ) => Promise<void>;
  onMultitask?: (
    sessionId: string,
    prompt: string,
    provider: ProviderId,
    pendingMessageId?: string
  ) => Promise<void>;
  pendingMessages?: Record<string, PendingMessage[]>;
  onTerminateSession: (sessionId: string, options?: TerminateSessionOptions) => Promise<void>;
  onClearSession: (sessionId: string) => Promise<void>;
  onForkSession: (sessionId: string) => Promise<void>;
  onRunCheck?: (workspaceId: string, command: string) => Promise<void>;
  /** App-level setter the focused SessionPane registers with so its file
      source + pick handler are wired into the command palette's Files
      group. */
  registerPaletteFileContext?: (
    context: { source: { kind: "workspace" | "project"; id: string }; onPick: (path: string) => void } | null
  ) => void;
}

export function SessionMultiGrid({
  grid,
  chatFontSize,
  approvals,
  checks,
  projectsById,
  workspacesById,
  sessionsById,
  multitasksByParent,
  defaultToolCallsDisplay,
  defaultToolCallGroupsExpanded,
  thinkingDisplay,
  defaultTurnChangesExpanded,
  goalEnabled,
  goalMaxTurns,
  revertEnabled,
  fastModeEnabled,
  workspaceCardVisible = true,
  onWorkspaceCardVisibleChange,
  maxColumnsPerRow = MAX_COLS,
  rightPanelToggleSignal,
  debugLogToggleSignal,
  renderLauncher,
  dragSourceWorkspaceId,
  onFocusPane,
  onClosePane,
  onDropWorkspace,
  onFastModeEnabledChange,
  onLoadAgentEvents,
  onLoadSessionEvents,
  onNewSession,
  onOpenSideChat,
  onOpenSession,
  onOpenDetails,
  defaultIde = null,
  detectedIdes = [],
  onOpenWorkspaceInIde,
  onWorkspaceMinWidthChange,
  onResolveApproval,
  onSendSessionInput,
  onCancelQueuedMessage,
  onSendQueuedMessageNow,
  onMultitask,
  pendingMessages,
  onTerminateSession,
  onClearSession,
  onForkSession,
  onRunCheck,
  registerPaletteFileContext
}: SessionMultiGridProps): JSX.Element {
  const dragActive = dragSourceWorkspaceId !== null;
  const [columnWeights, setColumnWeights] = useState<number[]>([1, 1]);
  const rowShape = grid.rows.map((row) => row.length).join(",");
  const draggingExisting = dragSourceWorkspaceId !== null && findWorkspaceCell(grid, dragSourceWorkspaceId) !== null;
  const [rightPanelWidthByCell, setRightPanelWidthByCell] = useState<Record<string, number>>({});
  const [isResizing, setIsResizing] = useState(false);
  const rowRefs = useRef<Array<HTMLDivElement | null>>([]);
  const dragCleanupRef = useRef<(() => void) | null>(null);
  const rowColumnCap = Math.max(1, Math.min(MAX_COLS, Math.floor(maxColumnsPerRow)));
  const canAddGridCell = totalCells(grid) < Math.min(MAX_CELLS, MAX_ROWS * rowColumnCap);

  useEffect(
    () => () => {
      dragCleanupRef.current?.();
      dragCleanupRef.current = null;
    },
    []
  );

  useEffect(() => {
    setColumnWeights([1, 1]);
  }, [rowShape]);

  useEffect(() => {
    const liveKeys = new Set<string>();
    grid.rows.forEach((row, rowIndex) => {
      row.forEach((cell, colIndex) => {
        liveKeys.add(gridCellKey(cell, rowIndex, colIndex));
      });
    });
    setRightPanelWidthByCell((current) => {
      const next = Object.fromEntries(Object.entries(current).filter(([key]) => liveKeys.has(key)));
      return Object.keys(next).length === Object.keys(current).length ? current : next;
    });
  }, [grid.rows]);

  const cellMinWidthForKey = useCallback((cellKey: string): number => {
    const rightPanelWidth = rightPanelWidthByCell[cellKey];
    return rightPanelWidth ? CHAT_PANE_MIN_WIDTH_PX + rightPanelWidth : MIN_RESIZABLE_CELL_WIDTH_PX;
  }, [rightPanelWidthByCell]);

  const requiredWorkspaceMinWidth = useMemo(() => {
    const columnWidths = [0, 0];
    let singleWidth = 0;
    grid.rows.forEach((row, r) => {
      row.forEach((cell, c) => {
        const width = cellMinWidthForKey(gridCellKey(cell, r, c));
        if (row.length === 1) singleWidth = Math.max(singleWidth, width);
        else columnWidths[c] = Math.max(columnWidths[c], width);
      });
    });
    return Math.max(singleWidth, columnWidths[0] + columnWidths[1]);
  }, [cellMinWidthForKey, grid.rows]);

  useEffect(() => {
    onWorkspaceMinWidthChange?.(requiredWorkspaceMinWidth);
  }, [onWorkspaceMinWidthChange, requiredWorkspaceMinWidth]);

  useEffect(
    () => () => {
      onWorkspaceMinWidthChange?.(0);
    },
    [onWorkspaceMinWidthChange]
  );

  const setCellRightPanelWidth = useCallback((cellKey: string, width: number | null): void => {
    setRightPanelWidthByCell((current) => {
      if (!width) {
        if (!(cellKey in current)) return current;
        const next = { ...current };
        delete next[cellKey];
        return next;
      }
      if (current[cellKey] === width) return current;
      return { ...current, [cellKey]: width };
    });
  }, []);

  const onResizeMouseDown = useCallback(
    (event: ReactMouseEvent, rowIndex: number, dividerIndex: number): void => {
      event.preventDefault();
      event.stopPropagation();
      const row = grid.rows[rowIndex];
      const rowEl = rowRefs.current[rowIndex];
      if (!row || row.length < 2 || !rowEl) return;

      const rowRect = rowEl.getBoundingClientRect();
      const startX = clampNumber(event.clientX, rowRect.left, rowRect.right);
      const rowWidth = rowRect.width;
      const availableWidth = Math.max(1, rowWidth - (row.length - 1));
      const startWeights = columnWeights;
      const totalWeight = startWeights.reduce((sum, value) => sum + Math.max(value, 0.01), 0);
      const startWidths = startWeights.map((weight) => (Math.max(weight, 0.01) / totalWeight) * availableWidth);
      const pairWidth = startWidths[dividerIndex] + startWidths[dividerIndex + 1];
      // Both rows share a divider, so respect the widest dock in each column.
      const columnMinWidth = (col: number): number => Math.max(
        MIN_RESIZABLE_CELL_WIDTH_PX,
        ...grid.rows.map((cells, r) => cells.length === 2
          ? cellMinWidthForKey(gridCellKey(cells[col], r, col))
          : 0)
      );
      const leftMinWidth = columnMinWidth(dividerIndex);
      const rightMinWidth = columnMinWidth(dividerIndex + 1);
      const minScale = pairWidth < leftMinWidth + rightMinWidth
        ? pairWidth / (leftMinWidth + rightMinWidth)
        : 1;
      const effectiveLeftMinWidth = leftMinWidth * minScale;
      const effectiveRightMinWidth = rightMinWidth * minScale;

      dragCleanupRef.current?.();
      setIsResizing(true);
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";

      let frame: number | null = null;
      let pendingWidths = startWidths;
      const onMouseMove = (moveEvent: MouseEvent): void => {
        const clientX = clampNumber(moveEvent.clientX, rowRect.left, rowRect.right);
        const delta = clientX - startX;
        const minDelta = effectiveLeftMinWidth - startWidths[dividerIndex];
        const maxDelta = startWidths[dividerIndex + 1] - effectiveRightMinWidth;
        const clampedDelta = Math.max(minDelta, Math.min(maxDelta, delta));
        const nextWidths = [...startWidths];
        nextWidths[dividerIndex] = startWidths[dividerIndex] + clampedDelta;
        nextWidths[dividerIndex + 1] = startWidths[dividerIndex + 1] - clampedDelta;
        pendingWidths = nextWidths;
        if (frame === null) frame = requestAnimationFrame(() => {
          setColumnWeights(pendingWidths);
          frame = null;
        });
      };

      const cleanup = (): void => {
        if (frame !== null) cancelAnimationFrame(frame);
        setColumnWeights(pendingWidths);
        setIsResizing(false);
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
        document.removeEventListener("mousemove", onMouseMove);
        document.removeEventListener("mouseup", onMouseUp);
        window.removeEventListener("blur", cleanup);
        dragCleanupRef.current = null;
      };
      const onMouseUp = (): void => cleanup();
      document.addEventListener("mousemove", onMouseMove);
      document.addEventListener("mouseup", onMouseUp);
      window.addEventListener("blur", cleanup);
      dragCleanupRef.current = cleanup;
    },
    [cellMinWidthForKey, grid.rows, columnWeights]
  );

  return (
    <div
      className="session-multigrid"
      role="group"
      aria-label="Chat panes"
      data-font-size={chatFontSize === undefined ? undefined : String(chatFontSize)}
      data-resizing={isResizing ? "true" : undefined}
      style={
        {
          "--session-pane-min-width": `${MIN_RESIZABLE_CELL_WIDTH_PX}px`
        } as CSSProperties
      }
    >
      {grid.rows.map((row, r) => {
        const weights = row.length === 2 ? columnWeights : balancedRowWeights(row.length);
        const templateColumns = weights
          .map((weight) => `minmax(0, ${Math.max(weight, 0.01)}fr)`)
          .join(" minmax(1px, 1px) ");
        return (
          <div
            className="session-multigrid-row"
            key={`row-${r}`}
            role="group"
            aria-label={`Pane row ${r + 1}`}
            ref={(element) => {
              rowRefs.current[r] = element;
            }}
            style={{ gridTemplateColumns: templateColumns }}
          >
            {row.map((cell, c) => {
              const isLauncher = cell.kind === "launcher";
              const session = isSessionCell(cell) ? sessionsById.get(cell.sessionId) ?? null : null;
              const workspace = !isLauncher ? workspacesById.get(cell.workspaceId) ?? null : null;
              const project = workspace ? projectsById.get(workspace.projectId) ?? null : null;
              const launcherProject = isLauncher ? projectsById.get(cell.projectId) ?? null : null;
              const focused = grid.focused?.row === r && grid.focused.col === c;
              const paneLabel = isLauncher
                ? `New chat${launcherProject ? ` for ${launcherProject.name}` : ""}`
                : workspace?.taskLabel || workspace?.branch || "Chat pane";
              const allowedDropPositions: EdgeDropPosition[] = [
                ...(!draggingExisting && canAddGridCell && grid.rows.length < MAX_ROWS ? (["above", "below"] as const) : []),
                ...(!draggingExisting && canAddGridCell && row.length < rowColumnCap ? (["left", "right"] as const) : [])
              ];
              const cellKey = gridCellKey(cell, r, c);
              return (
                <Fragment key={cellKey}>
                  <div
                    className="session-multigrid-cell"
                    data-focused={focused ? "true" : undefined}
                    role="region"
                    aria-label={paneLabel}
                    aria-current={focused ? "true" : undefined}
                    onPointerDownCapture={() => onFocusPane({ row: r, col: c })}
                    onFocusCapture={() => {
                      if (!focused) onFocusPane({ row: r, col: c });
                    }}
                  >
                    {isLauncher ? (
                      renderLauncher(launcherProject, focused)
                    ) : (
                      <SessionPane
                        approvals={approvals}
                        checks={checks}
                        defaultToolCallsDisplay={defaultToolCallsDisplay}
                        defaultToolCallGroupsExpanded={defaultToolCallGroupsExpanded}
                        thinkingDisplay={thinkingDisplay}
                        defaultTurnChangesExpanded={defaultTurnChangesExpanded}
                        goalEnabled={goalEnabled}
                        goalMaxTurns={goalMaxTurns}
                        revertEnabled={revertEnabled}
                        fastModeEnabled={fastModeEnabled}
                        workspaceCardVisible={workspaceCardVisible}
                        onWorkspaceCardVisibleChange={onWorkspaceCardVisibleChange}
                        isFocused={focused}
                        onClose={() => onClosePane({ row: r, col: c })}
                        onFastModeEnabledChange={onFastModeEnabledChange}
                        onLoadAgentEvents={onLoadAgentEvents}
                        onLoadSessionEvents={onLoadSessionEvents}
                        onNewSession={onNewSession}
                        onOpenSideChat={onOpenSideChat}
                        onOpenSession={onOpenSession}
                        onOpenDetails={onOpenDetails}
                        defaultIde={defaultIde}
                        detectedIdes={detectedIdes}
                        onOpenWorkspaceInIde={onOpenWorkspaceInIde}
                        onRightPanelWidthChange={(width) => setCellRightPanelWidth(cellKey, width)}
                        onResolveApproval={onResolveApproval}
                        onRunCheck={onRunCheck}
                        onSendSessionInput={onSendSessionInput}
                        onCancelQueuedMessage={onCancelQueuedMessage}
                        onSendQueuedMessageNow={onSendQueuedMessageNow}
                        onMultitask={onMultitask}
                        multitasks={session ? multitasksByParent?.get(session.id) : undefined}
                        pendingMessages={pendingMessages}
                        onTerminateSession={onTerminateSession}
                        onClearSession={onClearSession}
                        onForkSession={onForkSession}
                        project={project}
                        rightPanelToggleSignal={rightPanelToggleSignal}
                        debugLogToggleSignal={debugLogToggleSignal}
                        session={session}
                        workspace={workspace}
                        registerPaletteFileContext={registerPaletteFileContext}
                      />
                    )}
                    {dragActive && dragSourceWorkspaceId ? (
                      <DropZones
                        allowedPositions={allowedDropPositions}
                        replaceLabel={draggingExisting ? "Swap chats" : "Open here"}
                        onDrop={(position) => {
                          onDropWorkspace(dragSourceWorkspaceId, {
                            row: r,
                            col: c,
                            position
                          });
                        }}
                      />
                    ) : null}
                  </div>
                  {c < row.length - 1 ? (
                    <div
                      className="session-multigrid-resizer"
                      role="separator"
                      aria-label={`Resize ${paneLabel} and next pane`}
                      aria-orientation="vertical"
                      title="Resize panes"
                      onMouseDown={(event) => onResizeMouseDown(event, r, c)}
                    />
                  ) : null}
                </Fragment>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}

function edgeDropPosition(
  event: ReactDragEvent<HTMLDivElement>,
  allowedPositions: EdgeDropPosition[]
): SplitPosition {
  if (allowedPositions.length === 0) return "replace";
  const rect = event.currentTarget.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return "replace";
  const x = Math.max(0, Math.min(rect.width, event.clientX - rect.left));
  const y = Math.max(0, Math.min(rect.height, event.clientY - rect.top));
  const allDistances: Array<[EdgeDropPosition, number]> = [
    ["above", y / rect.height],
    ["right", (rect.width - x) / rect.width],
    ["below", (rect.height - y) / rect.height],
    ["left", x / rect.width]
  ];
  const distances = allDistances.filter(([position]) => allowedPositions.includes(position));
  const nearest = distances.reduce((best, candidate) => candidate[1] < best[1] ? candidate : best);
  return nearest[1] <= 0.25 ? nearest[0] : "replace";
}

function DropZones({
  allowedPositions,
  replaceLabel,
  onDrop
}: {
  allowedPositions: EdgeDropPosition[];
  replaceLabel: string;
  onDrop: (position: SplitPosition) => void;
}): JSX.Element {
  const [hovered, setHovered] = useState<SplitPosition | null>(null);

  return (
    <div
      className="multigrid-drop-overlay"
      role="group"
      aria-label="Drop chat here"
      onDragOver={(event) => {
        event.preventDefault();
        event.stopPropagation();
        event.dataTransfer.dropEffect = "move";
        const position = edgeDropPosition(event, allowedPositions);
        if (hovered !== position) setHovered(position);
      }}
      onDragLeave={(event) => {
        const related = event.relatedTarget;
        if (related instanceof Node && event.currentTarget.contains(related)) return;
        setHovered(null);
      }}
      onDrop={(event) => {
        event.preventDefault();
        const position = edgeDropPosition(event, allowedPositions);
        setHovered(null);
        onDrop(position);
      }}
    >
      {hovered ? (
        <div
          className="multigrid-drop-zone"
          data-position={hovered}
          data-hovered="true"
        >
          <span className="multigrid-drop-label">
            {hovered === "replace" ? replaceLabel : {
              left: "Split left", right: "Split right", above: "Split above", below: "Split below"
            }[hovered]}
          </span>
        </div>
      ) : null}
    </div>
  );
}
