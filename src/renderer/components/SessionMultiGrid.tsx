import { useState, type DragEvent as ReactDragEvent, type JSX } from "react";
import type { ProviderModelSelection } from "../../shared/providerModels.js";
import type {
  ApprovalRequest,
  CheckRun,
  ProjectSummary,
  RawProviderOutput,
  SessionSummary,
  TimelineEvent,
  WorkspaceSummary
} from "../../shared/types.js";
import type { GridCoord, GridState, SplitPosition } from "../lib/gridState.js";
import { WORKSPACE_DRAG_MIME } from "../lib/gridState.js";
import type { ThinkingStyle } from "../lib/thinkingStyle.js";
import { SessionPane } from "./SessionPane.js";

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
  dragActive: boolean;
  onFocusPane: (coord: GridCoord) => void;
  onClosePane: (coord: GridCoord) => void;
  onDropWorkspace: (workspaceId: string, target: GridCoord & { position: SplitPosition }) => void;
  onLoadSessionEvents: (sessionId: string) => Promise<void>;
  onResolveApproval: (approvalId: string, status: "approved" | "rejected") => Promise<void>;
  onSendSessionInput: (sessionId: string, input: string, model: ProviderModelSelection) => Promise<void>;
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
  dragActive,
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
  return (
    <div className="session-multigrid" role="group" aria-label="Session panes">
      {grid.rows.map((row, r) => (
        <div className="session-multigrid-row" key={`row-${r}`}>
          {row.map((cell, c) => {
            const session = sessionsById.get(cell.sessionId) ?? null;
            const workspace = workspacesById.get(cell.workspaceId) ?? null;
            const project = workspace ? projectsById.get(workspace.projectId) ?? null : null;
            const focused = grid.focused?.row === r && grid.focused.col === c;
            const paneLabel = workspace?.taskLabel || workspace?.branch || "Session pane";
            return (
              <div
                className="session-multigrid-cell"
                data-focused={focused ? "true" : undefined}
                role="region"
                aria-label={paneLabel}
                aria-current={focused ? "true" : undefined}
                key={`${cell.sessionId}-${r}-${c}`}
                onPointerDownCapture={() => onFocusPane({ row: r, col: c })}
              >
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
                {dragActive ? (
                  <DropZones
                    onDrop={(position) => {
                      const workspaceId = readWorkspaceId(position.event);
                      if (!workspaceId) return;
                      onDropWorkspace(workspaceId, {
                        row: r,
                        col: c,
                        position: position.position
                      });
                    }}
                  />
                ) : null}
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}

interface DropZonePayload {
  position: SplitPosition;
  event: ReactDragEvent<HTMLDivElement>;
}

function readWorkspaceId(event: ReactDragEvent<HTMLDivElement>): string | null {
  const value = event.dataTransfer.getData(WORKSPACE_DRAG_MIME);
  return value || null;
}

function DropZones({ onDrop }: { onDrop: (payload: DropZonePayload) => void }): JSX.Element {
  const [hovered, setHovered] = useState<SplitPosition | null>(null);
  const zones: SplitPosition[] = ["above", "right", "below", "left", "replace"];

  return (
    <div className="multigrid-drop-overlay" aria-hidden="true">
      {zones.map((position) => (
        <div
          key={position}
          className="multigrid-drop-zone"
          data-position={position}
          data-hovered={hovered === position ? "true" : undefined}
          onDragOver={(event) => {
            const types = Array.from(event.dataTransfer.types);
            if (!types.includes(WORKSPACE_DRAG_MIME)) return;
            event.preventDefault();
            event.dataTransfer.dropEffect = "move";
            if (hovered !== position) setHovered(position);
          }}
          onDragLeave={() => setHovered((current) => (current === position ? null : current))}
          onDrop={(event) => {
            const types = Array.from(event.dataTransfer.types);
            if (!types.includes(WORKSPACE_DRAG_MIME)) return;
            event.preventDefault();
            setHovered(null);
            onDrop({ position, event });
          }}
        />
      ))}
    </div>
  );
}
