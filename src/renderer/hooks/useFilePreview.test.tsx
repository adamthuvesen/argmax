import { useEffect, useRef } from "react";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ArgmaxApi, WorkspaceFilePreview } from "../../shared/types.js";
import type { ReviewIpcDispatch } from "../lib/reviewIpc.js";
import { useFilePreview } from "./useFilePreview.js";

function makeDispatch(readFile: (path: string) => Promise<WorkspaceFilePreview>): ReviewIpcDispatch {
  return {
    listChangedFiles: vi.fn().mockResolvedValue([]),
    loadDiff: vi.fn().mockRejectedValue(new Error("unused")),
    stageFile: vi.fn().mockResolvedValue(undefined),
    unstageFile: vi.fn().mockResolvedValue(undefined),
    revertFile: vi.fn().mockResolvedValue(undefined),
    stageHunk: vi.fn().mockResolvedValue(undefined),
    unstageHunk: vi.fn().mockResolvedValue(undefined),
    revertHunk: vi.fn().mockResolvedValue(undefined),
    commitStaged: vi.fn().mockRejectedValue(new Error("unused")),
    listFiles: vi.fn().mockResolvedValue([]),
    readFile,
    statFile: () => null,
    writeFile: () => null
  };
}

function usePreview(sourceId: string, dispatch: ReviewIpcDispatch, storageKey: string | null) {
  return useFilePreview({
    sourceId,
    sourceKind: "workspace",
    dispatch,
    canEdit: true,
    mode: "files",
    isPanelOpen: true,
    rootPath: `/tmp/${sourceId}`,
    storageKey
  });
}

function usePreviewWithSourceReset(
  sourceId: string,
  dispatch: ReviewIpcDispatch,
  storageKey: string | null
) {
  const preview = usePreview(sourceId, dispatch, storageKey);
  const resetForSourceChange = preview.resetForSourceChange;
  const previousSourceId = useRef(sourceId);
  useEffect(() => {
    if (previousSourceId.current === sourceId) return;
    previousSourceId.current = sourceId;
    resetForSourceChange();
  }, [sourceId, resetForSourceChange]);
  return preview;
}

