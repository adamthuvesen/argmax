import { shell } from "electron";
import { z } from "zod";
import {
  gitCommitInputSchema,
  gitCreateBranchInputSchema,
  gitPushInputSchema,
  gitViewOrCreatePrInputSchema,
  type IpcChannel
} from "../../shared/ipcSchemas.js";
import type { GhService } from "../gh/ghService.js";
import type { GitOpsService } from "../git/gitOpsService.js";
import { withValidation } from "../ipc.js";
import { createIpcRegistrar } from "./registry.js";

/** Git + PR IPC handlers (Ralph SPEC D3 — third split). */
export function registerGitHandlers(
  ghService: GhService,
  gitOps: GitOpsService
): readonly IpcChannel[] {
  const { register, channels: registered } = createIpcRegistrar();

  register(
    "prs:list-for-session",
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
    "git:create-branch",
    withValidation(gitCreateBranchInputSchema, (input) => gitOps.createBranch(input))
  );
  register(
    "git:view-or-create-pr",
    withValidation(gitViewOrCreatePrInputSchema, async (input) => {
      const result = await gitOps.viewOrCreatePr(input);
      // Defer to Electron's default browser handler so the PR opens in the
      // user's chosen browser instead of a new Electron window.
      await shell.openExternal(result.url);
      return result;
    })
  );

  return registered;
}
