import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ArgmaxApi, ProjectSummary, WorkspaceSummary } from "../../shared/types.js";
import { useReviewState, type ReviewSource } from "./useReviewState.js";

function workspaceSource(workspace: WorkspaceSummary): ReviewSource {
  return { kind: "workspace", workspace };
}

function projectSource(project: ProjectSummary): ReviewSource {
  return { kind: "project", project };
}

function makeWorkspace(overrides: Partial<WorkspaceSummary> = {}): WorkspaceSummary {
  return {
    id: "workspace-1",
    projectId: "project-1",
    taskLabel: "Build dashboard",
    branch: "argmax/dashboard",
    baseRef: "main",
    path: "/tmp/wt",
    state: "running",
    sharedWorkspace: false,
    dirty: false,
    changedFiles: 3,
    lastActivityAt: "2026-05-12T15:54:00.000Z",
    pinned: false,
    ...overrides
  };
}

function makeProject(overrides: Partial<ProjectSummary> = {}): ProjectSummary {
  return {
    id: "project-1",
    name: "Argmax",
    repoPath: "/tmp/repo",
    currentBranch: "main",
    defaultBranch: "main",
    settings: {
      defaultProvider: "codex",
      defaultModelLabel: "GPT-5.3 Codex",
      worktreeLocation: "/tmp/wt",
      setupCommand: "",
      checkCommands: []
    },
    counts: { active: 0, blocked: 0, failed: 0, reviewReady: 0 },
    latestActivityAt: "2026-05-12T15:54:00.000Z",
    ...overrides
  };
}

