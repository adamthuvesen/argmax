// @vitest-environment jsdom
import { EditorView, placeholder } from "@codemirror/view";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { composerEditorCommand } from "../../scripts/verification/desktop.mjs";
import { installZeroLayoutForCodeMirror } from "./jsdomCodeMirror.js";

// The native driver reads the composer through the installed CodeMirror's own
// internals (the tile the page keeps on `.cm-content`). This runs the driver's
// in-page function against a real EditorView, so a CodeMirror upgrade that
// moves those internals fails here, not in a native run that reads the
// placeholder as the prompt.
beforeAll(installZeroLayoutForCodeMirror);

const views: EditorView[] = [];

function mount(doc: string): EditorView {
  const view = new EditorView({
    doc,
    parent: document.body,
    extensions: [placeholder("Argmax Verification Chat")]
  });
  views.push(view);
  return view;
}

afterEach(() => {
  views.splice(0).forEach((view) => view.destroy());
});

describe("composerEditorCommand against the installed CodeMirror", () => {
  it("reads an empty prompt as empty although the placeholder is in the DOM", () => {
    const view = mount("");
    expect(view.contentDOM.textContent).toContain("Argmax Verification Chat");
    expect(composerEditorCommand(view.contentDOM, "text")).toBe("");
  });

  it("reads the document, not the rendered text", () => {
    const view = mount("look at [Chat](argmax://chat/s1?v=1) end");
    expect(composerEditorCommand(view.contentDOM, "text")).toBe("look at [Chat](argmax://chat/s1?v=1) end");
  });

  it("selects everything, or puts the caret at the end", () => {
    const view = mount("abc def");
    composerEditorCommand(view.contentDOM, "select-all");
    expect(view.state.selection.main).toMatchObject({ anchor: 0, head: 7 });
    composerEditorCommand(view.contentDOM, "select-end");
    expect(view.state.selection.main).toMatchObject({ anchor: 7, head: 7 });
  });

  it("fails loudly when the view is not reachable", () => {
    const orphan = document.createElement("div");
    orphan.className = "cm-content";
    expect(() => composerEditorCommand(orphan, "text")).toThrow(/view is not reachable/);
  });
});
