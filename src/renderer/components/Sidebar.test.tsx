import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DashboardSnapshot } from "../../shared/types.js";
import {
  collapsedDateGroupsStorageKey,
  collapsedProjectsStorageKey,
  projectOrderStorageKey,
  projectSortModeStorageKey,
  sidebarViewModeStorageKey
} from "../lib/projects.js";
import { Sidebar } from "./Sidebar.js";

const projectSettings = {
  defaultProvider: "codex" as const,
  defaultModelLabel: "GPT-5.3 Codex",
  defaultModelId: "",
  worktreeLocation: "/tmp/worktrees",
  setupCommand: "",
  checkCommands: []
};

const snapshot: DashboardSnapshot = {
  projects: [
    {
      id: "project-1",
      name: "Argmax",
      repoPath: "/tmp/argmax",
      currentBranch: "main",
      defaultBranch: "main",
      settings: projectSettings,
      counts: { active: 1, blocked: 0, failed: 0, reviewReady: 0 },
      latestActivityAt: "2026-05-12T15:54:00.000Z"
    }
  ],
  workspaces: [
    {
      id: "workspace-1",
      projectId: "project-1",
      taskLabel: "Build dashboard",
      branch: "argmax/dashboard",
      baseRef: "main",
      path: "/tmp/wt",
      state: "running",
      sharedWorkspace: false,
      dirty: false,
      changedFiles: 0,
      lastActivityAt: "2026-05-12T15:54:00.000Z",
      pinned: false,
      priorityDismissedAt: null,
      priorityAddedAt: null
    }
  ],
  sessions: [],
  events: [],
  rawOutputs: [],
  approvals: [],
  checks: []
};

const multiProjectSnapshot: DashboardSnapshot = {
  ...snapshot,
  projects: [
    // Snapshot order mirrors the DB sort (most-recent activity first).
    {
      id: "project-zebra",
      name: "Zebra",
      repoPath: "/tmp/zebra",
      currentBranch: "main",
      defaultBranch: "main",
      settings: projectSettings,
      counts: { active: 0, blocked: 0, failed: 0, reviewReady: 0 },
      latestActivityAt: "2026-05-12T15:54:00.000Z"
    },
    {
      id: "project-argmax",
      name: "Argmax",
      repoPath: "/tmp/argmax",
      currentBranch: "main",
      defaultBranch: "main",
      settings: projectSettings,
      counts: { active: 0, blocked: 0, failed: 0, reviewReady: 0 },
      latestActivityAt: "2026-05-11T15:54:00.000Z"
    },
    {
      id: "project-mango",
      name: "Mango",
      repoPath: "/tmp/mango",
      currentBranch: "main",
      defaultBranch: "main",
      settings: projectSettings,
      counts: { active: 0, blocked: 0, failed: 0, reviewReady: 0 },
      latestActivityAt: "2026-05-10T15:54:00.000Z"
    }
  ],
  workspaces: []
};

// Per-launch seed marker for session-group collapse, mirrored from Sidebar.tsx.
// Setting it opts a test out of the "collapse every group but Pinned" boot seed.
const bootGroupCollapseSeedKey = "argmax.sidebar.bootGroupCollapseSeeded";

const noop = (): void => {};

const baseProps = {
  loadState: "ready" as const,
  onAddProject: noop,
  onArchiveWorkspace: noop,
  onOpenInIde: noop,
  onOpenLauncher: noop,
  onOpenAbout: noop,
  onOpenCommandPalette: noop,
  onOpenDiagnostics: noop,
  onOpenKeyboardShortcuts: noop,
  onOpenProviders: noop,
  onOpenProject: noop,
  onOpenSettings: noop,
  onOpenWorkspaceChat: noop,
  onResizeMouseDown: noop,
  selectedProjectId: null,
  selectedWorkspaceId: null,
  openWorkspaceIds: new Set<string>(),
  canDragWorkspaceToGrid: false,
  detectedIdes: [],
  defaultIde: null,
  showSessionTokens: false,
  showPriority: false
};

// Section order assertions: does `later` sit after `earlier` in the rendered
// document? Reads the live DOM order rather than any class or index.
function rendersAfter(earlier: HTMLElement, later: HTMLElement): boolean {
  return Boolean(earlier.compareDocumentPosition(later) & Node.DOCUMENT_POSITION_FOLLOWING);
}

function getProjectButtonOrder(): string[] {
  return screen
    .getAllByRole("button")
    .filter((button) => button.classList.contains("project-name"))
    .map((button) => button.textContent ?? "");
}

describe("Sidebar — localStorage write isolation", () => {
  let setItemSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    window.localStorage.clear();
    // Clear the boot-collapse seed marker so the new mount triggers the
    // "collapse every project on launch" behavior these tests exercise.
    window.sessionStorage.clear();
    setItemSpy = vi.spyOn(Storage.prototype, "setItem");
  });

  afterEach(() => {
    cleanup();
    setItemSpy.mockRestore();
  });

  it("writes the collapsed-projects key exactly once per chevron click under StrictMode", () => {
    // Compute `next` outside the state updater so StrictMode's development
    // double-invoke still writes storage exactly once per user action.
    //
    // The sidebar boots every project collapsed (so no sessions are visible
    // on launch), so we first expand the project, then collapse it again
    // and assert that the second (collapse-direction) click writes exactly
    // once with `["project-1"]`.
    render(
      <StrictMode>
        <Sidebar
          loadState="ready"
          onAddProject={noop}
          onArchiveWorkspace={noop}
          onOpenInIde={noop}
          onOpenLauncher={noop}
          onOpenAbout={noop}
          onOpenCommandPalette={noop}
          onOpenDiagnostics={noop}
          onOpenKeyboardShortcuts={noop}
          onOpenProviders={noop}
          onOpenProject={noop}
          onOpenSettings={noop}
          onOpenWorkspaceChat={noop}
          onResizeMouseDown={noop}
          selectedProjectId={null}
          selectedWorkspaceId={null}
          openWorkspaceIds={new Set()}
          canDragWorkspaceToGrid={false}
          snapshot={snapshot}
          detectedIdes={[]}
          defaultIde={null}
          showSessionTokens={false}
          showPriority={false}
        />
      </StrictMode>
    );

    fireEvent.click(screen.getByRole("button", { name: "Show Argmax sessions" }));
    setItemSpy.mockClear();

    fireEvent.click(screen.getByRole("button", { name: "Hide Argmax sessions" }));

    const collapsedWrites = setItemSpy.mock.calls.filter(
      ([key]) => key === collapsedProjectsStorageKey
    );
    expect(collapsedWrites).toHaveLength(1);
    expect(collapsedWrites[0]?.[1]).toBe(JSON.stringify(["project-1"]));
  });

  it("writes the collapsed-projects key exactly once per expand click under StrictMode", () => {
    // Same property, the inverse direction. The sidebar boots collapsed by
    // default, so we don't need to pre-persist anything — clicking the
    // "Show" chevron once should write `[]` exactly once.

    render(
      <StrictMode>
        <Sidebar
          loadState="ready"
          onAddProject={noop}
          onArchiveWorkspace={noop}
          onOpenInIde={noop}
          onOpenLauncher={noop}
          onOpenAbout={noop}
          onOpenCommandPalette={noop}
          onOpenDiagnostics={noop}
          onOpenKeyboardShortcuts={noop}
          onOpenProviders={noop}
          onOpenProject={noop}
          onOpenSettings={noop}
          onOpenWorkspaceChat={noop}
          onResizeMouseDown={noop}
          selectedProjectId={null}
          selectedWorkspaceId={null}
          openWorkspaceIds={new Set()}
          canDragWorkspaceToGrid={false}
          snapshot={snapshot}
          detectedIdes={[]}
          defaultIde={null}
          showSessionTokens={false}
          showPriority={false}
        />
      </StrictMode>
    );

    setItemSpy.mockClear();

    const chevron = screen.getByRole("button", { name: "Show Argmax sessions" });
    fireEvent.click(chevron);

    const collapsedWrites = setItemSpy.mock.calls.filter(
      ([key]) => key === collapsedProjectsStorageKey
    );
    expect(collapsedWrites).toHaveLength(1);
    expect(collapsedWrites[0]?.[1]).toBe(JSON.stringify([]));
  });
});

