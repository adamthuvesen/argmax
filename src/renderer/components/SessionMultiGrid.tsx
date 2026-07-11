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
import type { ModelPickerSelection } from "../lib/models.js";
import type {
  AgentMode,
  ApprovalRequest,
  CheckRun,
  ComposerAttachment,
  PendingMessage,
  ProjectSummary,
  RawProviderOutput,
  SessionSummary,
  TimelineEvent,
  WorkspaceSummary
} from "../../shared/types.js";
import type { AgentPaneRequest, GridCell, GridCoord, GridState, SplitPosition } from "../lib/gridState.js";
import { isAgentCell, isSessionCell, MAX_CELLS, MAX_COLS, MAX_ROWS } from "../lib/gridState.js";
import { CHAT_PANE_MIN_WIDTH_PX, SESSION_CELL_MIN_WIDTH_PX } from "../lib/layoutConstants.js";
import type { ToolCall } from "../lib/toolCalls.js";
import { AgentTabsPane } from "./AgentTabsPane.js";
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
  if (cell.kind === "agent") {
    // Key on the parent session, never the active tab — switching or adding a
    // tab must not remount the cell (which would restart every pane's loads).
    return `agent-${cell.parentSessionId}-${rowIndex}-${colIndex}`;
  }
  return `${cell.sessionId}-${rowIndex}-${colIndex}`;
}

function balancedRowWeights(cellCount: number): number[] {
  return Array.from({ length: Math.max(1, cellCount) }, () => 1);
}

