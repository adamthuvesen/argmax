import { ipcMain } from "electron";
import { ZodError, type ZodIssue, type ZodType } from "zod";
import {
  createCheckpointInputSchema,
  createCurrentWorkspaceInputSchema,
  createWorkspaceInputSchema,
  approvalsPendingInputSchema,
  dashboardListInputSchema,
  launchProviderSessionInputSchema,
  loadDiffInputSchema,
  prepareCommitInputSchema,
  providerSessionInputSchema,
  providerSessionResizeInputSchema,
  providerSessionTerminateInputSchema,
  registerProjectInputSchema,
  resolveApprovalInputSchema,
  runCheckInputSchema,
  selectPreferredAttemptInputSchema,
  sessionEventsSinceInputSchema,
  updateProjectSettingsInputSchema,
  workspaceStatusInputSchema,
  workspaceIdInputSchema
} from "../shared/ipcSchemas.js";
import type { MaestroDatabase } from "./persistence/database.js";
import { ProjectService } from "./projects/projectRegistration.js";
import { WorkspaceService } from "./workspaces/workspaceOrchestration.js";
import { discoverProviders } from "./providers/providerDiscovery.js";
import type { ProviderSessionService } from "./providers/providerSessionService.js";
import { GitReviewService } from "./review/gitReviewService.js";
import { CheckService } from "./checks/checkService.js";
import { CheckpointService } from "./review/checkpointService.js";
import { CommitPreparationService } from "./review/commitPreparationService.js";

/**
 * Wraps an IPC handler body so its `input` is validated against a zod schema
 * before the handler runs. On a schema mismatch, throws an `Error` with
 * `code: "INVALID_INPUT"` and the zod `issues` attached so the renderer's
 * `invoke()` rejects with a structured payload instead of crashing inside
 * the service.
 *
 * Use as: `ipcMain.handle("channel", withValidation(schema, (input) => ...))`.
 */
export interface IpcInvalidInputError extends Error {
  code: "INVALID_INPUT";
  issues: ZodIssue[];
}

export function withValidation<TIn, TOut>(
  schema: ZodType<TIn>,
  fn: (input: TIn) => TOut | Promise<TOut>
): (event: unknown, rawInput: unknown) => Promise<TOut> {
  return async (_event, rawInput) => {
    let parsed: TIn;
    try {
      parsed = schema.parse(rawInput);
    } catch (error) {
      if (error instanceof ZodError) {
        const wrapped: IpcInvalidInputError = Object.assign(new Error("INVALID_INPUT"), {
          code: "INVALID_INPUT" as const,
          issues: error.issues
        });
        throw wrapped;
      }
      throw error;
    }
    return fn(parsed);
  };
}

/**
 * Registers every IPC channel against `ipcMain.handle` and returns the list
 * of channel names so the lifecycle owner (`main.ts`) can call
 * `ipcMain.removeHandler(channel)` for each on `before-quit`.
 *
 * The `providerSessions` instance is passed in (rather than constructed here)
 * so `main.ts` can wire `disposeAll()` to `before-quit` against the same
 * service the IPC layer talks to. Every payload-bearing handler validates its
 * input through a zod schema in `src/shared/ipcSchemas.ts` via
 * `withValidation`; runtime drift between renderer and main now rejects with
 * `INVALID_INPUT` instead of crashing inside a service.
 */
