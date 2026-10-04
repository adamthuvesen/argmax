import { EditorView } from "@codemirror/view";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createRef, useState, type JSX } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { installZeroLayoutForCodeMirror } from "../../test/jsdomCodeMirror.js";
import { chatReferenceLink } from "../lib/composerContext.js";
import { ComposerEditorView } from "./ComposerEditorView.js";
import type { ComposerField } from "./composerEditor/composerField.js";

beforeAll(installZeroLayoutForCodeMirror);

afterEach(cleanup);

const NO_CHATS = { resolve: () => null, open: () => undefined };

function Harness({
  initial = "",
  fieldRef,
  onChange,
  disabled = false,
  documentKey = null,
  chats = NO_CHATS
}: {
  initial?: string;
  fieldRef: React.RefObject<ComposerField | null>;
  onChange?: (value: string) => void;
  disabled?: boolean;
  documentKey?: string | null;
  chats?: { resolve: (id: string) => { title: string } | null; open: (id: string) => void };
}): JSX.Element {
  const [value, setValue] = useState(initial);
  return (
    <>
      <ComposerEditorView
        ariaLabel="Chat prompt"
        placeholder="Reply"
        value={value}
        disabled={disabled}
        documentKey={documentKey}
        onChange={(next) => {
          onChange?.(next);
          setValue(next);
        }}
        chats={chats}
        fieldRef={fieldRef}
      />
      <button type="button" onClick={() => setValue("from outside")}>
        set
      </button>
      <button type="button" onClick={() => setValue((current) => current.replace("that", "THAT"))}>
        shout
      </button>
      <button type="button" onClick={() => setValue((current) => `${current}ll `)}>
        complete
      </button>
      <button type="button" onClick={() => setValue("another draft")}>
        other draft
      </button>
      <output aria-label="state">{value}</output>
    </>
  );
}

function viewOf(): EditorView {
  const view = EditorView.findFromDOM(screen.getByRole("textbox", { name: "Chat prompt" }));
  if (!view) throw new Error("no editor");
  return view;
}

