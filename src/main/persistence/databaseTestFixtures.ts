import type { ArgmaxDatabase } from "./database.js";
import type { ProjectSettings, WorkspaceState } from "../../shared/types.js";

export const testProjectSettings: ProjectSettings = {
  defaultProvider: "codex",
  defaultModelLabel: "GPT-5.3 Codex Spark Low",
  worktreeLocation: "/tmp/wt",
  setupCommand: "",
  checkCommands: []
};

export function seedProject(database: ArgmaxDatabase, projectId = "p-1"): string {
  database.persistProject({
    id: projectId,
    name: `proj-${projectId}`,
    repoPath: `/tmp/repo-${projectId}`,
    currentBranch: "main",
    defaultBranch: "main",
    settings: testProjectSettings
  });
  return projectId;
}

export function seedWorkspace(
  database: ArgmaxDatabase,
  workspaceId: string,
  projectId: string,
  state: WorkspaceState,
  taskLabel = workspaceId
): void {
  database.persistWorkspace({
    id: workspaceId,
    projectId,
    taskLabel,
    branch: `branch-${workspaceId}`,
    baseRef: "main",
    path: `/tmp/${workspaceId}`,
    state,
    sharedWorkspace: false,
    dirty: false,
    changedFiles: 0
  });
}

export function seedSession(
  database: ArgmaxDatabase,
  sessionId: string,
  workspaceId: string,
  attention: "normal" | "approval-needed" | "blocked" | "failed" | "review-ready" = "normal"
): void {
  database.persistSession({
    id: sessionId,
    workspaceId,
    provider: "codex",
    modelLabel: "x",
    modelId: "gpt-5.3-codex",
    reasoningEffort: "medium",
    prompt: "p",
    state: "running",
    attention
  });
}
