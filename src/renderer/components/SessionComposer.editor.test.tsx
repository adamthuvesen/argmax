// The composer against the REAL CodeMirror editor. Every other composer suite
// renders the textarea stand-in (src/test/composerEditorMock.tsx), which has no
// undo history, no atomic chips, no clipboard handling and delivers `onChange`
// synchronously, so it cannot show the bugs these tests pin.
import { EditorView } from "@codemirror/view";
import { act, cleanup, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { installZeroLayoutForCodeMirror } from "../../test/jsdomCodeMirror.js";
import {
  baseSession,
  renderConversation,
  rerenderConversation
} from "../../test/sessionConversationTestHarness.js";
import type { ArgmaxApi } from "../../shared/types.js";
import { COMPOSER_CLIPBOARD_MIME } from "../lib/composerContext.js";

vi.mock("./ComposerEditor.js", async () => {
  const view = await import("./ComposerEditorView.js");
  return { ComposerEditor: view.ComposerEditorView };
});

beforeAll(installZeroLayoutForCodeMirror);

function editor(): EditorView {
  const found = EditorView.findFromDOM(screen.getByRole("textbox", { name: "Chat prompt" }));
  if (!found) throw new Error("the prompt is not a CodeMirror editor");
  return found;
}

/** Text arrives as the browser delivers it: one change event, typed. */
function type(view: EditorView, text: string): void {
  const end = view.state.doc.length;
  view.dispatch({
    changes: { from: end, insert: text },
    selection: { anchor: end + text.length },
    userEvent: "input.type"
  });
}

function press(view: EditorView, key: string, init: KeyboardEventInit = {}): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init });
  view.contentDOM.dispatchEvent(event);
  return event;
}

function clipboardEvent(type: "cut" | "copy"): { event: ClipboardEvent; data: Map<string, string> } {
  const data = new Map<string, string>();
  const event = new Event(type, { bubbles: true, cancelable: true }) as ClipboardEvent;
  Object.defineProperty(event, "clipboardData", {
    value: {
      setData: (mime: string, value: string) => data.set(mime, value),
      getData: (mime: string) => data.get(mime) ?? "",
      types: [],
      items: [],
      files: []
    }
  });
  return { event, data };
}

describe("SessionComposer with the real editor", () => {
  const listFiles = vi.fn<ArgmaxApi["workspace"]["listFiles"]>();

  beforeEach(() => {
    window.localStorage.clear();
    listFiles.mockReset();
    listFiles.mockResolvedValue([{ path: "src/main.ts" }, { path: "src/util.ts" }]);
    window.argmax = {
      workspace: { listFiles },
      prs: { listForSession: vi.fn(() => new Promise(() => {})) }
    } as unknown as ArgmaxApi;
  });
  afterEach(() => {
    cleanup();
    delete (window as unknown as { argmax?: unknown }).argmax;
  });

  it("sends what was just typed, even when React has not rendered the keystroke yet", async () => {
    const onSendSessionInput = vi.fn().mockResolvedValue(undefined);
    renderConversation(baseSession(), [], { onSendSessionInput });
    const view = editor();

    // One batch: the keystroke's state update is still pending when Enter lands.
    act(() => {
      type(view, "ship it");
      press(view, "Enter");
    });

    await waitFor(() => expect(onSendSessionInput).toHaveBeenCalledOnce());
    expect(onSendSessionInput.mock.calls[0]?.[1]).toBe("ship it");
  });

  it("does not send an empty prompt just because React's copy is stale", () => {
    const onSendSessionInput = vi.fn().mockResolvedValue(undefined);
    renderConversation(baseSession(), [], { onSendSessionInput });

    act(() => {
      press(editor(), "Enter");
    });

    expect(onSendSessionInput).not.toHaveBeenCalled();
  });

  it("undoes a file picked from the @ menu as its own step, leaving the typed text intact", async () => {
    renderConversation(baseSession());
    const view = editor();
    act(() => type(view, "look at @src"));
    await waitFor(() => expect(document.getElementById("file-popover")).not.toBeNull());

    act(() => {
      press(view, "Enter");
    });
    await waitFor(() => expect(view.state.doc.toString()).toBe("look at @src/ "));

    act(() => {
      press(view, "z", { ctrlKey: true });
    });
    // The pick comes back out; the typing is still there to be undone next.
    expect(view.state.doc.toString()).toBe("look at @src");

    act(() => {
      press(view, "z", { ctrlKey: true });
    });
    expect(view.state.doc.toString()).toBe("");
  });

  it("sends the completed mention when Enter follows the pick", async () => {
    const onSendSessionInput = vi.fn().mockResolvedValue(undefined);
    renderConversation(baseSession(), [], { onSendSessionInput });
    const view = editor();
    act(() => type(view, "look at @src"));
    await waitFor(() => expect(document.getElementById("file-popover")).not.toBeNull());

    act(() => {
      press(view, "Enter");
    });
    await waitFor(() => expect(view.state.doc.toString()).toBe("look at @src/ "));
    act(() => {
      press(view, "Enter");
    });

    await waitFor(() => expect(onSendSessionInput).toHaveBeenCalledOnce());
    expect(onSendSessionInput.mock.calls[0]?.[1]).toBe("look at @src/");
  });

  it("starts a new undo history for another chat's draft", async () => {
    window.localStorage.setItem(
      "argmax.composer.drafts",
      JSON.stringify({ "session-b": { v: 2, text: "fix the tests", attachments: [] } })
    );
    const { rerender } = renderConversation(baseSession({ id: "session-a" }));
    act(() => type(editor(), "fix the bug"));
    expect(editor().state.doc.toString()).toBe("fix the bug");

    rerenderConversation(rerender, baseSession({ id: "session-b" }));
    await waitFor(() => expect(editor().state.doc.toString()).toBe("fix the tests"));

    act(() => {
      press(editor(), "z", { ctrlKey: true });
    });
    // Undo reaches nothing of the other chat's typing.
    expect(editor().state.doc.toString()).toBe("fix the tests");
  });

  it("does not bring a sent message back with undo", async () => {
    const onSendSessionInput = vi.fn().mockResolvedValue(undefined);
    renderConversation(baseSession(), [], { onSendSessionInput });
    const view = editor();
    act(() => {
      type(view, "ship it");
      press(view, "Enter");
    });
    await waitFor(() => expect(view.state.doc.toString()).toBe(""));

    act(() => {
      press(view, "z", { ctrlKey: true });
    });

    expect(view.state.doc.toString()).toBe("");
  });

  it("cuts the selection with its typed entry, and cuts nothing when nothing is selected", () => {
    renderConversation(baseSession());
    const view = editor();
    act(() => type(view, "first line\nsecond line"));

    // A caret only: a textarea does nothing, and so must this. CodeMirror's own
    // handler would take the whole line.
    act(() => view.dispatch({ selection: { anchor: 3 } }));
    const empty = clipboardEvent("cut");
    act(() => {
      view.contentDOM.dispatchEvent(empty.event);
    });
    expect(empty.event.defaultPrevented).toBe(true);
    expect(empty.data.size).toBe(0);
    expect(view.state.doc.toString()).toBe("first line\nsecond line");

    act(() => view.dispatch({ selection: { anchor: 0, head: 5 } }));
    const real = clipboardEvent("cut");
    act(() => {
      view.contentDOM.dispatchEvent(real.event);
    });
    expect(real.data.get("text/plain")).toBe("first");
    expect(real.data.get(COMPOSER_CLIPBOARD_MIME)).toContain('"text":"first"');
    expect(view.state.doc.toString()).toBe(" line\nsecond line");
  });
});
