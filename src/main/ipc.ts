import { app, dialog, ipcMain, shell } from "electron";
import { isAbsolute, resolve as resolvePath } from "node:path";
import { ZodError, z, type ZodIssue, type ZodType } from "zod";
import { createRequire } from "node:module";
import {
  createCheckpointInputSchema,
  createCurrentWorkspaceInputSchema,
  createWorkspaceInputSchema,
  approvalsPendingInputSchema,
  dashboardListInputSchema,
  dashboardLoadInputSchema,
  healthPingInputSchema,
  IPC_CHANNELS,
  launchProviderSessionInputSchema,
  listDetectedIdesInputSchema,
  loadDiffInputSchema,
  openInIdeInputSchema,
  prepareCommitInputSchema,
  projectsListInputSchema,
  providersDiscoverInputSchema,
  providerSessionInputSchema,
  providerSessionResizeInputSchema,
  providerSessionTerminateInputSchema,
  projectsPickFolderInputSchema,
  registerProjectInputSchema,
  listBranchesInputSchema,
  switchBranchInputSchema,
  resolveApprovalInputSchema,
  runCheckInputSchema,
  selectPreferredAttemptInputSchema,
  sessionCostSummaryInputSchema,
  sessionEventsSinceInputSchema,
  skillsListInputSchema,
  systemOpenPathInputSchema,
  updateProjectSettingsInputSchema,
  workspaceListFilesInputSchema,
  workspaceReadFileInputSchema,
  workspaceStatusInputSchema,
  workspaceIdInputSchema,
  type IpcChannel
} from "../shared/ipcSchemas.js";
import { detectInstalledIdes } from "./ide/ideDetection.js";
import { launchIde } from "./ide/ideLaunch.js";
import type { DetectedIde, IdeId } from "../shared/types.js";
import type { ArgmaxDatabase } from "./persistence/database.js";
import { ProjectService } from "./projects/projectRegistration.js";
import { WorkspaceService } from "./workspaces/workspaceOrchestration.js";
import { discoverProviders } from "./providers/providerDiscovery.js";
import type { ProviderSessionService } from "./providers/providerSessionService.js";
import { GitReviewService } from "./review/gitReviewService.js";
import { WorkspaceFilesService } from "./files/workspaceFilesService.js";
import { CheckService } from "./checks/checkService.js";
import { CheckpointService } from "./review/checkpointService.js";
import { CommitPreparationService } from "./review/commitPreparationService.js";
import { listSkills } from "./skills/skillRegistry.js";
import { runGitText } from "./git/exec.js";

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
  providerSessions: ProviderSessionService
): readonly string[] {
  const projects = new ProjectService(database);
  const workspaces = new WorkspaceService(database);
  const review = new GitReviewService(database);
  const workspaceFiles = new WorkspaceFilesService(database);
  const checks = new CheckService(database);
  const checkpoints = new CheckpointService(database);
  const commits = new CommitPreparationService(database);

  ipcMain.handle(
    "health:ping",
    withValidation(healthPingInputSchema, () => ({
      ok: true,
      timestamp: new Date().toISOString()
    }))
  );
  ipcMain.handle("projects:list", withValidation(projectsListInputSchema, () => database.listProjects()));
  ipcMain.handle(
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
  ipcMain.handle("dashboard:list", withValidation(dashboardListInputSchema, () => database.listDashboard()));
  ipcMain.handle("dashboard:load", withValidation(dashboardLoadInputSchema, () => database.loadDashboard()));
  ipcMain.handle("providers:discover", withValidation(providersDiscoverInputSchema, () => discoverProviders()));

  ipcMain.handle(
    "projects:register",
    withValidation(registerProjectInputSchema, (input) => projects.registerProject(input))
  );
  ipcMain.handle(
    "projects:update-settings",
    withValidation(updateProjectSettingsInputSchema, (input) => projects.updateSettings(input))
  );
  ipcMain.handle(
    "projects:list-branches",
    withValidation(listBranchesInputSchema, async (input) => {
      const project = database.getProject(input.projectId);
      const raw = await runGitText(project.repoPath, ["branch"]);
      return raw.split("\n").map((b) => b.replace(/^\*\s*/, "").trim()).filter(Boolean);
    })
  );
  ipcMain.handle(
    "projects:switch-branch",
    withValidation(switchBranchInputSchema, async (input) => {
      const project = database.getProject(input.projectId);
      await runGitText(project.repoPath, ["checkout", input.branch]);
      return database.updateProjectBranch(input.projectId, input.branch);
    })
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
    "workspaces:openInIde",
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
  ipcMain.handle(
    "system:listDetectedIdes",
    withValidation(listDetectedIdesInputSchema, () => detectInstalledIdes())
  );
  ipcMain.handle("system:diagnostics", withValidation(z.void(), () => {
    const require = createRequire(import.meta.url);
    const pkg = require("../../package.json") as { version?: string };
    let sqliteVersion = "";
    try {
      const row = database.connection.prepare("SELECT sqlite_version() AS v").get() as { v: string };
      sqliteVersion = row.v;
    } catch {
      sqliteVersion = "unknown";
    }
    return {
      appVersion: pkg.version ?? "0.0.0",
      electronVersion: process.versions.electron ?? "",
      nodeVersion: process.versions.node,
      sqliteVersion,
      databasePath: app.getPath("userData") + "/local-state/argmax.sqlite",
      platform: process.platform,
      arch: process.arch,
      generatedAt: new Date().toISOString()
    };
  }));
  ipcMain.handle("system:vacuumDatabase", withValidation(z.void(), () => {
    database.connection.exec("VACUUM");
    return { ok: true } as const;
  }));
  ipcMain.handle(
    "learnings:list",
    withValidation(z.object({ projectId: z.string().min(1), limit: z.number().int().min(1).max(200).optional() }), (input) =>
      database.listLearnings(input.projectId, input.limit)
    )
  );
  ipcMain.handle(
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
  ipcMain.handle(
    "learnings:delete",
    withValidation(z.object({ id: z.string().min(1) }), (input) => {
      database.deleteLearning(input.id);
      return { ok: true } as const;
    })
  );
  ipcMain.handle(
    "session:search",
    withValidation(
      z.object({ query: z.string().min(1).max(200), limit: z.number().int().min(1).max(200).optional() }),
      (input) => database.searchEvents(input)
    )
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
      await providerSessions.sendInput(
        input.sessionId,
        input.input,
        input.modelLabel && input.modelId
          ? {
              modelLabel: input.modelLabel,
              modelId: input.modelId,
              ...(input.reasoningEffort ? { reasoningEffort: input.reasoningEffort } : {})
            }
          : undefined
      );
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
  // Cost & token transparency (additive — see SPEC_COST_TRANSPARENCY.md)
  ipcMain.handle(
    "session:costSummary",
    withValidation(sessionCostSummaryInputSchema, (input) => database.getSessionCostSummary(input.sessionId))
  );
  ipcMain.handle(
    "review:list-changed-files",
    withValidation(workspaceIdInputSchema, (workspaceId) => review.listChangedFiles(workspaceId))
  );
  // `review:load-diff` is invoked positionally as (workspaceId, filePath?).
  ipcMain.handle(
    "review:load-diff",
    withTupleValidation(loadDiffInputSchema, ([workspaceId, filePath]) => review.loadDiff(workspaceId, filePath))
  );
  ipcMain.handle(
    "workspace:list-files",
    withValidation(workspaceListFilesInputSchema, (input) => workspaceFiles.listFiles(input.workspaceId))
  );
  ipcMain.handle(
    "workspace:read-file",
    withValidation(workspaceReadFileInputSchema, (input) => workspaceFiles.readFile(input.workspaceId, input.filePath))
  );
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
  ipcMain.handle(
    "system:open-path",
    withValidation(systemOpenPathInputSchema, async (input) => {
      const target = isAbsolute(input.path)
        ? input.path
        : input.cwd
          ? resolvePath(input.cwd, input.path)
          : input.path;
      const error = await shell.openPath(target);
      if (error) throw new Error(error);
      return { ok: true } as const;
    })
  );
  ipcMain.handle(
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

  return REGISTERED_IPC_CHANNELS;
}

/**
 * Channel names registered by `registerIpcHandlers`. Derived from `ipcSchemas`
 * so adding a new channel only requires adding it to the schema map.
 */
export const REGISTERED_IPC_CHANNELS: readonly IpcChannel[] = IPC_CHANNELS;

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
  // Detected has at least one entry whose id is one of the schema-allowed
  // values, so this is unreachable in practice. We narrow to a concrete
  // IdeId anyway to keep the return type honest.
  const first = detected[0];
  if (!first) {
    throw new Error("No IDEs detected on this machine.");
  }
  return first.id;
}
