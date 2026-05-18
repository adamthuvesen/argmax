import { ipcMain } from "electron";
import {
  listBranchesInputSchema,
  registerProjectInputSchema,
  removeProjectInputSchema,
  switchBranchInputSchema,
  updateProjectSettingsInputSchema,
  type IpcChannel
} from "../../shared/ipcSchemas.js";
import type { ArgmaxDatabase } from "../persistence/database.js";
import type { ProjectService } from "../projects/projectRegistration.js";
import { runGitText } from "../git/exec.js";
import { timed } from "../util/ipcLatency.js";
import { withValidation } from "../ipc.js";

/** Project registration + branch IPC handlers (Ralph SPEC D3 — seventh split). */
export function registerProjectHandlers(
  database: ArgmaxDatabase,
  projects: ProjectService
): readonly IpcChannel[] {
  const registered: IpcChannel[] = [];
  const register = (channel: IpcChannel, listener: Parameters<typeof ipcMain.handle>[1]): void => {
    ipcMain.handle(channel, timed(channel, listener as (event: unknown, ...args: unknown[]) => unknown));
    registered.push(channel);
  };

  register(
    "projects:register",
    withValidation(registerProjectInputSchema, (input) => projects.registerProject(input))
  );
  register(
    "projects:remove",
    withValidation(removeProjectInputSchema, (input) => projects.removeProject(input))
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
      return raw
        .split("\n")
        .map((b) => b.replace(/^\*\s*/, "").trim())
        .filter(Boolean);
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

  return registered;
}
