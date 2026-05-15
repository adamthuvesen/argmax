import {
  Fragment,
  useCallback,
  useEffect,
  useRef,
  useState,
  type DragEvent as ReactDragEvent,
  type JSX,
  type MouseEvent as ReactMouseEvent
} from "react";
import type { ProviderModelSelection } from "../../shared/providerModels.js";
import type {
  AgentMode,
  ApprovalRequest,
  CheckRun,
  ProjectSummary,
  RawProviderOutput,
  SessionSummary,
  TimelineEvent,
  WorkspaceSummary
} from "../../shared/types.js";
import type { GridCoord, GridState, SplitPosition } from "../lib/gridState.js";
import { MAX_CELLS, MAX_COLS, MAX_ROWS, WORKSPACE_DRAG_MIME } from "../lib/gridState.js";
import type { ThinkingStyle } from "../lib/thinkingStyle.js";
import { SessionPane } from "./SessionPane.js";

const MIN_RESIZED_CELL_WIDTH = 220;
type EdgeDropPosition = Exclude<SplitPosition, "replace">;

function totalCells(grid: GridState): number {
  return grid.rows.reduce((sum, row) => sum + row.length, 0);
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
  thinkingStyle?: ThinkingStyle;
  rightPanelToggleSignal?: number;
  renderLauncher: (project: ProjectSummary | null) => JSX.Element;
  /** Which workspace is currently being dragged from the sidebar. The drop
      handlers use this directly instead of round-tripping through
      dataTransfer — Electron's synthetic-event path occasionally returns
      empty `getData()` even when the payload was set on `dragstart`. */
  dragSourceWorkspaceId: string | null;
  onFocusPane: (coord: GridCoord) => void;
  onClosePane: (coord: GridCoord) => void;
  onDropWorkspace: (workspaceId: string, target: GridCoord & { position: SplitPosition }) => void;
  onLoadSessionEvents: (sessionId: string) => Promise<void>;
  onResolveApproval: (approvalId: string, status: "approved" | "rejected") => Promise<void>;
  onSendSessionInput: (sessionId: string, input: string, model: ProviderModelSelection, agentMode: AgentMode) => Promise<void>;
  onTerminateSession: (sessionId: string) => Promise<void>;
  onCreateCheckpoint: (workspaceId: string) => Promise<void>;
  onRunCheck?: (workspaceId: string, command: string) => Promise<void>;
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
  thinkingStyle,
  rightPanelToggleSignal,
  renderLauncher,
  dragSourceWorkspaceId,
  onFocusPane,
  onClosePane,
  onDropWorkspace,
  onLoadSessionEvents,
  onResolveApproval,
  onSendSessionInput,
  onTerminateSession,
  onCreateCheckpoint,
  onRunCheck
}: SessionMultiGridProps): JSX.Element {
  const dragActive = dragSourceWorkspaceId !== null;
  const [rowWeights, setRowWeights] = useState<Record<number, number[]>>({});
  const [isResizing, setIsResizing] = useState(false);
  const rowRefs = useRef<Array<HTMLDivElement | null>>([]);
  const dragCleanupRef = useRef<(() => void) | null>(null);
  const canAddGridCell = totalCells(grid) < MAX_CELLS;

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
        const weights = existing ? existing.slice(0, row.length) : [];
        while (weights.length < row.length) weights.push(1);
        next[rowIndex] = weights.length > 0 ? weights : [1];
      });
      if (Object.keys(current).length !== Object.keys(next).length) changed = true;
      return changed ? next : current;
    });
  }, [grid.rows]);

  const onResizeMouseDown = useCallback(
    (event: ReactMouseEvent, rowIndex: number, dividerIndex: number): void => {
      event.preventDefault();
      event.stopPropagation();
      const row = grid.rows[rowIndex];
      const rowEl = rowRefs.current[rowIndex];
      if (!row || row.length < 2 || !rowEl) return;

      const startX = event.clientX;
      const rowWidth = rowEl.getBoundingClientRect().width;
      const availableWidth = Math.max(1, rowWidth - (row.length - 1));
      const startWeights = rowWeights[rowIndex] ?? row.map(() => 1);
      const totalWeight = startWeights.reduce((sum, value) => sum + Math.max(value, 0.01), 0);
      const startWidths = startWeights.map((weight) => (Math.max(weight, 0.01) / totalWeight) * availableWidth);
      const pairWidth = startWidths[dividerIndex] + startWidths[dividerIndex + 1];
      const minWidth = Math.min(MIN_RESIZED_CELL_WIDTH, Math.max(120, pairWidth / 3));

      setIsResizing(true);
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";

      const onMouseMove = (moveEvent: MouseEvent): void => {
        const delta = moveEvent.clientX - startX;
        const minDelta = minWidth - startWidths[dividerIndex];
        const maxDelta = startWidths[dividerIndex + 1] - minWidth;
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
    [grid.rows, rowWeights]
  );

  return (
    <div
      className="session-multigrid"
      role="group"
      aria-label="Session panes"
      data-resizing={isResizing ? "true" : undefined}
    >
      {grid.rows.map((row, r) => {
        const weights = rowWeights[r] ?? row.map(() => 1);
        const templateColumns = weights
          .map((weight) => `minmax(0, ${Math.max(weight, 0.01)}fr)`)
          .join(" minmax(1px, 1px) ");
        return (
          <div
            className="session-multigrid-row"
            key={`row-${r}`}
            ref={(element) => {
              rowRefs.current[r] = element;
            }}
            style={{ gridTemplateColumns: templateColumns }}
          >
            {row.map((cell, c) => {
              const isLauncher = cell.kind === "launcher";
              const session = !isLauncher ? sessionsById.get(cell.sessionId) ?? null : null;
              const workspace = !isLauncher ? workspacesById.get(cell.workspaceId) ?? null : null;
              const project = workspace ? projectsById.get(workspace.projectId) ?? null : null;
              const launcherProject = isLauncher ? projectsById.get(cell.projectId) ?? null : null;
              const focused = grid.focused?.row === r && grid.focused.col === c;
              const paneLabel = isLauncher
                ? `New session${launcherProject ? ` for ${launcherProject.name}` : ""}`
                : workspace?.taskLabel || workspace?.branch || "Session pane";
              const allowedDropPositions: EdgeDropPosition[] = [
                ...(canAddGridCell && grid.rows.length < MAX_ROWS ? (["above", "below"] as const) : []),
                ...(canAddGridCell && row.length < MAX_COLS ? (["left", "right"] as const) : [])
              ];
              const cellKey = isLauncher ? `launcher-${cell.projectId}-${r}-${c}` : `${cell.sessionId}-${r}-${c}`;
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
                    ) : (
                      <SessionPane
                        approvals={approvals}
                        checks={checks}
                        defaultToolCallsExpanded={defaultToolCallsExpanded}
                        events={events}
                        isFocused={focused}
                        onClose={() => onClosePane({ row: r, col: c })}
                        onCreateCheckpoint={onCreateCheckpoint}
                        onLoadSessionEvents={onLoadSessionEvents}
                        onResolveApproval={onResolveApproval}
                        onRunCheck={onRunCheck}
                        onSendSessionInput={onSendSessionInput}
                        onTerminateSession={onTerminateSession}
                        project={project}
                        rawOutputs={rawOutputs}
                        rightPanelToggleSignal={rightPanelToggleSignal}
                        session={session}
                        thinkingStyle={thinkingStyle}
                        workspace={workspace}
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
        const types = Array.from(event.dataTransfer.types);
        // Only react to our own workspace drag, not OS file drags etc.
        if (!types.includes(WORKSPACE_DRAG_MIME)) return;
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
        const types = Array.from(event.dataTransfer.types);
        if (!types.includes(WORKSPACE_DRAG_MIME)) return;
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
