import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { WorkspaceFileEntry } from "../../shared/types.js";
import { reviewIpcDispatch } from "../lib/reviewIpc.js";
import { useWorkspaceFileList } from "./useWorkspaceFileList.js";

afterEach(() => {
  cleanup();
  delete (window as unknown as { argmax?: unknown }).argmax;
});

it("ignores a previous source's pending file tree after switching sources while hidden", async () => {
  let resolveOld!: (entries: WorkspaceFileEntry[]) => void;
  const pending = new Promise<WorkspaceFileEntry[]>((resolve) => { resolveOld = resolve; });
  const listFiles = vi.fn().mockReturnValueOnce(pending).mockResolvedValue([]);
  Object.defineProperty(window, "argmax", {
    configurable: true,
    value: { workspace: { listFiles } }
  });
  const first = reviewIpcDispatch({ kind: "workspace", id: "first" });
  const second = reviewIpcDispatch({ kind: "workspace", id: "second" });
  const { result, rerender } = renderHook(
    ({ sourceId, dispatch, isPanelOpen }) => useWorkspaceFileList({
      sourceId, dispatch, isPanelOpen, sourceKind: "workspace", changedFilesKey: null, mode: "files"
    }),
    { initialProps: { sourceId: "first", dispatch: first, isPanelOpen: true } }
  );
  rerender({ sourceId: "first", dispatch: first, isPanelOpen: false });
  rerender({ sourceId: "second", dispatch: second, isPanelOpen: false });
  await act(async () => { resolveOld([{ path: "old.ts" }]); await pending; });
  expect(result.current.entries).toEqual([]);
  expect(result.current.listState).toBe("idle");
  await act(async () => {
    rerender({ sourceId: "second", dispatch: second, isPanelOpen: true });
    await Promise.resolve();
  });
  expect(listFiles).toHaveBeenLastCalledWith({ kind: "workspace", id: "second" });
  expect(result.current.listState).toBe("ready");
});
