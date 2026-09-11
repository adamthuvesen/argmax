import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ProjectSummary, WorkspaceSummary } from "../../shared/types.js";
import { findSharedCheckoutWorkspace } from "../lib/projectCheckoutWorkspace.js";

/**
 * Resolves — and when needed creates — the shared checkout workspace a
 * project-backed review panel uses for its Terminal tab.
 */
export function useProjectCheckoutTerminal(
  project: ProjectSummary | null,
  workspaces: readonly WorkspaceSummary[],
  onWorkspaceCreated: (workspace: WorkspaceSummary) => void
): {
  terminalWorkspaceId: string | null;
  ensureCheckoutWorkspace: () => Promise<string | null>;
} {
  const checkoutWorkspace = useMemo(
    () => (project ? findSharedCheckoutWorkspace(project, workspaces) : null),
    [project, workspaces]
  );
  const [createdWorkspaceId, setCreatedWorkspaceId] = useState<string | null>(null);
  const ensuringRef = useRef<Promise<string | null> | null>(null);

  useEffect(() => {
    setCreatedWorkspaceId(null);
  }, [project?.id]);

  const ensureCheckoutWorkspace = useCallback(async (): Promise<string | null> => {
    if (!project) return null;
    if (checkoutWorkspace) return checkoutWorkspace.id;
    if (createdWorkspaceId) return createdWorkspaceId;
    if (ensuringRef.current) return ensuringRef.current;

    ensuringRef.current = (async () => {
      if (!window.argmax) return null;
      const workspace = await window.argmax.workspaces.createCurrent({
        projectId: project.id,
        taskLabel: project.name
      });
      onWorkspaceCreated(workspace);
      setCreatedWorkspaceId(workspace.id);
      return workspace.id;
    })();

    try {
      return await ensuringRef.current;
    } finally {
      ensuringRef.current = null;
    }
  }, [checkoutWorkspace, createdWorkspaceId, onWorkspaceCreated, project]);

  return {
    terminalWorkspaceId: checkoutWorkspace?.id ?? createdWorkspaceId,
    ensureCheckoutWorkspace
  };
}
