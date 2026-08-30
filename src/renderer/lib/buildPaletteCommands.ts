import {
  Clock,
  Folder,
  MessageSquare,
  Plus,
  Search,
  Settings,
  SlidersHorizontal,
  Square
} from "lucide-react";
import type { PaletteCommand } from "../components/CommandPalette.js";
import { SCRATCH_PROJECT_ID, type DashboardSnapshot, type SessionSummary } from "../../shared/types.js";
import { SETTINGS_GROUPS, type SettingsGroupId } from "../components/settings/settingsMeta.js";
import { titleFromPrompt } from "./projects.js";
import { collapseHome } from "./pathDisplay.js";

export type BuildPaletteCommandsInput = {
  snapshot: DashboardSnapshot;
  selectedSession: SessionSummary | null;
  onNewSession: () => void;
  onOpenSettings: () => void;
  onOpenScheduledTasks: () => void;
  /** Jumps straight to one settings section — feeds the palette's Settings scope. */
  onOpenSettingsSection: (group: SettingsGroupId, sectionId: string) => void;
  /** Reopens the palette on its Messages tab — the mouse path to ⌘F. */
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
    onOpenScheduledTasks,
    onOpenSettingsSection,
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
      id: "action:open-scheduled-tasks",
      label: "Open Schedule",
      subtitle: "Prompts Argmax runs on a schedule",
      group: "Actions",
      icon: Clock,
      run: onOpenScheduledTasks
    },
    {
      id: "action:search-sessions",
      label: "Search Messages",
      subtitle: "Full-text search across every session timeline (⌘F)",
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

  const sessions: PaletteCommand[] = snapshot.sessions
    // Ephemeral "More details" popup sessions are not navigable surfaces.
    .filter((session) => workspaceById.get(session.workspaceId)?.kind !== "popup")
    .slice(0, 40)
    .map((session) => {
    const workspace = workspaceById.get(session.workspaceId) ?? null;
    const project = workspace ? projectById.get(workspace.projectId) ?? null : null;
    const label = workspace?.taskLabel || titleFromPrompt(session.prompt) || session.modelLabel;
    return {
      id: `session:${session.id}`,
      label,
      // Project alone. Branch, model, and state are visible in the session
      // itself and only crowd the row here.
      meta: project?.name,
      group: "Sessions",
      icon: MessageSquare,
      run: () => {
        closeOverlays();
        onOpenWorkspace(session.workspaceId);
      }
    };
  });

  // The Settings scope reuses the panel's own section registry, so the palette
  // can never list a page the panel doesn't have.
  const settings: PaletteCommand[] = SETTINGS_GROUPS.flatMap((group) =>
    group.sections.map((section) => ({
      id: `settings:${section.id}`,
      label: section.label,
      subtitle: `Settings · ${group.label}`,
      group: "Settings" as const,
      icon: SlidersHorizontal,
      run: () => {
        closeOverlays();
        onOpenSettingsSection(group.id, section.id);
      }
    }))
  );

  const projects: PaletteCommand[] = snapshot.projects
    // The hidden scratch project backs repo-less side chats; it is not an
    // openable repository.
    .filter((project) => project.id !== SCRATCH_PROJECT_ID)
    .slice(0, 40)
    .map((project) => ({
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

  return [...actions, ...sessions, ...projects, ...settings];
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
