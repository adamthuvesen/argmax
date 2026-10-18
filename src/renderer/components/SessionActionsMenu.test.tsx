import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionSummary, WorkspaceSummary } from "../../shared/types.js";
import { SessionActionsMenu } from "./SessionActionsMenu.js";
import { resetToastForTests } from "../state/toast.js";

function installArgmax(
  listForSession: ReturnType<typeof vi.fn>,
  prepareCloud: ReturnType<typeof vi.fn> = vi.fn().mockResolvedValue({
    provider: "codex",
    repository: "adamthuvesen/private-sandbox",
    branch: "main",
    commit: "12345678",
    brief: "Test task",
    environmentId: "env-default",
    environmentDescription: "Default",
    environments: [{ id: "env-default", name: "Default" }]
  })
): void {
  Object.defineProperty(window, "argmax", {
    configurable: true,
    writable: true,
    value: {
      prs: {
        listForSession
      },
      cloud: {
        prepare: prepareCloud,
        launch: vi.fn()
      },
      system: {
        openPath: vi.fn().mockResolvedValue({ ok: true })
      }
    }
  });
}

function session(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id: "session-1",
    workspaceId: "workspace-1",
    provider: "codex",
    modelLabel: "GPT-5.3 Codex",
    modelId: "gpt-5.5",
    permissionMode: "auto-approve",
    agentMode: "auto",
    providerConversationId: null,
    prompt: "go",
    state: "complete",
    attention: "normal",
    startedAt: "2026-05-12T15:00:00.000Z",
    completedAt: "2026-05-12T15:00:01.000Z",
    lastActivityAt: "2026-05-12T15:00:01.000Z",
    costUsd: 0,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextTokens: 0,
    imported: false,
    launchKind: "agent",
    ...overrides
  };
}

function workspace(overrides: Partial<WorkspaceSummary> = {}): WorkspaceSummary {
  return {
    id: "workspace-1",
    projectId: "project-1",
    taskLabel: "Tidy chat",
    branch: "feature/tidy-chat",
    baseRef: "main",
    path: "/repo",
    state: "complete",
    sharedWorkspace: false,
    kind: "git",
    dirty: false,
    changedFiles: 0,
    lastActivityAt: "2026-05-12T15:00:01.000Z",
    pinned: false,
    priorityDismissedAt: null,
    priorityAddedAt: null,
    prState: null,
    prNumber: null,
    icon: null,
    iconColor: null,
    prCreatedAt: null,
    prMergedAt: null,
    prCheckState: null,
    prActivityAt: null,
    ...overrides
  };
}

/**
 * Opening the menu fires the PR lookup for the session. Settle it inside
 * `act` so the state it sets lands during the test rather than after it,
 * which is what React warns about.
 */
async function openMenu(): Promise<void> {
  fireEvent.click(screen.getByRole("button", { name: "Chat actions" }));
  await act(async () => {});
}

