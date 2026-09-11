import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionSummary, WorkspaceSummary } from "../../shared/types.js";
import { SessionActionsMenu } from "./SessionActionsMenu.js";

function installArgmax(
  listForSession: ReturnType<typeof vi.fn>,
  viewOrCreatePr: ReturnType<typeof vi.fn> = vi.fn()
): void {
  Object.defineProperty(window, "argmax", {
    configurable: true,
    writable: true,
    value: {
      prs: {
        listForSession
      },
      git: {
        push: vi.fn(),
        createBranch: vi.fn(),
        viewOrCreatePr
      },
      system: {
        openPath: vi.fn().mockResolvedValue({ ok: true })
      }
    }
  });
}

function session(): SessionSummary {
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
    launchKind: "agent"
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

    expect(screen.queryByRole("menuitem", { name: "Browse files" })).toBeNull();
    await openMenu();

    expect(screen.getByRole("menuitem", { name: "Browse files" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("menuitem", { name: "Browse files" }));
    expect(onBrowseFiles).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("menuitem", { name: "Browse files" })).toBeNull();

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
    fireEvent.click(screen.getByRole("menuitem", { name: "Open browser" }));

    // No target URL: the claiming pane restores its own tab strip rather than
    // navigating to a hardcoded page.
    expect(requestCount).toBe(1);
    expect(getBrowserRequest()?.url).toBe("");
    unsubscribe();
  });

  it("switches between the main menu and git actions in place", async () => {
    render(
      <SessionActionsMenu
        isLogOpen
        onBrowseFiles={() => {}}
        onOpenCommitDialog={() => {}}
        onToggleLog={() => {}}
        session={session()}
        workspace={workspace()}
      />
    );

    await openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "Git actions" }));

    expect(screen.queryByRole("menuitem", { name: "Browse files" })).toBeNull();
    expect(screen.getByRole("menuitem", { name: "Push" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Create pull request" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Back to chat actions" }));
    expect(screen.getByRole("menuitem", { name: "Browse files" })).toBeInTheDocument();
  });

  it("opens an existing pull request in the system browser from git actions", async () => {
    const viewOrCreatePr = vi.fn().mockResolvedValue({
      action: "opened",
      url: "https://github.com/o/r/pull/12",
      prNumber: 12
    });
    listForSession.mockResolvedValue([{ prNumber: 12 }]);
    installArgmax(listForSession, viewOrCreatePr);

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
    fireEvent.click(screen.getByRole("menuitem", { name: "Git actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "View pull request" }));

    await waitFor(() =>
      expect(viewOrCreatePr).toHaveBeenCalledWith({ sessionId: "session-1" })
    );
    expect(
      (window as unknown as { argmax: { system: { openPath: ReturnType<typeof vi.fn> } } }).argmax.system
        .openPath
    ).toHaveBeenCalledWith({ path: "https://github.com/o/r/pull/12" });
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

  it("hides the action without a handler and disables it without IDEs", async () => {
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
    expect(screen.queryByRole("menuitem", { name: /Open in/ })).toBeNull();
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
    expect(screen.getByRole("menuitem", { name: "Open in IDE" })).toBeDisabled();
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

  it("opens the chat whose agent launched this one", async () => {
    const onOpenLaunchingChat = vi.fn();
    render(
      <SessionActionsMenu
        isLogOpen={false}
        onBrowseFiles={vi.fn()}
        onToggleLog={vi.fn()}
        onOpenLaunchingChat={onOpenLaunchingChat}
        session={{ ...session(), launchedBySessionId: "session-parent" }}
        workspace={workspace()}
      />
    );

    await openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "Open launching chat" }));

    expect(onOpenLaunchingChat).toHaveBeenCalledTimes(1);
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
    expect(screen.queryByRole("menuitem", { name: "Open launching chat" })).toBeNull();
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
    expect(screen.queryByRole("menuitem", { name: "Open launching chat" })).toBeNull();
  });
});
