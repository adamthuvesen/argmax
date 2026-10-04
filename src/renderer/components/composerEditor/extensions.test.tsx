// @vitest-environment jsdom
import { deleteCharBackward, redo, undo } from "@codemirror/commands";
import { EditorSelection, EditorState, Transaction } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { installZeroLayoutForCodeMirror } from "../../../test/jsdomCodeMirror.js";
import {
  COMPOSER_CLIPBOARD_MIME,
  chatReferenceLink,
  decodeClipboardPayload
} from "../../lib/composerContext.js";
import {
  chatChipEnvironment,
  promptExtensions,
  skillTokenPredicate,
  type ChatChipEnvironment,
  type PromptCallbacks
} from "./extensions.js";

// A real EditorView, the same extensions the composers mount. jsdom has no
// layout, so the measurements CodeMirror asks for are zeros; nothing here
// depends on geometry.
beforeAll(installZeroLayoutForCodeMirror);

const views: EditorView[] = [];

function mount(
  doc: string,
  options: {
    chats?: ChatChipEnvironment;
    isSkill?: (name: string) => boolean;
    callbacks?: PromptCallbacks;
  } = {}
): EditorView {
  const host = document.createElement("div");
  document.body.append(host);
  const view = new EditorView({
    parent: host,
    state: EditorState.create({
      doc,
      extensions: [
        promptExtensions({ current: options.callbacks ?? {} }),
        chatChipEnvironment.of(options.chats ?? { resolve: () => null, open: () => undefined }),
        skillTokenPredicate.of(options.isSkill ?? (() => false))
      ]
    })
  });
  views.push(view);
  return view;
}

afterEach(() => {
  for (const view of views.splice(0)) view.destroy();
  document.body.replaceChildren();
});

const link = chatReferenceLink({ sessionId: "s1", title: "Billing rewrite" });

describe("chat chips", () => {
  it("draws a reference as one chip showing the chat's current title", () => {
    const open = vi.fn();
    const view = mount(`see ${link} now`, {
      chats: { resolve: () => ({ title: "Billing v2" }), open }
    });

    const chip = view.dom.querySelector<HTMLElement>(".composer-chat-chip");
    expect(chip?.dataset.status).toBe("resolved");
    expect(chip?.textContent).toBe("Billing v2");
    expect(chip?.getAttribute("aria-label")).toBe("Chat reference: Billing v2. Open chat");
    expect(view.dom.textContent).not.toContain("argmax://");

    chip?.click();
    expect(open).toHaveBeenCalledWith("s1");
  });

  it("keeps an unresolved reference visible, with its title, and does not open it", () => {
    const open = vi.fn();
    const view = mount(link, { chats: { resolve: () => null, open } });

    const chip = view.dom.querySelector<HTMLElement>(".composer-chat-chip");
    expect(chip?.dataset.status).toBe("unresolved");
    expect(chip?.textContent).toBe("Billing rewrite (unavailable)");
    chip?.click();
    expect(open).not.toHaveBeenCalled();
  });

  it("leaves a reference this build cannot read as plain, visible text", () => {
    const view = mount("[Later](argmax://chat/s1?v=9)");

    expect(view.dom.querySelector(".composer-chat-chip")).toBeNull();
    expect(view.dom.textContent).toContain("argmax://chat/s1?v=9");
  });

  it("treats a chip as one character for Backspace and the caret", () => {
    const view = mount(`a${link}b`);
    const chipEnd = 1 + link.length;
    view.dispatch({ selection: EditorSelection.cursor(chipEnd) });

    deleteCharBackward(view);

    expect(view.state.doc.toString()).toBe("ab");
  });
});

describe("skill tokens", () => {
  it("tints only the tokens the predicate confirms, and not inside a chip", () => {
    const tricky = chatReferenceLink({ sessionId: "s2", title: "x /review y" });
    const view = mount(`/review ${tricky} /nope`, { isSkill: (name) => name === "review" });

    const tinted = [...view.dom.querySelectorAll(".skill-token")].map((node) => node.textContent);
    expect(tinted).toEqual(["/review"]);
  });
});