describe("Sidebar — project sort menu", () => {
  let setItemSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    window.localStorage.clear();
    setItemSpy = vi.spyOn(Storage.prototype, "setItem");
  });

  afterEach(() => {
    cleanup();
    setItemSpy.mockRestore();
  });

  it("renders projects in snapshot order by default and exposes an accessible sort trigger", () => {
    render(
      <Sidebar
        {...baseProps}
        snapshot={multiProjectSnapshot}
      />
    );

    expect(getProjectButtonOrder()).toEqual(["Zebra", "Argmax", "Mango"]);

    const trigger = screen.getByRole("button", { name: "Sidebar view options" });
    expect(trigger.getAttribute("aria-haspopup")).toBe("menu");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
  });

  it("reorders projects alphabetically and persists the mode exactly once under StrictMode", () => {
    render(
      <StrictMode>
        <Sidebar {...baseProps} snapshot={multiProjectSnapshot} />
      </StrictMode>
    );

    fireEvent.click(screen.getByRole("button", { name: "Sidebar view options" }));

    const menu = screen.getByRole("menu", { name: "Sidebar view options" });
    const recentItem = within(menu).getByRole("menuitemradio", { name: /Recent activity/ });
    expect(recentItem.getAttribute("aria-checked")).toBe("true");

    setItemSpy.mockClear();

    fireEvent.click(within(menu).getByRole("menuitemradio", { name: /Alphabetical/ }));

    expect(getProjectButtonOrder()).toEqual(["Argmax", "Mango", "Zebra"]);

    const sortWrites = setItemSpy.mock.calls.filter(
      ([key]) => key === projectSortModeStorageKey
    );
    expect(sortWrites).toHaveLength(1);
    expect(sortWrites[0]?.[1]).toBe(JSON.stringify("alphabetical"));

    // Menu closes on selection.
    expect(screen.queryByRole("menu", { name: "Sidebar view options" })).toBeNull();
  });

  it("reads the persisted sort mode on mount", () => {
    window.localStorage.setItem(projectSortModeStorageKey, JSON.stringify("alphabetical"));

    render(<Sidebar {...baseProps} snapshot={multiProjectSnapshot} />);

    expect(getProjectButtonOrder()).toEqual(["Argmax", "Mango", "Zebra"]);

    fireEvent.click(screen.getByRole("button", { name: "Sidebar view options" }));
    const alphabeticalItem = screen.getByRole("menuitemradio", { name: /Alphabetical/ });
    expect(alphabeticalItem.getAttribute("aria-checked")).toBe("true");
  });

  it("flips to manual mode when the user drags a project while sorted non-manually", () => {
    render(<Sidebar {...baseProps} snapshot={multiProjectSnapshot} />);

    // Start in default "recent" order: Zebra, Argmax, Mango.
    expect(getProjectButtonOrder()).toEqual(["Zebra", "Argmax", "Mango"]);

    // Only project groups are draggable. The "Projects" header and the
    // Pinned / Priority sections share the class but never reorder.
    const groups = document.querySelectorAll<HTMLElement>('.project-group[draggable="true"]');
    expect(groups).toHaveLength(3);
    const zebra = groups[0];
    const mango = groups[2];
    if (!zebra || !mango) throw new Error("expected project groups to render");

    // Drag Mango onto Zebra (move Mango to the top).
    const dataTransfer = {
      effectAllowed: "",
      dropEffect: "",
      setData: vi.fn(),
      getData: vi.fn()
    };
    fireEvent.dragStart(mango, { dataTransfer });
    fireEvent.dragOver(zebra, { dataTransfer });
    fireEvent.drop(zebra, { dataTransfer });

    // Mode flipped to manual and the drag order was persisted.
    expect(window.localStorage.getItem(projectSortModeStorageKey)).toBe(JSON.stringify("manual"));
    const persistedOrder = JSON.parse(window.localStorage.getItem(projectOrderStorageKey) ?? "[]") as string[];
    expect(persistedOrder[0]).toBe("project-mango");

    // The rendered order reflects the drag — Mango is now first.
    expect(getProjectButtonOrder()[0]).toBe("Mango");

    // The menu now reports Manual as the active radio.
    fireEvent.click(screen.getByRole("button", { name: "Sidebar view options" }));
    const manualItem = screen.getByRole("menuitemradio", { name: /Manual/ });
    expect(manualItem.getAttribute("aria-checked")).toBe("true");
  });
});

describe("Sidebar — project removal menu", () => {
  afterEach(() => {
    cleanup();
    window.localStorage.clear();
  });

  it("opens a confirm step in-place and calls onRemoveProject only after confirmation", () => {
    const onRemoveProject = vi.fn();

    render(
      <Sidebar
        {...baseProps}
        snapshot={multiProjectSnapshot}
        onRemoveProject={onRemoveProject}
      />
    );

    // First click on the per-project "Actions" trigger — opens the menu.
    fireEvent.click(screen.getByRole("button", { name: "Actions for Zebra" }));
    const removeItem = screen.getByRole("menuitem", { name: /Remove project/ });
    expect(removeItem).toBeInTheDocument();

    // Click "Remove project" — must NOT trigger removal yet; it swaps to confirm.
    fireEvent.click(removeItem);
    expect(onRemoveProject).not.toHaveBeenCalled();
    expect(screen.getByText(/and all its sessions/)).toBeInTheDocument();

    // Cancel returns to nothing and does not remove.
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onRemoveProject).not.toHaveBeenCalled();
    expect(screen.queryByText(/and all its sessions/)).toBeNull();

    // Re-open and confirm — now the callback fires with the project id.
    fireEvent.click(screen.getByRole("button", { name: "Actions for Zebra" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /Remove project/ }));
    fireEvent.click(screen.getByRole("button", { name: /^Remove$/ }));

    expect(onRemoveProject).toHaveBeenCalledTimes(1);
    expect(onRemoveProject).toHaveBeenCalledWith("project-zebra");
  });

  it("hides the action trigger entirely when onRemoveProject is not provided", () => {
    render(<Sidebar {...baseProps} snapshot={multiProjectSnapshot} />);
    expect(screen.queryByRole("button", { name: /Actions for/ })).toBeNull();
  });
});

