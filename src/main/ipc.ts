import { ipcMain } from "electron";
import type { MaestroDatabase } from "./persistence/database.js";
import { ProjectService } from "./projects/projectRegistration.js";
import { WorkspaceService } from "./workspaces/workspaceOrchestration.js";
import { discoverProviders } from "./providers/providerDiscovery.js";
import { ProviderSessionService } from "./providers/providerSessionService.js";
import { GitReviewService } from "./review/gitReviewService.js";
import { CheckService } from "./checks/checkService.js";
import { CheckpointService } from "./review/checkpointService.js";
import { CommitPreparationService } from "./review/commitPreparationService.js";
import type {
  CreateCheckpointInput,
  CreateCurrentWorkspaceInput,
  CreateWorkspaceInput,
  LaunchProviderSessionInput,
  ProviderSessionInput,
  ProviderSessionResizeInput,
  PrepareCommitInput,
  RegisterProjectInput,
  ResolveApprovalInput,
  RunCheckInput,
  SelectPreferredAttemptInput,
  UpdateProjectSettingsInput
} from "../shared/types.js";

export function registerIpcHandlers(database: MaestroDatabase): void {
  const projects = new ProjectService(database);
  const workspaces = new WorkspaceService(database);
  const providerSessions = new ProviderSessionService(database);
  const review = new GitReviewService(database);
  const checks = new CheckService(database);
  const checkpoints = new CheckpointService(database);
  const commits = new CommitPreparationService(database);

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
  ipcMain.handle("providers:launch", (_event, input: unknown) =>
    providerSessions.launch(input as LaunchProviderSessionInput)
  );
  ipcMain.handle("providers:send-input", (_event, input: ProviderSessionInput) => {
    providerSessions.sendInput(input.sessionId, input.input);
    return { ok: true };
  });
  ipcMain.handle("providers:resize", (_event, input: ProviderSessionResizeInput) => {
    providerSessions.resize(input.sessionId, input.cols, input.rows);
    return { ok: true };
  });
  ipcMain.handle("providers:terminate", (_event, sessionId: string) => {
    providerSessions.terminate(sessionId);
    return { ok: true };
  });
  ipcMain.handle("approvals:resolve", (_event, input: ResolveApprovalInput) =>
    database.resolveApproval(input.approvalId, input.status)
  );
  ipcMain.handle("review:list-changed-files", (_event, workspaceId: string) => review.listChangedFiles(workspaceId));
  ipcMain.handle("review:load-diff", (_event, workspaceId: string, filePath?: string) =>
    review.loadDiff(workspaceId, filePath)
  );
  ipcMain.handle("checks:run", (_event, input: RunCheckInput) => checks.runWorkspaceCheck(input));
  ipcMain.handle("checkpoints:create", (_event, input: CreateCheckpointInput) => checkpoints.createCheckpoint(input));
  ipcMain.handle("attempts:select-preferred", (_event, input: SelectPreferredAttemptInput) =>
    database.selectPreferredAttempt(input.sessionId)
  );
  ipcMain.handle("commits:prepare", (_event, input: PrepareCommitInput) => commits.prepareCommit(input));
  ipcMain.handle("dashboard:load", () => database.loadDashboard());
}
