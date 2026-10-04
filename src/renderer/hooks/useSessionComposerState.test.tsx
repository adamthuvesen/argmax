import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { snapshot } from "../../test/appTestHarness.js";
import { useSessionComposerState } from "./useSessionComposerState.js";

afterEach(() => cleanup());

describe("useSessionComposerState", () => {
  it("keeps review and transcript annotations in one draft, then clears them on a session switch", async () => {
    const firstSession = snapshot.sessions[0];
    const secondSession = { ...firstSession, id: "another-session" };
    const review = {
      isPanelOpen: true,
      workspaceFiles: {
        tabs: [{ path: "README.md" }, { path: "src/main.ts" }],
        activeTabPath: "src/main.ts"
      }
    };
    let annotationSink: ((input: {
      filePath: string; line: number | null; side: "addition"; lineText: string; comment: string; base: string;
    }) => void) | null = null;
    const { result, rerender } = renderHook(({ session }) => useSessionComposerState({
      session,
      isFocused: false,
      review,
      registerAnnotationSink: (sink) => { annotationSink = sink; }
    }), { initialProps: { session: firstSession } });

    act(() => {
      result.current.addAnnotation({ text: "selected answer" });
      annotationSink?.({
        filePath: "src/main.ts",
        line: 4,
        side: "addition",
        lineText: "new line",
        comment: "Check this",
        base: "branch"
      });
    });
    expect(result.current.pendingAnnotations.map((annotation) => annotation.kind)).toEqual(["excerpt", "diff-note"]);
    expect(result.current.openFilePaths).toEqual(["src/main.ts", "README.md"]);

    rerender({ session: secondSession });
    await waitFor(() => expect(result.current.pendingAnnotations).toEqual([]));
    expect(annotationSink).not.toBeNull();
  });
});
