import { useCallback, useMemo, useRef, useState } from "react";
import type { WorkspaceSummary } from "../../shared/types.js";
import { createProjectCheckout } from "../data/bridgeActions.js";
import { findSharedCheckoutWorkspace } from "../lib/projectCheckoutWorkspace.js";
import type { ProjectTarget } from "../lib/projectTarget.js";

/**
 * Resolves — and when needed creates — the shared checkout workspace a
 * project-backed review panel uses for its Terminal tab.
 */
export function useProjectCheckoutTerminal(
  target: ProjectTarget | null,
  workspaces: readonly WorkspaceSummary[],
  onWorkspaceCreated: (workspace: WorkspaceSummary) => void,
): {
  terminalWorkspaceId: string | null;
  ensureCheckoutWorkspace: () => Promise<string | null>;
} {
  const project = target?.project ?? null;
  const checkoutWorkspace = useMemo(
    () => (project ? findSharedCheckoutWorkspace(project, workspaces) : null),
    [project, workspaces],
  );
  const [created, setCreated] = useState<{ key: string; id: string } | null>(null);
  const ensuringRef = useRef<{ key: string; promise: Promise<string | null> } | null>(null);
  const selectionKey = `${project?.id}:${target?.projectFolderId}:${project?.repoPath}`;
  const selectionRef = useRef(selectionKey);
  selectionRef.current = selectionKey;

  const createdWorkspaceId = created?.key === selectionKey ? created.id : null;

  const ensureCheckoutWorkspace = useCallback(async (): Promise<string | null> => {
    if (!target) return null;
    if (checkoutWorkspace) return checkoutWorkspace.id;
    if (createdWorkspaceId) return createdWorkspaceId;
    if (ensuringRef.current?.key === selectionKey) return ensuringRef.current.promise;

    const promise = (async () => {
      const workspace = await createProjectCheckout(target);
      if (!workspace) return null;
      onWorkspaceCreated(workspace);
      if (selectionRef.current !== selectionKey) return null;
      setCreated({ key: selectionKey, id: workspace.id });
      return workspace.id;
    })();

    ensuringRef.current = { key: selectionKey, promise };
    try {
      return await promise;
    } finally {
      if (ensuringRef.current?.promise === promise) ensuringRef.current = null;
    }
  }, [checkoutWorkspace, createdWorkspaceId, onWorkspaceCreated, selectionKey, target]);

  return {
    terminalWorkspaceId: checkoutWorkspace?.id ?? createdWorkspaceId,
    ensureCheckoutWorkspace,
  };
}
