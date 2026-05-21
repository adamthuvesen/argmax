import {
  archiveWorkspaceInputSchema,
  createCurrentWorkspaceInputSchema,
  createWorkspaceInputSchema,
  openInIdeInputSchema,
  workspaceIdInputSchema,
  workspaceSetPinnedInputSchema,
  workspaceStatusInputSchema,
  type IpcChannel
} from "../../shared/ipcSchemas.js";
import type { ArgmaxDatabase } from "../persistence/database.js";
import type { CheckService } from "../checks/checkService.js";
import type { NotificationService } from "../notifications/notificationService.js";
import { listSessionIdsForWorkspace } from "../persistence/sessions.js";
import type { WorkspaceService } from "../workspaces/workspaceOrchestration.js";
import type { DetectedIde, IdeId } from "../../shared/types.js";
import { detectInstalledIdes } from "../ide/ideDetection.js";
import { launchIde } from "../ide/ideLaunch.js";
import { withValidation } from "../ipc.js";
import { createIpcRegistrar } from "./registry.js";

/**
 * Workspace orchestration IPC handlers (Ralph SPEC D3 — sixth split).
 * Covers create/refresh/keep/archive lifecycle, pinning, status snapshots,
 * and `openInIde` (which is workspace-scoped — it takes a workspaceId and
 * routes to the user's preferred IDE).
 */
export function registerWorkspaceHandlers(
  database: ArgmaxDatabase,
  workspaces: WorkspaceService,
  checks: CheckService,
  notifications: NotificationService | null = null
): readonly IpcChannel[] {
  const { register, channels: registered } = createIpcRegistrar();

  register(
    "workspaces:create-isolated",
    withValidation(createWorkspaceInputSchema, (input) => workspaces.createIsolatedWorkspace(input))
  );
  register(
    "workspaces:create-current",
    withValidation(createCurrentWorkspaceInputSchema, (input) => workspaces.createCurrentWorkspaceSession(input))
  );
  register(
    "workspaces:refresh-status",
    withValidation(workspaceIdInputSchema, (workspaceId) => workspaces.refreshGitStatus(workspaceId))
  );
  register(
    "workspaces:keep",
    withValidation(workspaceIdInputSchema, (workspaceId) => workspaces.keepWorkspace(workspaceId))
  );
  register(
    "workspaces:archive",
    withValidation(archiveWorkspaceInputSchema, async (input) => {
      // Pass cancelChecks through so archiveWorkspace can run it AFTER the
      // dirty/force decision and the 200 ms porcelain settle window — clean
      // archives no longer pay an unnecessary SIGTERM round, and the dirty
      // path still gets its settle window.
      const workspace = await workspaces.archiveWorkspace(input.workspaceId, {
        force: input.force,
        cancelChecks: (id) => checks.cancelWorkspaceChecks(id)
      });
      if (workspace.state === "archived" && notifications) {
        for (const sessionId of listSessionIdsForWorkspace(database.connection, input.workspaceId)) {
          notifications.forget(sessionId);
        }
      }
      return workspace;
    })
  );
  register(
    "workspaces:open-in-ide",
    withValidation(openInIdeInputSchema, async (input) => {
      const workspace = database.getWorkspace(input.workspaceId);
      if (!workspace.path) {
        throw new Error("Workspace has no path on disk yet.");
      }
      const detected = await detectInstalledIdes();
      const target: IdeId = input.ide === "default" ? resolveDefaultIde(detected) : input.ide;
      await launchIde(target, workspace.path, detected);
      return { ok: true } as const;
    })
  );
  register(
    "workspaces:set-pinned",
    withValidation(workspaceSetPinnedInputSchema, (input) =>
      database.setWorkspacePinned(input.workspaceId, input.pinned)
    )
  );
  register(
    "workspace:status",
    withValidation(workspaceStatusInputSchema, (input) => database.listWorkspaceStatus(input))
  );

  return registered;
}

/**
 * Fallback when the renderer asks main to "open in default IDE" but the
 * caller has not yet persisted a preference (`localStorage["argmax.defaultIde"]`
 * is empty). Order matches the user-facing chevron menu: GUI IDEs first, then
 * Terminal. If somehow the detected list is empty the renderer should already
 * have disabled the button, so we throw a useful error instead of guessing.
 */
const DEFAULT_IDE_PRIORITY: readonly IdeId[] = ["vscode", "cursor", "windsurf", "zed", "iterm", "terminal"];

export function resolveDefaultIde(detected: readonly DetectedIde[]): IdeId {
  if (detected.length === 0) {
    throw new Error("No IDEs detected on this machine.");
  }
  for (const id of DEFAULT_IDE_PRIORITY) {
    if (detected.some((entry) => entry.id === id)) {
      return id;
    }
  }
  return detected[0].id;
}
