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
      pinned: false
    }
  ],
  sessions: [],
  events: [],
  rawOutputs: [],
  approvals: [],
  checks: [],
  checkpoints: []
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

const noop = (): void => {};

const baseProps = {
  loadState: "ready" as const,
  onAddProject: noop,
  onArchiveWorkspace: noop,
  onOpenInIde: noop,
  onOpenLauncher: noop,
  onOpenProject: noop,
  onOpenSettings: noop,
  onOpenWorkspaceChat: noop,
  onResizeMouseDown: noop,
  isSettingsActive: false,
  selectedProjectId: null,
  selectedWorkspaceId: null,
  openWorkspaceIds: new Set<string>(),
  canDragWorkspaceToGrid: false,
  detectedIdes: [],
  defaultIde: null,
  showSessionTokens: false
};

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
    // audit-2026-05-11 / SPEC P1.08 — saving inside the setState updater
    // would persist twice when StrictMode double-invokes the updater in
    // dev. The fix computes `next` outside the updater and calls the
    // storage writer exactly once per user action.
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
          onOpenProject={noop}
          onOpenSettings={noop}
          onOpenWorkspaceChat={noop}
          onResizeMouseDown={noop}
          isSettingsActive={false}
          selectedProjectId={null}
          selectedWorkspaceId={null}
          openWorkspaceIds={new Set()}
          canDragWorkspaceToGrid={false}
          snapshot={snapshot}
          detectedIdes={[]}
          defaultIde={null}
          showSessionTokens={false}
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
          onOpenProject={noop}
          onOpenSettings={noop}
          onOpenWorkspaceChat={noop}
          onResizeMouseDown={noop}
          isSettingsActive={false}
          selectedProjectId={null}
          selectedWorkspaceId={null}
          openWorkspaceIds={new Set()}
          canDragWorkspaceToGrid={false}
          snapshot={snapshot}
          detectedIdes={[]}
          defaultIde={null}
          showSessionTokens={false}
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

    const groups = document.querySelectorAll<HTMLElement>(".project-group");
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
          pinned: false
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
    pinned: false
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

    // Header label switches to "Sessions".
    expect(screen.getByText("Sessions")).toBeInTheDocument();

    // Date buckets render, newest first.
    expect(screen.getByText("Today")).toBeInTheDocument();
    expect(screen.getByText("April")).toBeInTheDocument();

    // Both sessions are visible immediately (no per-project collapse), across
    // both projects.
    expect(screen.getByRole("button", { name: /Zebra task today/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Argmax task in april/ })).toBeInTheDocument();

    // No project rows in this view.
    expect(getProjectButtonOrder()).toEqual([]);
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

    // Defaults to project grouping: the header reads "Projects".
    expect(screen.getByText("Projects")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Sidebar view options" }));
    const menu = screen.getByRole("menu", { name: "Sidebar view options" });
    fireEvent.click(within(menu).getByRole("menuitemradio", { name: "Date" }));

    expect(window.localStorage.getItem(sidebarViewModeStorageKey)).toBe(JSON.stringify("sessions"));
    expect(screen.getByText("Sessions")).toBeInTheDocument();
    expect(screen.getByText("Today")).toBeInTheDocument();
  });
});
