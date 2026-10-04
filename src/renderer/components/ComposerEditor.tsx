import { useEffect, useRef, useState, type JSX } from "react";
import { importChunk } from "../lib/importChunk.js";
import { ComposerFallbackField } from "./ComposerFallbackField.js";
import type * as ViewModule from "./ComposerEditorView.js";
import type { ComposerEditorHandoff, ComposerEditorProps } from "./composerEditor/props.js";

export type { ComposerEditorProps } from "./composerEditor/props.js";

type EditorModule = typeof ViewModule;

// CodeMirror is hundreds of kilobytes of script, and the prompt is on the first
// screen, so it loads as its own chunk once the app is idle rather than with
// the entry (scripts/check-bundle.mjs holds the eager graph to a budget). Until
// it arrives the prompt is a working textarea; when it arrives the editor takes
// over with the same text, caret and focus.
let editorModule: EditorModule | null = null;
let editorLoad: Promise<EditorModule> | null = null;

function loadEditor(): Promise<EditorModule> {
  editorLoad ??= importChunk(() => import("./ComposerEditorView.js")).then((loaded) => {
    editorModule = loaded;
    return loaded;
  });
  return editorLoad;
}

if (typeof window !== "undefined") {
  const whenIdle =
    typeof window.requestIdleCallback === "function"
      ? (run: () => void) => window.requestIdleCallback(run)
      : (run: () => void) => window.setTimeout(run, 0);
  whenIdle(() => {
    loadEditor().catch(() => undefined);
  });
}

/**
 * The prompt field both composers share. See ComposerEditorView for the
 * editor; this decides which of the two is on screen.
 */
export function ComposerEditor(props: ComposerEditorProps): JSX.Element {
  // The view is a component, so a bare function here would be called as the
  // state initializer (with no props) when the chunk is already warm.
  const [Loaded, setLoaded] = useState<EditorModule["ComposerEditorView"] | null>(
    () => editorModule?.ComposerEditorView ?? null
  );
  const handoff = useRef<ComposerEditorHandoff | undefined>(undefined);
  const { fieldRef } = props;

  useEffect(() => {
    if (Loaded) return undefined;
    let current = true;
    loadEditor().then(
      (loaded) => {
        if (!current) return;
        // Read the textarea before it unmounts.
        const field = typeof fieldRef === "object" && fieldRef !== null ? fieldRef.current : null;
        if (field) {
          handoff.current = {
            selectionStart: field.selectionStart ?? 0,
            selectionEnd: field.selectionEnd ?? field.selectionStart ?? 0,
            focused: field.contains(document.activeElement)
          };
        }
        setLoaded(() => loaded.ComposerEditorView);
      },
      () => undefined
    );
    return () => {
      current = false;
    };
  }, [Loaded, fieldRef]);

  if (!Loaded) return <ComposerFallbackField {...props} />;
  return <Loaded {...props} handoff={handoff.current} />;
}
