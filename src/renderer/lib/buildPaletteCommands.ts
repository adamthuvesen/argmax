import {
  AppWindow,
  Archive,
  ArrowLeftRight,
  Bell,
  Bug,
  ChartNoAxesColumn,
  Clock,
  Code,
  FileSearch,
  FileText,
  GitCommitHorizontal,
  GitFork,
  Folder,
  Globe,
  Keyboard,
  MessageSquare,
  MessageSquarePlus,
  PanelLeft,
  PanelRight,
  Plus,
  Search,
  Settings,
  SlidersHorizontal,
  Square,
  SquareTerminal
} from "lucide-react";
import type { PaletteCommand } from "../components/CommandPalette.js";
import { SCRATCH_PROJECT_ID, type DashboardSnapshot, type SessionSummary } from "../../shared/types.js";
import { SETTINGS_GROUPS, type SettingsGroupId } from "../components/settings/settingsMeta.js";
import { buildSettingCommands, type SettingCommandsInput } from "./settingCommands.js";
import { titleFromPrompt } from "./projects.js";
import { collapseHome } from "./pathDisplay.js";
import { computeWorkspaceAttention, type PriorityAttention } from "./priority.js";

type BuildPaletteCommandsInput = {
  snapshot: DashboardSnapshot;
  selectedSession: SessionSummary | null;
  onNewSession: () => void;
  onOpenSettings: () => void;
  onOpenScheduledTasks: () => void;
  onOpenBrowser?: () => void;
  onOpenUsage: () => void;
  onOpenActivity: () => void;
  /** Jumps straight to one settings section — feeds the palette's Settings scope. */
  onOpenSettingsSection: (group: SettingsGroupId, sectionId: string) => void;
  /** Reopens the palette on its Messages tab — the mouse path to ⌘F. */
  onOpenSearch: () => void;
  /** Current values and setters for the settings that get one-shot palette rows. */
  preferences: SettingCommandsInput;
  onStopSession: (sessionId: string) => void;
  onNewSideChat: () => void;
  /** ⌘P and ⌘⇧F: reopen the palette on its Files or Contents filter. */
  onGoToFile: () => void;
  onSearchContents: () => void;
  onToggleTerminal: () => void;
  onToggleRightSidebar: () => void;
  onToggleLeftSidebar: () => void;
  onSwitchToLastChat: () => void;
  onShowShortcuts: () => void;
  onToggleDebugLog: () => void;
  onForkSession: (sessionId: string) => void;
  onArchiveWorkspace: (workspaceId: string) => void;
  /** The IDE "Open in" lands in, when one is set up. */
  openInIde?: { label: string; run: (workspaceId: string) => void } | undefined;
  onOpenInNewWindow?: ((workspaceId: string) => void) | undefined;
  /** Rows the focused pane contributes: its panel toggles, commit. */
  paneActions?: PaletteCommand[] | undefined;
  /** Clock for chat attention, which ages out. */
  nowMs: number;
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
    onOpenBrowser,
    onOpenUsage,
    onOpenActivity,
    onOpenSettingsSection,
    onOpenSearch,
    preferences,
    onStopSession,
    onNewSideChat,
    onGoToFile,
    onSearchContents,
    onToggleTerminal,
    onToggleRightSidebar,
    onToggleLeftSidebar,
    onSwitchToLastChat,
    onShowShortcuts,
    onToggleDebugLog,
    onForkSession,
    onArchiveWorkspace,
    openInIde,
    onOpenInNewWindow,
    paneActions = [],
    nowMs,
    onOpenWorkspace,
    onSelectProject,
    onClearGrid,
    onCloseOverlays
  } = input;
  const closeOverlays = (): void => {
    onCloseOverlays?.();
  };
  const workspaceById = new Map(snapshot.workspaces.map((workspace) => [workspace.id, workspace]));
  const chatLabel = (session: SessionSummary): string =>
    workspaceById.get(session.workspaceId)?.taskLabel || titleFromPrompt(session.prompt) || session.modelLabel;

  // What can be done to the chat on screen. Popups are not chats a user works in.
  function currentChatActions(): PaletteCommand[] {
    if (!selectedSession) return [];
    const workspace = workspaceById.get(selectedSession.workspaceId);
    if (!workspace || workspace.kind === "popup") return [];
    const label = chatLabel(selectedSession);
    return [
      {
        id: "action:fork-chat",
        label: "Fork chat",
        subtitle: label,
        group: "Actions",
        icon: GitFork,
        keywords: ["branch", "duplicate", "copy conversation"],
        run: () => onForkSession(selectedSession.id)
      },
      {
        id: "action:archive-chat",
        label: "Archive chat",
        subtitle: label,
        group: "Actions",
        icon: Archive,
        keywords: ["close", "done", "remove", "worktree"],
        run: () => onArchiveWorkspace(workspace.id)
      },
      ...(openInIde
        ? [{
            id: "action:open-in-ide",
            label: `Open in ${openInIde.label}`,
            subtitle: label,
            group: "Actions" as const,
            icon: Code,
            keywords: ["editor", "ide", "code"],
            run: () => openInIde.run(workspace.id)
          }]
        : []),
      ...(onOpenInNewWindow
        ? [{
            id: "action:open-in-new-window",
            label: "Open chat in new window",
            subtitle: label,
            group: "Actions" as const,
            icon: AppWindow,
            keywords: ["tear off", "detach", "pop out"],
            run: () => onOpenInNewWindow(workspace.id)
          }]
        : [])
    ];
  }

  // Chats waiting on the user, the same fresh, undismissed attention the
  // sidebar's Priority section draws. The chat on screen needs no jump.
  function attentionActions(): PaletteCommand[] {
    const attention = computeWorkspaceAttention(snapshot.workspaces, snapshot.sessions, nowMs);
    return [...attention].flatMap(([workspaceId, entry]) => {
      if (workspaceId === selectedSession?.workspaceId) return [];
      if (workspaceById.get(workspaceId)?.kind === "popup") return [];
      const session = snapshot.sessions.find((candidate) => candidate.workspaceId === workspaceId);
      if (!session) return [];
      const copy = ATTENTION_COPY[entry.attention];
      return [{
        id: `attention:${workspaceId}`,
        label: `${copy.verb} ${chatLabel(session)}`,
        subtitle: copy.subtitle,
        group: "Actions" as const,
        icon: Bell,
        keywords: ["attention", "waiting", "needs me", "inbox"],
        suggest: true,
        run: () => {
          closeOverlays();
          onOpenWorkspace(workspaceId);
        }
      }];
    });
  }

  const actions: PaletteCommand[] = [
    {
      id: "action:new-session",
      label: "New chat",
      subtitle: "Open the launcher",
      group: "Actions",
      icon: Plus,
      shortcut: "⌘N",
      keywords: ["session", "agent", "launch", "start"],
      run: onNewSession
    },
    {
      id: "action:open-settings",
      label: "Open settings",
      subtitle: "Defaults, providers, tools",
      group: "Actions",
      icon: Settings,
      shortcut: "⌘,",
      keywords: ["preferences", "config"],
      run: onOpenSettings
    },
    {
      id: "action:open-scheduled-tasks",
      label: "Open schedule",
      subtitle: "Prompts Argmax runs on a schedule",
      group: "Actions",
      icon: Clock,
      keywords: ["routines", "cron", "scheduled tasks"],
      run: onOpenScheduledTasks
    },
    ...(onOpenBrowser
      ? [
          {
            id: "action:open-browser",
            label: "Open browser",
            subtitle: "Browse in the workspace",
            group: "Actions" as const,
            icon: Globe,
            run: onOpenBrowser
          }
        ]
      : []),
    {
      id: "action:open-usage",
      label: "Open usage",
      subtitle: "Tokens and cost per provider",
      group: "Actions",
      icon: ChartNoAxesColumn,
      keywords: ["cost", "tokens", "spend", "billing"],
      run: onOpenUsage
    },
    {
      id: "action:open-activity",
      label: "Open activity",
      subtitle: "Commits, pull requests, and reviews",
      group: "Actions",
      icon: GitCommitHorizontal,
      keywords: ["streak", "stats", "prs"],
      run: onOpenActivity
    },
    {
      id: "action:search-sessions",
      label: "Search messages",
      subtitle: "Full-text search across every chat timeline",
      group: "Actions",
      icon: Search,
      shortcut: "⌘F",
      keywords: ["find", "history", "transcript"],
      run: onOpenSearch
    },
    {
      id: "action:new-side-chat",
      label: "New side chat",
      subtitle: "A chat with no repository",
      group: "Actions",
      icon: MessageSquarePlus,
      keywords: ["scratch", "question", "ask"],
      run: onNewSideChat
    },
    {
      id: "action:go-to-file",
      label: "Go to file",
      subtitle: "Open a file in this checkout",
      group: "Actions",
      icon: FileText,
      shortcut: "⌘P",
      keywords: ["open file", "find file"],
      run: onGoToFile
    },
    {
      id: "action:search-contents",
      label: "Search file contents",
      subtitle: "Grep this checkout",
      group: "Actions",
      icon: FileSearch,
      shortcut: "⌘⇧F",
      keywords: ["grep", "find in files", "text"],
      run: onSearchContents
    },
    {
      id: "action:toggle-terminal",
      label: "Toggle terminal",
      subtitle: "The chat's integrated shell",
      group: "Actions",
      icon: SquareTerminal,
      shortcut: "⌘J",
      keywords: ["shell", "console", "pty", "command line"],
      run: onToggleTerminal
    },
    {
      id: "action:toggle-right-sidebar",
      label: "Toggle right sidebar",
      subtitle: "Changes, files, browser",
      group: "Actions",
      icon: PanelRight,
      shortcut: "⌘B",
      keywords: ["panel", "review", "diff"],
      run: onToggleRightSidebar
    },
    {
      id: "action:toggle-left-sidebar",
      label: "Toggle left sidebar",
      subtitle: "Chats and projects",
      group: "Actions",
      icon: PanelLeft,
      shortcut: "⌘⇧B",
      keywords: ["panel", "chat list", "hide"],
      run: onToggleLeftSidebar
    },
    {
      id: "action:switch-to-last-chat",
      label: "Switch to last chat",
      subtitle: "Back to the chat used before this one",
      group: "Actions",
      icon: ArrowLeftRight,
      shortcut: "⌘`",
      keywords: ["previous", "recent", "back", "cycle"],
      run: onSwitchToLastChat
    },
    {
      id: "action:show-shortcuts",
      label: "Show keyboard shortcuts",
      group: "Actions",
      icon: Keyboard,
      shortcut: "⌘/",
      keywords: ["cheat sheet", "keys", "hotkeys", "bindings"],
      run: onShowShortcuts
    },
    {
      id: "action:toggle-debug-log",
      label: "Toggle debug log",
      subtitle: "The focused chat's raw provider output",
      group: "Actions",
      icon: Bug,
      shortcut: "⌘⇧D",
      keywords: ["diagnostics", "raw", "stdout"],
      run: onToggleDebugLog
    },
    ...paneActions,
    ...(selectedSession && selectedSession.state === "running"
      ? [
          {
            id: "action:stop-session",
            label: "Stop current chat",
            subtitle: selectedSession.modelLabel,
            group: "Actions" as const,
            icon: Square,
            keywords: ["cancel", "interrupt", "halt"],
            suggest: true,
            run: () => onStopSession(selectedSession.id)
          }
        ]
      : []),
    ...currentChatActions(),
    ...attentionActions()
  ];

  const projectById = new Map(snapshot.projects.map((project) => [project.id, project]));

  const sessions: PaletteCommand[] = snapshot.sessions
    // Ephemeral "More details" popup sessions are not navigable surfaces.
    .filter((session) => workspaceById.get(session.workspaceId)?.kind !== "popup")
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
  // can never list a page the panel doesn't have. Section jumps lead; the
  // value rows from `buildSettingCommands` follow so an empty query still
  // opens with the panel's table of contents.
  const settings: PaletteCommand[] = SETTINGS_GROUPS.flatMap((group) =>
    group.sections.map((section) => ({
      id: `settings:${section.id}`,
      label: section.label,
      subtitle: `Settings · ${group.label}`,
      group: "Settings" as const,
      icon: SlidersHorizontal,
      keywords: section.settings ? [...section.settings] : undefined,
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

  return [...actions, ...sessions, ...projects, ...settings, ...buildSettingCommands(preferences)];
}

const ATTENTION_COPY: Record<PriorityAttention, { verb: string; subtitle: string }> = {
  "approval-needed": { verb: "Approve in", subtitle: "Waiting for your approval" },
  "question-asked": { verb: "Answer", subtitle: "Asked you a question" },
  blocked: { verb: "Unblock", subtitle: "Blocked" },
  failed: { verb: "Go to", subtitle: "The last turn failed" },
  "review-ready": { verb: "Review", subtitle: "Finished and ready for review" }
};

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
