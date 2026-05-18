import { dialog, ipcMain } from "electron";
import { ZodError, type ZodIssue, type ZodType } from "zod";
import {
  dashboardListInputSchema,
  dashboardLoadInputSchema,
  healthPingInputSchema,
  IPC_CHANNELS,
  projectsListInputSchema,
  projectsPickFolderInputSchema,
  type IpcChannel
} from "../shared/ipcSchemas.js";
import { registerApprovalsHandlers } from "./ipc/approvals.js";
import { registerAttachmentHandlers } from "./ipc/attachments.js";
import { registerGitHandlers } from "./ipc/git.js";
import { registerMcpHandlers } from "./ipc/mcp.js";
import { registerProjectHandlers } from "./ipc/projects.js";
import { registerProviderHandlers } from "./ipc/providers.js";
import { registerReviewHandlers } from "./ipc/review.js";
import { registerSessionHandlers } from "./ipc/sessions.js";
import { registerSystemHandlers } from "./ipc/system.js";
import { registerTerminalHandlers } from "./ipc/terminal.js";
import { registerTournamentHandlers } from "./ipc/tournaments.js";
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
import { GitOpsService } from "./git/gitOpsService.js";
import { GhService } from "./gh/ghService.js";
import { TournamentService } from "./tournaments/tournamentService.js";
import { AttachmentStore } from "./attachments/attachmentStore.js";
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
  const workspaces = new WorkspaceService(database);
  const attachments = new AttachmentStore();
  const projects = new ProjectService(database, workspaces, attachments);
  const review = new GitReviewService(database);
  const workspaceFiles = new WorkspaceFilesService(database);
  const checks = new CheckService(database);
  const checkpoints = new CheckpointService(database);
  const ghService = new GhService(database);
  const gitOps = new GitOpsService(database, ghService);
  const tournaments = new TournamentService(database, providerSessions, workspaces, checks);
  // Same idea as providerSessions.recoverOrphanedSessions(): tournaments that
  // entered 'judging' before a crash have partial scores and no verdict.
  // Reset them to 'running' so the next refreshAndJudgeIfReady drives the
  // judge pipeline idempotently. Best-effort so a partial database in tests
  // (which pass stub objects) doesn't block IPC registration.
  try {
    tournaments.recoverStuckJudgingTournaments();
  } catch {
    /* boot-time reconciler is non-critical; first IPC call retries on demand. */
  }
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
  register(
    "dashboard:load",
    withValidation(dashboardLoadInputSchema, () => {
      const snapshot = database.loadDashboard();
      // The queued-follow-up map lives in main memory (not SQLite), so the
      // dashboard snapshot has to merge it in at the IPC boundary rather than
      // at the database layer. Empty object stays empty — no allocation noise.
      const pendingMessages = providerSessions.getAllPendingMessages();
      return {
        ...snapshot,
        ...(Object.keys(pendingMessages).length > 0 ? { pendingMessages } : {})
      };
    })
  );
  for (const channel of registerProjectHandlers(database, projects)) {
    registeredChannels.push(channel);
  }
  for (const channel of registerWorkspaceHandlers(database, workspaces, checks)) {
    registeredChannels.push(channel);
  }
  for (const channel of registerSystemHandlers(database)) {
    registeredChannels.push(channel);
  }
  for (const channel of registerMcpHandlers(mcpAuth)) {
    registeredChannels.push(channel);
  }
  for (const channel of registerSessionHandlers(database, checks, checkpoints)) {
    registeredChannels.push(channel);
  }
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
  for (const channel of registerReviewHandlers(review, workspaceFiles)) {
    registeredChannels.push(channel);
  }
  for (const channel of registerTournamentHandlers(tournaments)) {
    registeredChannels.push(channel);
  }
  for (const channel of registerAttachmentHandlers(attachments)) {
    registeredChannels.push(channel);
  }

  return registeredChannels;
}

/**
 * Channel names registered by `registerIpcHandlers`. Derived from `ipcSchemas`
 * so adding a new channel only requires adding it to the schema map.
 */
export const REGISTERED_IPC_CHANNELS: readonly IpcChannel[] = IPC_CHANNELS;

// `resolveDefaultIde` now lives in `./ipc/workspaces.ts` alongside the
// workspaces:open-in-ide handler that uses it.
export { resolveDefaultIde } from "./ipc/workspaces.js";
