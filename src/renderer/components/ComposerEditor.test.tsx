import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createRef, useState, type JSX } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { installZeroLayoutForCodeMirror } from "../../test/jsdomCodeMirror.js";
import { ComposerEditor } from "./ComposerEditor.js";
import type { ComposerField } from "./composerEditor/composerField.js";

// The suite replaces this wrapper with the textarea fallback; these tests need
// the real one, which starts as that textarea and hands over to CodeMirror.
vi.unmock("./ComposerEditor.js");

beforeAll(installZeroLayoutForCodeMirror);
afterEach(cleanup);

function Harness({ fieldRef }: { fieldRef: React.RefObject<ComposerField | null> }): JSX.Element {
  const [value, setValue] = useState("");
  return (
    <ComposerEditor
      ariaLabel="Chat prompt"
      placeholder="Reply"
      value={value}
      onChange={setValue}
      chats={{ resolve: () => null, open: () => undefined }}
      fieldRef={fieldRef}
    />
  );
}

describe("ComposerEditor (lazy)", () => {
  it("is a usable textarea until the editor chunk arrives, then hands over text, caret and focus", async () => {
    const field = createRef<ComposerField>();
    render(<Harness fieldRef={field} />);
    const textarea = screen.getByRole("textbox", { name: "Chat prompt" });
    expect(textarea.tagName).toBe("TEXTAREA");

    // The person is already typing when the chunk lands.
    act(() => (textarea as HTMLTextAreaElement).focus());
    fireEvent.change(textarea, { target: { value: "half a thought" } });

    await waitFor(() =>
      expect(screen.getByRole("textbox", { name: "Chat prompt" }).tagName).toBe("DIV")
    );
    const editor = screen.getByRole("textbox", { name: "Chat prompt" });
    expect(editor.textContent).toBe("half a thought");
    expect(field.current?.selectionStart).toBe("half a thought".length);
    expect(document.activeElement).toBe(editor);
  });

  it("mounts the editor at once, without calling the view as an initializer, when the chunk is already loaded", async () => {
    // A first composer warms the chunk, as the idle preload does before most mounts.
    const warm = render(<Harness fieldRef={createRef<ComposerField>()} />);
    await waitFor(() =>
      expect(screen.getByRole("textbox", { name: "Chat prompt" }).tagName).toBe("DIV")
    );
    warm.unmount();

    // A composer that mounts later (a chat resumed, a pane remounted) must not
    // throw destructuring props from an initializer call, and must not flash the textarea.
    render(<Harness fieldRef={createRef<ComposerField>()} />);
    expect(screen.getByRole("textbox", { name: "Chat prompt" }).tagName).toBe("DIV");
  });
});