describe("clipboard", () => {
  function clipboardEvent(type: string, data: Record<string, string> = {}): ClipboardEvent {
    const store = { ...data };
    const event = new Event(type, { bubbles: true, cancelable: true }) as ClipboardEvent;
    Object.defineProperty(event, "clipboardData", {
      value: {
        setData: (mime: string, value: string) => {
          store[mime] = value;
        },
        getData: (mime: string) => store[mime] ?? "",
        types: Object.keys(store),
        items: [],
        files: []
      }
    });
    return event;
  }

  it("copies the text and a typed entry that reads back to the same references", () => {
    const view = mount(`ask ${link}`);
    view.dispatch({ selection: EditorSelection.range(0, view.state.doc.length) });

    const event = clipboardEvent("copy");
    view.contentDOM.dispatchEvent(event);

    const data = event.clipboardData as unknown as { getData: (mime: string) => string };
    expect(event.defaultPrevented).toBe(true);
    expect(data.getData("text/plain")).toBe(`ask ${link}`);
    expect(decodeClipboardPayload(data.getData(COMPOSER_CLIPBOARD_MIME))).toMatchObject({
      text: `ask ${link}`,
      references: [{ sessionId: "s1", title: "Billing rewrite" }]
    });
  });

  it("cuts: same entry, and the selection leaves the draft", () => {
    const view = mount(`ask ${link}`);
    view.dispatch({ selection: EditorSelection.range(4, view.state.doc.length) });

    const event = clipboardEvent("cut");
    view.contentDOM.dispatchEvent(event);

    expect((event.clipboardData as unknown as { getData: (m: string) => string }).getData("text/plain")).toBe(link);
    expect(view.state.doc.toString()).toBe("ask ");
  });

  it("pastes the typed entry in place of the selection, and falls back to plain text when it is not ours", () => {
    const view = mount("before after");
    view.dispatch({ selection: EditorSelection.cursor(7) });

    const typed = clipboardEvent("paste", {
      "text/plain": "ignored",
      [COMPOSER_CLIPBOARD_MIME]: JSON.stringify({ v: 1, text: link, references: [{ sessionId: "other" }] })
    });
    view.contentDOM.dispatchEvent(typed);
    // The payload lists a reference the text does not hold, so it is refused
    // and CodeMirror pastes the plain flavor instead.
    expect(view.state.doc.toString()).toBe("before ignoredafter");

    const genuine = clipboardEvent("paste", {
      [COMPOSER_CLIPBOARD_MIME]: JSON.stringify({
        v: 1,
        text: link,
        references: [{ v: 1, sessionId: "s1", title: "Billing rewrite" }]
      })
    });
    view.dispatch({ selection: EditorSelection.cursor(7) });
    view.contentDOM.dispatchEvent(genuine);
    expect(view.state.doc.toString()).toBe(`before ${link}ignoredafter`);
  });

  it("lets the composer claim a paste first, so images become attachments", () => {
    const onPaste = vi.fn((event: ClipboardEvent) => event.preventDefault());
    const view = mount("", { callbacks: { onPaste } });

    const event = clipboardEvent("paste", { "text/plain": "x" });
    view.contentDOM.dispatchEvent(event);

    expect(onPaste).toHaveBeenCalledOnce();
    expect(view.state.doc.toString()).toBe("");
  });
});

describe("keyboard", () => {
  function key(init: KeyboardEventInit & { keyCode?: number }): KeyboardEvent {
    const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
    if (init.keyCode !== undefined) Object.defineProperty(event, "keyCode", { value: init.keyCode });
    return event;
  }

  it("hands the key to the composer, and a handled Enter does not type a newline", () => {
    const onKeyDown = vi.fn((event: KeyboardEvent) => {
      if (event.key === "Enter" && !event.shiftKey) event.preventDefault();
    });
    const view = mount("hi", { callbacks: { onKeyDown } });
    view.dispatch({ selection: EditorSelection.cursor(2) });

    view.contentDOM.dispatchEvent(key({ key: "Enter" }));
    expect(view.state.doc.toString()).toBe("hi");

    view.contentDOM.dispatchEvent(key({ key: "Enter", shiftKey: true }));
    expect(view.state.doc.toString()).toBe("hi\n");
  });

  it("never offers an IME-confirming Enter to the composer, so it cannot send", () => {
    const onKeyDown = vi.fn();
    const view = mount("日本", { callbacks: { onKeyDown } });

    view.contentDOM.dispatchEvent(key({ key: "Enter", keyCode: 229 }));

    expect(onKeyDown).not.toHaveBeenCalled();
  });

  it("does not auto-indent a new line after an indented one", () => {
    const view = mount("    indented");
    view.dispatch({ selection: EditorSelection.cursor(view.state.doc.length) });

    view.contentDOM.dispatchEvent(key({ key: "Enter", shiftKey: true }));

    expect(view.state.doc.toString()).toBe("    indented\n");
  });
});

describe("undo", () => {
  it("takes back typing, and redo returns it", () => {
    const view = mount("");
    view.dispatch({ changes: { from: 0, insert: "hello" }, userEvent: "input.type" });
    expect(view.state.doc.toString()).toBe("hello");

    undo(view);
    expect(view.state.doc.toString()).toBe("");
    redo(view);
    expect(view.state.doc.toString()).toBe("hello");
  });

  it("leaves a change the app made out of the history", () => {
    const view = mount("typed");
    view.dispatch({
      changes: { from: 0, to: 5, insert: "" },
      annotations: Transaction.addToHistory.of(false)
    });

    undo(view);

    expect(view.state.doc.toString()).toBe("");
  });
});
