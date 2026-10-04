import { vi } from "vitest";

// CodeMirror leans on layout APIs jsdom does not implement, and about forty
// composer tests drive the prompt the way a textarea is driven: change, keyDown,
// paste, setSelectionRange. This keeps the lazy wrapper out of the way and
// renders the textarea fallback the wrapper shows while the editor chunk loads,
// with the same props and the same field handle, so those tests exercise the
// composers' own behavior. It proves nothing about CodeMirror. The editor itself
// (chips, atomic ranges, clipboard, undo, composition) is covered against a real
// EditorView in composerEditor/extensions.test.tsx and ComposerEditorView.test.tsx,
// and, in a real browser, by scripts/verification/composer-editor.mjs.
vi.mock("../renderer/components/ComposerEditor.js", async () => {
  const { ComposerFallbackField } = await import("../renderer/components/ComposerFallbackField.js");
  return { ComposerEditor: ComposerFallbackField };
});