describe("useReviewState — IPC fan-out resistance", () => {
  let listChangedFiles: ReturnType<typeof vi.fn<ArgmaxApi["review"]["listChangedFiles"]>>;
  let listWorkspaceFiles: ReturnType<typeof vi.fn<ArgmaxApi["workspace"]["listFiles"]>>;
  let readWorkspaceFile: ReturnType<typeof vi.fn<ArgmaxApi["workspace"]["readFile"]>>;
  let writeWorkspaceFile: ReturnType<typeof vi.fn<ArgmaxApi["workspace"]["writeFile"]>>;
  let statWorkspaceFile: ReturnType<typeof vi.fn<ArgmaxApi["workspace"]["statFile"]>>;
  let readProjectFile: ReturnType<typeof vi.fn<ArgmaxApi["workspace"]["readFileForProject"]>>;
  let writeProjectFile: ReturnType<typeof vi.fn<ArgmaxApi["workspace"]["writeFileForProject"]>>;

  beforeEach(() => {
    listChangedFiles = vi
      .fn<ArgmaxApi["review"]["listChangedFiles"]>()
      .mockResolvedValue([]);
    listWorkspaceFiles = vi
      .fn<ArgmaxApi["workspace"]["listFiles"]>()
      .mockResolvedValue([]);
    readWorkspaceFile = vi
      .fn<ArgmaxApi["workspace"]["readFile"]>()
      .mockResolvedValue({ kind: "text", content: "", size: 0, mtimeMs: 0 });
    writeWorkspaceFile = vi
      .fn<ArgmaxApi["workspace"]["writeFile"]>()
      .mockResolvedValue({ ok: true, mtimeMs: 2, size: 0 });
    statWorkspaceFile = vi
      .fn<ArgmaxApi["workspace"]["statFile"]>()
      .mockResolvedValue({ mtimeMs: 1, size: 0 });
    readProjectFile = vi
      .fn<ArgmaxApi["workspace"]["readFileForProject"]>()
      .mockResolvedValue({ kind: "text", content: "project\n", size: 8, mtimeMs: 10 });
    writeProjectFile = vi
      .fn<ArgmaxApi["workspace"]["writeFileForProject"]>()
      .mockResolvedValue({ ok: true, mtimeMs: 11, size: 0 });

    Object.defineProperty(window, "argmax", {
      configurable: true,
      writable: true,
      value: {
        review: {
          listChangedFiles,
          loadDiff: vi.fn().mockResolvedValue(null),
          listChangedFilesForProject: vi.fn().mockResolvedValue([]),
          loadDiffForProject: vi.fn().mockResolvedValue(null)
        },
        workspace: {
          listFiles: listWorkspaceFiles,
          readFile: readWorkspaceFile,
          writeFile: writeWorkspaceFile,
          statFile: statWorkspaceFile,
          listFilesForProject: vi.fn().mockResolvedValue([]),
          readFileForProject: readProjectFile,
          writeFileForProject: writeProjectFile,
          statFileForProject: vi.fn(),
          grepContent: vi.fn().mockResolvedValue({ files: [], truncated: false })
        }
      } satisfies Partial<ArgmaxApi>
    });
  });

  afterEach(() => {
    cleanup();
    delete (window as unknown as { argmax?: unknown }).argmax;
  });

  it("does not refetch listChangedFiles when only `lastActivityAt` ticks (50 chat tokens)", async () => {
    // audit-2026-05-11 / SPEC P1.05 — the changed-files effect depended on
    // `workspace.lastActivityAt`, which bumps once per streamed token; that
    // caused ~1 IPC roundtrip per token. Fix: depend on stable signals
    // (workspace.id + changedFiles count + lifecycle state).
    const initial = makeWorkspace({ lastActivityAt: "2026-05-12T15:54:00.000Z" });
    const { rerender } = renderHook(({ ws }: { ws: WorkspaceSummary }) => useReviewState(workspaceSource(ws)), {
      initialProps: { ws: initial }
    });

    await waitFor(() => expect(listChangedFiles).toHaveBeenCalledTimes(1));

    // Simulate 50 dashboard-delta ticks. Only `lastActivityAt` changes — the
    // workspace id and changedFiles count stay put.
    for (let i = 0; i < 50; i++) {
      const tickedAt = new Date(Date.UTC(2026, 4, 12, 15, 54, i + 1)).toISOString();
      rerender({ ws: makeWorkspace({ lastActivityAt: tickedAt }) });
    }

    // Still exactly one call: the unstable `lastActivityAt` no longer
    // appears in the effect's dependency list.
    expect(listChangedFiles).toHaveBeenCalledTimes(1);
  });

  it("does refetch listChangedFiles when changedFiles count changes", async () => {
    const initial = makeWorkspace({ changedFiles: 3 });
    const { rerender } = renderHook(({ ws }: { ws: WorkspaceSummary }) => useReviewState(workspaceSource(ws)), {
      initialProps: { ws: initial }
    });

    await waitFor(() => expect(listChangedFiles).toHaveBeenCalledTimes(1));

    rerender({ ws: makeWorkspace({ changedFiles: 4 }) });

    await waitFor(() => expect(listChangedFiles).toHaveBeenCalledTimes(2));
  });

  it("does refetch listChangedFiles when the workspace completes with a stale changedFiles count", async () => {
    const initial = makeWorkspace({ changedFiles: 0, state: "running" });
    const { rerender } = renderHook(({ ws }: { ws: WorkspaceSummary }) => useReviewState(workspaceSource(ws)), {
      initialProps: { ws: initial }
    });

    await waitFor(() => expect(listChangedFiles).toHaveBeenCalledTimes(1));

    rerender({ ws: makeWorkspace({ changedFiles: 0, state: "complete" }) });

    await waitFor(() => expect(listChangedFiles).toHaveBeenCalledTimes(2));
  });

  it("does refetch when the workspace id changes", async () => {
    const { rerender } = renderHook(({ ws }: { ws: WorkspaceSummary }) => useReviewState(workspaceSource(ws)), {
      initialProps: { ws: makeWorkspace({ id: "workspace-1" }) }
    });

    await waitFor(() => expect(listChangedFiles).toHaveBeenCalledTimes(1));

    rerender({ ws: makeWorkspace({ id: "workspace-2" }) });

    await waitFor(() => expect(listChangedFiles).toHaveBeenCalledTimes(2));
    expect(listChangedFiles).toHaveBeenNthCalledWith(2, "workspace-2");
  });

  it("does not refetch workspace.listFiles when lastActivityAt ticks while in Files mode", async () => {
    // Same audit class, sibling effect: the Files-mode list previously
    // re-fetched on every `lastActivityAt` change too.
    const initial = makeWorkspace();
    const { result, rerender } = renderHook(
      ({ ws }: { ws: WorkspaceSummary }) => useReviewState(workspaceSource(ws)),
      { initialProps: { ws: initial } }
    );

    // Open the Files pane to activate the listFiles effect.
    act(() => {
      result.current.openPanelInFilesMode();
    });

    await waitFor(() => expect(listWorkspaceFiles).toHaveBeenCalledTimes(1));

    for (let i = 0; i < 50; i++) {
      const tickedAt = new Date(Date.UTC(2026, 4, 12, 15, 54, i + 1)).toISOString();
      rerender({ ws: makeWorkspace({ lastActivityAt: tickedAt }) });
    }

    expect(listWorkspaceFiles).toHaveBeenCalledTimes(1);
  });

  it("keeps separate open tabs and preserves buffers while switching", async () => {
    readWorkspaceFile
      .mockResolvedValueOnce({ kind: "text", content: "one\n", size: 4, mtimeMs: 10 })
      .mockResolvedValueOnce({ kind: "text", content: "two\n", size: 4, mtimeMs: 20 });
    const { result } = renderHook(
      ({ ws }: { ws: WorkspaceSummary }) => useReviewState(workspaceSource(ws)),
      { initialProps: { ws: makeWorkspace() } }
    );

    await waitFor(() => expect(listChangedFiles).toHaveBeenCalledTimes(1));

    act(() => {
      result.current.openInFilesView("src/one.ts");
    });
    await waitFor(() => expect(readWorkspaceFile).toHaveBeenCalledWith("workspace-1", "src/one.ts"));
    await waitFor(() => expect(result.current.workspaceFiles.buffer).toBe("one\n"));

    act(() => {
      result.current.workspaceFiles.editFile("one edited\n");
      result.current.openInFilesView("src/two.ts");
    });
    await waitFor(() => expect(readWorkspaceFile).toHaveBeenCalledWith("workspace-1", "src/two.ts"));
    await waitFor(() => expect(result.current.workspaceFiles.buffer).toBe("two\n"));

    act(() => {
      result.current.workspaceFiles.selectTab("src/one.ts");
    });

    expect(result.current.workspaceFiles.activeTabPath).toBe("src/one.ts");
    expect(result.current.workspaceFiles.buffer).toBe("one edited\n");
    expect(result.current.workspaceFiles.isDirty).toBe(true);
    expect(readWorkspaceFile).toHaveBeenCalledTimes(2);
  });

  it("focuses existing tabs without refetching the file", async () => {
    readWorkspaceFile.mockResolvedValueOnce({
      kind: "text",
      content: "export const value = 1;\n",
      size: 24,
      mtimeMs: 10
    });
    const { result } = renderHook(
      ({ ws }: { ws: WorkspaceSummary }) => useReviewState(workspaceSource(ws)),
      { initialProps: { ws: makeWorkspace() } }
    );

    await waitFor(() => expect(listChangedFiles).toHaveBeenCalledTimes(1));
    act(() => {
      result.current.openInFilesView("src/value.ts");
    });
    await waitFor(() => expect(result.current.workspaceFiles.previewState).toBe("ready"));

    act(() => {
      result.current.openInFilesView("src/value.ts");
    });

    expect(result.current.workspaceFiles.tabs).toHaveLength(1);
    expect(readWorkspaceFile).toHaveBeenCalledTimes(1);
  });

  it("prompts before closing dirty tabs and supports cancel, discard, and save", async () => {
    readWorkspaceFile.mockResolvedValue({
      kind: "text",
      content: "draft\n",
      size: 6,
      mtimeMs: 10
    });
    const { result } = renderHook(
      ({ ws }: { ws: WorkspaceSummary }) => useReviewState(workspaceSource(ws)),
      { initialProps: { ws: makeWorkspace() } }
    );

    await waitFor(() => expect(listChangedFiles).toHaveBeenCalledTimes(1));
    act(() => {
      result.current.openInFilesView("src/draft.ts");
    });
    await waitFor(() => expect(result.current.workspaceFiles.previewState).toBe("ready"));

    act(() => {
      result.current.workspaceFiles.editFile("draft changed\n");
    });
    act(() => {
      result.current.workspaceFiles.closeTab("src/draft.ts");
    });
    expect(result.current.workspaceFiles.dirtyClosePrompt?.path).toBe("src/draft.ts");

    act(() => {
      result.current.workspaceFiles.cancelDirtyTabClose();
    });
    expect(result.current.workspaceFiles.dirtyClosePrompt).toBeNull();
    expect(result.current.workspaceFiles.tabs).toHaveLength(1);

    act(() => {
      result.current.workspaceFiles.closeTab("src/draft.ts");
    });
    act(() => {
      result.current.workspaceFiles.discardDirtyTabAndClose();
    });
    expect(result.current.workspaceFiles.tabs).toHaveLength(0);

    act(() => {
      result.current.openInFilesView("src/draft.ts");
    });
    await waitFor(() => expect(result.current.workspaceFiles.previewState).toBe("ready"));
    act(() => {
      result.current.workspaceFiles.editFile("saved draft\n");
    });
    act(() => {
      result.current.workspaceFiles.closeTab("src/draft.ts");
    });
    await act(async () => {
      await result.current.workspaceFiles.saveDirtyTabAndClose();
    });

    expect(writeWorkspaceFile).toHaveBeenCalledWith("workspace-1", "src/draft.ts", "saved draft\n", 10);
    expect(result.current.workspaceFiles.tabs).toHaveLength(0);
  });

  it("keeps a dirty tab open and marks it stale when save-on-close hits the mtime guard", async () => {
    readWorkspaceFile.mockResolvedValue({
      kind: "text",
      content: "draft\n",
      size: 6,
      mtimeMs: 10
    });
    writeWorkspaceFile.mockResolvedValueOnce({
      ok: false,
      reason: "stale",
      currentMtimeMs: 15,
      size: 8
    });
    const { result } = renderHook(
      ({ ws }: { ws: WorkspaceSummary }) => useReviewState(workspaceSource(ws)),
      { initialProps: { ws: makeWorkspace() } }
    );

    await waitFor(() => expect(listChangedFiles).toHaveBeenCalledTimes(1));
    act(() => {
      result.current.openInFilesView("src/draft.ts");
    });
    await waitFor(() => expect(result.current.workspaceFiles.previewState).toBe("ready"));
    act(() => {
      result.current.workspaceFiles.editFile("draft changed\n");
    });
    act(() => {
      result.current.workspaceFiles.closeTab("src/draft.ts");
    });

    await act(async () => {
      await result.current.workspaceFiles.saveDirtyTabAndClose();
    });

    expect(result.current.workspaceFiles.tabs).toHaveLength(1);
    expect(result.current.workspaceFiles.activeTabPath).toBe("src/draft.ts");
    expect(result.current.workspaceFiles.externalChange).toBe(true);
    expect(result.current.workspaceFiles.dirtyClosePrompt).toBeNull();
  });

  it("resets open file tabs when the workspace id changes", async () => {
    readWorkspaceFile.mockResolvedValue({
      kind: "text",
      content: "one\n",
      size: 4,
      mtimeMs: 10
    });
    const { result, rerender } = renderHook(
      ({ ws }: { ws: WorkspaceSummary }) => useReviewState(workspaceSource(ws)),
      { initialProps: { ws: makeWorkspace({ id: "workspace-1" }) } }
    );

    await waitFor(() => expect(listChangedFiles).toHaveBeenCalledTimes(1));
    act(() => {
      result.current.openInFilesView("src/one.ts");
    });
    await waitFor(() => expect(result.current.workspaceFiles.tabs).toHaveLength(1));

    rerender({ ws: makeWorkspace({ id: "workspace-2" }) });

    await waitFor(() => expect(listChangedFiles).toHaveBeenCalledTimes(2));
    expect(result.current.workspaceFiles.tabs).toHaveLength(0);
    expect(result.current.workspaceFiles.activeTabPath).toBeNull();
  });

  it("keeps project file browsing read-only", async () => {
    const { result } = renderHook(() => useReviewState(projectSource(makeProject())));

    await waitFor(() => expect(result.current.filesState).toBe("ready"));
    act(() => {
      result.current.openInFilesView("src/project.ts");
    });
    await waitFor(() => expect(readProjectFile).toHaveBeenCalledWith("project-1", "src/project.ts"));
    await waitFor(() => expect(result.current.workspaceFiles.previewState).toBe("ready"));

    expect(result.current.workspaceFiles.canEdit).toBe(false);
    act(() => {
      result.current.workspaceFiles.editFile("mutated\n");
    });
    expect(result.current.workspaceFiles.buffer).toBe("project\n");
    expect(result.current.workspaceFiles.isDirty).toBe(false);

    await act(async () => {
      await result.current.workspaceFiles.saveFile();
    });

    expect(writeProjectFile).not.toHaveBeenCalled();
  });
});
