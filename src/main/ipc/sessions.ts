import { ipcMain } from "electron";
import { z } from "zod";
import {
  createCheckpointInputSchema,
  runCheckInputSchema,
  selectPreferredAttemptInputSchema,
  sessionCostSummaryInputSchema,
  sessionEventsSinceInputSchema,
  skillsListInputSchema,
  type IpcChannel
} from "../../shared/ipcSchemas.js";
import type { ArgmaxDatabase } from "../persistence/database.js";
import type { CheckService } from "../checks/checkService.js";
import type { CheckpointService } from "../review/checkpointService.js";
import { listSkills } from "../skills/skillRegistry.js";
import { timed } from "../util/ipcLatency.js";
import { withValidation } from "../ipc.js";

/**
 * Sessions / learnings / checks / checkpoints / skills IPC handlers
 * (Ralph SPEC D3 — seventh split). These channels all walk the database
 * for session-scoped reads or run small per-session services; grouping them
 * in one module keeps the entry point lean without one-channel files.
 */
export function registerSessionHandlers(
  database: ArgmaxDatabase,
  checks: CheckService,
  checkpoints: CheckpointService
): readonly IpcChannel[] {
  const registered: IpcChannel[] = [];
  const register = (channel: IpcChannel, listener: Parameters<typeof ipcMain.handle>[1]): void => {
    ipcMain.handle(channel, timed(channel, listener as (event: unknown, ...args: unknown[]) => unknown));
    registered.push(channel);
  };

  register(
    "learnings:list",
    withValidation(
      z.object({ projectId: z.string().min(1), limit: z.number().int().min(1).max(200).optional() }),
      (input) => database.listLearnings(input.projectId, input.limit)
    )
  );
  register(
    "learnings:update",
    withValidation(
      z.object({
        id: z.string().min(1),
        summary: z.string().min(1).optional(),
        verified: z.boolean().optional()
      }),
      (input) => database.updateLearning(input)
    )
  );
  register(
    "learnings:delete",
    withValidation(z.object({ id: z.string().min(1) }), (input) => {
      database.deleteLearning(input.id);
      return { ok: true } as const;
    })
  );
  register(
    "session:search",
    withValidation(
      z.object({ query: z.string().min(1).max(200), limit: z.number().int().min(1).max(200).optional() }),
      (input) => database.searchEvents(input)
    )
  );
  register(
    "session:events-since",
    withValidation(sessionEventsSinceInputSchema, (input) => database.listSessionEventsSince(input))
  );
  // Cost & token transparency (additive — see SPEC_COST_TRANSPARENCY.md).
  register(
    "session:cost-summary",
    withValidation(sessionCostSummaryInputSchema, (input) => database.getSessionCostSummary(input.sessionId))
  );
  register(
    "checks:run",
    withValidation(runCheckInputSchema, (input) => checks.runWorkspaceCheck(input))
  );
  register(
    "checkpoints:create",
    withValidation(createCheckpointInputSchema, (input) => checkpoints.createCheckpoint(input))
  );
  register(
    "attempts:select-preferred",
    withValidation(selectPreferredAttemptInputSchema, (input) => database.selectPreferredAttempt(input.sessionId))
  );
  register(
    "skills:list",
    withValidation(skillsListInputSchema, (input) => {
      // Resolve workspace path so workspace-local .claude/.codex skill dirs
      // are picked up. The launcher composer has no workspace yet — return
      // user-level only in that case. Also tolerate just-archived workspaces.
      let workspaceCwd: string | null = null;
      if (input.workspaceId) {
        try {
          workspaceCwd = database.getWorkspace(input.workspaceId).path;
        } catch {
          workspaceCwd = null;
        }
      }
      return listSkills({ provider: input.provider, workspaceCwd });
    })
  );

  return registered;
}