interface SessionMultiGridProps {
  grid: GridState;
  approvals: ApprovalRequest[];
  events: TimelineEvent[];
  rawOutputs: RawProviderOutput[];
  checks?: CheckRun[];
  projectsById: Map<string, ProjectSummary>;
  workspacesById: Map<string, WorkspaceSummary>;
  sessionsById: Map<string, SessionSummary>;
  defaultToolCallsExpanded?: boolean;
  defaultToolCallGroupsExpanded?: boolean;
  defaultThinkingExpanded?: boolean;
  fastModeEnabled?: boolean;
  showCostPanel?: boolean;
  maxColumnsPerRow?: number;
  rightPanelToggleSignal?: number;
  debugLogToggleSignal?: number;
  terminalToggleSignal?: number;
  renderLauncher: (project: ProjectSummary | null) => JSX.Element;
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
  onLoadAgentEvents: (sessionId: string, parentToolUseId: string) => Promise<void>;
  onOpenAgentPane: (request: AgentPaneRequest) => void;
  onActivateAgentTab: (parentSessionId: string, parentToolUseId: string) => void;
  onCloseAgentTab: (parentSessionId: string, parentToolUseId: string) => void;
  onWorkspaceMinWidthChange?: (width: number) => void;
  onResolveApproval: (approvalId: string, status: "approved" | "rejected") => Promise<void>;
  onSendSessionInput: (
    sessionId: string,
    input: string,
    model: ModelPickerSelection,
    agentMode: AgentMode,
    attachments?: ComposerAttachment[]
  ) => Promise<void>;
  onCancelQueuedMessage: (sessionId: string, messageId: string) => Promise<void>;
  pendingMessages?: Record<string, PendingMessage[]>;
  onTerminateSession: (sessionId: string) => Promise<void>;
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
  approvals,
  events,
  rawOutputs,
  checks,
  projectsById,
  workspacesById,
  sessionsById,
  defaultToolCallsExpanded,
  defaultToolCallGroupsExpanded,
  defaultThinkingExpanded,
  fastModeEnabled,
  showCostPanel = true,
  maxColumnsPerRow = MAX_COLS,
  rightPanelToggleSignal,
  debugLogToggleSignal,
  terminalToggleSignal,
  renderLauncher,
  dragSourceWorkspaceId,
  onFocusPane,
  onClosePane,
  onDropWorkspace,
  onFastModeEnabledChange,
  onLoadSessionEvents,
  onLoadAgentEvents,
  onOpenAgentPane,
  onActivateAgentTab,
  onCloseAgentTab,
  onWorkspaceMinWidthChange,
  onResolveApproval,
  onSendSessionInput,
  onCancelQueuedMessage,
  pendingMessages,
  onTerminateSession,
  onRunCheck,
  registerPaletteFileContext
}: SessionMultiGridProps): JSX.Element {
  const dragActive = dragSourceWorkspaceId !== null;
  const [rowWeights, setRowWeights] = useState<Record<number, number[]>>({});
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
    setRowWeights((current) => {
      const next: Record<number, number[]> = {};
      let changed = false;
      grid.rows.forEach((row, rowIndex) => {
        const existing = current[rowIndex];
        if (existing && existing.length === row.length) {
          next[rowIndex] = existing;
          return;
        }
        changed = true;
        next[rowIndex] = balancedRowWeights(row.length);
      });
      if (Object.keys(current).length !== Object.keys(next).length) changed = true;
      return changed ? next : current;
    });
  }, [grid.rows]);

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
    return grid.rows.reduce((maxWidth, row, rowIndex) => {
      const rowWidth = row.reduce((sum, cell, colIndex) => {
        return sum + cellMinWidthForKey(gridCellKey(cell, rowIndex, colIndex));
      }, 0);
      return Math.max(maxWidth, rowWidth);
    }, 0);
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
      const startWeights = rowWeights[rowIndex] ?? row.map(() => 1);
      const totalWeight = startWeights.reduce((sum, value) => sum + Math.max(value, 0.01), 0);
      const startWidths = startWeights.map((weight) => (Math.max(weight, 0.01) / totalWeight) * availableWidth);
      const pairWidth = startWidths[dividerIndex] + startWidths[dividerIndex + 1];
      const leftCell = row[dividerIndex];
      const rightCell = row[dividerIndex + 1];
      const leftMinWidth = leftCell
        ? cellMinWidthForKey(gridCellKey(leftCell, rowIndex, dividerIndex))
        : MIN_RESIZABLE_CELL_WIDTH_PX;
      const rightMinWidth = rightCell
        ? cellMinWidthForKey(gridCellKey(rightCell, rowIndex, dividerIndex + 1))
        : MIN_RESIZABLE_CELL_WIDTH_PX;
      const minScale = pairWidth < leftMinWidth + rightMinWidth
        ? pairWidth / (leftMinWidth + rightMinWidth)
        : 1;
      const effectiveLeftMinWidth = leftMinWidth * minScale;
      const effectiveRightMinWidth = rightMinWidth * minScale;

      setIsResizing(true);
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";

      const onMouseMove = (moveEvent: MouseEvent): void => {
        const clientX = clampNumber(moveEvent.clientX, rowRect.left, rowRect.right);
        const delta = clientX - startX;
        const minDelta = effectiveLeftMinWidth - startWidths[dividerIndex];
        const maxDelta = startWidths[dividerIndex + 1] - effectiveRightMinWidth;
        const clampedDelta = Math.max(minDelta, Math.min(maxDelta, delta));
        const nextWidths = [...startWidths];
        nextWidths[dividerIndex] = startWidths[dividerIndex] + clampedDelta;
        nextWidths[dividerIndex + 1] = startWidths[dividerIndex + 1] - clampedDelta;
        setRowWeights((current) => ({ ...current, [rowIndex]: nextWidths }));
      };

      const cleanup = (): void => {
        setIsResizing(false);
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
        document.removeEventListener("mousemove", onMouseMove);
        document.removeEventListener("mouseup", onMouseUp);
        dragCleanupRef.current = null;
      };
      const onMouseUp = (): void => cleanup();
      document.addEventListener("mousemove", onMouseMove);
      document.addEventListener("mouseup", onMouseUp);
      dragCleanupRef.current = cleanup;
    },
    [cellMinWidthForKey, grid.rows, rowWeights]
  );

  return (
    <div
      className="session-multigrid"
      role="group"
      aria-label="Session panes"
      data-resizing={isResizing ? "true" : undefined}
      style={
        {
          "--session-pane-min-width": `${MIN_RESIZABLE_CELL_WIDTH_PX}px`
        } as CSSProperties
      }
    >
      {grid.rows.map((row, r) => {
        const storedWeights = rowWeights[r];
        const weights = storedWeights?.length === row.length
          ? storedWeights
          : balancedRowWeights(row.length);
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
              const isAgent = isAgentCell(cell);
              const session = isSessionCell(cell) ? sessionsById.get(cell.sessionId) ?? null : null;
              const parentSession = isAgent ? sessionsById.get(cell.parentSessionId) ?? null : null;
              const workspace = !isLauncher ? workspacesById.get(cell.workspaceId) ?? null : null;
              const project = workspace ? projectsById.get(workspace.projectId) ?? null : null;
              const launcherProject = isLauncher ? projectsById.get(cell.projectId) ?? null : null;
              const focused = grid.focused?.row === r && grid.focused.col === c;
              const paneLabel = isLauncher
                ? `New session${launcherProject ? ` for ${launcherProject.name}` : ""}`
                : isAgent
                  ? `Agent activity${workspace ? ` for ${workspace.taskLabel}` : ""}`
                  : workspace?.taskLabel || workspace?.branch || "Session pane";
              const openChildAgent = (tool: ToolCall): void => {
                const baseSession = isAgent ? parentSession : session;
                if (!baseSession || !workspace) return;
                onOpenAgentPane({
                  parentSessionId: baseSession.id,
                  workspaceId: workspace.id,
                  parentToolUseId: tool.toolUseId
                });
              };
              const allowedDropPositions: EdgeDropPosition[] = [
                ...(canAddGridCell && grid.rows.length < MAX_ROWS ? (["above", "below"] as const) : []),
                ...(canAddGridCell && row.length < rowColumnCap ? (["left", "right"] as const) : [])
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
                  >
                    {isLauncher ? (
                      renderLauncher(launcherProject)
                    ) : isAgent ? (
                      <AgentTabsPane
                        cell={cell}
                        events={events}
                        isFocused={focused}
                        parentSession={parentSession}
                        workspace={workspace}
                        onLoadAgentEvents={onLoadAgentEvents}
                        onLoadSessionEvents={onLoadSessionEvents}
                        onOpenAgent={openChildAgent}
                        onCloseCell={() => onClosePane({ row: r, col: c })}
                        onActivateTab={(parentToolUseId) =>
                          onActivateAgentTab(cell.parentSessionId, parentToolUseId)
                        }
                        onCloseTab={(parentToolUseId) =>
                          onCloseAgentTab(cell.parentSessionId, parentToolUseId)
                        }
                      />
                    ) : (
                      <SessionPane
                        approvals={approvals}
                        checks={checks}
                        defaultToolCallsExpanded={defaultToolCallsExpanded}
                        defaultToolCallGroupsExpanded={defaultToolCallGroupsExpanded}
                        defaultThinkingExpanded={defaultThinkingExpanded}
                        events={events}
                        fastModeEnabled={fastModeEnabled}
                        showCostPanel={showCostPanel}
                        isFocused={focused}
                        onClose={() => onClosePane({ row: r, col: c })}
                        onFastModeEnabledChange={onFastModeEnabledChange}
                        onLoadSessionEvents={onLoadSessionEvents}
                        onOpenAgent={openChildAgent}
                        onRightPanelWidthChange={(width) => setCellRightPanelWidth(cellKey, width)}
                        onResolveApproval={onResolveApproval}
                        onRunCheck={onRunCheck}
                        onSendSessionInput={onSendSessionInput}
                        onCancelQueuedMessage={onCancelQueuedMessage}
                        pendingMessages={pendingMessages}
                        onTerminateSession={onTerminateSession}
                        project={project}
                        rawOutputs={rawOutputs}
                        rightPanelToggleSignal={rightPanelToggleSignal}
                        debugLogToggleSignal={debugLogToggleSignal}
                        terminalToggleSignal={terminalToggleSignal}
                        session={session}
                        workspace={workspace}
                        registerPaletteFileContext={registerPaletteFileContext}
                      />
                    )}
                    {dragActive && dragSourceWorkspaceId && allowedDropPositions.length > 0 ? (
                      <DropZones
                        allowedPositions={allowedDropPositions}
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
): EdgeDropPosition | null {
  if (allowedPositions.length === 0) return null;
  const rect = event.currentTarget.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return allowedPositions[0] ?? null;
  const x = Math.max(0, Math.min(rect.width, event.clientX - rect.left));
  const y = Math.max(0, Math.min(rect.height, event.clientY - rect.top));
  const allDistances: Array<[EdgeDropPosition, number]> = [
    ["above", y],
    ["right", rect.width - x],
    ["below", rect.height - y],
    ["left", x]
  ];
  const distances = allDistances.filter(([position]) => allowedPositions.includes(position));
  return distances.reduce((best, candidate) => candidate[1] < best[1] ? candidate : best)[0];
}

function DropZones({
  allowedPositions,
  onDrop
}: {
  allowedPositions: EdgeDropPosition[];
  onDrop: (position: EdgeDropPosition) => void;
}): JSX.Element {
  const [hovered, setHovered] = useState<EdgeDropPosition | null>(null);

  return (
    <div
      className="multigrid-drop-overlay"
      aria-hidden="true"
      onDragOver={(event) => {
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
        const position = edgeDropPosition(event, allowedPositions);
        if (!position) return;
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
        if (!position) return;
        setHovered(null);
        onDrop(position);
      }}
    >
      {hovered ? (
        <div
          className="multigrid-drop-zone"
          data-position={hovered}
          data-hovered="true"
        />
      ) : null}
    </div>
  );
}
