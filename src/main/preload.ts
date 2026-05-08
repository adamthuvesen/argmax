import { contextBridge, ipcRenderer } from "electron";
import type {
  DashboardSnapshot,
  CreateCurrentWorkspaceInput,
  CreateWorkspaceInput,
  MaestroApi,
  ProjectSummary,
  RegisterProjectInput,
  UpdateProjectSettingsInput
} from "../shared/types.js";

const api: MaestroApi = {
  dashboard: {
    load: () => ipcRenderer.invoke("dashboard:load") as Promise<DashboardSnapshot>
  },
  projects: {
    list: () => ipcRenderer.invoke("projects:list") as Promise<ProjectSummary[]>,
    register: (input: RegisterProjectInput) => ipcRenderer.invoke("projects:register", input) as Promise<ProjectSummary>,
    updateSettings: (input: UpdateProjectSettingsInput) =>
      ipcRenderer.invoke("projects:update-settings", input) as Promise<ProjectSummary>
  },
  workspaces: {
    createIsolated: (input: CreateWorkspaceInput) =>
      ipcRenderer.invoke("workspaces:create-isolated", input) as Promise<DashboardSnapshot["workspaces"][number]>,
    createCurrent: (input: CreateCurrentWorkspaceInput) =>
      ipcRenderer.invoke("workspaces:create-current", input) as Promise<DashboardSnapshot["workspaces"][number]>,
    refreshStatus: (workspaceId: string) =>
      ipcRenderer.invoke("workspaces:refresh-status", workspaceId) as Promise<DashboardSnapshot["workspaces"][number]>,
    keep: (workspaceId: string) =>
      ipcRenderer.invoke("workspaces:keep", workspaceId) as Promise<DashboardSnapshot["workspaces"][number]>,
    archive: (workspaceId: string) =>
      ipcRenderer.invoke("workspaces:archive", workspaceId) as Promise<DashboardSnapshot["workspaces"][number]>
  },
  providers: {
    discover: () => ipcRenderer.invoke("providers:discover") as Promise<unknown[]>
  },
  health: {
    ping: () => ipcRenderer.invoke("health:ping") as Promise<{ ok: true; timestamp: string }>
  }
};

contextBridge.exposeInMainWorld("maestro", api);
