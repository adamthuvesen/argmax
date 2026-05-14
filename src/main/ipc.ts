import { dialog, ipcMain } from "electron";
import { ZodError, z, type ZodIssue, type ZodType } from "zod";
import {
  createCheckpointInputSchema,
  dashboardListInputSchema,
  dashboardLoadInputSchema,
  healthPingInputSchema,
  IPC_CHANNELS,
  projectsListInputSchema,
  projectsPickFolderInputSchema,
  registerProjectInputSchema,
  listBranchesInputSchema,
  switchBranchInputSchema,
  runCheckInputSchema,
  selectPreferredAttemptInputSchema,
  sessionCostSummaryInputSchema,
  sessionEventsSinceInputSchema,
  skillsListInputSchema,
  updateProjectSettingsInputSchema,
  type IpcChannel
} from "../shared/ipcSchemas.js";
import { registerApprovalsHandlers } from "./ipc/approvals.js";
import { registerGitHandlers } from "./ipc/git.js";
import { registerMcpHandlers } from "./ipc/mcp.js";
import { registerProviderHandlers } from "./ipc/providers.js";
import { registerReviewHandlers } from "./ipc/review.js";
import { registerSystemHandlers } from "./ipc/system.js";
import { registerTerminalHandlers } from "./ipc/terminal.js";
import { registerWorkspaceHandlers } from "./ipc/workspaces.js";
import type { ArgmaxDatabase } from "./persistence/database.js";
import { ProjectService } from "./projects/projectRegistration.js";
import { WorkspaceService } from "./workspaces/workspaceOrchestration.js";
import type { ProviderSessionService } from "./providers/providerSessionService.js";
import type { TerminalService } from "./terminal/terminalService.js";
import type { McpAuthService } from "./mcp/mcpAuthService.js";
import { GitReviewService } from "./review/gitReviewService.js";
import { WorkspaceFilesService } from "./files/workspaceFilesService.js";
import { CheckService } from "./checks/checkService.js";
import { CheckpointService } from "./review/checkpointService.js";
import { listSkills } from "./skills/skillRegistry.js";
import { runGitText } from "./git/exec.js";
import { GitOpsService } from "./git/gitOpsService.js";
import { GhService } from "./gh/ghService.js";
import { timed } from "./util/ipcLatency.js";

/**
 * Wraps an IPC handler body so its `input` is validated against a zod schema
 * before the handler runs. On a schema mismatch, throws an `Error` with
 * `code: "INVALID_INPUT"` and the zod `issues` attached so the renderer's
 * `invoke()` rejects with a structured payload instead of crashing inside
 * the service.
 *
 * Use as: `register("channel", withValidation(schema, (input) => ...))`.
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
 * Sibling of `withValidation` for handlers invoked positionally (e.g. via
 * `ipcRenderer.invoke("ch", a, b)`). Collects rest args into a tuple, runs
 * the supplied tuple schema, and forwards the parsed tuple to `fn`. Keeps
 * the INVALID_INPUT wrapping single-sourced so error shape stays consistent.
 */