describe("useFilePreview dirty buffers", () => {
  beforeEach(() => {
    window.localStorage.clear();
    Object.defineProperty(window, "argmax", {
      configurable: true,
      writable: true,
      value: {} satisfies Partial<ArgmaxApi>
    });
  });

  afterEach(() => {
    cleanup();
    delete (window as unknown as { argmax?: unknown }).argmax;
  });

  it("restores a dirty buffer when its session pane remounts", async () => {
    const readFile = vi.fn<(path: string) => Promise<WorkspaceFilePreview>>().mockResolvedValue({
      kind: "text",
      content: "on disk\n",
      size: 8,
      mtimeMs: 10
    });
    const statFile = vi.fn<NonNullable<ReviewIpcDispatch["statFile"]>>().mockResolvedValue({
      mtimeMs: 20,
      size: 18
    });
    const writeFile = vi.fn<ReviewIpcDispatch["writeFile"]>().mockResolvedValue({
      ok: "false",
      reason: "stale",
      currentMtimeMs: 20,
      size: 18
    });
    const dispatch = { ...makeDispatch(readFile), statFile, writeFile };
    const first = renderHook(() => usePreview("workspace-1", dispatch, "argmax.reviewPanel.files.session-1"));

    act(() => first.result.current.openFile("src/file.ts"));
    await waitFor(() => expect(first.result.current.previewState).toBe("ready"));
    act(() => first.result.current.editFile("unsaved draft\n"));
    expect(first.result.current.isDirty).toBe(true);
    first.unmount();

    const restored = renderHook(() =>
      usePreview("workspace-1", dispatch, "argmax.reviewPanel.files.session-1")
    );

    await waitFor(() => expect(restored.result.current.previewState).toBe("ready"));
    expect(restored.result.current.activeTabPath).toBe("src/file.ts");
    expect(restored.result.current.buffer).toBe("unsaved draft\n");
    expect(restored.result.current.isDirty).toBe(true);
    await waitFor(() => expect(restored.result.current.externalChange).toBe(true));
    await act(async () => restored.result.current.saveFile());
    expect(writeFile).toHaveBeenCalledWith("src/file.ts", "unsaved draft\n", 10);
    expect(readFile).toHaveBeenCalledTimes(1);
  });

  it("keeps dirty buffers with their source across a project round trip", async () => {
    const firstRead = vi.fn<(path: string) => Promise<WorkspaceFilePreview>>().mockResolvedValue({
      kind: "text",
      content: "first disk\n",
      size: 11,
      mtimeMs: 10
    });
    const secondRead = vi.fn<(path: string) => Promise<WorkspaceFilePreview>>().mockResolvedValue({
      kind: "text",
      content: "second disk\n",
      size: 12,
      mtimeMs: 20
    });
    const firstDispatch = makeDispatch(firstRead);
    const secondDispatch = makeDispatch(secondRead);
    const { result, rerender } = renderHook(
      ({ sourceId, dispatch }) => usePreviewWithSourceReset(sourceId, dispatch, null),
      { initialProps: { sourceId: "project-1", dispatch: firstDispatch } }
    );

    act(() => result.current.openFile("src/shared.ts"));
    await waitFor(() => expect(result.current.buffer).toBe("first disk\n"));
    act(() => result.current.editFile("first unsaved\n"));

    rerender({ sourceId: "project-2", dispatch: secondDispatch });
    expect(result.current.tabs).toHaveLength(0);
    act(() => result.current.openFile("src/shared.ts"));
    await waitFor(() => expect(result.current.buffer).toBe("second disk\n"));
    expect(result.current.isDirty).toBe(false);

    rerender({ sourceId: "project-1", dispatch: firstDispatch });
    await waitFor(() => expect(result.current.previewState).toBe("ready"));
    expect(result.current.activeTabPath).toBe("src/shared.ts");
    expect(result.current.buffer).toBe("first unsaved\n");
    expect(result.current.isDirty).toBe(true);
  });

  it("retains an undone buffer while an older save is still in flight", async () => {
    const readFile = vi.fn<(path: string) => Promise<WorkspaceFilePreview>>().mockResolvedValue({
      kind: "text",
      content: "original\n",
      size: 9,
      mtimeMs: 10
    });
    let finishSave!: (result: { ok: "true"; mtimeMs: number; size: number }) => void;
    const writeFile = vi.fn<ReviewIpcDispatch["writeFile"]>().mockReturnValue(
      new Promise((resolve) => {
        finishSave = resolve;
      })
    );
    const dispatch = { ...makeDispatch(readFile), writeFile };
    const first = renderHook(() => usePreview("workspace-save", dispatch, "files.session-save"));

    act(() => first.result.current.openFile("src/file.ts"));
    await waitFor(() => expect(first.result.current.previewState).toBe("ready"));
    act(() => first.result.current.editFile("saving\n"));
    act(() => void first.result.current.saveFile());
    await waitFor(() => expect(writeFile).toHaveBeenCalledWith("src/file.ts", "saving\n", 10));
    act(() => first.result.current.editFile("original\n"));
    expect(first.result.current.isDirty).toBe(false);
    first.unmount();

    const restored = renderHook(() => usePreview("workspace-save", dispatch, "files.session-save"));
    await waitFor(() => expect(restored.result.current.previewState).toBe("ready"));
    expect(restored.result.current.buffer).toBe("original\n");
    expect(restored.result.current.isDirty).toBe(true);

    await act(async () => {
      finishSave({ ok: "true", mtimeMs: 11, size: 7 });
      await Promise.resolve();
    });
    expect(restored.result.current.buffer).toBe("original\n");
  });
});
