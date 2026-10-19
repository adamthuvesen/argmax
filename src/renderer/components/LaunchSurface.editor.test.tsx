// The launcher against the REAL CodeMirror editor; see SessionComposer.editor.test.tsx.
import { EditorView } from "@codemirror/view";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { installZeroLayoutForCodeMirror } from "../../test/jsdomCodeMirror.js";
import { App } from "../App.js";
import { resetToastForTests } from "../state/toast.js";
import {
  createCurrentWorkspace,
  createIsolatedWorkspace,
  launchProvider,
  setupAppTestMocks,
  snapshot
} from "../../test/appTestHarness.js";

vi.mock("./ComposerEditor.js", async () => {
  const view = await import("./ComposerEditorView.js");
  return { ComposerEditor: view.ComposerEditorView };
});

beforeAll(installZeroLayoutForCodeMirror);

const workspace = { ...snapshot.workspaces[0], id: "workspace-real", taskLabel: "Real editor chat" };
const session = { ...snapshot.sessions[0], id: "session-real", workspaceId: workspace.id };

async function launcher(): Promise<EditorView> {
  const box = await screen.findByRole("textbox", { name: "Task prompt" });
  const view = EditorView.findFromDOM(box);
  if (!view) throw new Error("the prompt is not a CodeMirror editor");
  return view;
}

function type(view: EditorView, text: string): void {
  const end = view.state.doc.length;
  view.dispatch({
    changes: { from: end, insert: text },
    selection: { anchor: end + text.length },
    userEvent: "input.type"
  });
}

describe("LaunchSurface with the real editor", () => {
  beforeEach(() => {
    setupAppTestMocks();
    createCurrentWorkspace.mockResolvedValue(workspace);
    createIsolatedWorkspace.mockResolvedValue(workspace);
    launchProvider.mockResolvedValue(session);
  });
  afterEach(() => {
    cleanup();
    resetToastForTests();
  });

  it("starts the agent with the text just typed, before React has rendered the keystroke", async () => {
    render(<App />);
    const view = await launcher();

    act(() => {
      type(view, "Fix the flaky test");
      view.contentDOM.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })
      );
    });

    await waitFor(() => expect(launchProvider).toHaveBeenCalledOnce());
    expect(launchProvider.mock.calls[0]?.[0]).toMatchObject({ prompt: "Fix the flaky test" });
  });

  it("starts in the background from the chord on text typed a moment ago", async () => {
    render(<App />);
    const view = await launcher();

    act(() => {
      type(view, "Background task");
      view.contentDOM.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", altKey: true, bubbles: true, cancelable: true })
      );
    });

    await waitFor(() => expect(launchProvider).toHaveBeenCalledOnce());
    expect(launchProvider.mock.calls[0]?.[0]).toMatchObject({ prompt: "Background task" });
    await waitFor(() => expect(view.state.doc.toString()).toBe(""));
  });
});
