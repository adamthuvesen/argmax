import { Folder, MessageSquare, Plus, Search, Settings, Square } from "lucide-react";
import type { PaletteCommand } from "../components/CommandPalette.js";
import type { DashboardSnapshot, SessionSummary } from "../../shared/types.js";
import { titleFromPrompt } from "./projects.js";
import { collapseHome } from "./pathDisplay.js";

export type BuildPaletteCommandsInput = {
  snapshot: DashboardSnapshot;
  selectedSession: SessionSummary | null;
  onNewSession: () => void;
  onOpenSettings: () => void;
  onOpenSearch: () => void;
  onStopSession: (sessionId: string) => void;
  onOpenWorkspace: (workspaceId: string) => void;
  onSelectProject: (projectId: string) => void;
  onClearGrid: () => void;
  onCloseOverlays?: () => void;
};

export function buildPaletteCommands(input: BuildPaletteCommandsInput): PaletteCommand[] {
  const {
    snapshot,
    selectedSession,
    onNewSession,
    onOpenSettings,
    onOpenSearch,
    onStopSession,
    onOpenWorkspace,
    onSelectProject,
    onClearGrid,
    onCloseOverlays
  } = input;
  const closeOverlays = (): void => {
    onCloseOverlays?.();
  };

  const actions: PaletteCommand[] = [
    {
      id: "action:new-session",
      label: "New Session",
      subtitle: "Open the launcher",
      group: "Actions",
      icon: Plus,
      run: onNewSession
    },
    {
      id: "action:open-settings",
      label: "Open Settings",
      subtitle: "Defaults, providers, tools",
      group: "Actions",
      icon: Settings,
      run: onOpenSettings
    },
    {
      id: "action:search-sessions",
      label: "Search Sessions",
      subtitle: "Full-text search across every session timeline",
      group: "Actions",
      icon: Search,
      run: onOpenSearch
    },
    ...(selectedSession && selectedSession.state === "running"
      ? [
          {
            id: "action:stop-session",
            label: "Stop Current Session",
            subtitle: selectedSession.modelLabel,
            group: "Actions" as const,
            icon: Square,
            run: () => onStopSession(selectedSession.id)
          }
        ]
      : [])
  ];

  const workspaceById = new Map(snapshot.workspaces.map((workspace) => [workspace.id, workspace]));
  const projectById = new Map(snapshot.projects.map((project) => [project.id, project]));

  const sessions: PaletteCommand[] = snapshot.sessions.slice(0, 40).map((session) => {
    const workspace = workspaceById.get(session.workspaceId) ?? null;
    const project = workspace ? projectById.get(workspace.projectId) ?? null : null;
    const label = workspace?.taskLabel || titleFromPrompt(session.prompt) || session.modelLabel;
    const parts: string[] = [];
    if (project) parts.push(project.name);
    if (workspace?.branch) parts.push(workspace.branch);
    parts.push(session.modelLabel, session.state);
    return {
      id: `session:${session.id}`,
      label,
      subtitle: parts.filter(Boolean).join(" · "),
      group: "Sessions",
      icon: MessageSquare,
      run: () => {
        closeOverlays();
        onOpenWorkspace(session.workspaceId);
      }
    };
  });

  const projects: PaletteCommand[] = snapshot.projects.slice(0, 40).map((project) => ({
    id: `project:${project.id}`,
    label: project.name,
    subtitle: [project.currentBranch, collapseHome(project.repoPath)].filter(Boolean).join(" · "),
    group: "Projects",
    icon: Folder,
    run: () => {
      closeOverlays();
      onSelectProject(project.id);
      onClearGrid();
    }
  }));

  return [...actions, ...sessions, ...projects];
}

export function buildSessionLabelById(snapshot: DashboardSnapshot): Map<string, string> {
  const workspaceById = new Map(snapshot.workspaces.map((workspace) => [workspace.id, workspace]));
  const projectById = new Map(snapshot.projects.map((project) => [project.id, project]));
  const map = new Map<string, string>();
  for (const session of snapshot.sessions) {
    const workspace = workspaceById.get(session.workspaceId) ?? null;
    const project = workspace ? projectById.get(workspace.projectId) ?? null : null;
    const taskLabel = workspace?.taskLabel || titleFromPrompt(session.prompt) || session.modelLabel;
    map.set(session.id, project ? `${project.name} · ${taskLabel}` : taskLabel);
  }
  return map;
}