export function registerIpcHandlers(
  database: MaestroDatabase,
  providerSessions: ProviderSessionService
): readonly string[] {
  const projects = new ProjectService(database);
  const workspaces = new WorkspaceService(database);
  const review = new GitReviewService(database);
  const checks = new CheckService(database);
  const checkpoints = new CheckpointService(database);
  const commits = new CommitPreparationService(database);

  ipcMain.handle("health:ping", () => ({
    ok: true,
    timestamp: new Date().toISOString()
  }));
  ipcMain.handle("projects:list", () => database.listProjects());
  ipcMain.handle("dashboard:list", withValidation(dashboardListInputSchema, () => database.listDashboard()));
  ipcMain.handle("dashboard:load", () => database.loadDashboard());
  ipcMain.handle("providers:discover", () => discoverProviders());

  ipcMain.handle(
    "projects:register",
    withValidation(registerProjectInputSchema, (input) => projects.registerProject(input))
  );
  ipcMain.handle(
    "projects:update-settings",
    withValidation(updateProjectSettingsInputSchema, (input) => projects.updateSettings(input))
  );
  ipcMain.handle(
    "workspaces:create-isolated",
    withValidation(createWorkspaceInputSchema, (input) => workspaces.createIsolatedWorkspace(input))
  );
  ipcMain.handle(
    "workspaces:create-current",
    withValidation(createCurrentWorkspaceInputSchema, (input) => workspaces.createCurrentWorkspaceSession(input))
  );
  ipcMain.handle(
    "workspaces:refresh-status",
    withValidation(workspaceIdInputSchema, (workspaceId) => workspaces.refreshGitStatus(workspaceId))
  );
  ipcMain.handle(
    "workspaces:keep",
    withValidation(workspaceIdInputSchema, (workspaceId) => workspaces.keepWorkspace(workspaceId))
  );
  ipcMain.handle(
    "workspaces:archive",
    withValidation(workspaceIdInputSchema, (workspaceId) => workspaces.archiveWorkspace(workspaceId))
  );
  ipcMain.handle(
    "workspace:status",
    withValidation(workspaceStatusInputSchema, (input) => database.listWorkspaceStatus(input))
  );
  ipcMain.handle(
    "providers:launch",
    withValidation(launchProviderSessionInputSchema, (input) => providerSessions.launch(input))
  );
  ipcMain.handle(
    "providers:send-input",
    withValidation(providerSessionInputSchema, async (input) => {
      await providerSessions.sendInput(input.sessionId, input.input);
      return { ok: true } as const;
    })
  );
  ipcMain.handle(
    "providers:resize",
    withValidation(providerSessionResizeInputSchema, (input) => {
      providerSessions.resize(input.sessionId, input.cols, input.rows);
      return { ok: true } as const;
    })
  );
  ipcMain.handle(
    "providers:terminate",
    withValidation(providerSessionTerminateInputSchema, async (sessionId) => {
      await providerSessions.terminate(sessionId);
      return { ok: true } as const;
    })
  );
  ipcMain.handle(
    "approvals:resolve",
    withValidation(resolveApprovalInputSchema, (input) => database.resolveApproval(input.approvalId, input.status))
  );
  ipcMain.handle("approvals:pending", withValidation(approvalsPendingInputSchema, () => database.listPendingApprovals()));
  ipcMain.handle(
    "session:eventsSince",
    withValidation(sessionEventsSinceInputSchema, (input) => database.listSessionEventsSince(input))
  );
  ipcMain.handle(
    "review:list-changed-files",
    withValidation(workspaceIdInputSchema, (workspaceId) => review.listChangedFiles(workspaceId))
  );
  // `review:load-diff` is invoked positionally as (workspaceId, filePath?).
  // We assemble the args into a tuple before validating against the tuple schema.
  ipcMain.handle("review:load-diff", async (_event, workspaceId: unknown, filePath: unknown) => {
    let parsed: [string, string | undefined];
    try {
      parsed = loadDiffInputSchema.parse([workspaceId, filePath]);
    } catch (error) {
      if (error instanceof ZodError) {
        throw Object.assign(new Error("INVALID_INPUT"), {
          code: "INVALID_INPUT" as const,
          issues: error.issues
        });
      }
      throw error;
    }
    return review.loadDiff(parsed[0], parsed[1]);
  });
  ipcMain.handle(
    "checks:run",
    withValidation(runCheckInputSchema, (input) => checks.runWorkspaceCheck(input))
  );
  ipcMain.handle(
    "checkpoints:create",
    withValidation(createCheckpointInputSchema, (input) => checkpoints.createCheckpoint(input))
  );
  ipcMain.handle(
    "attempts:select-preferred",
    withValidation(selectPreferredAttemptInputSchema, (input) => database.selectPreferredAttempt(input.sessionId))
  );
  ipcMain.handle(
    "commits:prepare",
    withValidation(prepareCommitInputSchema, (input) => commits.prepareCommit(input))
  );

  return REGISTERED_IPC_CHANNELS;
}

/**
 * Channel names registered by `registerIpcHandlers`. New IPC channels MUST be
 * added here AND wired in `registerIpcHandlers`; the IPC handler regression
 * test asserts the two stay in sync.
 */
export const REGISTERED_IPC_CHANNELS: readonly string[] = [
  "health:ping",
  "projects:list",
  "dashboard:list",
  "projects:register",
  "projects:update-settings",
  "workspaces:create-isolated",
  "workspaces:create-current",
  "workspaces:refresh-status",
  "workspaces:keep",
  "workspaces:archive",
  "workspace:status",
  "providers:discover",
  "providers:launch",
  "providers:send-input",
  "providers:resize",
  "providers:terminate",
  "approvals:resolve",
  "approvals:pending",
  "session:eventsSince",
  "review:list-changed-files",
  "review:load-diff",
  "checks:run",
  "checkpoints:create",
  "attempts:select-preferred",
  "commits:prepare",
  "dashboard:load"
];