describe("SessionActionsMenu", () => {
  let listForSession: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    listForSession = vi.fn().mockResolvedValue([]);
    installArgmax(listForSession);
  });

  afterEach(() => {
    cleanup();
    resetToastForTests();
    delete (window as { argmax?: unknown }).argmax;
  });


  it("hides actions until opened and routes main menu clicks", async () => {
    const onBrowseFiles = vi.fn();
    const onToggleLog = vi.fn();
    render(
      <SessionActionsMenu
        isLogOpen={false}
        onBrowseFiles={onBrowseFiles}
        onToggleLog={onToggleLog}
        session={session()}
        workspace={workspace({ dirty: true })}
      />
    );

    expect(screen.queryByRole("menuitem", { name: "Browse Files" })).toBeNull();
    await openMenu();

    expect(screen.getByRole("menuitem", { name: "Browse Files" })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "Git actions" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("menuitem", { name: "Browse Files" }));
    expect(onBrowseFiles).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("menuitem", { name: "Browse Files" })).toBeNull();

    await waitFor(() => {
      expect(listForSession).toHaveBeenCalledWith({ sessionId: "session-1" });
    });
  });

  it("opens the browser pane from the menu", async () => {
    const { getBrowserRequest, subscribeBrowserRequest } = await import("../lib/browserPanel.js");
    let requestCount = 0;
    const unsubscribe = subscribeBrowserRequest(() => {
      requestCount += 1;
    });

    render(
      <SessionActionsMenu
        isLogOpen={false}
        onBrowseFiles={vi.fn()}
        onToggleLog={vi.fn()}
        session={session()}
        workspace={workspace()}
      />
    );

    await openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "Open Browser" }));

    // No target URL: the claiming pane restores its own tab strip rather than
    // navigating to a hardcoded page.
    expect(requestCount).toBe(1);
    expect(getBrowserRequest()?.url).toBe("");
    unsubscribe();
  });

  it("offers the session provider's cloud agent for a git-backed session", async () => {
    const prepareCloud = vi.fn().mockResolvedValue({
      provider: "codex",
      repository: "adamthuvesen/private-sandbox",
      branch: "main",
      commit: "12345678",
      brief: "Test task",
      environmentId: "env-default",
      environmentDescription: "Default",
      environments: [{ id: "env-default", name: "Default" }]
    });
    installArgmax(listForSession, prepareCloud);

    render(
      <SessionActionsMenu
        isLogOpen={false}
        onBrowseFiles={vi.fn()}
        onToggleLog={vi.fn()}
        session={session()}
        workspace={workspace()}
      />
    );

    await openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "Send Task to Codex Cloud…" }));

    expect(await screen.findByRole("dialog", { name: "Send task to Codex Cloud" })).toBeInTheDocument();
    expect(prepareCloud).toHaveBeenCalledWith({ sessionId: "session-1", provider: "codex" });
  });

  it("does not offer cloud handoff for providers without hosted agents", async () => {
    render(
      <SessionActionsMenu
        isLogOpen={false}
        onBrowseFiles={vi.fn()}
        onToggleLog={vi.fn()}
        session={session({ provider: "opencode" })}
        workspace={workspace()}
      />
    );

    await openMenu();
    expect(screen.queryByRole("menuitem", { name: /Cloud/ })).not.toBeInTheDocument();
  });




});