describe("Sidebar — workspaces without sessions", () => {
  beforeEach(() => {
    // Clear the boot-collapse seed so each test starts with all projects
    // collapsed (matching the real per-launch behavior).
    window.sessionStorage.clear();
  });

  afterEach(() => {
    cleanup();
    window.localStorage.clear();
  });

  it("hides workspaces that have no matching session in the snapshot", () => {
    // Two workspaces — one with a session row, one without. The renderer
    // can't open a workspace without a session (the grid needs a sessionId),
    // so the orphan row must not show.
    const baseWorkspace = snapshot.workspaces[0];
    if (!baseWorkspace) throw new Error("snapshot fixture missing workspace");
    const snapshotWithOrphan: DashboardSnapshot = {
      ...snapshot,
      workspaces: [
        baseWorkspace,
        {
          id: "workspace-orphan",
          projectId: "project-1",
          taskLabel: "What is this project about?",
          branch: "argmax/orphan",
          baseRef: "main",
          path: "/tmp/orphan",
          state: "complete",
          sharedWorkspace: false,
          dirty: false,
          changedFiles: 0,
          lastActivityAt: "2026-05-12T15:54:00.000Z",
          pinned: false,
          priorityDismissedAt: null,
          priorityAddedAt: null
        }
      ],
      sessions: [
        {
          id: "session-1",
          workspaceId: "workspace-1",
          provider: "codex",
          modelLabel: "GPT-5.3 Codex",
          modelId: "gpt-5.5",
          permissionMode: "auto-approve",
          agentMode: "auto",
          providerConversationId: null,
          state: "running",
          attention: "normal",
          startedAt: "2026-05-12T15:54:00.000Z",
          completedAt: null,
          lastActivityAt: "2026-05-12T15:54:00.000Z",
          prompt: "Build the dashboard",
        }
      ]
    };

    render(<Sidebar {...baseProps} snapshot={snapshotWithOrphan} />);

    // Sidebar boots every project collapsed; expand to see its sessions.
    fireEvent.click(screen.getByRole("button", { name: "Show Argmax sessions" }));

    // The session-backed workspace is visible.
    expect(screen.getByRole("button", { name: /Build dashboard/ })).toBeInTheDocument();
    // The orphan is hidden.
    expect(screen.queryByRole("button", { name: /What is this project about/ })).toBeNull();
  });

  it("boots with every project collapsed so no workspaces are visible on startup", () => {
    // Even if a previous session expanded the project (persisted as []
    // in collapsedProjectsStorageKey), each new launch should re-collapse
    // everything so the sidebar starts empty.
    window.localStorage.setItem(collapsedProjectsStorageKey, JSON.stringify([]));

    render(<Sidebar {...baseProps} snapshot={snapshot} />);

    expect(screen.getByRole("button", { name: "Show Argmax sessions" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Build dashboard/ })).toBeNull();
  });
});

