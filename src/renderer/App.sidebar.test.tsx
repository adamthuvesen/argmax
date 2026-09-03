import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App.js";
import type { ArgmaxApi, DashboardSnapshot } from "../shared/types.js";
import { WORKSPACE_ASSET_PROTOCOL_SCHEME } from "../shared/assetProtocol.js";
import {
  createCurrentWorkspace,
  dashboardDeltaListener,
  dashboardList,
  dashboardListSnapshot,
  launchProvider,
  listChangedFiles,
  listProjectFiles,
  listWorkspaceFiles,
  loadDiff,
  menuCommandListener,
  mockDashboardSnapshot,
  primaryProject,
  secondProject,
  readProjectFile,
  readWorkspaceFile,
  sendProviderInput,
  sessionEventsSince,
  setPriorityDismissed,
  setWorkspaceIcon,
  skillsList,
  setupAppTestMocks,
  snapshot,
  terminateProvider,
  writeProjectFile,
  workspaceStatus,
  workspaceStatusSnapshot
} from "../test/appTestHarness.js";

describe("App sidebar", () => {
  afterEach(() => {
    vi.useRealTimers();
    cleanup();
  });

  beforeEach(() => {
    setupAppTestMocks();
  });

  it("expands the hosting date group when a workspace appears without being selected", async () => {
    window.localStorage.setItem("argmax.sidebar.viewMode", JSON.stringify("sessions"));
    // The harness disables Priority by default; this test needs it on so the
    // mid-turn seed floats out of the date buckets.
    window.localStorage.setItem("argmax.sidebar.priority.visible", "true");
    render(<App />);
    // The seeded workspace is mid-turn, so it floats into Priority; the seeded
    // snapshot has no Today activity, so that bucket isn't rendered yet — and
    // per-launch defaults would show it collapsed once it appears.
    await screen.findByRole("button", { name: /Priority chats/ });
    expect(screen.queryByRole("button", { name: /Today chats/ })).not.toBeInTheDocument();

    // A fork (or an agent-launched session) lands as a delta with a fresh
    // workspace the user never clicked. Its group must open so the creation
    // is visibly confirmed.
    const forkedWorkspace: DashboardSnapshot["workspaces"][number] = {
      id: "workspace-forked",
      projectId: "project-1",
      taskLabel: "Morning Status Check (fork)",
      branch: "main",
      baseRef: "main",
      path: "/tmp/project-1",
      state: "complete",
      sharedWorkspace: true,
      kind: "git",
      dirty: false,
      changedFiles: 0,
      lastActivityAt: new Date().toISOString(),
      pinned: false,
      priorityDismissedAt: null,
      priorityAddedAt: null
    };
    const forkedSession: DashboardSnapshot["sessions"][number] = {
      id: "session-forked",
      workspaceId: "workspace-forked",
      provider: "claude",
      modelLabel: "Sonnet 5",
      modelId: "claude-sonnet-5",
      permissionMode: "auto-approve",
      providerConversationId: "session-1",
      prompt: "Morning status check",
      state: "complete",
      attention: "normal",
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      lastActivityAt: new Date().toISOString()
    };
    await act(async () => {
      dashboardDeltaListener?.({ workspaces: [forkedWorkspace], sessions: [forkedSession] });
      await Promise.resolve();
    });

    expect(await screen.findByRole("button", { name: /Today chats/ })).toHaveAttribute(
      "aria-expanded",
      "true"
    );
  });

  it("opens the nth sidebar row on Cmd+1..9, in the order the rows are shown", async () => {
    window.localStorage.setItem("argmax.sidebar.viewMode", JSON.stringify("sessions"));
    // Pinned floats to the top of the sidebar, so the row the user sees first
    // is not the first entry in the snapshot's session list.
    const pinnedWorkspace: DashboardSnapshot["workspaces"][number] = {
      ...snapshot.workspaces[0],
      id: "workspace-pinned",
      taskLabel: "Pinned work",
      branch: "argmax/pinned",
      path: "/tmp/worktrees/pinned",
      state: "complete",
      dirty: false,
      changedFiles: 0,
      pinned: true,
      lastActivityAt: "2026-05-08T15:00:00.000Z"
    };
    const pinnedSession: DashboardSnapshot["sessions"][number] = {
      ...snapshot.sessions[0],
      id: "session-pinned",
      workspaceId: "workspace-pinned",
      prompt: "Pinned work",
      state: "complete",
      completedAt: "2026-05-08T15:00:00.000Z",
      lastActivityAt: "2026-05-08T15:00:00.000Z"
    };
    mockDashboardSnapshot({
      ...snapshot,
      workspaces: [...snapshot.workspaces, pinnedWorkspace],
      sessions: [...snapshot.sessions, pinnedSession]
    });

    render(<App />);
    await screen.findByRole("button", { name: /Pinned work/ });

    fireEvent.keyDown(document, { key: "1", code: "Digit1", metaKey: true });
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /Pinned work/ })).toHaveAttribute("aria-current", "true")
    );

    fireEvent.keyDown(document, { key: "2", code: "Digit2", metaKey: true });
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /Build dashboard/ })).toHaveAttribute("aria-current", "true")
    );

    // Cmd+1..9 must work even when focus is inside the composer textarea
    const promptInput = await screen.findByLabelText("Chat prompt");
    promptInput.focus();
    expect(promptInput).toHaveFocus();

    fireEvent.keyDown(promptInput, { key: "1", code: "Digit1", metaKey: true });
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /Pinned work/ })).toHaveAttribute("aria-current", "true")
    );
  });

  it("follows a moved session only while its source is selected", async () => {
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: /Build dashboard/ }));
    await screen.findByText("Dashboard ready.");
    const movedWorkspace: DashboardSnapshot["workspaces"][number] = {
      id: "workspace-moved",
      projectId: "project-2",
      taskLabel: "Build dashboard",
      branch: "main",
      baseRef: "main",
      path: "/tmp/dotfiles",
      state: "complete",
      sharedWorkspace: true,
      kind: "git",
      dirty: false,
      changedFiles: 0,
      lastActivityAt: "2026-05-08T16:00:00.000Z",
      pinned: false,
      priorityDismissedAt: null,
      priorityAddedAt: null
    };
    const movedSession: DashboardSnapshot["sessions"][number] = {
      id: "session-moved",
      workspaceId: movedWorkspace.id,
      provider: "codex",
      modelLabel: "GPT-5.6 Terra",
      modelId: "gpt-5.6-terra",
      reasoningEffort: "medium",
      permissionMode: "auto-approve",
      providerConversationId: null,
      prompt: "Build dashboard",
      state: "complete",
      attention: "normal",
      startedAt: "2026-05-08T15:30:00.000Z",
      completedAt: "2026-05-08T16:00:00.000Z",
      lastActivityAt: "2026-05-08T16:00:00.000Z"
    };
    await act(async () => {
      dashboardDeltaListener?.({
        projects: [secondProject()],
        workspaces: [movedWorkspace],
        sessions: [movedSession],
        events: [
          {
            id: "move-destination",
            sessionId: movedSession.id,
            type: "session.moved",
            message: "Moved from Argmax to Dotfiles.",
            payload: {
              direction: "destination",
              sourceSessionId: "session-1",
              sourceWorkspaceId: "workspace-1",
              sourceProjectName: "Argmax",
              destinationSessionId: movedSession.id,
              destinationWorkspaceId: movedWorkspace.id,
              destinationProjectName: "Dotfiles",
              checkoutMode: "shared"
            },
            createdAt: "2026-05-08T16:00:00.000Z"
          }
        ]
      });
      await Promise.resolve();
    });

    expect(
      await screen.findByRole("status", {
        name: "Argmax → Dotfiles, shared checkout"
      })
    ).toBeInTheDocument();
    // The sidebar has to name the repo the agent is working in now, not the
    // one it left.
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Dotfiles" })).toHaveAttribute(
        "aria-current",
        "true"
      )
    );
    expect(screen.getByRole("button", { name: "Argmax" })).not.toHaveAttribute("aria-current");
  });

  it("opens a sidebar session", async () => {
    const secondWorkspace: DashboardSnapshot["workspaces"][number] = {
      id: "workspace-2",
      projectId: "project-1",
      taskLabel: "Second chat",
      branch: "argmax/second-chat",
      baseRef: "main",
      path: "/tmp/worktrees/second-chat",
      state: "complete",
      sharedWorkspace: false,
      kind: "git",
      dirty: false,
      changedFiles: 0,
      lastActivityAt: "2026-05-08T16:04:00.000Z",
      pinned: false,
      priorityDismissedAt: null,
      priorityAddedAt: null
    };
    const secondSession: DashboardSnapshot["sessions"][number] = {
      id: "session-2",
      workspaceId: "workspace-2",
      provider: "claude",
      modelLabel: "Sonnet 5",
      modelId: "claude-sonnet-5",
      permissionMode: "auto-approve",
      providerConversationId: "session-2",
      prompt: "Second chat",
      state: "complete",
      attention: "review-ready",
      startedAt: "2026-05-08T16:00:00.000Z",
      completedAt: "2026-05-08T16:04:00.000Z",
      lastActivityAt: "2026-05-08T16:04:00.000Z",
    };
    const secondEvent: DashboardSnapshot["events"][number] = {
      id: "event-2",
      sessionId: "session-2",
      type: "message.completed",
      message: "Second answer.",
      payload: {},
      createdAt: "2026-05-08T16:04:00.000Z"
    };
    mockDashboardSnapshot({
      ...snapshot,
      workspaces: [...snapshot.workspaces, secondWorkspace],
      sessions: [...snapshot.sessions, secondSession]
    });
    sessionEventsSince.mockImplementation((input) => {
      if (input.sessionId === "session-2") {
        return Promise.resolve({ events: [secondEvent], rawOutputs: [], eventCursor: 2, rawOutputCursor: 0 });
      }
      return Promise.resolve({ events: snapshot.events, rawOutputs: [], eventCursor: 1, rawOutputCursor: 0 });
    });

    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "Second chat" }));

    expect(await screen.findByRole("heading", { name: "Argmax" })).toBeInTheDocument();
    expect(screen.getByText("Second answer.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Chat model" })).toHaveTextContent("Sonnet 5");
    expect(screen.queryByText("review-ready")).not.toBeInTheDocument();
    expect(screen.queryByText("complete")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Second chat" })).toHaveAttribute("aria-current", "true");
    expect(screen.queryByText("Dashboard ready.")).not.toBeInTheDocument();
  });

  it("persists a custom session icon through the workspaces:set-icon command", async () => {
    render(<App />);

    const row = await screen.findByRole("button", { name: /Build dashboard/ });
    fireEvent.contextMenu(row);
    fireEvent.click(screen.getByRole("menuitem", { name: "Edit Icon" }));
    fireEvent.click(screen.getByRole("button", { name: "Plum icon color" }));
    fireEvent.click(screen.getByRole("button", { name: "Sparkles" }));

    await waitFor(() =>
      expect(setWorkspaceIcon).toHaveBeenCalledWith({
        workspaceId: "workspace-1",
        icon: "Sparkles",
        iconColor: "plum"
      })
    );
  });

  it("shows a thinking indicator while a session is running", async () => {
    mockDashboardSnapshot({
      ...snapshot,
      events: []
    });
    sessionEventsSince.mockResolvedValue({
      events: [],
      rawOutputs: [],
      eventCursor: 0,
      rawOutputCursor: 0
    });

    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "Build dashboard" }));

    expect(await screen.findByLabelText("Thinking")).toBeInTheDocument();
    expect(screen.getByTestId("thinking-label")).toBeInTheDocument();
    expect(screen.queryByPlaceholderText("Waiting for agent")).not.toBeInTheDocument();
    expect(screen.queryByPlaceholderText("Send a follow-up")).not.toBeInTheDocument();
  });

  it("keeps the thinking indicator visible briefly after assistant output while the session is still running", async () => {
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "Build dashboard" }));

    expect(await screen.findByText("Dashboard ready.")).toBeInTheDocument();
    expect(screen.getByLabelText("Thinking")).toBeInTheDocument();
    expect(screen.getByTestId("thinking-label")).toBeInTheDocument();
  });

  it("shows a thinking indicator for a follow-up turn after earlier assistant output", async () => {
    const followUpEvent: DashboardSnapshot["events"][number] = {
      id: "event-follow-up",
      sessionId: "session-1",
      type: "user.message",
      message: "very good!",
      payload: { source: "composer" },
      createdAt: "2026-05-08T15:55:00.000Z"
    };
    const oldRawOutput: DashboardSnapshot["rawOutputs"][number] = {
      id: "raw-old",
      sessionId: "session-1",
      stream: "stdout",
      content: "old output\n",
      createdAt: "2026-05-08T15:54:30.000Z"
    };
    const rawOutputAfterFollowUp: DashboardSnapshot["rawOutputs"][number] = {
      id: "raw-after-follow-up",
      sessionId: "session-1",
      stream: "stdout",
      content: '{"type":"turn.started"}\n',
      createdAt: "2026-05-08T15:55:01.000Z"
    };
    mockDashboardSnapshot({
      ...snapshot,
      rawOutputs: [oldRawOutput, rawOutputAfterFollowUp],
      events: [...snapshot.events, followUpEvent]
    });
    sessionEventsSince.mockResolvedValue({
      events: [...snapshot.events, followUpEvent],
      rawOutputs: [oldRawOutput, rawOutputAfterFollowUp],
      eventCursor: 2,
      rawOutputCursor: 2
    });

    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "Build dashboard" }));

    expect(await screen.findByText("Dashboard ready.")).toBeInTheDocument();
    expect(screen.getByText("very good!")).toBeInTheDocument();
    expect(screen.getByLabelText("Thinking")).toBeInTheDocument();
    expect(screen.getByTestId("thinking-label")).toBeInTheDocument();
  });

  it("sends follow-up prompts to the selected live session", async () => {
    const completeSessions = snapshot.sessions.map((session) => ({ ...session, state: "complete" as const }));
    const completeSnapshot = {
      ...snapshot,
      sessions: completeSessions
    };
    mockDashboardSnapshot({
      ...snapshot,
      sessions: completeSessions
    });
    workspaceStatus.mockResolvedValue(workspaceStatusSnapshot(completeSnapshot));
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "Build dashboard" }));
    expect(await screen.findByRole("heading", { name: "Argmax" })).toBeInTheDocument();
    const input = await screen.findByLabelText("Chat prompt");
    fireEvent.change(input, {
      target: { value: "continue with tests" }
    });
    fireEvent.click(screen.getByTitle("Send follow-up"));

    await waitFor(() =>
      expect(sendProviderInput).toHaveBeenCalledWith({
        sessionId: "session-1",
        input: "continue with tests",
        provider: "codex",
        modelLabel: "GPT-5.6 Terra",
        modelId: "gpt-5.6-terra",
        reasoningEffort: "medium",
        fastMode: false,
        agentMode: "auto",
        attachments: null
      })
    );
    expect(createCurrentWorkspace).not.toHaveBeenCalled();
    expect(launchProvider).not.toHaveBeenCalled();
    await waitFor(() => expect(input).toHaveFocus());
  });

  it("appends @path references when files are dropped onto the composer", async () => {
    const completeSessions = snapshot.sessions.map((session) => ({ ...session, state: "complete" as const }));
    const completeSnapshot = { ...snapshot, sessions: completeSessions };
    mockDashboardSnapshot(completeSnapshot);
    workspaceStatus.mockResolvedValue(workspaceStatusSnapshot(completeSnapshot));
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "Build dashboard" }));
    const input = await screen.findByLabelText("Chat prompt");
    const form = input.closest("form");
    expect(form).not.toBeNull();

    // Synthesize a Tauri-shaped drop: File objects with a `path` field.
    const insideWorkspace = new File([], "app.ts");
    Object.defineProperty(insideWorkspace, "path", {
      value: "/tmp/worktrees/dashboard/src/app.ts"
    });
    const outsideWorkspace = new File([], "notes.md");
    Object.defineProperty(outsideWorkspace, "path", { value: "/tmp/notes.md" });

    fireEvent.drop(form!, {
      dataTransfer: {
        files: [insideWorkspace, outsideWorkspace],
        types: ["Files"]
      }
    });

    await waitFor(() => {
      const value = (input as HTMLTextAreaElement).value;
      expect(value).toContain("@src/app.ts");
      expect(value).toContain("@/tmp/notes.md");
    });
  });

  it("keeps the composer enabled while running so follow-ups can be queued", async () => {
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "Build dashboard" }));
    const input = await screen.findByLabelText("Chat prompt");
    // Composer is enabled while running; the actual send is routed to the
    // queue in main (see providerSessionService.queue.test.ts).
    expect(input).toBeEnabled();
    // Stop is still available alongside Send while a turn is in flight.
    expect(screen.getByRole("button", { name: "Stop chat" })).toBeInTheDocument();
  });

  it("surfaces a Stop button on a running session and terminates it", async () => {
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "Build dashboard" }));
    const stopButton = await screen.findByRole("button", { name: "Stop chat" });
    // Stop replaces the send/queue button in the same slot while running.
    // Follow-ups are queued via Enter in the textarea, not via a visible button.
    expect(
      screen.queryByRole("button", { name: "Queue follow-up — sent when the current turn finishes" })
    ).not.toBeInTheDocument();

    fireEvent.click(stopButton);

    await waitFor(() => expect(terminateProvider).toHaveBeenCalledWith("session-1"));
    expect(sendProviderInput).not.toHaveBeenCalled();
  });

  it("switches the session model for the next follow-up prompt", async () => {
    const completeSessions = snapshot.sessions.map((session) => ({ ...session, state: "complete" as const }));
    mockDashboardSnapshot({
      ...snapshot,
      sessions: completeSessions
    });
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "Build dashboard" }));
    fireEvent.click(await screen.findByRole("button", { name: "Chat model" }));
    const modelPopover = await screen.findByRole("listbox", { name: "Chat model" });
    // GPT-5.6 Sol is effort-capable; selecting it seeds the default Medium effort.
    fireEvent.click(within(modelPopover).getByText("GPT-5.6 Sol"));
    fireEvent.change(await screen.findByLabelText("Chat prompt"), {
      target: { value: "use the stronger model" }
    });
    fireEvent.click(screen.getByTitle("Send follow-up"));

    await waitFor(() =>
      expect(sendProviderInput).toHaveBeenCalledWith({
        sessionId: "session-1",
        input: "use the stronger model",
        provider: "codex",
        modelLabel: "GPT-5.6 Sol",
        modelId: "gpt-5.6-sol",
        reasoningEffort: "medium",
        fastMode: false,
        agentMode: "auto",
        attachments: null
      })
    );
  });

  it("opens a changed file review panel with parsed diff lines", async () => {
    listChangedFiles.mockResolvedValue([
      { path: "src/renderer/App.tsx", status: "M", additions: 2, deletions: 2 },
      { path: "src/renderer/styles.css", status: "M", additions: 0, deletions: 15 }
    ]);
    loadDiff.mockResolvedValue({
      workspaceId: "workspace-1",
      filePath: "src/renderer/App.tsx",
      content: [
        "diff --git a/src/renderer/App.tsx b/src/renderer/App.tsx",
        "--- a/src/renderer/App.tsx",
        "+++ b/src/renderer/App.tsx",
        "@@ -1,3 +1,3 @@",
        " const before = true;",
        "-const oldValue = true;",
        "+const newValue = true;",
        " const after = true;",
        "@@ -20,2 +20,2 @@",
        "-const stale = true;",
        "+const fresh = true;"
      ].join("\n")
    });

    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "Build dashboard" }));

    const changesButton = await screen.findByRole("button", {
      name: "Open changed files in review panel: 2 files changed, 2 additions, 17 deletions"
    });
    expect(changesButton).toHaveTextContent("+2");
    expect(changesButton).toHaveTextContent("-17");
    expect(screen.queryByText("2 files changed")).not.toBeInTheDocument();
    expect(screen.queryByRole("complementary", { name: "Review panel" })).not.toBeInTheDocument();

    fireEvent.click(changesButton);

    const reviewPanel = await screen.findByRole("complementary", { name: "Review panel" }, { timeout: 5000 });
    expect(reviewPanel).toBeInTheDocument();
    // Opening the Changes view selects the first changed file for the reader,
    // so its diff loads without anyone picking one.
    await waitFor(() =>
      expect(loadDiff).toHaveBeenCalledWith(
        { kind: "workspace", id: "workspace-1" }, "src/renderer/App.tsx", "branch", undefined
      )
    );
    expect(
      await screen.findByRole("button", { name: "Collapse src/renderer/App.tsx diff" })
    ).toBeInTheDocument();
    // shiki tokenizes lines into per-token <span> children, so getByText on
    // the full source line misses. toHaveTextContent matches concatenated
    // textContent regardless of token carving (same workaround P6.01 used).
    expect(reviewPanel).toHaveTextContent("const oldValue = true;");
    expect(reviewPanel).toHaveTextContent("const newValue = true;");

    // The gap between the two hunks (old lines 4–19) is an expand control, and
    // clicking it refetches the file with a wider context.
    const expandGap = screen.getByRole("button", { name: "Expand 16 unmodified lines" });
    fireEvent.click(expandGap);
    await waitFor(() =>
      expect(loadDiff).toHaveBeenCalledWith(
        { kind: "workspace", id: "workspace-1" }, "src/renderer/App.tsx", "branch", 25
      )
    );

    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() =>
      expect(screen.queryByRole("complementary", { name: "Review panel" })).not.toBeInTheDocument()
    );
  });

  it("browses workspace files via the Files tab and previews a selection", async () => {
    listChangedFiles.mockResolvedValue([]);
    listWorkspaceFiles.mockResolvedValue([
      { path: "src-tauri/src/index.ts" },
      { path: "src/renderer/lib/tauriBridge.ts" },
      { path: "src/renderer/App.tsx" },
      { path: "README.md" }
    ]);
    readWorkspaceFile.mockImplementation((_workspaceId, filePath) =>
      Promise.resolve({
        kind: "text",
        content:
          filePath === "src/renderer/lib/tauriBridge.ts"
            ? "export const tauriBridge = true;\n"
            : "export const hello = 'world';\n",
        size: 30,
        mtimeMs: 0
      })
    );

    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "Build dashboard" }));
    // Empty changed-files state → Browse files entry is available behind the picker
    fireEvent.click(await screen.findByRole("button", { name: "Chat actions" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Browse files" }));

    // The panel opens directly in Files mode
    expect(await screen.findByRole("complementary", { name: "Review panel" })).toBeInTheDocument();
    expect(listWorkspaceFiles).toHaveBeenCalledWith({ kind: "workspace", id: "workspace-1" });

    // Expand src-tauri/ then src/ to reach the file
    fireEvent.click(await screen.findByRole("treeitem", { name: /^src-tauri$/ }));
    const nestedSrc = (await screen.findAllByRole("treeitem", { name: /^src$/ })).find(
      (node) => node.getAttribute("title") === "src-tauri/src"
    );
    expect(nestedSrc).toBeDefined();
    fireEvent.click(nestedSrc!);
    fireEvent.click(await screen.findByRole("treeitem", { name: /^index\.ts$/ }));

    await waitFor(() => expect(readWorkspaceFile).toHaveBeenCalledWith(
      { kind: "workspace", id: "workspace-1" }, "src-tauri/src/index.ts"
    ));
    // The shiki highlighter tokenizes lines into per-token spans, so the line
    // text spans multiple DOM nodes. Query the preview wrapper by aria-label
    // and assert against its concatenated textContent — matches the real
    // production rendering regardless of how the line is carved into tokens.
    const preview = await screen.findByLabelText("Preview of src-tauri/src/index.ts");
    expect(preview).toHaveTextContent("export const hello = 'world';");

    const appSrc = (await screen.findAllByRole("treeitem", { name: /^src$/ })).find(
      (node) => node.getAttribute("title") === "src"
    );
    expect(appSrc).toBeDefined();
    fireEvent.click(appSrc!);
    fireEvent.click(await screen.findByRole("treeitem", { name: /^renderer$/ }));
    fireEvent.click(await screen.findByRole("treeitem", { name: /^lib$/ }));
    fireEvent.click(await screen.findByRole("treeitem", { name: /^tauriBridge\.ts$/ }));
    await waitFor(() => expect(readWorkspaceFile).toHaveBeenCalledWith(
      { kind: "workspace", id: "workspace-1" }, "src/renderer/lib/tauriBridge.ts"
    ));
    expect(await screen.findByLabelText("Preview of src/renderer/lib/tauriBridge.ts")).toHaveTextContent(
      "export const tauriBridge = true;"
    );

    const tablist = screen.getByRole("tablist", { name: "Open files" });
    expect(within(tablist).getByRole("tab", { name: "index.ts" })).toHaveAttribute(
      "aria-selected",
      "false"
    );
    expect(within(tablist).getByRole("tab", { name: "tauriBridge.ts" })).toHaveAttribute(
      "aria-selected",
      "true"
    );

    fireEvent.click(within(tablist).getByRole("tab", { name: "index.ts" }));
    expect(await screen.findByLabelText("Preview of src-tauri/src/index.ts")).toHaveTextContent(
      "export const hello = 'world';"
    );
  });

  it("opens workspace files in the review panel with Cmd+G", async () => {
    listChangedFiles.mockResolvedValue([
      { path: "src/renderer/App.tsx", status: "modified", additions: 2, deletions: 1 }
    ]);
    listWorkspaceFiles.mockResolvedValue([
      { path: "src-tauri/src/index.ts" },
      { path: "src/renderer/App.tsx" }
    ]);

    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "Build dashboard" }));
    const input = await screen.findByLabelText("Chat prompt");
    fireEvent.keyDown(input, { key: "g", metaKey: true });

    expect(await screen.findByRole("complementary", { name: "Review panel" })).toBeInTheDocument();
    expect(await screen.findByRole("tab", { name: "Files", selected: true })).toBeInTheDocument();
    expect(listWorkspaceFiles).toHaveBeenCalledWith({ kind: "workspace", id: "workspace-1" });
    expect(screen.queryByText("1 file")).not.toBeInTheDocument();

    fireEvent.keyDown(input, { key: "g", metaKey: true });
    await waitFor(() =>
      expect(screen.queryByRole("complementary", { name: "Review panel" })).not.toBeInTheDocument()
    );
  });

  it("opens workspace files via the unified command palette on Cmd+P", async () => {
    listChangedFiles.mockResolvedValue([]);
    listWorkspaceFiles.mockResolvedValue([
      { path: "src-tauri/src/index.ts" },
      { path: "src/renderer/App.tsx" }
    ]);
    readWorkspaceFile.mockResolvedValue({
      kind: "text",
      content: "export const hello = 'world';\n",
      size: 30,
      mtimeMs: 0
    });

    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "Build dashboard" }));
    expect(screen.queryByRole("complementary", { name: "Review panel" })).not.toBeInTheDocument();

    fireEvent.keyDown(document, { key: "p", metaKey: true });

    // The merged palette renders one dialog labeled "Command palette".
    // Files load lazily on first non-empty keystroke (matches Messages).
    const palette = await screen.findByRole("dialog", { name: "Command palette" });
    const input = within(palette).getByLabelText("Command palette query");
    fireEvent.change(input, { target: { value: "index" } });
    await waitFor(() => expect(listWorkspaceFiles).toHaveBeenCalledWith({ kind: "workspace", id: "workspace-1" }));
    // uFuzzy may split the basename across highlighted spans; the option's
    // accessible name remains stable.
    await within(palette).findByRole("option", { name: /index\.ts/ });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(await screen.findByRole("complementary", { name: "Review panel" })).toBeInTheDocument();
    await waitFor(() => expect(readWorkspaceFile).toHaveBeenCalledWith(
      { kind: "workspace", id: "workspace-1" }, "src-tauri/src/index.ts"
    ));
  });

  it("shows a placeholder when a previewed file is binary or too large", async () => {
    listChangedFiles.mockResolvedValue([]);
    listWorkspaceFiles.mockResolvedValue([{ path: "assets/model.bin" }]);
    readWorkspaceFile.mockResolvedValue({ kind: "skipped", reason: "binary", size: 2048 });

    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "Build dashboard" }));
    fireEvent.click(await screen.findByRole("button", { name: "Chat actions" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Browse files" }));
    fireEvent.click(await screen.findByRole("treeitem", { name: /^assets$/ }));
    fireEvent.click(await screen.findByRole("treeitem", { name: /^model\.bin$/ }));

    expect(await screen.findByText(/Binary file/i)).toBeInTheDocument();
  });

  it("previews an image file that the read reported as binary", async () => {
    listChangedFiles.mockResolvedValue([]);
    listWorkspaceFiles.mockResolvedValue([{ path: "assets/logo.png" }]);
    readWorkspaceFile.mockResolvedValue({ kind: "skipped", reason: "binary", size: 2048 });

    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "Build dashboard" }));
    fireEvent.click(await screen.findByRole("button", { name: "Chat actions" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Browse files" }));
    fireEvent.click(await screen.findByRole("treeitem", { name: /^assets$/ }));
    fireEvent.click(await screen.findByRole("treeitem", { name: /^logo\.png$/ }));

    const image = await screen.findByRole("img", { name: "assets/logo.png" });
    expect(image.getAttribute("src")).toContain(`${WORKSPACE_ASSET_PROTOCOL_SCHEME}://file`);
    expect(image.getAttribute("src")).toContain("assets/logo.png");
    expect(screen.queryByText(/Binary file/i)).not.toBeInTheDocument();
  });

  it("opens slash autocomplete in the launcher composer without a workspace id", async () => {
    skillsList.mockResolvedValue([
      { name: "plan", description: "Phased plan", source: "user" },
      { name: "impl", description: "Implement code", source: "user" }
    ]);

    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "Switch model" }));
    const launchPopover = await screen.findByRole("listbox", { name: "Switch model" });
    fireEvent.click(within(launchPopover).getByText("Sonnet 5"));
    const input = await screen.findByLabelText<HTMLInputElement>("Task prompt");
    fireEvent.change(input, { target: { value: "/" } });

    const menu = await screen.findByRole("listbox", { name: "Slash commands" });
    expect(skillsList).toHaveBeenCalledWith({ provider: "claude", workspaceId: null });
    // Composer actions lead; the skills follow under their own heading.
    expect(within(menu).getAllByRole("option")[0]).toHaveTextContent("Plan");
    expect(within(menu).getByText("Skills")).toBeInTheDocument();

    // A query past the command names leaves only the skill, and Enter inserts it.
    fireEvent.change(input, { target: { value: "/impl" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(input.value).toBe("/impl ");
    expect(launchProvider).not.toHaveBeenCalled();
  });

  it("toggles active-session agent mode with Shift+Tab and sends plan mode", async () => {
    const completeSnapshot = {
      ...snapshot,
      sessions: snapshot.sessions.map((session) => ({ ...session, state: "complete" as const }))
    };
    mockDashboardSnapshot(completeSnapshot);
    workspaceStatus.mockResolvedValue(workspaceStatusSnapshot(completeSnapshot));
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "Build dashboard" }));
    const input = await screen.findByLabelText("Chat prompt");
    fireEvent.change(input, { target: { value: "Plan the follow-up" } });
    fireEvent.keyDown(input, { key: "Tab", shiftKey: true });

    expect(screen.getByRole("button", { name: "Agent mode" })).toHaveTextContent("Plan");
    fireEvent.click(screen.getByTitle("Send follow-up"));

    await waitFor(() =>
      expect(sendProviderInput).toHaveBeenCalledWith(
        expect.objectContaining({
          input: "Plan the follow-up",
          agentMode: "plan"
        })
      )
    );
    expect(window.localStorage.getItem("argmax.sessionAgentMode.session-1")).toBe("plan");
  });

  it("opens project files via the unified command palette on Cmd+P", async () => {
    listProjectFiles.mockResolvedValue([
      { path: "src/renderer/App.tsx" },
      { path: "README.md" }
    ]);
    readProjectFile.mockResolvedValue({
      kind: "text",
      content: "export function App() {}\n",
      size: 25,
      mtimeMs: 0
    });

    render(<App />);

    const prompt = await screen.findByLabelText("Task prompt");
    prompt.focus();
    fireEvent.keyDown(prompt, { key: "p", metaKey: true });

    const palette = await screen.findByRole("dialog", { name: "Command palette" });
    const input = within(palette).getByLabelText("Command palette query");
    fireEvent.change(input, { target: { value: "app" } });
    await waitFor(() => expect(listProjectFiles).toHaveBeenCalledWith({ kind: "project", id: "project-1" }));
    await within(palette).findByRole("option", { name: /App\.tsx/ });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(await screen.findByRole("complementary", { name: "Review panel" })).toBeInTheDocument();
    await waitFor(() => expect(readProjectFile).toHaveBeenCalledWith(
      { kind: "project", id: "project-1" },
      "src/renderer/App.tsx"
    ));
  });

  it("opens the launcher review panel in project files mode with Cmd+B", async () => {
    listProjectFiles.mockResolvedValue([
      { path: "src-tauri/src/main.ts" },
      { path: "index.ts" },
      { path: "README.md" }
    ]);
    readProjectFile.mockResolvedValue({
      kind: "text",
      content: "export const ok = true;\n",
      size: 24,
      mtimeMs: 123
    });

    render(<App />);

    const prompt = await screen.findByLabelText("Task prompt");
    prompt.focus();
    fireEvent.keyDown(prompt, { key: "b", metaKey: true });

    expect(await screen.findByRole("complementary", { name: "Review panel" })).toBeInTheDocument();
    expect(await screen.findByRole("tab", { name: "Files", selected: true })).toBeInTheDocument();
    expect(screen.queryByText("2 files")).not.toBeInTheDocument();
    expect(listProjectFiles).toHaveBeenCalledWith({ kind: "project", id: "project-1" });

    fireEvent.click(screen.getByRole("treeitem", { name: "index.ts" }));
    const editor = await screen.findByLabelText("Editor for index.ts");
    fireEvent.change(editor, { target: { value: "export const ok = false;\n" } });
    fireEvent.keyDown(editor, { key: "s", metaKey: true });
    await waitFor(() =>
      expect(writeProjectFile).toHaveBeenCalledWith(
        { kind: "project", id: "project-1" },
        "index.ts",
        "export const ok = false;\n",
        123
      )
    );

    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() =>
      expect(screen.queryByRole("complementary", { name: "Review panel" })).not.toBeInTheDocument()
    );
  });

  it("dismisses the launcher review panel when New chat is clicked", async () => {
    listProjectFiles.mockResolvedValue([
      { path: "src-tauri/src/main.ts" },
      { path: "README.md" }
    ]);

    render(<App />);

    const prompt = await screen.findByLabelText("Task prompt");
    prompt.focus();
    fireEvent.keyDown(prompt, { key: "b", metaKey: true });

    expect(await screen.findByRole("complementary", { name: "Review panel" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "New chat" }));

    await waitFor(() =>
      expect(screen.queryByRole("complementary", { name: "Review panel" })).not.toBeInTheDocument()
    );
    expect(screen.getByLabelText("Task prompt")).toBeInTheDocument();
  });

  it("clears the session repo title past the sidebar toggle when the sidebar is hidden", async () => {
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "Build dashboard" }));
    expect(await screen.findByRole("heading", { name: "Argmax" })).toBeInTheDocument();

    fireEvent.click(await screen.findByRole("button", { name: "Hide sidebar" }));

    expect(document.querySelector('.app-shell[data-sidebar-collapsed="true"]')).toBeInTheDocument();
    expect(
      document.querySelector(
        '.app-shell[data-sidebar-collapsed="true"] .session-multigrid-cell:first-child .conversation-surface > .section-heading'
      )
    ).toBeInTheDocument();
  });

  it("keeps launcher review chrome below the collapsed-sidebar titlebar controls", async () => {
    listProjectFiles.mockResolvedValue([
      { path: "src-tauri/src/main.ts" },
      { path: "README.md" }
    ]);

    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "Hide sidebar" }));
    expect(screen.getByRole("button", { name: "Show sidebar" })).toBeInTheDocument();

    const prompt = await screen.findByLabelText("Task prompt");
    prompt.focus();
    fireEvent.keyDown(prompt, { key: "b", metaKey: true });

    expect(await screen.findByRole("complementary", { name: "Review panel" })).toBeInTheDocument();
    expect(await screen.findByRole("tab", { name: "Files", selected: true })).toBeInTheDocument();
    expect(
      document.querySelector(
        '.app-shell[data-sidebar-collapsed="true"] .launcher-shell[data-review-open="true"] > .review-panel > .review-toolbar'
      )
    ).toBeInTheDocument();
  });

  it("opens the launcher review panel when Tauri sends the Cmd+B menu command", async () => {
    listProjectFiles.mockResolvedValue([
      { path: "src-tauri/src/main.ts" },
      { path: "README.md" }
    ]);

    render(<App />);

    expect(await screen.findByLabelText("Task prompt")).toBeInTheDocument();
    expect(menuCommandListener).not.toBeNull();
    act(() => {
      menuCommandListener?.("toggle-sidebar");
    });

    expect(await screen.findByRole("complementary", { name: "Review panel" })).toBeInTheDocument();
    expect(await screen.findByRole("tab", { name: "Files", selected: true })).toBeInTheDocument();
    expect(listProjectFiles).toHaveBeenCalledWith({ kind: "project", id: "project-1" });
  });

  it("opens the launcher review panel in project files mode with Cmd+G", async () => {
    listProjectFiles.mockResolvedValue([
      { path: "src-tauri/src/main.ts" },
      { path: "README.md" }
    ]);

    render(<App />);

    const prompt = await screen.findByLabelText("Task prompt");
    prompt.focus();
    fireEvent.keyDown(prompt, { key: "g", metaKey: true });

    expect(await screen.findByRole("complementary", { name: "Review panel" })).toBeInTheDocument();
    expect(await screen.findByRole("tab", { name: "Files", selected: true })).toBeInTheDocument();
    expect(listProjectFiles).toHaveBeenCalledWith({ kind: "project", id: "project-1" });

    fireEvent.keyDown(prompt, { key: "g", metaKey: true });
    await waitFor(() =>
      expect(screen.queryByRole("complementary", { name: "Review panel" })).not.toBeInTheDocument()
    );
  });

  it("surfaces project files in the command palette after Cmd+B opens review", async () => {
    listProjectFiles.mockResolvedValue([
      { path: "src/renderer/App.tsx" },
      { path: "README.md" }
    ]);

    render(<App />);

    expect(await screen.findByLabelText("Task prompt")).toBeInTheDocument();
    fireEvent.keyDown(document, { key: "b", metaKey: true });
    expect(await screen.findByRole("complementary", { name: "Review panel" })).toBeInTheDocument();

    fireEvent.keyDown(document, { key: "p", metaKey: true });

    // Unified palette — type into it and the Files group surfaces matching paths.
    const palette = await screen.findByRole("dialog", { name: "Command palette" });
    const input = within(palette).getByLabelText("Command palette query");
    fireEvent.change(input, { target: { value: "app" } });
    await within(palette).findByRole("option", { name: /App\.tsx/ });
  });

  it("opens a slash autocomplete with provider-filtered skills and inserts the selected name", async () => {
    skillsList.mockImplementation(({ provider, workspaceId }) => {
      expect(workspaceId).toBe("workspace-1");
      if (provider === "codex") {
        return Promise.resolve([
          { name: "opsx-apply", description: "Apply a change", source: "codex-prompt" },
          { name: "opsx-archive", description: "Archive a change", source: "codex-prompt" }
        ]);
      }
      return Promise.resolve([
        { name: "impl", description: "Implement code from a plan", source: "user" }
      ]);
    });

    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "Build dashboard" }));
    const input = await screen.findByLabelText<HTMLInputElement>("Chat prompt");
    fireEvent.change(input, { target: { value: "/o" } });

    const listbox = await screen.findByRole("listbox", { name: "Slash commands" });
    expect(listbox).toBeInTheDocument();
    expect(skillsList).toHaveBeenCalledWith({ provider: "codex", workspaceId: "workspace-1" });

    // No composer command starts with "o", so the query leaves only skills.
    const options = within(listbox).getAllByRole("option");
    expect(options.map((option) => option.textContent)).toEqual([
      "opsx-applyApply a changePrompt",
      "opsx-archiveArchive a changePrompt"
    ]);
    // Claude-only skill must not be present in a Codex session.
    expect(screen.queryByText("/impl")).not.toBeInTheDocument();

    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(input.value).toBe("/opsx-archive ");
    expect(sendProviderInput).not.toHaveBeenCalled();
  });

  it("submits the composer on Enter without reloading the page", async () => {
    render(<App />);

    const input = await screen.findByLabelText("Task prompt");
    fireEvent.change(input, { target: { value: "Implement PTY launch" } });

    const form = input.closest("form");
    if (!form) {
      throw new Error("Composer form not found");
    }

    // Dispatch a real submit event so we can read defaultPrevented after the
    // React onSubmit handler runs (a target-phase listener would observe the
    // pre-React state).
    const submitEvent = new Event("submit", { bubbles: true, cancelable: true });
    act(() => {
      form.dispatchEvent(submitEvent);
    });

    await waitFor(() => expect(launchProvider).toHaveBeenCalledTimes(1));
    expect(launchProvider).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: "Implement PTY launch", provider: "claude" })
    );
    expect(submitEvent.defaultPrevented).toBe(true);
  });

  it("returns to the composer from an open session via the project row", async () => {
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "Build dashboard" }));
    expect(await screen.findByRole("heading", { name: "Argmax" })).toBeInTheDocument();

    const projectVisibility = screen.getByRole("button", { name: "Hide Argmax chats" });
    fireEvent.click(screen.getByRole("button", { name: "Argmax" }));

    expect(await screen.findByLabelText("Task prompt")).toBeInTheDocument();
    expect(projectVisibility).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("button", { name: "Build dashboard" })).toBeInTheDocument();
    expect(screen.queryByText("Dashboard ready.")).not.toBeInTheDocument();
  });

  it("discards a stale dashboard load when a newer load completes first", async () => {
    let resolveSlow: (data: Awaited<ReturnType<ArgmaxApi["dashboard"]["list"]>>) => void = () => {
      throw new Error("slow dashboard load did not start");
    };
    const slowSnapshot: DashboardSnapshot = {
      ...snapshot,
      projects: [
        {
          ...primaryProject(),
          name: "Stale-Project"
        }
      ]
    };
    const fastSnapshot: DashboardSnapshot = {
      ...snapshot,
      projects: [
        {
          ...primaryProject(),
          name: "Fresh-Project"
        }
      ]
    };

    let callCount = 0;
    dashboardList.mockImplementation(() => {
      callCount += 1;
      if (callCount === 1) {
        return new Promise<Awaited<ReturnType<ArgmaxApi["dashboard"]["list"]>>>((resolve) => {
          resolveSlow = resolve;
        });
      }
      return Promise.resolve(dashboardListSnapshot(fastSnapshot));
    });

    render(<App />);

    // Wait for the first invocation to be in flight.
    await waitFor(() => expect(callCount).toBe(1));

    act(() => {
      dashboardDeltaListener?.({ projects: fastSnapshot.projects });
    });

    // Now resolve the first (slow) load with stale data.
    resolveSlow(dashboardListSnapshot(slowSnapshot));

    // Snapshot should reflect the second (fast) load result, not the stale first.
    expect(await screen.findByRole("button", { name: "Fresh-Project" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Stale-Project" })).not.toBeInTheDocument();
  });

  it("keeps a read session in priority and clears it on right-click → Done", async () => {
    window.localStorage.setItem("argmax.sidebar.priority.visible", "true");
    // Inside the 30-minute idle window, so the row is triage either way.
    const attentionChangedAt = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    const waitingWorkspace: DashboardSnapshot["workspaces"][number] = {
      id: "workspace-wait",
      projectId: "project-1",
      taskLabel: "Waiting chat",
      branch: "argmax/waiting-chat",
      baseRef: "main",
      path: "/tmp/worktrees/waiting-chat",
      state: "waiting",
      sharedWorkspace: false,
      kind: "git",
      dirty: false,
      changedFiles: 0,
      lastActivityAt: attentionChangedAt,
      pinned: false,
      priorityDismissedAt: null,
      priorityAddedAt: null
    };
    const otherWorkspace: DashboardSnapshot["workspaces"][number] = {
      id: "workspace-other",
      projectId: "project-1",
      taskLabel: "Other chat",
      branch: "argmax/other-chat",
      baseRef: "main",
      path: "/tmp/worktrees/other-chat",
      state: "complete",
      sharedWorkspace: false,
      kind: "git",
      dirty: false,
      changedFiles: 0,
      lastActivityAt: "2026-05-08T16:00:00.000Z",
      pinned: false,
      priorityDismissedAt: null,
      priorityAddedAt: null
    };
    const waitingSession: DashboardSnapshot["sessions"][number] = {
      id: "session-wait",
      workspaceId: "workspace-wait",
      provider: "claude",
      modelLabel: "Sonnet 5",
      modelId: "claude-sonnet-5",
      permissionMode: "auto-approve",
      providerConversationId: "session-wait",
      prompt: "Waiting chat",
      state: "waiting",
      attention: "blocked",
      attentionChangedAt,
      startedAt: "2026-05-08T16:00:00.000Z",
      completedAt: null,
      lastActivityAt: attentionChangedAt
    };
    const otherSession: DashboardSnapshot["sessions"][number] = {
      id: "session-other",
      workspaceId: "workspace-other",
      provider: "claude",
      modelLabel: "Sonnet 5",
      modelId: "claude-sonnet-5",
      permissionMode: "auto-approve",
      providerConversationId: "session-other",
      prompt: "Other chat",
      state: "complete",
      attention: "review-ready",
      attentionChangedAt,
      startedAt: "2026-05-08T15:50:00.000Z",
      completedAt: "2026-05-08T16:00:00.000Z",
      lastActivityAt: "2026-05-08T16:00:00.000Z"
    };
    const demotionSnapshot: DashboardSnapshot = {
      ...snapshot,
      workspaces: [...snapshot.workspaces, waitingWorkspace, otherWorkspace],
      sessions: [...snapshot.sessions, waitingSession, otherSession]
    };
    mockDashboardSnapshot(demotionSnapshot);
    sessionEventsSince.mockImplementation((input) => {
      if (input.sessionId === "session-wait" || input.sessionId === "session-other") {
        return Promise.resolve({ events: [], rawOutputs: [], eventCursor: 0, rawOutputCursor: 0 });
      }
      return Promise.resolve({ events: snapshot.events, rawOutputs: [], eventCursor: 1, rawOutputCursor: 0 });
    });
    setPriorityDismissed.mockImplementation(({ workspaceId, dismissed }) => {
      const current =
        demotionSnapshot.workspaces.find((item) => item.id === workspaceId) ?? waitingWorkspace;
      const updated = {
        ...current,
        priorityDismissedAt: dismissed ? new Date().toISOString() : null,
        priorityAddedAt: null
      };
      const next = {
        ...demotionSnapshot,
        workspaces: demotionSnapshot.workspaces.map((item) =>
          item.id === workspaceId ? updated : item
        )
      };
      workspaceStatus.mockResolvedValue(workspaceStatusSnapshot(next));
      dashboardDeltaListener?.({ workspaces: [updated] });
      return Promise.resolve(updated);
    });

    render(<App />);

    const waitingRow = await screen.findByRole("button", { name: /Waiting chat/ });
    expect(waitingRow).toHaveAttribute("title", expect.stringContaining("waiting for input"));

    // Reading it and moving on leaves it in place — Priority is not an unread
    // list any more; it holds the row until it goes quiet or the user is done.
    fireEvent.click(waitingRow);
    fireEvent.click(screen.getByRole("button", { name: /Other chat/ }));
    expect(setPriorityDismissed).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: /Waiting chat/ })).toHaveAttribute(
      "title",
      expect.stringContaining("waiting for input")
    );

    fireEvent.contextMenu(screen.getByRole("button", { name: /Waiting chat/ }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Done" }));

    await waitFor(() =>
      expect(setPriorityDismissed).toHaveBeenCalledWith({
        workspaceId: "workspace-wait",
        dismissed: true
      })
    );
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /Waiting chat/ }).getAttribute("title")).not.toContain(
        "waiting for input"
      )
    );
  });

  it("keeps a working session in priority after the user opens it and leaves", async () => {
    window.localStorage.setItem("argmax.sidebar.priority.visible", "true");
    const attentionChangedAt = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    const workingWorkspace: DashboardSnapshot["workspaces"][number] = {
      id: "workspace-working",
      projectId: "project-1",
      taskLabel: "Working chat",
      branch: "argmax/working-chat",
      baseRef: "main",
      path: "/tmp/worktrees/working-chat",
      state: "running",
      sharedWorkspace: false,
      kind: "git",
      dirty: false,
      changedFiles: 0,
      lastActivityAt: "2026-05-08T16:04:00.000Z",
      pinned: false,
      priorityDismissedAt: null,
      priorityAddedAt: null
    };
    const otherWorkspace: DashboardSnapshot["workspaces"][number] = {
      id: "workspace-other",
      projectId: "project-1",
      taskLabel: "Other chat",
      branch: "argmax/other-chat",
      baseRef: "main",
      path: "/tmp/worktrees/other-chat",
      state: "complete",
      sharedWorkspace: false,
      kind: "git",
      dirty: false,
      changedFiles: 0,
      lastActivityAt: "2026-05-08T16:00:00.000Z",
      pinned: false,
      priorityDismissedAt: null,
      priorityAddedAt: null
    };
    const workingSnapshot: DashboardSnapshot = {
      ...snapshot,
      workspaces: [...snapshot.workspaces, workingWorkspace, otherWorkspace],
      sessions: [
        ...snapshot.sessions,
        {
          id: "session-working",
          workspaceId: "workspace-working",
          provider: "claude",
          modelLabel: "Sonnet 5",
          modelId: "claude-sonnet-5",
          permissionMode: "auto-approve",
          providerConversationId: "session-working",
          prompt: "Working chat",
          state: "running",
          attention: "approval-needed",
          attentionChangedAt,
          startedAt: "2026-05-08T16:00:00.000Z",
          completedAt: null,
          lastActivityAt: "2026-05-08T16:04:00.000Z"
        },
        {
          id: "session-other",
          workspaceId: "workspace-other",
          provider: "claude",
          modelLabel: "Sonnet 5",
          modelId: "claude-sonnet-5",
          permissionMode: "auto-approve",
          providerConversationId: "session-other",
          prompt: "Other chat",
          state: "complete",
          attention: "review-ready",
          attentionChangedAt,
          startedAt: "2026-05-08T15:50:00.000Z",
          completedAt: "2026-05-08T16:00:00.000Z",
          lastActivityAt: "2026-05-08T16:00:00.000Z"
        }
      ]
    };
    mockDashboardSnapshot(workingSnapshot);

    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: /Working chat/ }));
    fireEvent.click(screen.getByRole("button", { name: /Other chat/ }));

    await waitFor(() => expect(screen.getByRole("button", { name: /Other chat/ })).toHaveAttribute("aria-current", "true"));
    expect(setPriorityDismissed).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: /Working chat/ })).toHaveAttribute(
      "title",
      expect.stringContaining("needs approval")
    );
  });
});