describe("SessionActionsMenu — Open in IDE", () => {
  let listForSession: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    listForSession = vi.fn().mockResolvedValue([]);
    installArgmax(listForSession);
  });

  afterEach(() => {
    cleanup();
    delete (window as { argmax?: unknown }).argmax;
  });

  const IDES = [
    { id: "vscode" as const, label: "VS Code", appPath: "/Applications/VS Code.app", hasCli: true },
    { id: "cursor" as const, label: "Cursor", appPath: "/Applications/Cursor.app", hasCli: true }
  ];

  it("opens the default IDE from the menu", async () => {
    const onOpenInIde = vi.fn();
    render(
      <SessionActionsMenu
        isLogOpen={false}
        onBrowseFiles={vi.fn()}
        onToggleLog={vi.fn()}
        session={session()}
        workspace={workspace()}
        detectedIdes={IDES}
        defaultIde="cursor"
        onOpenInIde={onOpenInIde}
      />
    );

    await openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "Open in Cursor" }));

    expect(onOpenInIde).toHaveBeenCalledWith("cursor");
  });

  it("falls back to the first GUI IDE when the default is not detected", async () => {
    const onOpenInIde = vi.fn();
    render(
      <SessionActionsMenu
        isLogOpen={false}
        onBrowseFiles={vi.fn()}
        onToggleLog={vi.fn()}
        session={session()}
        workspace={workspace()}
        detectedIdes={[{ id: "zed", label: "Zed", appPath: "/Applications/Zed.app", hasCli: false }]}
        defaultIde="cursor"
        onOpenInIde={onOpenInIde}
      />
    );

    await openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "Open in Zed" }));

    expect(onOpenInIde).toHaveBeenCalledWith("zed");
  });

  it("lists every GUI IDE when the user chose Ask each time", async () => {
    const onOpenInIde = vi.fn();
    render(
      <SessionActionsMenu
        isLogOpen={false}
        onBrowseFiles={vi.fn()}
        onToggleLog={vi.fn()}
        session={session()}
        workspace={workspace()}
        detectedIdes={IDES}
        defaultIde={null}
        onOpenInIde={onOpenInIde}
      />
    );

    await openMenu();
    expect(screen.getByRole("menuitem", { name: "Open in VS Code" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("menuitem", { name: "Open in Cursor" }));

    expect(onOpenInIde).toHaveBeenCalledWith("cursor");
  });

  it("leaves the action out with no handler and with no IDE installed", async () => {
    const { unmount } = render(
      <SessionActionsMenu
        isLogOpen={false}
        onBrowseFiles={vi.fn()}
        onToggleLog={vi.fn()}
        session={session()}
        workspace={workspace()}
      />
    );
    await openMenu();
    expect(screen.queryByRole("menuitem", { name: /^Open in (?!New Window)/ })).toBeNull();
    unmount();

    render(
      <SessionActionsMenu
        isLogOpen={false}
        onBrowseFiles={vi.fn()}
        onToggleLog={vi.fn()}
        session={session()}
        workspace={workspace()}
        detectedIdes={[]}
        defaultIde={null}
        onOpenInIde={vi.fn()}
      />
    );
    await openMenu();
    // A greyed-out row nobody can ever click explains nothing; with no IDE
    // installed there is simply no row.
    expect(screen.queryByRole("menuitem", { name: /^Open in (?!New Window)/ })).toBeNull();
  });
});

describe("SessionActionsMenu — launching chat", () => {
  let listForSession: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    listForSession = vi.fn().mockResolvedValue([]);
    installArgmax(listForSession);
  });

  afterEach(() => {
    cleanup();
    delete (window as { argmax?: unknown }).argmax;
  });

  it("hides the action for a session nobody launched, and when the launcher is gone", async () => {
    const { unmount } = render(
      <SessionActionsMenu
        isLogOpen={false}
        onBrowseFiles={vi.fn()}
        onToggleLog={vi.fn()}
        onOpenLaunchingChat={vi.fn()}
        session={session()}
        workspace={workspace()}
      />
    );
    await openMenu();
    expect(screen.queryByRole("menuitem", { name: "Open Launching Chat" })).toBeNull();
    unmount();

    render(
      <SessionActionsMenu
        isLogOpen={false}
        onBrowseFiles={vi.fn()}
        onToggleLog={vi.fn()}
        session={{ ...session(), launchedBySessionId: "session-parent" }}
        workspace={workspace()}
      />
    );
    await openMenu();
    expect(screen.queryByRole("menuitem", { name: "Open Launching Chat" })).toBeNull();
  });

  it("starts an arc from the chat, and says why it cannot while a turn runs", async () => {
    const run = vi.fn();
    const { unmount } = render(
      <SessionActionsMenu
        isLogOpen={false}
        onBrowseFiles={vi.fn()}
        onToggleLog={vi.fn()}
        onStartArc={{ run, disabledReason: null }}
        session={session()}
        workspace={workspace()}
      />
    );
    await openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "Start an Arc from This Chat…" }));
    expect(run).toHaveBeenCalledTimes(1);
    unmount();

    render(
      <SessionActionsMenu
        isLogOpen={false}
        onBrowseFiles={vi.fn()}
        onToggleLog={vi.fn()}
        onStartArc={{ run, disabledReason: "Wait for this turn to finish" }}
        session={session()}
        workspace={workspace()}
      />
    );
    await openMenu();
    const item = screen.getByRole("menuitem", { name: "Start an Arc from This Chat…" });
    expect(item).toBeDisabled();
    expect(item).toHaveAttribute("title", "Wait for this turn to finish");
  });
});