describe("Sidebar — date (sessions) view mode", () => {
  // Two projects, one session each, on different days so they fall into
  // distinct date buckets. System time is pinned so the buckets are stable.
  const session = (workspaceId: string, lastActivityAt: string) => ({
    id: `session-${workspaceId}`,
    workspaceId,
    provider: "codex" as const,
    modelLabel: "GPT-5.3 Codex",
    modelId: "gpt-5.5",
    permissionMode: "auto-approve" as const,
    agentMode: "auto" as const,
    providerConversationId: null,
    state: "complete" as const,
    attention: "normal" as const,
    startedAt: lastActivityAt,
    completedAt: lastActivityAt,
    lastActivityAt,
    prompt: "Do the thing"
  });

  const workspace = (id: string, projectId: string, taskLabel: string, lastActivityAt: string) => ({
    id,
    projectId,
    taskLabel,
    branch: `argmax/${id}`,
    baseRef: "main",
    path: `/tmp/${id}`,
    state: "complete" as const,
    sharedWorkspace: false,
    dirty: false,
    changedFiles: 0,
    lastActivityAt,
    pinned: false,
    priorityDismissedAt: null,
    priorityAddedAt: null
  });

  const TODAY = new Date(2026, 5, 5, 9, 0, 0).toISOString();
  const APRIL = new Date(2026, 3, 2, 9, 0, 0).toISOString();

  const viewSnapshot: DashboardSnapshot = {
    ...multiProjectSnapshot,
    projects: [multiProjectSnapshot.projects[0], multiProjectSnapshot.projects[1]],
    workspaces: [
      workspace("w-zebra", "project-zebra", "Zebra task today", TODAY),
      workspace("w-argmax", "project-argmax", "Argmax task in april", APRIL)
    ],
    sessions: [session("w-zebra", TODAY), session("w-argmax", APRIL)]
  };

  beforeEach(() => {
    window.localStorage.clear();
    window.sessionStorage.clear();
    // These tests are about bucketing, ordering, and overflow, so they opt out
    // of the per-launch "collapse every group but Pinned" seed. The seed itself
    // is covered in "Sidebar — boot collapse defaults".
    window.sessionStorage.setItem(bootGroupCollapseSeedKey, "1");
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 5, 5, 12, 0, 0));
  });

  afterEach(() => {
    vi.useRealTimers();
    cleanup();
  });

  it("flattens sessions from every project under date headers with no project rows", () => {
    window.localStorage.setItem(sidebarViewModeStorageKey, JSON.stringify("sessions"));

    render(<Sidebar {...baseProps} snapshot={viewSnapshot} />);

    // No section title bar: the recency labels name the list on their own.
    expect(screen.queryByText("Sessions")).toBeNull();

    // Date buckets render, newest first. Anything past 30 days lands in the
    // single Older bucket rather than a per-month header.
    expect(screen.getByText("Today")).toBeInTheDocument();
    expect(screen.getByText("Older")).toBeInTheDocument();

    // Both sessions are visible immediately (no per-project collapse), across
    // both projects.
    expect(screen.getByRole("button", { name: /Zebra task today/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Argmax task in april/ })).toBeInTheDocument();

    // No project rows in this view.
    expect(getProjectButtonOrder()).toEqual([]);
  });

  it("orders recency buckets Today, Last 7 Days, Last 30 Days, Older", () => {
    window.localStorage.setItem(sidebarViewModeStorageKey, JSON.stringify("sessions"));

    const THIS_WEEK = new Date(2026, 5, 2, 9, 0, 0).toISOString();
    const THIS_MONTH = new Date(2026, 4, 20, 9, 0, 0).toISOString();
    const workspaces = [
      workspace("w-today", "project-zebra", "Task today", TODAY),
      workspace("w-week", "project-zebra", "Task this week", THIS_WEEK),
      workspace("w-month", "project-zebra", "Task this month", THIS_MONTH),
      workspace("w-older", "project-zebra", "Task long ago", APRIL)
    ];

    render(
      <Sidebar
        {...baseProps}
        snapshot={{
          ...viewSnapshot,
          workspaces,
          sessions: workspaces.map((row) => session(row.id, row.lastActivityAt))
        }}
      />
    );

    const today = screen.getByText("Today");
    const week = screen.getByText("Last 7 Days");
    const month = screen.getByText("Last 30 Days");
    const older = screen.getByText("Older");
    expect(rendersAfter(today, week)).toBe(true);
    expect(rendersAfter(week, month)).toBe(true);
    expect(rendersAfter(month, older)).toBe(true);

    // Each bucket holds its own session, and no session is repeated.
    expect(screen.getAllByRole("button", { name: /Task today/ })).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: /Task this week/ })).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: /Task this month/ })).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: /Task long ago/ })).toHaveLength(1);
  });

  it("floats a pinned session into a Pinned section and out of its date bucket", () => {
    window.localStorage.setItem(sidebarViewModeStorageKey, JSON.stringify("sessions"));

    const pinnedSnapshot: DashboardSnapshot = {
      ...viewSnapshot,
      workspaces: [
        { ...workspace("w-zebra", "project-zebra", "Zebra task today", TODAY), pinned: true },
        workspace("w-argmax", "project-argmax", "Argmax task in april", APRIL)
      ],
      sessions: [session("w-zebra", TODAY), session("w-argmax", APRIL)]
    };

    const { container } = render(<Sidebar {...baseProps} snapshot={pinnedSnapshot} />);

    // The pinned session renders inside the Pinned section.
    const pinnedGroup = container.querySelector(".session-pinned-group");
    expect(pinnedGroup).not.toBeNull();
    expect(within(pinnedGroup as HTMLElement).getByText("Pinned")).toBeInTheDocument();
    expect(
      within(pinnedGroup as HTMLElement).getByRole("button", { name: /Zebra task today/ })
    ).toBeInTheDocument();

    // It's pulled out of its date bucket — it was the only Today session, so the
    // Today bucket is gone, and it appears exactly once (not duplicated).
    expect(screen.queryByText("Today")).toBeNull();
    expect(screen.getByText("Older")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /Zebra task today/ })).toHaveLength(1);
  });

  it("collapses a date bucket with the chevron and caps overflow behind Show more", () => {
    window.localStorage.setItem(sidebarViewModeStorageKey, JSON.stringify("sessions"));

    // 12 sessions, all Today → over the 5-row cap.
    const workspaces = Array.from({ length: 12 }, (_, i) =>
      workspace(`w-${i}`, "project-zebra", `Today task ${i}`, new Date(2026, 5, 5, 6, i).toISOString())
    );
    const overflowSnapshot: DashboardSnapshot = {
      ...viewSnapshot,
      workspaces,
      sessions: workspaces.map((w) => session(w.id, w.lastActivityAt))
    };

    render(<Sidebar {...baseProps} snapshot={overflowSnapshot} />);

    // Only the first 5 render; the rest hide behind "Show more".
    expect(screen.getAllByRole("button", { name: /Today task/ })).toHaveLength(5);
    const showMore = screen.getByRole("button", { name: /Show 7 more Today sessions/ });
    fireEvent.click(showMore);
    expect(screen.getAllByRole("button", { name: /Today task/ })).toHaveLength(12);

    // The chevron collapses the whole bucket.
    fireEvent.click(screen.getByRole("button", { name: "Hide Today sessions" }));
    expect(screen.queryByRole("button", { name: /Today task/ })).toBeNull();
    // Collapse state is persisted.
    expect(window.localStorage.getItem(collapsedDateGroupsStorageKey)).toBe(JSON.stringify(["today"]));
  });

  it("show less returns an overflowed date bucket to five rows when the selected session is older", () => {
    window.localStorage.setItem(sidebarViewModeStorageKey, JSON.stringify("sessions"));

    const workspaces = Array.from({ length: 12 }, (_, i) =>
      workspace(`w-${i}`, "project-zebra", `Today task ${i}`, new Date(2026, 5, 5, 6, i).toISOString())
    );
    const overflowSnapshot: DashboardSnapshot = {
      ...viewSnapshot,
      workspaces,
      sessions: workspaces.map((w) => session(w.id, w.lastActivityAt))
    };

    render(<Sidebar {...baseProps} selectedWorkspaceId="w-0" snapshot={overflowSnapshot} />);

    expect(screen.getAllByRole("button", { name: /Today task/ })).toHaveLength(5);
    expect(screen.getByRole("button", { name: /Today task 0/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Show 7 more Today sessions/ })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Show 7 more Today sessions/ }));
    expect(screen.getAllByRole("button", { name: /Today task/ })).toHaveLength(12);

    fireEvent.click(screen.getByRole("button", { name: /Show fewer Today sessions/ }));
    expect(screen.getAllByRole("button", { name: /Today task/ })).toHaveLength(5);
    expect(screen.getByRole("button", { name: /Today task 0/ })).toBeInTheDocument();
  });

  it("show less returns an overflowed project to five rows when the selected session is older", () => {
    const workspaces = Array.from({ length: 12 }, (_, i) =>
      workspace(`w-${i}`, "project-zebra", `Zebra task ${i}`, new Date(2026, 5, 5, 6, i).toISOString())
    );
    const overflowSnapshot: DashboardSnapshot = {
      ...viewSnapshot,
      workspaces,
      sessions: workspaces.map((w) => session(w.id, w.lastActivityAt))
    };

    render(<Sidebar {...baseProps} selectedWorkspaceId="w-0" snapshot={overflowSnapshot} />);

    fireEvent.click(screen.getByRole("button", { name: "Show Zebra sessions" }));
    expect(screen.getAllByRole("button", { name: /Zebra task/ })).toHaveLength(5);
    expect(screen.getByRole("button", { name: /Zebra task 0/ })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Show 7 more Zebra sessions/ }));
    expect(screen.getAllByRole("button", { name: /Zebra task/ })).toHaveLength(12);

    fireEvent.click(screen.getByRole("button", { name: /Show fewer Zebra sessions/ }));
    expect(screen.getAllByRole("button", { name: /Zebra task/ })).toHaveLength(5);
    expect(screen.getByRole("button", { name: /Zebra task 0/ })).toBeInTheDocument();
  });

  it("toggles a date bucket by clicking the row, not just the chevron", () => {
    window.localStorage.setItem(sidebarViewModeStorageKey, JSON.stringify("sessions"));

    render(<Sidebar {...baseProps} snapshot={viewSnapshot} />);

    // Sessions start visible; click the date header row itself (its label) to
    // collapse — no chevron needed.
    expect(screen.getByRole("button", { name: /Zebra task today/ })).toBeInTheDocument();
    fireEvent.click(screen.getByText("Today"));
    expect(screen.queryByRole("button", { name: /Zebra task today/ })).toBeNull();
    expect(window.localStorage.getItem(collapsedDateGroupsStorageKey)).toBe(JSON.stringify(["today"]));

    // Clicking the row again expands it back.
    fireEvent.click(screen.getByText("Today"));
    expect(screen.getByRole("button", { name: /Zebra task today/ })).toBeInTheDocument();
  });

  it("toggles a project's sessions by clicking the project row background", () => {
    // Default (projects) view boots collapsed. Clicking the row container —
    // not the project-name button, not the chevron — expands it.
    render(<Sidebar {...baseProps} snapshot={viewSnapshot} />);

    const zebraName = screen.getByRole("button", { name: "Zebra" });
    const zebraRow = zebraName.closest(".project-row");
    if (!zebraRow) throw new Error("expected a project row for Zebra");

    expect(screen.queryByRole("button", { name: /Zebra task today/ })).toBeNull();
    fireEvent.click(zebraRow);
    expect(screen.getByRole("button", { name: /Zebra task today/ })).toBeInTheDocument();
    fireEvent.click(zebraRow);
    expect(screen.queryByRole("button", { name: /Zebra task today/ })).toBeNull();
  });

  it("switches to date mode from the menu and persists the choice", () => {
    render(<Sidebar {...baseProps} snapshot={viewSnapshot} />);

    // Defaults to project grouping: project rows, no recency buckets.
    expect(getProjectButtonOrder()).toEqual(["Zebra", "Argmax"]);
    expect(screen.queryByText("Today")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Sidebar view options" }));
    const menu = screen.getByRole("menu", { name: "Sidebar view options" });
    fireEvent.click(within(menu).getByRole("menuitemradio", { name: "Date" }));

    expect(window.localStorage.getItem(sidebarViewModeStorageKey)).toBe(JSON.stringify("sessions"));
    expect(screen.queryByText("Sessions")).toBeNull();
    expect(screen.getByText("Today")).toBeInTheDocument();
    expect(getProjectButtonOrder()).toEqual([]);

    // The view-mode menu follows the relocated cluster onto the Today header,
    // so the user can switch back.
    const relocated = screen.getByRole("menu", { name: "Sidebar view options" });
    expect(relocated.closest(".project-row")).toBe(screen.getByText("Today").closest(".project-row"));
    fireEvent.click(within(relocated).getByRole("menuitemradio", { name: "Projects" }));
    expect(window.localStorage.getItem(sidebarViewModeStorageKey)).toBe(JSON.stringify("projects"));
    expect(getProjectButtonOrder()).toEqual(["Zebra", "Argmax"]);
  });

  // Structural helper: which header row hosts a given label?
  function headerRowFor(label: string): HTMLElement {
    const row = screen.getByText(label).closest(".project-row");
    if (!(row instanceof HTMLElement)) throw new Error(`expected a header row for ${label}`);
    return row;
  }

  it("hosts the new-session and view-options actions on the newest recency header", () => {
    window.localStorage.setItem(sidebarViewModeStorageKey, JSON.stringify("sessions"));

    render(<Sidebar {...baseProps} snapshot={viewSnapshot} />);

    const today = headerRowFor("Today");
    expect(within(today).getByRole("button", { name: "Add Project" })).toBeInTheDocument();
    expect(within(today).getByRole("button", { name: "Sidebar view options" })).toBeInTheDocument();
    // The header still collapses its own rows.
    expect(within(today).getByRole("button", { name: "Hide Today sessions" })).toBeInTheDocument();

    // Older buckets stay plain collapsible labels.
    const older = headerRowFor("Older");
    expect(within(older).queryByRole("button", { name: "Add Project" })).toBeNull();
    expect(within(older).queryByRole("button", { name: "Sidebar view options" })).toBeNull();
  });

  it("hosts the same actions on the Projects header in projects view", () => {
    render(<Sidebar {...baseProps} snapshot={viewSnapshot} />);

    // Projects view gets a real list header instead of a label-less strip, so
    // the … / + cluster sits on the same line the recency header uses.
    const header = headerRowFor("Projects");
    expect(within(header).getByRole("button", { name: "Add Project" })).toBeInTheDocument();
    expect(within(header).getByRole("button", { name: "Sidebar view options" })).toBeInTheDocument();
    expect(document.querySelector(".rail-heading")).toBeNull();
  });

  it("keeps every recency header's collapse chevron inside the label cluster", () => {
    window.localStorage.setItem(sidebarViewModeStorageKey, JSON.stringify("sessions"));

    render(<Sidebar {...baseProps} snapshot={viewSnapshot} />);

    // The chevron shares the label span so it hugs the word instead of drifting
    // to the row's right edge, where the … / + cluster lives.
    for (const label of ["Today", "Older"]) {
      const chevron = screen.getByRole("button", { name: `Hide ${label} sessions` });
      expect(chevron.closest(".session-date-label")).toBe(
        screen.getByText(label).closest(".session-date-label")
      );
    }
  });

  it("falls through to the next bucket when the newest one is empty", () => {
    window.localStorage.setItem(sidebarViewModeStorageKey, JSON.stringify("sessions"));

    // The only Today session is pinned, so the Today bucket is omitted.
    const pinnedSnapshot: DashboardSnapshot = {
      ...viewSnapshot,
      workspaces: [
        { ...workspace("w-zebra", "project-zebra", "Zebra task today", TODAY), pinned: true },
        workspace("w-argmax", "project-argmax", "Argmax task in april", APRIL)
      ]
    };

    render(<Sidebar {...baseProps} snapshot={pinnedSnapshot} />);

    expect(screen.queryByText("Today")).toBeNull();
    const older = headerRowFor("Older");
    expect(within(older).getByRole("button", { name: "Add Project" })).toBeInTheDocument();
    expect(within(older).getByRole("button", { name: "Sidebar view options" })).toBeInTheDocument();

    // Pinned keeps its plain header.
    const pinned = headerRowFor("Pinned");
    expect(within(pinned).queryByRole("button", { name: "Add Project" })).toBeNull();
  });

  it("keeps the actions off the Pinned and Priority headers", () => {
    window.localStorage.setItem(sidebarViewModeStorageKey, JSON.stringify("sessions"));

    const attentionSnapshot: DashboardSnapshot = {
      ...viewSnapshot,
      workspaces: [
        { ...workspace("w-pinned", "project-zebra", "Pinned task", TODAY), pinned: true },
        workspace("w-blocked", "project-zebra", "Blocked task", TODAY),
        workspace("w-plain", "project-zebra", "Plain task", TODAY)
      ],
      sessions: [
        session("w-pinned", TODAY),
        {
          ...session("w-blocked", TODAY),
          state: "waiting" as const,
          attention: "blocked" as const,
          attentionChangedAt: new Date(Date.now() - 30 * 60 * 1000).toISOString()
        },
        session("w-plain", TODAY)
      ]
    };

    render(<Sidebar {...baseProps} showPriority snapshot={attentionSnapshot} />);

    for (const label of ["Pinned", "Priority"]) {
      const row = headerRowFor(label);
      expect(within(row).queryByRole("button", { name: "Add Project" })).toBeNull();
      expect(within(row).queryByRole("button", { name: "Sidebar view options" })).toBeNull();
    }

    expect(
      within(headerRowFor("Today")).getByRole("button", { name: "Add Project" })
    ).toBeInTheDocument();
  });

  it("does not collapse the newest group when the new-session action is clicked", () => {
    window.localStorage.setItem(sidebarViewModeStorageKey, JSON.stringify("sessions"));
    const onAddProject = vi.fn();

    render(<Sidebar {...baseProps} onAddProject={onAddProject} snapshot={viewSnapshot} />);

    fireEvent.click(screen.getByRole("button", { name: "Add Project" }));

    expect(onAddProject).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: /Zebra task today/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Hide Today sessions" })).toBeInTheDocument();
  });
});

