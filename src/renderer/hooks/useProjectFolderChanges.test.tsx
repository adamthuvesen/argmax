import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ArgmaxApi, ProjectFolder } from "../../shared/types.js";
import { useProjectFolderChanges } from "./useProjectFolderChanges.js";

const folder = (id: string, enabled = true): ProjectFolder => ({
  id, projectId: "project", name: id, rootPath: `/repos/${id}`, isPrimary: id === "primary", enabled, summary: null
});

afterEach(cleanup);

describe("useProjectFolderChanges", () => {
  it("keeps identical file paths scoped to their folder and excludes the chat's original checkout", async () => {
    const getFolders = vi.fn().mockResolvedValue([folder("primary"), folder("one"), folder("two"), folder("disabled", false)]);
    const listChangedFiles = vi.fn().mockResolvedValue([{ path: "README.md", status: "M", additions: 1, deletions: 0, staged: false }]);
    const loadDiff = vi.fn<ArgmaxApi["review"]["loadDiff"]>().mockImplementation((target, path) => Promise.resolve({
      workspaceId: target.id, filePath: path ?? null, content: `diff for ${target.id}`, revision: target.id
    }));
    window.argmax = { projects: { getFolders }, review: { listChangedFiles, loadDiff } } as unknown as ArgmaxApi;
    const { result, rerender } = renderHook(({ refreshKey }) => useProjectFolderChanges({
      projectId: "project", workingFolderId: "primary", workingRootPath: "/isolated/chat", refreshKey
    }, true), { initialProps: { refreshKey: "running" } });
    await waitFor(() => expect(result.current.groups).toHaveLength(2));
    expect(listChangedFiles.mock.calls).toEqual([
      [{ kind: "projectFolder", id: "one" }, "workingTree"],
      [{ kind: "projectFolder", id: "two" }, "workingTree"]
    ]);
    act(() => result.current.selectFile("one", "README.md"));
    await waitFor(() => expect(result.current.diff?.content).toBe("diff for one"));
    act(() => result.current.selectFile("two", "README.md"));
    await waitFor(() => expect(result.current.diff?.content).toBe("diff for two"));
    expect(loadDiff).toHaveBeenLastCalledWith({ kind: "projectFolder", id: "two" }, "README.md", "workingTree", undefined);
    rerender({ refreshKey: "ready" });
    await waitFor(() => expect(getFolders).toHaveBeenCalledTimes(2));
    act(() => result.current.refresh());
    await waitFor(() => expect(getFolders).toHaveBeenCalledTimes(3));
  });

  it("keeps usable repositories visible when a folder is not a Git repository", async () => {
    const getFolders = vi.fn().mockResolvedValue([folder("primary"), folder("docs"), folder("code")]);
    const listChangedFiles = vi.fn<ArgmaxApi["review"]["listChangedFiles"]>().mockImplementation((target) => {
      if (target.id === "docs") return Promise.reject(new Error("Not a Git repository"));
      return Promise.resolve([]);
    });
    window.argmax = { projects: { getFolders }, review: { listChangedFiles } } as unknown as ArgmaxApi;
    const { result } = renderHook(() => useProjectFolderChanges({
      projectId: "project", workingFolderId: "primary", workingRootPath: "/repos/primary", refreshKey: null
    }, true));
    await waitFor(() => expect(result.current.groups).toHaveLength(2));
    expect(result.current.groups[0]?.error).toBe("Not a Git repository");
    expect(result.current.groups[1]?.error).toBeNull();
    expect(result.current.error).toBeNull();
  });
});
