import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { App } from "../App.js";
import { readDraft } from "../lib/composerDrafts.js";
import {
  BACKGROUND_SEND_SHORTCUT_KEY,
  resetBackgroundSendShortcut,
  writeBackgroundSendShortcut
} from "../lib/backgroundSend.js";
import { resetToastForTests, toastSnapshot } from "../state/toast.js";
import { windowSnapshotInbox } from "../lib/windowSnapshotInbox.js";
import { drainWindowSnapshotInbox } from "../../test/windowSnapshotInboxTestUtil.js";
import {
  createCurrentWorkspace,
  createIsolatedWorkspace,
  launchProvider,
  setupAppTestMocks,
  snapshot
} from "../../test/appTestHarness.js";

const workspace = { ...snapshot.workspaces[0], id: "workspace-bg", taskLabel: "Background chat" };
const session = { ...snapshot.sessions[0], id: "session-bg", workspaceId: workspace.id };

function promptField(): Promise<HTMLElement> {
  return screen.findByLabelText("Task prompt");
}

function altEnter(field: HTMLElement): void {
  fireEvent.keyDown(field, { key: "Enter", altKey: true });
}

describe("starting a new chat in the background", () => {
  beforeEach(() => {
    setupAppTestMocks();
    createCurrentWorkspace.mockResolvedValue(workspace);
    createIsolatedWorkspace.mockResolvedValue(workspace);
    launchProvider.mockResolvedValue(session);
  });

  afterEach(() => {
    cleanup();
    resetToastForTests();
    resetBackgroundSendShortcut();
    window.localStorage.removeItem(BACKGROUND_SEND_SHORTCUT_KEY);
  });

  it("launches, stays on the launcher with an empty draft, and offers the way in", async () => {
    render(<App />);
    const field = await promptField();
    fireEvent.change(field, { target: { value: "Fix the flaky test" } });
    field.focus();

    altEnter(field);

    await waitFor(() => expect(launchProvider).toHaveBeenCalledOnce());
    expect(launchProvider.mock.calls[0]?.[0]).toMatchObject({ prompt: "Fix the flaky test" });
    // Still the launcher: the field is there, empty, and kept the focus.
    await waitFor(() => expect(toastSnapshot()?.message).toContain("Started “Fix the flaky test” in the background."));
    expect(await promptField()).toHaveValue("");
    expect(screen.getByLabelText("Task prompt")).toHaveFocus();
    expect(screen.queryByRole("region", { name: "Background chat" })).not.toBeInTheDocument();
    expect(readDraft("launch-project-1").text).toBe("");
    expect(toastSnapshot()?.kind === "info" && toastSnapshot()?.action?.label).toBe("Open");
  });

  it("is ready for the next draft while the launch is still running", async () => {
    let finishLaunch!: () => void;
    launchProvider.mockImplementation(
      () => new Promise((resolve) => { finishLaunch = () => resolve(session); })
    );
    render(<App />);
    const field = await promptField();
    fireEvent.change(field, { target: { value: "First task" } });

    altEnter(field);
    await waitFor(() => expect(launchProvider).toHaveBeenCalledOnce());

    expect(screen.getByLabelText("Task prompt")).toHaveValue("");
    expect(screen.getByLabelText("Task prompt")).toBeEnabled();
    fireEvent.change(screen.getByLabelText("Task prompt"), { target: { value: "Second task" } });
    expect(screen.getByLabelText("Task prompt")).toHaveValue("Second task");
    await act(() => {
      finishLaunch();
      return Promise.resolve();
    });
  });

  it("puts the draft back above newer typing when the launch fails", async () => {
    let failLaunch!: (error: Error) => void;
    launchProvider.mockImplementation(
      () => new Promise((_resolve, reject) => { failLaunch = reject; })
    );
    render(<App />);
    const field = await promptField();
    fireEvent.change(field, { target: { value: "Doomed task" } });

    altEnter(field);
    await waitFor(() => expect(launchProvider).toHaveBeenCalledOnce());
    fireEvent.change(screen.getByLabelText("Task prompt"), { target: { value: "Next idea" } });
    await act(() => {
      failLaunch(new Error("provider offline"));
      return Promise.resolve();
    });

    await waitFor(() => expect(screen.getByLabelText("Task prompt")).toHaveValue("Doomed task\n\nNext idea"));
    expect(toastSnapshot()).toMatchObject({
      kind: "error",
      message: "provider offline Your draft is back in the composer."
    });
    expect(readDraft("launch-project-1").text).toBe("Doomed task\n\nNext idea");
  });

  it("puts the draft back in storage when the launcher is gone by the time the start fails", async () => {
    let failLaunch!: (error: Error) => void;
    launchProvider.mockImplementation(
      () => new Promise((_resolve, reject) => { failLaunch = reject; })
    );
    render(<App />);
    const field = await promptField();
    fireEvent.change(field, { target: { value: "Doomed task" } });

    altEnter(field);
    await waitFor(() => expect(launchProvider).toHaveBeenCalledOnce());
    expect(readDraft("launch-project-1").text).toBe("");

    // The person opens a chat from the sidebar; the launcher unmounts.
    fireEvent.click(screen.getByRole("button", { name: snapshot.workspaces[0]?.taskLabel ?? "" }));
    await waitFor(() => expect(screen.queryByLabelText("Task prompt")).toBeNull());
    await act(() => {
      failLaunch(new Error("provider offline"));
      return Promise.resolve();
    });

    await waitFor(() => expect(readDraft("launch-project-1").text).toBe("Doomed task"));
    expect(toastSnapshot()).toMatchObject({
      kind: "error",
      message: "provider offline Your draft was put back in its New chat."
    });
  });

  it("hands a failed start's draft to a launcher opened in the meantime, above what was typed there", async () => {
    let failLaunch!: (error: Error) => void;
    launchProvider.mockImplementation(
      () => new Promise((_resolve, reject) => { failLaunch = reject; })
    );
    const first = render(<App />);
    fireEvent.change(await promptField(), { target: { value: "Doomed task" } });
    altEnter(await promptField());
    await waitFor(() => expect(launchProvider).toHaveBeenCalledOnce());

    // The window is rebuilt (or the launcher reopened) and the person starts a new draft.
    first.unmount();
    render(<App />);
    fireEvent.change(await promptField(), { target: { value: "Next idea" } });
    await act(() => {
      failLaunch(new Error("provider offline"));
      return Promise.resolve();
    });

    await waitFor(() => expect(screen.getByLabelText("Task prompt")).toHaveValue("Doomed task\n\nNext idea"));
    await waitFor(() => expect(readDraft("launch-project-1").text).toBe("Doomed task\n\nNext idea"));
  });

  it("answers the shortcut the user chose, and not the old one", async () => {
    writeBackgroundSendShortcut("CmdOrCtrl+Alt+Enter");
    render(<App />);
    const field = await promptField();
    fireEvent.change(field, { target: { value: "Remapped" } });

    altEnter(field);
    expect(launchProvider).not.toHaveBeenCalled();

    fireEvent.keyDown(field, { key: "Enter", altKey: true, metaKey: true });
    await waitFor(() => expect(launchProvider).toHaveBeenCalledOnce());
  });

  it("does not send while an IME composition is confirming", async () => {
    render(<App />);
    const field = await promptField();
    fireEvent.change(field, { target: { value: "日本語" } });

    fireEvent.keyDown(field, { key: "Enter", altKey: true, isComposing: true });

    expect(launchProvider).not.toHaveBeenCalled();
    expect(field).toHaveValue("日本語");
  });
});

describe("a window capture arriving at the New chat draft", () => {
  beforeEach(() => {
    setupAppTestMocks();
    drainWindowSnapshotInbox();
  });
  afterEach(cleanup);

  it("attaches to the draft the user is composing and keeps the prompt focused", async () => {
    render(<App />);
    const field = await screen.findByLabelText("Task prompt");

    act(() =>
      windowSnapshotInbox.deliver({
        attachment: { filePath: "/attachments/window-snapshots/a.png", mimeType: "image/png", sizeBytes: 7 },
        source: { appName: "Xcode", bundleId: null, windowTitle: null, capturedAt: "2026-10-04T08:00:00Z" }
      })
    );

    expect(screen.getByLabelText("Attached images").querySelectorAll("img")).toHaveLength(1);
    expect(readDraft("launch-project-1").attachments).toHaveLength(1);
    expect(field).toHaveFocus();
  });
});