describe("Sidebar — Priority section", () => {
  // The Priority selector runs against real Date.now() with a 24h staleness
  // gate, so fixture stamps are anchored to "now" rather than fixed dates.
  const MINUTES_AGO_30 = new Date(Date.now() - 30 * 60 * 1000).toISOString();
  const MINUTES_AGO_15 = new Date(Date.now() - 15 * 60 * 1000).toISOString();

  const session = (
    workspaceId: string,
    attention: "normal" | "blocked" | "review-ready",
    attentionChangedAt: string
  ) => ({
    id: `session-${workspaceId}`,
    workspaceId,
    provider: "codex" as const,
    modelLabel: "GPT-5.3 Codex",
    modelId: "gpt-5.5",
    permissionMode: "auto-approve" as const,
    agentMode: "auto" as const,
    providerConversationId: null,
    state: attention === "blocked" ? ("waiting" as const) : ("running" as const),
    attention,
    attentionChangedAt,
    startedAt: "2026-05-12T15:00:00.000Z",
    completedAt: null,
    lastActivityAt: "2026-05-12T15:54:00.000Z",
    prompt: "Do the thing"
  });

  const workspace = (id: string, taskLabel: string, priorityDismissedAt?: string) => ({
    id,
    projectId: "project-1",
    taskLabel,
    branch: `argmax/${id}`,
    baseRef: "main",
    path: `/tmp/${id}`,
    state: "running" as const,
    sharedWorkspace: false,
    dirty: false,
    changedFiles: 0,
    lastActivityAt: "2026-05-12T15:54:00.000Z",
    pinned: false,
    priorityDismissedAt: priorityDismissedAt ?? null,
    priorityAddedAt: null
  });

  const prioritySnapshot: DashboardSnapshot = {
    ...snapshot,
    workspaces: [workspace("w-blocked", "Blocked task"), workspace("w-calm", "Calm task")],
    sessions: [
      session("w-blocked", "blocked", MINUTES_AGO_30),
      session("w-calm", "normal", MINUTES_AGO_30)
    ]
  };

  beforeEach(() => {
    window.localStorage.clear();
    // Projects still boot collapsed here, but Priority starts expanded so these
    // tests can assert on its rows. The launch seed is covered separately.
    window.sessionStorage.clear();
    window.sessionStorage.setItem(bootGroupCollapseSeedKey, "1");
  });

  afterEach(() => {
    cleanup();
    window.localStorage.clear();
  });

  it("floats attention-worthy sessions above collapsed projects", () => {
    render(<Sidebar {...baseProps} showPriority snapshot={prioritySnapshot} />);

    // The priority row is visible even though its project boots collapsed;
    // the calm workspace stays hidden inside the collapsed project group.
    expect(screen.getByText("Priority")).toBeInTheDocument();
    const blockedRow = screen.getByRole("button", { name: /Blocked task/ });
    expect(blockedRow).toHaveAttribute("title", expect.stringContaining("waiting for input"));
    expect(screen.queryByRole("button", { name: /Calm task/ })).toBeNull();
  });

  it("renders nothing when the setting is off", () => {
    render(<Sidebar {...baseProps} showPriority={false} snapshot={prioritySnapshot} />);
    expect(screen.queryByText("Priority")).toBeNull();
  });

  it("removes a priority row from its home group", () => {
    render(<Sidebar {...baseProps} showPriority snapshot={prioritySnapshot} />);

    // Expanding the project group must not produce a second copy of the
    // blocked row — a workspace lives in exactly one section at a time.
    fireEvent.click(screen.getByRole("button", { name: "Show Argmax sessions" }));
    expect(screen.getAllByRole("button", { name: /Blocked task/ })).toHaveLength(1);
    expect(screen.getByRole("button", { name: /Calm task/ })).toBeInTheDocument();
  });

  it("clears the whole section from the header", () => {
    const onClearPriority = vi.fn();
    const mixedSnapshot: DashboardSnapshot = {
      ...prioritySnapshot,
      workspaces: [
        workspace("w-blocked", "Blocked task"),
        { ...workspace("w-calm", "Calm task"), priorityAddedAt: MINUTES_AGO_15 }
      ]
    };

    render(
      <Sidebar
        {...baseProps}
        showPriority
        onClearPriority={onClearPriority}
        snapshot={mixedSnapshot}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Clear priority" }));

    // Both flavors of entry go: the attention row and the manually added one.
    expect(onClearPriority).toHaveBeenCalledWith(["w-blocked", "w-calm"]);
    // The click belongs to the button, not the header's collapse toggle.
    expect(screen.getByRole("button", { name: "Hide Priority sessions" })).toBeInTheDocument();
  });

  it("shows a project subtitle on priority rows but not under project groups", () => {
    render(<Sidebar {...baseProps} showPriority snapshot={prioritySnapshot} />);

    // The priority row carries the owning project's name as a second line.
    const blockedRow = screen.getByRole("button", { name: /Blocked task/ });
    expect(within(blockedRow).getByText("Argmax")).toBeInTheDocument();

    // A row under its project group skips the subtitle — the header names it.
    fireEvent.click(screen.getByRole("button", { name: "Show Argmax sessions" }));
    const calmRow = screen.getByRole("button", { name: /Calm task/ });
    expect(within(calmRow).queryByText("Argmax")).toBeNull();
  });

  it("renders the project subtitle as plain text without a folder glyph", () => {
    render(<Sidebar {...baseProps} showPriority snapshot={prioritySnapshot} />);

    const blockedRow = screen.getByRole("button", { name: /Blocked task/ });
    expect(within(blockedRow).getByText("Argmax")).toBeInTheDocument();
    // The leading status marker is the row's only icon: the folder glyph that
    // used to sit beside the project name is gone.
    expect(blockedRow.querySelectorAll("svg")).toHaveLength(1);
  });

  it("keeps Pinned above Priority", () => {
    const pinnedSnapshot: DashboardSnapshot = {
      ...prioritySnapshot,
      workspaces: [
        ...prioritySnapshot.workspaces,
        { ...workspace("w-pinned", "Pinned task"), pinned: true }
      ],
      sessions: [...prioritySnapshot.sessions, session("w-pinned", "normal", MINUTES_AGO_30)]
    };

    render(<Sidebar {...baseProps} showPriority snapshot={pinnedSnapshot} />);

    expect(rendersAfter(screen.getByText("Pinned"), screen.getByText("Priority"))).toBe(true);
    // Both sections still list their rows.
    expect(screen.getByRole("button", { name: /Pinned task/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Blocked task/ })).toBeInTheDocument();
  });

  it("keeps a pinned session in Pinned even when it qualifies for Priority", () => {
    const pinnedAttentionSnapshot: DashboardSnapshot = {
      ...prioritySnapshot,
      workspaces: [
        ...prioritySnapshot.workspaces,
        { ...workspace("w-pinned-blocked", "Pinned blocked"), pinned: true }
      ],
      sessions: [
        ...prioritySnapshot.sessions,
        session("w-pinned-blocked", "blocked", MINUTES_AGO_30)
      ]
    };

    const { container } = render(
      <Sidebar {...baseProps} showPriority snapshot={pinnedAttentionSnapshot} />
    );

    const pinnedGroup = container.querySelector(".session-pinned-group");
    const priorityGroup = container.querySelector(".session-priority-group");
    expect(pinnedGroup).not.toBeNull();
    expect(priorityGroup).not.toBeNull();
    expect(
      within(pinnedGroup as HTMLElement).getByRole("button", { name: /Pinned blocked/ })
    ).toBeInTheDocument();
    expect(
      within(priorityGroup as HTMLElement).getByRole("button", { name: /Blocked task/ })
    ).toBeInTheDocument();
    expect(
      within(priorityGroup as HTMLElement).queryByRole("button", { name: /Pinned blocked/ })
    ).toBeNull();
  });

  it("does not offer Add to priority on a pinned row", () => {
    const onAddToPriority = vi.fn();
    const pinnedSnapshot: DashboardSnapshot = {
      ...prioritySnapshot,
      workspaces: [
        ...prioritySnapshot.workspaces,
        { ...workspace("w-pinned", "Pinned task"), pinned: true }
      ],
      sessions: [...prioritySnapshot.sessions, session("w-pinned", "normal", MINUTES_AGO_30)]
    };

    render(
      <Sidebar
        {...baseProps}
        showPriority
        onAddToPriority={onAddToPriority}
        snapshot={pinnedSnapshot}
      />
    );

    fireEvent.contextMenu(screen.getByRole("button", { name: /Pinned task/ }));
    expect(screen.queryByRole("menuitem", { name: "Add to priority" })).toBeNull();
    expect(screen.queryByRole("menuitem", { name: "Remove from priority" })).toBeNull();
  });

  it("collapses and expands the Priority section from its header chevron", () => {
    render(<Sidebar {...baseProps} showPriority snapshot={prioritySnapshot} />);

    // The chevron sits inside the label cluster so it hugs the word, matching
    // every recency header.
    const chevron = screen.getByRole("button", { name: "Hide Priority sessions" });
    expect(chevron.closest(".session-date-label")).toBe(
      screen.getByText("Priority").closest(".session-date-label")
    );

    fireEvent.click(chevron);
    expect(screen.queryByRole("button", { name: /Blocked task/ })).toBeNull();
    expect(screen.getByText("Priority")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Show Priority sessions" }));
    expect(screen.getByRole("button", { name: /Blocked task/ })).toBeInTheDocument();
  });

  it("persists the Priority collapse alongside the date groups", () => {
    render(<Sidebar {...baseProps} showPriority snapshot={prioritySnapshot} />);

    fireEvent.click(screen.getByRole("button", { name: "Hide Priority sessions" }));

    expect(JSON.parse(window.localStorage.getItem(collapsedDateGroupsStorageKey) ?? "[]")).toContain(
      "priority"
    );

    cleanup();
    render(<Sidebar {...baseProps} showPriority snapshot={prioritySnapshot} />);
    expect(screen.getByRole("button", { name: "Show Priority sessions" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Blocked task/ })).toBeNull();
  });

  it("collapses Pinned the same way, and keeps it above Priority", () => {
    const pinnedSnapshot: DashboardSnapshot = {
      ...prioritySnapshot,
      workspaces: [
        ...prioritySnapshot.workspaces,
        { ...workspace("w-pinned", "Pinned task"), pinned: true }
      ],
      sessions: [...prioritySnapshot.sessions, session("w-pinned", "normal", MINUTES_AGO_30)]
    };

    render(<Sidebar {...baseProps} showPriority snapshot={pinnedSnapshot} />);

    expect(rendersAfter(screen.getByText("Pinned"), screen.getByText("Priority"))).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Hide Pinned sessions" }));
    expect(screen.queryByRole("button", { name: /Pinned task/ })).toBeNull();
    // Collapsing one section leaves the other alone.
    expect(screen.getByRole("button", { name: /Blocked task/ })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Show Pinned sessions" }));
    expect(screen.getByRole("button", { name: /Pinned task/ })).toBeInTheDocument();
  });

  it("omits subtitles entirely when priority mode is off", () => {
    render(<Sidebar {...baseProps} showPriority={false} snapshot={prioritySnapshot} />);
    fireEvent.click(screen.getByRole("button", { name: "Show Argmax sessions" }));
    const blockedRow = screen.getByRole("button", { name: /Blocked task/ });
    expect(within(blockedRow).queryByText("Argmax")).toBeNull();
  });

  it("removes a priority row from the context menu", () => {
    const onRemoveFromPriority = vi.fn();
    render(
      <Sidebar
        {...baseProps}
        showPriority
        onRemoveFromPriority={onRemoveFromPriority}
        snapshot={prioritySnapshot}
      />
    );

    fireEvent.contextMenu(screen.getByRole("button", { name: /Blocked task/ }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Remove from priority" }));

    expect(onRemoveFromPriority).toHaveBeenCalledWith("w-blocked");
  });

  it("adds a non-priority row from the context menu", () => {
    const onAddToPriority = vi.fn();
    render(
      <Sidebar
        {...baseProps}
        showPriority
        onAddToPriority={onAddToPriority}
        snapshot={prioritySnapshot}
      />
    );

    // The calm row sits in its project group; its menu offers Add, not Remove.
    fireEvent.click(screen.getByRole("button", { name: "Show Argmax sessions" }));
    fireEvent.contextMenu(screen.getByRole("button", { name: /Calm task/ }));
    expect(screen.queryByRole("menuitem", { name: "Remove from priority" })).toBeNull();
    fireEvent.click(screen.getByRole("menuitem", { name: "Add to priority" }));

    expect(onAddToPriority).toHaveBeenCalledWith("w-calm");
  });

  it("sets a custom row icon from the context menu", () => {
    const onSetWorkspaceIcon = vi.fn();
    render(
      <Sidebar
        {...baseProps}
        showPriority
        onSetWorkspaceIcon={onSetWorkspaceIcon}
        snapshot={prioritySnapshot}
      />
    );

    fireEvent.contextMenu(screen.getByRole("button", { name: /Blocked task/ }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Edit Icon" }));
    fireEvent.click(screen.getByRole("button", { name: "Teal icon color" }));
    fireEvent.click(screen.getByRole("button", { name: "Rocket" }));

    expect(onSetWorkspaceIcon).toHaveBeenCalledWith("w-blocked", "Rocket", "teal");
  });

  it("floats a manually added workspace without attention", () => {
    const manualSnapshot: DashboardSnapshot = {
      ...prioritySnapshot,
      workspaces: [
        workspace("w-blocked", "Blocked task"),
        { ...workspace("w-calm", "Calm task"), priorityAddedAt: MINUTES_AGO_15 }
      ]
    };
    render(<Sidebar {...baseProps} showPriority snapshot={manualSnapshot} />);

    // Both rows float: the blocked one by attention, the calm one manually.
    expect(screen.getByText("Priority")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Calm task/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Blocked task/ })).toBeInTheDocument();
  });

  it("hides a dismissed workspace whose attention has not changed since", () => {
    const dismissedSnapshot: DashboardSnapshot = {
      ...prioritySnapshot,
      workspaces: [
        workspace("w-blocked", "Blocked task", MINUTES_AGO_15),
        workspace("w-calm", "Calm task")
      ]
    };
    render(<Sidebar {...baseProps} showPriority snapshot={dismissedSnapshot} />);
    expect(screen.queryByText("Priority")).toBeNull();
  });
});

describe("Sidebar — boot collapse defaults", () => {
  const MINUTES_AGO_30 = new Date(Date.now() - 30 * 60 * 1000).toISOString();
  const LONG_AGO = new Date(2024, 0, 4, 9, 0, 0).toISOString();

  const bootWorkspace = (id: string, taskLabel: string, lastActivityAt: string) => ({
    id,
    projectId: "project-1",
    taskLabel,
    branch: `argmax/${id}`,
    baseRef: "main",
    path: `/tmp/${id}`,
    state: "running" as const,
    sharedWorkspace: false,
    dirty: false,
    changedFiles: 0,
    lastActivityAt,
    pinned: false,
    priorityDismissedAt: null,
    priorityAddedAt: null
  });

  const bootSession = (workspaceId: string, attention: "normal" | "blocked") => ({
    id: `session-${workspaceId}`,
    workspaceId,
    provider: "codex" as const,
    modelLabel: "GPT-5.3 Codex",
    modelId: "gpt-5.5",
    permissionMode: "auto-approve" as const,
    agentMode: "auto" as const,
    providerConversationId: null,
    state: attention === "blocked" ? ("waiting" as const) : ("running" as const),
    attention,
    attentionChangedAt: MINUTES_AGO_30,
    startedAt: "2026-05-12T15:00:00.000Z",
    completedAt: null,
    lastActivityAt: MINUTES_AGO_30,
    prompt: "Do the thing"
  });

  const bootSnapshot: DashboardSnapshot = {
    ...snapshot,
    workspaces: [
      { ...bootWorkspace("w-pinned", "Pinned task", MINUTES_AGO_30), pinned: true },
      bootWorkspace("w-blocked", "Blocked task", MINUTES_AGO_30),
      bootWorkspace("w-old", "Ancient task", LONG_AGO)
    ],
    sessions: [
      bootSession("w-pinned", "normal"),
      bootSession("w-blocked", "blocked"),
      bootSession("w-old", "normal")
    ]
  };

  beforeEach(() => {
    window.localStorage.clear();
    window.localStorage.setItem(sidebarViewModeStorageKey, JSON.stringify("sessions"));
    // A previous session left every group expanded; a launch must ignore that.
    window.localStorage.setItem(collapsedDateGroupsStorageKey, JSON.stringify([]));
    window.sessionStorage.clear();
  });

  afterEach(() => {
    cleanup();
    window.localStorage.clear();
  });

  it("opens with Pinned expanded and every other group collapsed", () => {
    render(<Sidebar {...baseProps} showPriority snapshot={bootSnapshot} />);

    expect(screen.getByRole("button", { name: "Hide Pinned sessions" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Pinned task/ })).toBeInTheDocument();

    for (const label of ["Priority", "Older"]) {
      expect(screen.getByRole("button", { name: `Show ${label} sessions` })).toBeInTheDocument();
    }
    expect(screen.queryByRole("button", { name: /Blocked task/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Ancient task/ })).toBeNull();
  });

  it("lets a group stay expanded for the rest of the session", () => {
    render(<Sidebar {...baseProps} showPriority snapshot={bootSnapshot} />);

    fireEvent.click(screen.getByRole("button", { name: "Show Older sessions" }));
    expect(screen.getByRole("button", { name: /Ancient task/ })).toBeInTheDocument();

    // A re-mount inside the same launch respects the toggle; only a new launch
    // (a cleared sessionStorage marker) re-seeds the collapsed set.
    cleanup();
    render(<Sidebar {...baseProps} showPriority snapshot={bootSnapshot} />);
    expect(screen.getByRole("button", { name: /Ancient task/ })).toBeInTheDocument();

    window.sessionStorage.clear();
    cleanup();
    render(<Sidebar {...baseProps} showPriority snapshot={bootSnapshot} />);
    expect(screen.queryByRole("button", { name: /Ancient task/ })).toBeNull();
  });
});
