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
  gitCommitInputSchema,
  gitCreateBranchInputSchema,
  gitPushInputSchema,
  gitViewOrCreatePrInputSchema,
  healthPingInputSchema,
  IPC_CHANNELS,
  launchProviderSessionInputSchema,
  listDetectedIdesInputSchema,
  loadDiffInputSchema,
  loadDiffForProjectInputSchema,
  mcpAuthResizeInputSchema,
  mcpAuthStartInputSchema,
  mcpAuthTerminateInputSchema,
  mcpAuthWriteInputSchema,
  openInIdeInputSchema,
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
  terminalResizeInputSchema,
  terminalSpawnInputSchema,
  terminalTerminateInputSchema,
  terminalWriteInputSchema,
  updateProjectSettingsInputSchema,
  workspaceListFilesInputSchema,
  workspaceListFilesForProjectInputSchema,
  workspaceReadFileInputSchema,
  workspaceReadFileForProjectInputSchema,
  reviewListChangedFilesForProjectInputSchema,
  workspaceStatFileInputSchema,
  workspaceWriteFileInputSchema,
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
import type { TerminalService } from "./terminal/terminalService.js";
import type { McpAuthService } from "./mcp/mcpAuthService.js";
import { GitReviewService } from "./review/gitReviewService.js";
import { WorkspaceFilesService } from "./files/workspaceFilesService.js";
import { CheckService } from "./checks/checkService.js";
import { CheckpointService } from "./review/checkpointService.js";
import { listSkills } from "./skills/skillRegistry.js";
import { listMcpServers } from "./mcp/mcpRegistry.js";
import { runGitText } from "./git/exec.js";
import { GitOpsService } from "./git/gitOpsService.js";
import { GhService } from "./gh/ghService.js";
import { readPhases as readStartupPhases } from "./util/startupTimer.js";
import { readHistogram as readIpcHistogram, timed } from "./util/ipcLatency.js";
import { readLogBuffer } from "../shared/logger.js";
import { statSync } from "node:fs";
import type { DatabaseStats } from "../shared/types.js";

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
  register("providers:discover", withValidation(providersDiscoverInputSchema, () => discoverProviders()));

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
    withValidation(workspaceIdInputSchema, (workspaceId) => {
      checks.cancelWorkspaceChecks(workspaceId);
      return workspaces.archiveWorkspace(workspaceId);
    })
  );
  register(
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
  register(
    "system:listDetectedIdes",
    withValidation(listDetectedIdesInputSchema, () => detectInstalledIdes())
  );
  register("system:diagnostics", withValidation(z.void(), () => {
    const require = createRequire(import.meta.url);
    const pkg = require("../../package.json") as { version?: string };
    let sqliteVersion = "";
    try {
      const row = database.connection.prepare("SELECT sqlite_version() AS v").get() as { v: string };
      sqliteVersion = row.v;
    } catch {
      sqliteVersion = "unknown";
    }
    const databasePath = app.getPath("userData") + "/local-state/argmax.sqlite";
    return {
      appVersion: pkg.version ?? "0.0.0",
      electronVersion: process.versions.electron ?? "",
      nodeVersion: process.versions.node,
      sqliteVersion,
      databasePath,
      platform: process.platform,
      arch: process.arch,
      generatedAt: new Date().toISOString(),
      startupPhases: readStartupPhases(),
      databaseStats: collectDatabaseStats(database, databasePath),
      ipcStats: readIpcHistogram(),
      // Tail the most recent 200 entries. The buffer caps at 1000; the panel
      // only needs the recent slice and a 200-row table stays scannable.
      recentLogs: readLogBuffer().slice(-200)
    };
  }));
  register("system:vacuumDatabase", withValidation(z.void(), () => {
    database.connection.exec("VACUUM");
    return { ok: true } as const;
  }));
  register("mcp:list", withValidation(z.void(), () => listMcpServers()));
  register(
    "mcp:auth:start",
    withValidation(mcpAuthStartInputSchema, (input) => mcpAuth.start(input))
  );
  register(
    "mcp:auth:write",
    withValidation(mcpAuthWriteInputSchema, (input) => {
      mcpAuth.write(input);
      return { ok: true } as const;
    })
  );
  register(
    "mcp:auth:resize",
    withValidation(mcpAuthResizeInputSchema, (input) => {
      mcpAuth.resize(input);
      return { ok: true } as const;
    })
  );
  register(
    "mcp:auth:terminate",
    withValidation(mcpAuthTerminateInputSchema, (sessionId) => {
      mcpAuth.terminate(sessionId);
      return { ok: true } as const;
    })
  );
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
  register(
    "workspaces:set-pinned",
    withValidation(
      z.object({ workspaceId: z.string().min(1), pinned: z.boolean() }),
      (input) => database.setWorkspacePinned(input.workspaceId, input.pinned)
    )
  );
  register(
    "prs:listForSession",
    withValidation(z.object({ sessionId: z.string().min(1) }), (input) =>
      ghService.listForSession(input.sessionId)
    )
  );
  register(
    "prs:refresh",
    withValidation(z.object({ sessionId: z.string().min(1) }), (input) => ghService.refresh(input.sessionId))
  );
  register(
    "git:commit",
    withValidation(gitCommitInputSchema, (input) => gitOps.commitAll(input))
  );
  register(
    "git:push",
    withValidation(gitPushInputSchema, (input) => gitOps.push(input))
  );
  register(
    "git:createBranch",
    withValidation(gitCreateBranchInputSchema, (input) => gitOps.createBranch(input))
  );
  register(
    "git:viewOrCreatePr",
    withValidation(gitViewOrCreatePrInputSchema, async (input) => {
      const result = await gitOps.viewOrCreatePr(input);
      // Defer to Electron's default browser handler so the PR opens in the
      // user's chosen browser instead of a new Electron window.
      await shell.openExternal(result.url);
      return result;
    })
  );
  register(
    "workspace:status",
    withValidation(workspaceStatusInputSchema, (input) => database.listWorkspaceStatus(input))
  );
  register(
    "providers:launch",
    withValidation(launchProviderSessionInputSchema, (input) => providerSessions.launch(input))
  );
  register(
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
  register(
    "providers:resize",
    withValidation(providerSessionResizeInputSchema, (input) => {
      providerSessions.resize(input.sessionId, input.cols, input.rows);
      return { ok: true } as const;
    })
  );
  register(
    "providers:terminate",
    withValidation(providerSessionTerminateInputSchema, async (sessionId) => {
      await providerSessions.terminate(sessionId);
      return { ok: true } as const;
    })
  );
  register(
    "terminal:spawn",
    withValidation(terminalSpawnInputSchema, (input) => terminals.spawn(input))
  );
  register(
    "terminal:write",
    withValidation(terminalWriteInputSchema, (input) => {
      terminals.write(input);
      return { ok: true } as const;
    })
  );
  register(
    "terminal:resize",
    withValidation(terminalResizeInputSchema, (input) => {
      terminals.resize(input);
      return { ok: true } as const;
    })
  );
  register(
    "terminal:terminate",
    withValidation(terminalTerminateInputSchema, (terminalId) => {
      terminals.terminate(terminalId);
      return { ok: true } as const;
    })
  );
  register(
    "approvals:resolve",
    withValidation(resolveApprovalInputSchema, (input) => database.resolveApproval(input.approvalId, input.status))
  );
  register("approvals:pending", withValidation(approvalsPendingInputSchema, () => database.listPendingApprovals()));
  register(
    "session:eventsSince",
    withValidation(sessionEventsSinceInputSchema, (input) => database.listSessionEventsSince(input))
  );
  // Cost & token transparency (additive — see SPEC_COST_TRANSPARENCY.md)
  register(
    "session:costSummary",
    withValidation(sessionCostSummaryInputSchema, (input) => database.getSessionCostSummary(input.sessionId))
  );
  register(
    "review:list-changed-files",
    withValidation(workspaceIdInputSchema, (workspaceId) => review.listChangedFiles(workspaceId))
  );
  // `review:load-diff` is invoked positionally as (workspaceId, filePath?).
  register(
    "review:load-diff",
    withTupleValidation(loadDiffInputSchema, ([workspaceId, filePath]) => review.loadDiff(workspaceId, filePath))
  );
  register(
    "review:list-changed-files-for-project",
    withValidation(reviewListChangedFilesForProjectInputSchema, (projectId) =>
      review.listChangedFilesForProject(projectId)
    )
  );
  // Mirrors `review:load-diff`'s positional invocation — `(projectId, filePath?)`.
  register(
    "review:load-diff-for-project",
    withTupleValidation(loadDiffForProjectInputSchema, ([projectId, filePath]) =>
      review.loadDiffForProject(projectId, filePath)
    )
  );
  register(
    "workspace:list-files",
    withValidation(workspaceListFilesInputSchema, (input) => workspaceFiles.listFiles(input.workspaceId))
  );
  register(
    "workspace:read-file",
    withValidation(workspaceReadFileInputSchema, (input) => workspaceFiles.readFile(input.workspaceId, input.filePath))
  );
  register(
    "workspace:list-files-for-project",
    withValidation(workspaceListFilesForProjectInputSchema, (input) =>
      workspaceFiles.listFilesForProject(input.projectId)
    )
  );
  register(
    "workspace:read-file-for-project",
    withValidation(workspaceReadFileForProjectInputSchema, (input) =>
      workspaceFiles.readFileForProject(input.projectId, input.filePath)
    )
  );
  register(
    "workspace:write-file",
    withValidation(workspaceWriteFileInputSchema, (input) =>
      workspaceFiles.writeFile(input.workspaceId, input.filePath, input.content, input.expectedMtimeMs)
    )
  );
  register(
    "workspace:stat-file",
    withValidation(workspaceStatFileInputSchema, (input) =>
      workspaceFiles.statFile(input.workspaceId, input.filePath)
    )
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

/**
 * Fallback when the renderer asks main to "open in default IDE" but the
 * caller has not yet persisted a preference (`localStorage["argmax.defaultIde"]`
 * is empty). Order matches the user-facing chevron menu: GUI IDEs first, then
 * Terminal. If somehow the detected list is empty the renderer should already
 * have disabled the button, so we throw a useful error instead of guessing.
 */
const DEFAULT_IDE_PRIORITY: readonly IdeId[] = ["vscode", "cursor", "windsurf", "zed", "iterm", "terminal"];

/**
 * SPEC P7.03 — collect database health stats for Diagnostics → Database.
 * Per-table row counts, WAL sidecar size, and the configured
 * `wal_autocheckpoint` pragma. All reads are cheap (`COUNT(*)` against
 * indexed tables, single pragma read, single `fs.stat`).
 */
function collectDatabaseStats(database: ArgmaxDatabase, databasePath: string): DatabaseStats {
  const count = (table: string): number => {
    try {
      const row = database.connection.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number };
      return row.n;
    } catch {
      return 0;
    }
  };
  let walBytes = 0;
  try {
    walBytes = statSync(`${databasePath}-wal`).size;
  } catch {
    /* sidecar missing or unreadable */
  }
  let walAutocheckpoint = 0;
  try {
    walAutocheckpoint = Number(database.connection.pragma("wal_autocheckpoint", { simple: true })) || 0;
  } catch {
    /* pragma read failed */
  }
  return {
    rowCounts: {
      projects: count("projects"),
      workspaces: count("workspaces"),
      sessions: count("sessions"),
      events: count("events"),
      rawOutputs: count("raw_outputs"),
      approvals: count("approvals"),
      checks: count("checks"),
      checkpoints: count("checkpoints"),
      learnings: count("learnings"),
      usageEvents: count("usage_events")
    },
    walBytes,
    walAutocheckpoint
  };
}

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
