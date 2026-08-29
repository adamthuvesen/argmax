import { useEffect, useRef } from "react";
import type { SessionSummary, WorkspaceSummary } from "../../shared/types.js";
import { shouldDemoteWaitingOnLeave } from "../lib/priority.js";

/**
 * After the user opens a waiting-for-input Priority session and then leaves
 * it (another session, launcher, settings, another project), stamp the same
 * dismissal as "Remove from priority". Working sessions are not demoted.
 */
export function usePriorityDemotion({
  selectedWorkspaceId,
  isSettingsOpen,
  isFullLauncherOpen,
  workspaces,
  sessions,
  onDemote
}: {
  selectedWorkspaceId: string | null;
  isSettingsOpen: boolean;
  isFullLauncherOpen: boolean;
  workspaces: WorkspaceSummary[];
  sessions: SessionSummary[];
  onDemote: (workspaceId: string) => void;
}): void {
  const viewingId =
    !isSettingsOpen && !isFullLauncherOpen ? selectedWorkspaceId : null;
  const previousViewingIdRef = useRef<string | null>(null);
  const onDemoteRef = useRef(onDemote);
  onDemoteRef.current = onDemote;
  const workspacesRef = useRef(workspaces);
  workspacesRef.current = workspaces;
  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;

  useEffect(() => {
    const previousId = previousViewingIdRef.current;
    previousViewingIdRef.current = viewingId;
    if (!previousId || previousId === viewingId) return;
    const workspace = workspacesRef.current.find((item) => item.id === previousId);
    if (!workspace) return;
    if (!shouldDemoteWaitingOnLeave(workspace, sessionsRef.current, Date.now())) return;
    onDemoteRef.current(previousId);
  }, [viewingId]);
}
