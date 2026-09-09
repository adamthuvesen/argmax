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
    kind: "git",
    dirty: false,
    changedFiles: 3,
    lastActivityAt: "2026-05-12T15:54:00.000Z",
    pinned: false,
    priorityDismissedAt: null,
    priorityAddedAt: null,
    prState: null,
    prNumber: null,
    icon: null,
    iconColor: null,
    prCreatedAt: null,
    prMergedAt: null,
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
      archiveOnMerge: false,
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
  let readProjectFile: ReturnType<typeof vi.fn<ArgmaxApi["workspace"]["readFile"]>>;
  let writeProjectFile: ReturnType<typeof vi.fn<ArgmaxApi["workspace"]["writeFile"]>>;

  it("remembers each session's panel visibility after leaving and returning", () => {
    const source = workspaceSource(makeWorkspace());
    const first = renderHook(() => useReviewState(source, null, { sessionId: "session-1" }));
    act(() => first.result.current.openChangesPanel());
    first.unmount();

    const other = renderHook(() => useReviewState(source, null, { sessionId: "session-2" }));
    expect(other.result.current.isPanelOpen).toBe(false);
    other.unmount();

    const restored = renderHook(() => useReviewState(source, null, { sessionId: "session-1" }));
    expect(restored.result.current.isPanelOpen).toBe(true);
    act(() => restored.result.current.closePanel());
    restored.unmount();

    const closed = renderHook(() => useReviewState(source, null, { sessionId: "session-1" }));
    expect(closed.result.current.isPanelOpen).toBe(false);
  });

  it.each(["browser", "files", "agents", "terminal", "changes"] as const)(
    "remembers panel mode %s per session after leaving and returning",
    (mode) => {
      if (mode === "browser") {
        (window.argmax as ArgmaxApi).browser = {} as ArgmaxApi["browser"];
      }
      const source = workspaceSource(makeWorkspace());
      const first = renderHook(() => useReviewState(source, null, { sessionId: "session-1" }));
      act(() => {
        first.result.current.openChangesPanel();
        first.result.current.setMode(mode);
      });
      first.unmount();

      const other = renderHook(() => useReviewState(source, null, { sessionId: "session-2" }));
      act(() => other.result.current.openChangesPanel());
      expect(other.result.current.mode).toBe("changes");
      other.unmount();

      const restored = renderHook(() => useReviewState(source, null, { sessionId: "session-1" }));
      expect(restored.result.current.isPanelOpen).toBe(true);
      expect(restored.result.current.mode).toBe(mode);
      if (mode === "browser") expect(restored.result.current.browserOwner).toBe(true);
      act(() => restored.result.current.closePanel());
      restored.unmount();

      const closed = renderHook(() => useReviewState(source, null, { sessionId: "session-1" }));
      expect(closed.result.current.isPanelOpen).toBe(false);
      expect(closed.result.current.mode).toBe(mode);
    }
  );

  it("persists a split layout per session and keeps it across whole-panel close and reopen", () => {
    const source = workspaceSource(makeWorkspace());
    const first = renderHook(() => useReviewState(source, null, { sessionId: "session-split" }));
    act(() => {
      first.result.current.openChangesPanel();
      first.result.current.splitMode("files", "bottom");
      first.result.current.setSplitRatio(0.65);
      first.result.current.closePanel();
    });
    first.unmount();

    const restored = renderHook(() => useReviewState(source, null, { sessionId: "session-split" }));
    expect(restored.result.current.isPanelOpen).toBe(false);
    expect(restored.result.current.layout).toEqual({
      modes: ["changes", "files"],
      activeIndex: 1,
      ratio: 0.65
    });

    act(() => restored.result.current.togglePanel());
    expect(restored.result.current.isPanelOpen).toBe(true);
    expect(restored.result.current.layout.modes).toEqual(["changes", "files"]);
  });

  it("restores the legacy per-session mode when no layout has been saved yet", () => {
    window.localStorage.setItem("argmax.reviewPanel.mode.session-legacy", "terminal");

    const { result } = renderHook(() =>
      useReviewState(workspaceSource(makeWorkspace()), null, { sessionId: "session-legacy" })
    );

    expect(result.current.layout).toEqual({ modes: ["terminal"], activeIndex: 0, ratio: 0.5 });
  });

  it("focuses visible modes, swaps duplicate pane selections, and promotes a survivor", () => {
    const source = workspaceSource(makeWorkspace());
    const { result } = renderHook(() => useReviewState(source, null, { sessionId: "session-layout" }));
    act(() => {
      result.current.openChangesPanel();
      result.current.splitMode("files", "bottom");
      result.current.setMode("changes");
    });
    expect(result.current.layout).toMatchObject({ modes: ["changes", "files"], activeIndex: 0 });

    act(() => result.current.setPaneMode(0, "files"));
    expect(result.current.layout).toMatchObject({ modes: ["files", "changes"], activeIndex: 0 });

    act(() => result.current.closePane(0));
    expect(result.current.isPanelOpen).toBe(true);
    expect(result.current.layout).toMatchObject({ modes: ["changes"], activeIndex: 0 });

    act(() => result.current.closePane(0));
    expect(result.current.isPanelOpen).toBe(false);
    expect(result.current.layout.modes).toEqual(["changes"]);
  });

  it("removes a visible terminal pane when toggled and leaves its neighbour open", () => {
    const source = workspaceSource(makeWorkspace());
    const { result } = renderHook(() => useReviewState(source, null, { sessionId: "session-terminal" }));
    act(() => {
      result.current.openChangesPanel();
      result.current.splitMode("terminal", "bottom");
    });

    act(() => result.current.toggleTerminal());
    expect(result.current.isPanelOpen).toBe(true);
    expect(result.current.layout.modes).toEqual(["changes"]);
  });

  it("normalizes modes that a project-backed launcher cannot show", () => {
    window.localStorage.setItem(
      "argmax.reviewPanel.layout.launcher",
      JSON.stringify({ modes: ["terminal", "agents"], activeIndex: 1, ratio: 0.6 })
    );

    const { result } = renderHook(() => useReviewState(projectSource(makeProject())));
    expect(result.current.layout).toEqual({
      modes: ["changes", "files"],
      activeIndex: 0,
      ratio: 0.6
    });
  });

  it("keeps an explicitly open mobile-style review surface unsplit", () => {
    window.localStorage.setItem(
      "argmax.reviewPanel.layout.session-mobile",
      JSON.stringify({ modes: ["changes", "files"], activeIndex: 1, ratio: 0.6 })
    );

    const { result } = renderHook(() =>
      useReviewState(workspaceSource(makeWorkspace()), null, {
        editable: false,
        initiallyOpen: true,
        sessionId: "session-mobile"
      })
    );
    expect(result.current.isPanelOpen).toBe(true);
    expect(result.current.layout).toEqual({ modes: ["changes"], activeIndex: 0, ratio: 0.5 });
  });

  beforeEach(() => {
    // The Local/Branch toggle persists to localStorage; clear it so each test
    // starts from the "local" default regardless of run order.
    window.localStorage.clear();
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
      .mockResolvedValue({ ok: "true", mtimeMs: 2, size: 0 });
    statWorkspaceFile = vi
      .fn<ArgmaxApi["workspace"]["statFile"]>()
      .mockResolvedValue({ mtimeMs: 1, size: 0 });
    readProjectFile = vi
      .fn<ArgmaxApi["workspace"]["readFile"]>()
      .mockResolvedValue({ kind: "text", content: "project\n", size: 8, mtimeMs: 10 });
    writeProjectFile = vi
      .fn<ArgmaxApi["workspace"]["writeFile"]>()
      .mockResolvedValue({ ok: "true", mtimeMs: 11, size: 0 });

    Object.defineProperty(window, "argmax", {
      configurable: true,
      writable: true,
      value: {
        review: {
          listChangedFiles,
          loadDiff: vi.fn().mockResolvedValue(null)
        },
        workspace: {
          listFiles: listWorkspaceFiles,
          readFile: (target, path) => target.kind === "project"
            ? readProjectFile(target, path)
            : readWorkspaceFile(target, path),
          writeFile: (target, path, content, mtime) => target.kind === "project"
            ? writeProjectFile(target, path, content, mtime)
            : writeWorkspaceFile(target, path, content, mtime),
          statFile: statWorkspaceFile,
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
    // The changed-files effect depends on stable signals (workspace id,
    // changedFiles count, and lifecycle state), not token-level activity ticks.
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

    // Still exactly one call: `lastActivityAt` is not an effect dependency.
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
    expect(listChangedFiles).toHaveBeenNthCalledWith(2, { kind: "workspace", id: "workspace-2" }, "branch");
  });

  it("expands the first changed file when the Changes panel opens", async () => {
    listChangedFiles.mockResolvedValue([
      { path: "src/a.ts", status: "M", additions: 1, deletions: 0 },
      { path: "src/b.ts", status: "M", additions: 2, deletions: 0 }
    ]);
    const { result } = renderHook(() => useReviewState(workspaceSource(makeWorkspace())));

    await waitFor(() => expect(result.current.files).toHaveLength(2));
    expect(result.current.selectedFilePath).toBeNull();

    act(() => {
      result.current.openChangesPanel();
    });

    await waitFor(() => expect(result.current.selectedFilePath).toBe("src/a.ts"));
  });

  it("loads both Changes and Files data when both views are visible and Files is active", async () => {
    listChangedFiles.mockResolvedValue([
      { path: "src/a.ts", status: "M", additions: 1, deletions: 0 }
    ]);
    const { result } = renderHook(() => useReviewState(workspaceSource(makeWorkspace())));
    await waitFor(() => expect(result.current.files).toHaveLength(1));

    act(() => {
      result.current.openChangesPanel();
      result.current.splitMode("files", "bottom");
    });

    expect(result.current.mode).toBe("files");
    await waitFor(() => expect(result.current.selectedFilePath).toBe("src/a.ts"));
    await waitFor(() => expect(listWorkspaceFiles).toHaveBeenCalledTimes(1));
  });

  it("defaults to the whole branch and refetches when the scope changes", async () => {
    const { result } = renderHook(() => useReviewState(workspaceSource(makeWorkspace())));

    await waitFor(() => expect(listChangedFiles).toHaveBeenCalledTimes(1));
    expect(result.current.changesScope).toBe("branch");
    expect(listChangedFiles).toHaveBeenNthCalledWith(1, { kind: "workspace", id: "workspace-1" }, "branch");
    expect(result.current.comparisonBaseLabel).toBe("main");

    act(() => {
      result.current.setChangesScope("committed");
    });
    await waitFor(() => expect(listChangedFiles).toHaveBeenCalledTimes(2));
    expect(listChangedFiles).toHaveBeenNthCalledWith(2, { kind: "workspace", id: "workspace-1" }, "committed");

    act(() => {
      result.current.setChangesScope("uncommitted");
    });
    await waitFor(() => expect(listChangedFiles).toHaveBeenCalledTimes(3));
    expect(listChangedFiles).toHaveBeenNthCalledWith(3, { kind: "workspace", id: "workspace-1" }, "workingTree");
  });

  it("offers Last turn only with a transcript, and narrows the branch list to it", async () => {
    listChangedFiles.mockResolvedValue([
      { path: "src/a.ts", status: "M", additions: 1, deletions: 0 },
      { path: "src/b.ts", status: "M", additions: 2, deletions: 0 }
    ]);

    const withoutTranscript = renderHook(() => useReviewState(workspaceSource(makeWorkspace())));
    expect(withoutTranscript.result.current.availableScopes).not.toContain("lastTurn");
    withoutTranscript.unmount();

    const { result } = renderHook(() => useReviewState(workspaceSource(makeWorkspace()), ["/abs/repo/src/b.ts"]));
    await waitFor(() => expect(result.current.files).toHaveLength(2));
    expect(result.current.availableScopes).toContain("lastTurn");

    act(() => {
      result.current.setChangesScope("lastTurn");
    });

    // Same git query as "branch", narrowed client-side, so no refetch.
    expect(result.current.files.map((file) => file.path)).toEqual(["src/b.ts"]);
    expect(listChangedFiles).toHaveBeenLastCalledWith({ kind: "workspace", id: "workspace-1" }, "branch");
  });

  it("reloads the diff under the new baseline when the scope changes (cache busted)", async () => {
    listChangedFiles.mockResolvedValue([{ path: "src/a.ts", status: "M", additions: 1, deletions: 0 }]);
    const loadDiff = window.argmax!.review.loadDiff as ReturnType<typeof vi.fn>;
    loadDiff.mockResolvedValue({ workspaceId: "workspace-1", filePath: "src/a.ts", content: "diff" });

    const { result } = renderHook(() => useReviewState(workspaceSource(makeWorkspace())));
    await waitFor(() => expect(listChangedFiles).toHaveBeenCalledTimes(1));

    act(() => {
      result.current.openFile("src/a.ts");
    });
    await waitFor(() => expect(loadDiff).toHaveBeenCalledWith(
      { kind: "workspace", id: "workspace-1" }, "src/a.ts", "branch", undefined
    ));

    act(() => {
      result.current.setChangesScope("uncommitted");
    });

    // The cached branch diff must not be served for the working-tree baseline.
    await waitFor(() => expect(loadDiff).toHaveBeenCalledWith(
      { kind: "workspace", id: "workspace-1" }, "src/a.ts", "workingTree", undefined
    ));
  });

  it("climbs the context ladder and never serves the narrower cached diff", async () => {
    listChangedFiles.mockResolvedValue([{ path: "src/a.ts", status: "M", additions: 1, deletions: 0 }]);
    const loadDiff = window.argmax!.review.loadDiff as ReturnType<typeof vi.fn>;
    loadDiff.mockResolvedValue({ workspaceId: "workspace-1", filePath: "src/a.ts", content: "diff" });

    const { result } = renderHook(() => useReviewState(workspaceSource(makeWorkspace())));
    await waitFor(() => expect(listChangedFiles).toHaveBeenCalledTimes(1));

    act(() => {
      result.current.openFile("src/a.ts");
    });
    await waitFor(() => expect(loadDiff).toHaveBeenCalledWith(
      { kind: "workspace", id: "workspace-1" }, "src/a.ts", "branch", undefined
    ));

    act(() => {
      result.current.expandDiffContext();
    });
    await waitFor(() => expect(loadDiff).toHaveBeenCalledWith(
      { kind: "workspace", id: "workspace-1" }, "src/a.ts", "branch", 25
    ));

    act(() => {
      result.current.expandDiffContext();
    });
    await waitFor(() => expect(loadDiff).toHaveBeenCalledWith(
      { kind: "workspace", id: "workspace-1" }, "src/a.ts", "branch", 100_000
    ));

    // Top of the ladder: another click must not fire a fourth fetch.
    const callsAtFullContext = loadDiff.mock.calls.length;
    act(() => {
      result.current.expandDiffContext();
    });
    await waitFor(() => expect(loadDiff.mock.calls.length).toBe(callsAtFullContext));
  });

  it("drops back to the default context when a different file is opened", async () => {
    listChangedFiles.mockResolvedValue([
      { path: "src/a.ts", status: "M", additions: 1, deletions: 0 },
      { path: "src/b.ts", status: "M", additions: 1, deletions: 0 }
    ]);
    const loadDiff = window.argmax!.review.loadDiff as ReturnType<typeof vi.fn>;
    loadDiff.mockResolvedValue({ workspaceId: "workspace-1", filePath: "src/a.ts", content: "diff" });

    const { result } = renderHook(() => useReviewState(workspaceSource(makeWorkspace())));
    await waitFor(() => expect(listChangedFiles).toHaveBeenCalledTimes(1));

    act(() => {
      result.current.openFile("src/a.ts");
    });
    act(() => {
      result.current.expandDiffContext();
    });
    await waitFor(() => expect(loadDiff).toHaveBeenCalledWith(
      { kind: "workspace", id: "workspace-1" }, "src/a.ts", "branch", 25
    ));

    act(() => {
      result.current.openFile("src/b.ts");
    });
    await waitFor(() => expect(loadDiff).toHaveBeenCalledWith(
      { kind: "workspace", id: "workspace-1" }, "src/b.ts", "branch", undefined
    ));
  });

  it("does not refetch workspace.listFiles when lastActivityAt ticks while in Files mode", async () => {
    // Files-mode list loading also ignores token-level `lastActivityAt` ticks.
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
    await waitFor(() => expect(readWorkspaceFile).toHaveBeenCalledWith(
      { kind: "workspace", id: "workspace-1" }, "src/one.ts"
    ));
    await waitFor(() => expect(result.current.workspaceFiles.buffer).toBe("one\n"));

    act(() => {
      result.current.workspaceFiles.editFile("one edited\n");
      result.current.openInFilesView("src/two.ts");
    });
    await waitFor(() => expect(readWorkspaceFile).toHaveBeenCalledWith(
      { kind: "workspace", id: "workspace-1" }, "src/two.ts"
    ));
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

  it("bounds closed file previews and re-reads an evicted file", async () => {
    readWorkspaceFile.mockImplementation((_target, path) =>
      Promise.resolve({
        kind: "text",
        content: `${path}\n`,
        size: path.length + 1,
        mtimeMs: 10
      })
    );
    const { result } = renderHook(() => useReviewState(workspaceSource(makeWorkspace())));
    await waitFor(() => expect(listChangedFiles).toHaveBeenCalledTimes(1));

    for (let i = 0; i < 13; i++) {
      const path = `src/file-${i}.ts`;
      act(() => {
        result.current.openInFilesView(path);
      });
      await waitFor(() => expect(result.current.workspaceFiles.previewState).toBe("ready"));
      act(() => {
        result.current.workspaceFiles.closeTab(path);
      });
    }
    expect(readWorkspaceFile).toHaveBeenCalledTimes(13);

    act(() => {
      result.current.openInFilesView("src/file-0.ts");
    });
    await waitFor(() => expect(readWorkspaceFile).toHaveBeenCalledTimes(14));
  });

  it("saves rapid edits in order so an older response cannot overwrite the newest buffer", async () => {
    readWorkspaceFile.mockResolvedValue({
      kind: "text",
      content: "original\n",
      size: 9,
      mtimeMs: 10
    });
    let resolveFirst!: (value: { ok: "true"; mtimeMs: number; size: number }) => void;
    let resolveSecond!: (value: { ok: "true"; mtimeMs: number; size: number }) => void;
    writeWorkspaceFile
      .mockImplementationOnce(() => new Promise((resolve) => { resolveFirst = resolve; }))
      .mockImplementationOnce(() => new Promise((resolve) => { resolveSecond = resolve; }));
    const { result } = renderHook(() => useReviewState(workspaceSource(makeWorkspace())));
    await waitFor(() => expect(listChangedFiles).toHaveBeenCalledTimes(1));
    act(() => {
      result.current.openInFilesView("src/rapid.ts");
    });
    await waitFor(() => expect(result.current.workspaceFiles.previewState).toBe("ready"));

    let firstSave!: Promise<void>;
    let secondSave!: Promise<void>;
    act(() => {
      result.current.workspaceFiles.editFile("first\n");
    });
    act(() => {
      firstSave = result.current.workspaceFiles.saveFile();
    });
    act(() => {
      result.current.workspaceFiles.editFile("second\n");
    });
    act(() => {
      secondSave = result.current.workspaceFiles.saveFile();
    });
    await waitFor(() => expect(writeWorkspaceFile).toHaveBeenCalledTimes(1));
    expect(writeWorkspaceFile).toHaveBeenLastCalledWith(
      { kind: "workspace", id: "workspace-1" }, "src/rapid.ts", "first\n", 10
    );

    await act(async () => {
      resolveFirst({ ok: "true", mtimeMs: 11, size: 6 });
      await firstSave;
    });
    await waitFor(() => expect(writeWorkspaceFile).toHaveBeenCalledTimes(2));
    expect(writeWorkspaceFile).toHaveBeenLastCalledWith(
      { kind: "workspace", id: "workspace-1" }, "src/rapid.ts", "second\n", 11
    );
    await act(async () => {
      resolveSecond({ ok: "true", mtimeMs: 12, size: 7 });
      await secondSave;
    });
    expect(result.current.workspaceFiles.buffer).toBe("second\n");
    expect(result.current.workspaceFiles.isDirty).toBe(false);
    expect(result.current.workspaceFiles.diskMtimeMs).toBe(12);
  });

  it("abandons queued saves when a discarded tab is closed and reopened", async () => {
    readWorkspaceFile.mockResolvedValue({
      kind: "text",
      content: "original\n",
      size: 9,
      mtimeMs: 10
    });
    let resolveFirst!: (value: { ok: "true"; mtimeMs: number; size: number }) => void;
    writeWorkspaceFile.mockImplementationOnce(() => new Promise((resolve) => { resolveFirst = resolve; }));
    const { result } = renderHook(() => useReviewState(workspaceSource(makeWorkspace())));
    await waitFor(() => expect(listChangedFiles).toHaveBeenCalledTimes(1));
    act(() => {
      result.current.openInFilesView("src/discarded.ts");
    });
    await waitFor(() => expect(result.current.workspaceFiles.previewState).toBe("ready"));
    act(() => {
      result.current.workspaceFiles.editFile("first\n");
    });
    act(() => {
      void result.current.workspaceFiles.saveFile();
    });
    await waitFor(() => expect(writeWorkspaceFile).toHaveBeenCalledTimes(1));
    act(() => {
      result.current.workspaceFiles.editFile("discarded queued save\n");
    });
    act(() => {
      void result.current.workspaceFiles.saveFile();
      result.current.workspaceFiles.closeTab("src/discarded.ts");
    });
    expect(result.current.workspaceFiles.dirtyClosePrompt?.path).toBe("src/discarded.ts");
    act(() => {
      result.current.workspaceFiles.discardDirtyTabAndClose();
      result.current.openInFilesView("src/discarded.ts");
    });
    await waitFor(() => expect(result.current.workspaceFiles.activeTabPath).toBe("src/discarded.ts"));

    await act(async () => {
      resolveFirst({ ok: "true", mtimeMs: 11, size: 6 });
      await Promise.resolve();
    });
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    expect(writeWorkspaceFile).toHaveBeenCalledTimes(1);
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

    expect(writeWorkspaceFile).toHaveBeenCalledWith(
      { kind: "workspace", id: "workspace-1" }, "src/draft.ts", "saved draft\n", 10
    );
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
      ok: "false",
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

  it.each(["poll", "dismiss"] as const)(
    "ignores a stale stat response after the workspace changes (%s)",
    async (trigger) => {
      readWorkspaceFile.mockResolvedValue({
        kind: "text",
        content: "{}\n",
        size: 3,
        mtimeMs: 10
      });
      let resolveStat!: (value: { mtimeMs: number; size: number }) => void;
      statWorkspaceFile.mockReturnValueOnce(
        new Promise((resolve) => {
          resolveStat = resolve;
        })
      );

      const { result, rerender } = renderHook(
        ({ ws }: { ws: WorkspaceSummary }) => useReviewState(workspaceSource(ws)),
        { initialProps: { ws: makeWorkspace({ id: "workspace-1" }) } }
      );
      await waitFor(() => expect(listChangedFiles).toHaveBeenCalledTimes(1));
      act(() => {
        result.current.openInFilesView("package.json");
      });
      await waitFor(() => expect(result.current.workspaceFiles.previewState).toBe("ready"));

      if (trigger === "poll") {
        act(() => {
          window.dispatchEvent(new Event("focus"));
        });
      } else {
        act(() => {
          result.current.workspaceFiles.dismissExternalChange();
        });
      }
      await waitFor(() => expect(statWorkspaceFile).toHaveBeenCalled());

      rerender({ ws: makeWorkspace({ id: "workspace-2" }) });
      act(() => {
        result.current.openInFilesView("package.json");
      });
      await waitFor(() => expect(result.current.workspaceFiles.previewState).toBe("ready"));

      await act(async () => {
        resolveStat({ mtimeMs: 99, size: 3 });
        await Promise.resolve();
      });

      expect(result.current.workspaceFiles.externalChange).toBe(false);
      expect(result.current.workspaceFiles.diskMtimeMs).toBe(10);
    }
  );

  it("uses the dismissed on-disk mtime as the save baseline", async () => {
    readWorkspaceFile.mockResolvedValue({
      kind: "text",
      content: "pkg\n",
      size: 4,
      mtimeMs: 10
    });
    statWorkspaceFile.mockResolvedValue({ mtimeMs: 20, size: 4 });

    const { result } = renderHook(() => useReviewState(workspaceSource(makeWorkspace())));
    await waitFor(() => expect(listChangedFiles).toHaveBeenCalledTimes(1));
    act(() => {
      result.current.openInFilesView("package.json");
    });
    await waitFor(() => expect(result.current.workspaceFiles.previewState).toBe("ready"));

    act(() => {
      result.current.workspaceFiles.dismissExternalChange();
    });
    await waitFor(() => expect(result.current.workspaceFiles.diskMtimeMs).toBe(20));

    act(() => {
      result.current.workspaceFiles.editFile("edited\n");
    });
    await act(async () => {
      await result.current.workspaceFiles.saveFile();
    });

    expect(writeWorkspaceFile).toHaveBeenCalledWith(
      { kind: "workspace", id: "workspace-1" },
      "package.json",
      "edited\n",
      20
    );
  });

  it("edits and saves project files from the launcher review state", async () => {
    const { result } = renderHook(() => useReviewState(projectSource(makeProject())));

    await waitFor(() => expect(result.current.filesState).toBe("ready"));
    act(() => {
      result.current.openInFilesView("src/project.ts");
    });
    await waitFor(() => expect(readProjectFile).toHaveBeenCalledWith(
      { kind: "project", id: "project-1" },
      "src/project.ts"
    ));
    await waitFor(() => expect(result.current.workspaceFiles.previewState).toBe("ready"));

    expect(result.current.workspaceFiles.canEdit).toBe(true);
    act(() => {
      result.current.workspaceFiles.editFile("mutated\n");
    });
    expect(result.current.workspaceFiles.buffer).toBe("mutated\n");
    expect(result.current.workspaceFiles.isDirty).toBe(true);

    await act(async () => {
      await result.current.workspaceFiles.saveFile();
    });

    expect(writeProjectFile).toHaveBeenCalledWith(
      { kind: "project", id: "project-1" },
      "src/project.ts",
      "mutated\n",
      10
    );
    expect(result.current.workspaceFiles.isDirty).toBe(false);
  });

  it("keeps an open Files panel open across a project switch", async () => {
    // Picking another project from the palette while browsing files must
    // re-target the view in place, not dump the user back to the launcher.
    const { result, rerender } = renderHook(
      ({ source }: { source: ReviewSource }) => useReviewState(source),
      { initialProps: { source: projectSource(makeProject()) } }
    );

    act(() => {
      result.current.openPanelInFilesMode();
    });
    expect(result.current.isPanelOpen).toBe(true);
    expect(result.current.mode).toBe("files");

    rerender({ source: projectSource(makeProject({ id: "project-2", name: "Other" })) });

    await waitFor(() => expect(result.current.isPanelOpen).toBe(true));
    expect(result.current.mode).toBe("files");
  });

  it("still resets a closed panel's mode when the source changes", async () => {
    const { result, rerender } = renderHook(
      ({ source }: { source: ReviewSource }) => useReviewState(source),
      { initialProps: { source: projectSource(makeProject()) } }
    );

    act(() => {
      result.current.openPanelInFilesMode();
    });
    act(() => {
      result.current.closePanel();
    });

    rerender({ source: projectSource(makeProject({ id: "project-2", name: "Other" })) });
    // Each source change kicks off a fresh diff read; settle them inside act
    // so the state they set lands during the test rather than after it.
    await act(async () => {});

    expect(result.current.isPanelOpen).toBe(false);
    expect(result.current.mode).toBe("changes");
  });
});