describe("ComposerEditorView", () => {
  it("is a labelled multiline textbox", () => {
    render(<Harness fieldRef={createRef()} />);

    const box = screen.getByRole("textbox", { name: "Chat prompt" });
    expect(box.getAttribute("aria-multiline")).toBe("true");
    expect(box.getAttribute("aria-expanded")).toBe("false");
    expect(box.getAttribute("spellcheck")).toBe("true");
  });

  it("reports what the person types, and only that", () => {
    const onChange = vi.fn();
    render(<Harness fieldRef={createRef()} onChange={onChange} />);

    act(() => viewOf().dispatch({ changes: { from: 0, insert: "hello" }, userEvent: "input.type" }));
    expect(onChange).toHaveBeenCalledWith("hello");

    onChange.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "set" }));
    expect(viewOf().state.doc.toString()).toBe("from outside");
    // The editor followed `value`; that is not an edit to report back.
    expect(onChange).not.toHaveBeenCalled();
  });

  it("follows an outside change by replacing only what differs, so the caret stays in untouched text", () => {
    const field = createRef<ComposerField>();
    render(<Harness initial="keep this and change that" fieldRef={field} />);
    act(() => field.current?.setSelectionRange(4, 4));

    fireEvent.click(screen.getByRole("button", { name: "shout" }));

    expect(viewOf().state.doc.toString()).toBe("keep this and change THAT");
    expect(field.current?.selectionStart).toBe(4);
  });

  it("keeps a caret that sat at the end at the end when the text grows from outside", () => {
    const field = createRef<ComposerField>();
    render(<Harness initial="/ski" fieldRef={field} />);
    act(() => field.current?.setSelectionRange(4, 4));

    fireEvent.click(screen.getByRole("button", { name: "complete" }));

    expect(viewOf().state.doc.toString()).toBe("/skill ");
    expect(field.current?.selectionStart).toBe(7);
  });

  it("exposes the textarea-shaped handle the menus use", () => {
    const field = createRef<ComposerField>();
    render(<Harness initial="abcdef" fieldRef={field} />);

    field.current?.setSelectionRange(2, 4);
    expect([field.current?.selectionStart, field.current?.selectionEnd]).toEqual([2, 4]);
    field.current?.setSelectionRange(2, 99);
    expect(field.current?.selectionEnd).toBe(6);

    const box = screen.getByRole("textbox", { name: "Chat prompt" });
    expect(field.current?.contains(box)).toBe(true);
    expect(field.current?.contains(document.body)).toBe(false);
    field.current?.focus();
    expect(document.activeElement).toBe(box);
  });

  it("stops accepting edits when disabled", () => {
    render(<Harness fieldRef={createRef()} disabled />);

    const box = screen.getByRole("textbox", { name: "Chat prompt" });
    expect(box.getAttribute("contenteditable")).toBe("false");
    expect(box.getAttribute("aria-disabled")).toBe("true");
  });

  it("round-trips a chat reference through the text, as one chip", () => {
    const text = `see ${chatReferenceLink({ sessionId: "s1", title: "Billing" })} please`;
    render(<Harness initial={text} fieldRef={createRef()} />);

    expect(viewOf().state.doc.toString()).toBe(text);
    expect(document.querySelectorAll(".composer-chat-chip")).toHaveLength(1);
  });

  it("announces its placeholder to assistive technology", () => {
    render(<Harness fieldRef={createRef()} />);

    expect(screen.getByRole("textbox", { name: "Chat prompt" }).getAttribute("aria-placeholder")).toBe(
      "Reply"
    );
  });

  it("reports the text now through the handle, ahead of React", () => {
    const field = createRef<ComposerField>();
    render(<Harness fieldRef={field} />);

    act(() => {
      viewOf().dispatch({ changes: { from: 0, insert: "typed" }, userEvent: "input.type" });
      expect(field.current?.value).toBe("typed");
    });
  });

  it("starts a new undo history when the document key changes", () => {
    const field = createRef<ComposerField>();
    const { rerender } = render(<Harness fieldRef={field} documentKey="a" initial="" />);
    act(() => viewOf().dispatch({ changes: { from: 0, insert: "first draft" }, userEvent: "input.type" }));

    // The same text under another key is another document: the typing that
    // made it belongs to the draft before, and undo must not take it back.
    rerender(<Harness fieldRef={field} documentKey="b" initial="" />);
    act(() => {
      viewOf().contentDOM.dispatchEvent(
        new KeyboardEvent("keydown", { key: "z", ctrlKey: true, bubbles: true, cancelable: true })
      );
    });

    expect(viewOf().state.doc.toString()).toBe("first draft");

    // Edits in the new document undo as usual.
    fireEvent.click(screen.getByRole("button", { name: "other draft" }));
    expect(viewOf().state.doc.toString()).toBe("another draft");
    act(() => {
      viewOf().contentDOM.dispatchEvent(
        new KeyboardEvent("keydown", { key: "z", ctrlKey: true, bubbles: true, cancelable: true })
      );
    });
    expect(viewOf().state.doc.toString()).toBe("first draft");
  });

  it("reports the caret of the new document when the key changes, and when the prompt is emptied", () => {
    const onCaretChange = vi.fn();
    function Caret({ documentKey, text }: { documentKey: string; text: string }): JSX.Element {
      return (
        <ComposerEditorView
          ariaLabel="Chat prompt"
          placeholder="Reply"
          value={text}
          documentKey={documentKey}
          onChange={() => undefined}
          onCaretChange={onCaretChange}
          chats={NO_CHATS}
          fieldRef={createRef()}
        />
      );
    }
    const { rerender } = render(<Caret documentKey="a" text="look at @src" />);
    act(() => viewOf().dispatch({ selection: { anchor: 12 } }));
    expect(onCaretChange).toHaveBeenLastCalledWith(12);

    // Another draft, longer, with the old caret offset inside a mention.
    rerender(<Caret documentKey="b" text="look at @src and more" />);
    expect(viewOf().state.selection.main.head).toBe(21);
    expect(onCaretChange).toHaveBeenLastCalledWith(21);

    rerender(<Caret documentKey="b" text="" />);
    expect(onCaretChange).toHaveBeenLastCalledWith(0);
  });

  it("takes no cut or paste when disabled, but still copies", () => {
    render(<Harness fieldRef={createRef()} initial="locked text" disabled />);
    const view = viewOf();
    act(() => view.dispatch({ selection: { anchor: 0, head: 6 } }));
    const store = new Map<string, string>();
    const clipboardData = {
      setData: (mime: string, value: string) => store.set(mime, value),
      getData: (mime: string) => (mime === "text/plain" ? "pasted" : ""),
      types: [],
      items: [],
      files: []
    };
    const cut = new Event("cut", { bubbles: true, cancelable: true });
    Object.defineProperty(cut, "clipboardData", { value: clipboardData });
    const paste = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(paste, "clipboardData", { value: clipboardData });

    act(() => {
      view.contentDOM.dispatchEvent(cut);
      view.contentDOM.dispatchEvent(paste);
    });

    expect(store.get("text/plain")).toBe("locked");
    expect(view.state.doc.toString()).toBe("locked text");
  });

  it("opens the chat reference at the caret from the keyboard, since a chip cannot be tabbed to", () => {
    const open = vi.fn();
    const link = chatReferenceLink({ sessionId: "s1", title: "Billing" });
    render(
      <Harness
        fieldRef={createRef()}
        initial={`see ${link} now`}
        chats={{ resolve: () => ({ title: "Billing" }), open }}
      />
    );
    const view = viewOf();
    const press = (): void => {
      view.contentDOM.dispatchEvent(
        new KeyboardEvent("keydown", { key: "o", ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true })
      );
    };

    act(() => view.dispatch({ selection: { anchor: 0 } }));
    press();
    expect(open).not.toHaveBeenCalled();

    act(() => view.dispatch({ selection: { anchor: 4 } }));
    press();
    expect(open).toHaveBeenCalledWith("s1");

    // The chip itself is reachable by Tab and answers Enter.
    open.mockClear();
    const chip = document.querySelector<HTMLElement>(".composer-chat-chip");
    expect(chip?.tabIndex).toBe(0);
    chip?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    expect(open).toHaveBeenCalledWith("s1");
  });
});
