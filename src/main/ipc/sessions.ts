import {
  createCheckpointInputSchema,
  learningsDeleteInputSchema,
  learningsListInputSchema,
  learningsUpdateInputSchema,
  runCheckInputSchema,
  selectPreferredAttemptInputSchema,
  sessionCostSummaryInputSchema,
  sessionEventsSinceInputSchema,
  sessionSearchInputSchema,
  skillsListInputSchema,
  type IpcChannel
} from "../../shared/ipcSchemas.js";
import type { ArgmaxDatabase } from "../persistence/database.js";
import type { CheckService } from "../checks/checkService.js";
import type { CheckpointService } from "../review/checkpointService.js";
import { listSkills } from "../skills/skillRegistry.js";
import { withValidation } from "../ipc.js";
import { createIpcRegistrar } from "./registry.js";

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
  const { register, channels: registered } = createIpcRegistrar();

  register(
    "learnings:list",
    withValidation(learningsListInputSchema, (input) => database.listLearnings(input.projectId, input.limit))
  );
  register(
    "learnings:update",
    withValidation(learningsUpdateInputSchema, (input) => database.updateLearning(input))
  );
  register(
    "learnings:delete",
    withValidation(learningsDeleteInputSchema, (input) => {
      database.deleteLearning(input.id);
      return { ok: true } as const;
    })
  );
  register(
    "session:search",
    withValidation(sessionSearchInputSchema, (input) => database.searchEvents(input))
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
