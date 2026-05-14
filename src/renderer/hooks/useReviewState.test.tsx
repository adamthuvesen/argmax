import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ArgmaxApi, WorkspaceSummary } from "../../shared/types.js";
import { useReviewState, type ReviewSource } from "./useReviewState.js";

function workspaceSource(workspace: WorkspaceSummary): ReviewSource {
  return { kind: "workspace", workspace };
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

describe("useReviewState — IPC fan-out resistance", () => {
  let listChangedFiles: ReturnType<typeof vi.fn<ArgmaxApi["review"]["listChangedFiles"]>>;
  let listWorkspaceFiles: ReturnType<typeof vi.fn<ArgmaxApi["workspace"]["listFiles"]>>;

  beforeEach(() => {
    listChangedFiles = vi
      .fn<ArgmaxApi["review"]["listChangedFiles"]>()
      .mockResolvedValue([]);
    listWorkspaceFiles = vi
      .fn<ArgmaxApi["workspace"]["listFiles"]>()
      .mockResolvedValue([]);

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
          readFile: vi.fn(),
          writeFile: vi.fn(),
          statFile: vi.fn(),
          listFilesForProject: vi.fn().mockResolvedValue([]),
          readFileForProject: vi.fn(),
          writeFileForProject: vi.fn(),
          statFileForProject: vi.fn()
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
    // caused ~1 IPC roundtrip per token. Fix: depend on a stable signal
    // (workspace.id + changedFiles count).
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
});
