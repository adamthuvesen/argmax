import { ipcMain } from "electron";
import type { MaestroDatabase } from "./persistence/database.js";
import { ProjectService } from "./projects/projectRegistration.js";
import { WorkspaceService } from "./workspaces/workspaceOrchestration.js";
import { discoverProviders } from "./providers/providerDiscovery.js";
import type {
  CreateCurrentWorkspaceInput,
  CreateWorkspaceInput,
  RegisterProjectInput,
  UpdateProjectSettingsInput
} from "../shared/types.js";

export function registerIpcHandlers(database: MaestroDatabase): void {
  const projects = new ProjectService(database);
  const workspaces = new WorkspaceService(database);

  ipcMain.handle("health:ping", () => ({
    ok: true,
    timestamp: new Date().toISOString()
  }));

  ipcMain.handle("projects:list", () => database.listProjects());
  ipcMain.handle("projects:register", (_event, input: unknown) =>
    projects.registerProject(input as RegisterProjectInput)
  );
  ipcMain.handle("projects:update-settings", (_event, input: unknown) =>
    projects.updateSettings(input as UpdateProjectSettingsInput)
  );
  ipcMain.handle("workspaces:create-isolated", (_event, input: unknown) =>
    workspaces.createIsolatedWorkspace(input as CreateWorkspaceInput)
  );
  ipcMain.handle("workspaces:create-current", (_event, input: unknown) =>
    workspaces.createCurrentWorkspaceSession(input as CreateCurrentWorkspaceInput)
  );
  ipcMain.handle("workspaces:refresh-status", (_event, workspaceId: string) => workspaces.refreshGitStatus(workspaceId));
  ipcMain.handle("workspaces:keep", (_event, workspaceId: string) => workspaces.keepWorkspace(workspaceId));
  ipcMain.handle("workspaces:archive", (_event, workspaceId: string) => workspaces.archiveWorkspace(workspaceId));
  ipcMain.handle("providers:discover", () => discoverProviders());
  ipcMain.handle("dashboard:load", () => database.loadDashboard());
}