export function withTupleValidation<TTuple extends readonly unknown[], TOut>(
  schema: ZodType<TTuple>,
  fn: (input: TTuple) => TOut | Promise<TOut>
): (event: unknown, ...rawArgs: unknown[]) => Promise<TOut> {
  return async (_event, ...rawArgs) => {
    let parsed: TTuple;
    try {
      parsed = schema.parse(rawArgs);
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
  database: ArgmaxDatabase,
  providerSessions: ProviderSessionService,
  terminals: TerminalService,
  mcpAuth: McpAuthService
): readonly string[] {
  const projects = new ProjectService(database);
  const workspaces = new WorkspaceService(database);
  const review = new GitReviewService(database);
  const workspaceFiles = new WorkspaceFilesService(database);
  const checks = new CheckService(database);
  const checkpoints = new CheckpointService(database);
  const ghService = new GhService(database);
  const gitOps = new GitOpsService(database, ghService);
  const registeredChannels: IpcChannel[] = [];
  const register = (channel: IpcChannel, listener: Parameters<typeof ipcMain.handle>[1]): void => {
    // SPEC P4.02 / P7.02 — every channel funnels through `timed()` so the
    // IPC latency histogram populates without needing per-call instrumentation.
    // The wrapper runs `performance.now()` deltas on both success and failure
    // paths; cost is one `Map.get` + one push on the hot path.
    ipcMain.handle(channel, timed(channel, listener as (event: unknown, ...args: unknown[]) => unknown));
    registeredChannels.push(channel);
  };

  register(
    "health:ping",
    withValidation(healthPingInputSchema, () => ({
      ok: true,
      timestamp: new Date().toISOString()
    }))
  );
  register("projects:list", withValidation(projectsListInputSchema, () => database.listProjects()));
  register(
    "projects:pick-folder",
    withValidation(projectsPickFolderInputSchema, async () => {
      const result = await dialog.showOpenDialog({
        properties: ["openDirectory"],
        title: "Add Project"
      });
      const [repoPath] = result.filePaths;
      if (result.canceled || !repoPath) {
        return { cancelled: true } as const;
      }

      return {
        cancelled: false,
        project: await projects.registerProject({ repoPath })
      } as const;
    })
  );
  register("dashboard:list", withValidation(dashboardListInputSchema, () => database.listDashboard()));
  register("dashboard:load", withValidation(dashboardLoadInputSchema, () => database.loadDashboard()));
  register(
    "projects:register",
    withValidation(registerProjectInputSchema, (input) => projects.registerProject(input))
  );
  register(
    "projects:update-settings",
    withValidation(updateProjectSettingsInputSchema, (input) => projects.updateSettings(input))
  );
  register(
    "projects:list-branches",
    withValidation(listBranchesInputSchema, async (input) => {
      const project = database.getProject(input.projectId);
      const raw = await runGitText(project.repoPath, ["branch"]);
      return raw.split("\n").map((b) => b.replace(/^\*\s*/, "").trim()).filter(Boolean);
    })
  );
  register(
    "projects:switch-branch",
    withValidation(switchBranchInputSchema, async (input) => {
      const project = database.getProject(input.projectId);
      // `--` separator after the user-controlled ref so git cannot mistake a
      // future input value for a flag or a pathspec. zod also rejects leading
      // dashes via gitRefSchema; the separator is defense-in-depth.
      await runGitText(project.repoPath, ["checkout", input.branch, "--"]);
      return database.updateProjectBranch(input.projectId, input.branch);
    })
  );
  for (const channel of registerWorkspaceHandlers(database, workspaces, checks)) {
    registeredChannels.push(channel);
  }
  for (const channel of registerSystemHandlers(database)) {
    registeredChannels.push(channel);
  }
  for (const channel of registerMcpHandlers(mcpAuth)) {
    registeredChannels.push(channel);
  }
  register(
    "learnings:list",
    withValidation(z.object({ projectId: z.string().min(1), limit: z.number().int().min(1).max(200).optional() }), (input) =>
      database.listLearnings(input.projectId, input.limit)
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
  for (const channel of registerGitHandlers(ghService, gitOps)) {
    registeredChannels.push(channel);
  }
  for (const channel of registerProviderHandlers(providerSessions)) {
    registeredChannels.push(channel);
  }
  for (const channel of registerTerminalHandlers(terminals)) {
    registeredChannels.push(channel);
  }
  for (const channel of registerApprovalsHandlers(database)) {
    registeredChannels.push(channel);
  }
  register(
    "session:eventsSince",
    withValidation(sessionEventsSinceInputSchema, (input) => database.listSessionEventsSince(input))
  );
  // Cost & token transparency (additive — see SPEC_COST_TRANSPARENCY.md)
  register(
    "session:costSummary",
    withValidation(sessionCostSummaryInputSchema, (input) => database.getSessionCostSummary(input.sessionId))
  );
  for (const channel of registerReviewHandlers(review, workspaceFiles)) {
    registeredChannels.push(channel);
  }
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

  return registeredChannels;
}

/**
 * Channel names registered by `registerIpcHandlers`. Derived from `ipcSchemas`
 * so adding a new channel only requires adding it to the schema map.
 */
export const REGISTERED_IPC_CHANNELS: readonly IpcChannel[] = IPC_CHANNELS;

// `resolveDefaultIde` now lives in `./ipc/workspaces.ts` alongside the
// workspaces:openInIde handler that uses it.
export { resolveDefaultIde } from "./ipc/workspaces.js";
