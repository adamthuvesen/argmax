import { act, cleanup, render, renderHook, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Learning, ProjectSummary, WorkspaceFileStat } from "../../shared/types.js";
import { ProjectKnowledgePanel } from "../components/ProjectKnowledgePanel.js";
import { useBridgeQuery } from "./useBridgeQuery.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function installBridge(bridge: unknown): void {
  Object.defineProperty(window, "argmax", { configurable: true, writable: true, value: bridge });
}

describe("useBridgeQuery", () => {
  beforeEach(() => installBridge({}));

  afterEach(() => {
    cleanup();
    delete (window as unknown as { argmax?: unknown }).argmax;
  });

  it("reads once on mount and reports the reply", async () => {
    const read = vi.fn().mockResolvedValue({ ok: true });
    const { result } = renderHook(() => useBridgeQuery({ key: ["k"], read }));
    expect(result.current.isLoading).toBe(true);
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(read).toHaveBeenCalledTimes(1);
    expect(result.current.data).toEqual({ ok: true });
    expect(result.current.error).toBeNull();
  });

  it("reports a rejected read and clears the error when a refetch succeeds", async () => {
    const read = vi.fn().mockRejectedValueOnce(new Error("flaky")).mockResolvedValueOnce({ ok: true });
    const { result } = renderHook(() => useBridgeQuery({ key: ["k"], read }));
    await waitFor(() => expect(result.current.error).toBe("flaky"));
    await act(async () => {
      await result.current.refetch();
    });
    expect(result.current.error).toBeNull();
    expect(result.current.data).toEqual({ ok: true });
  });

  it("does not read and reports no bridge outside the host", () => {
    delete (window as unknown as { argmax?: unknown }).argmax;
    const read = vi.fn();
    const { result } = renderHook(() => useBridgeQuery({ key: ["k"], read }));
    expect(read).not.toHaveBeenCalled();
    expect(result.current.isAvailable).toBe(false);
    expect(result.current.isLoading).toBe(false);
  });

  it("drops a reply whose key changed, and shows no old data for the new key", async () => {
    const replies = { a: deferred<string>(), b: deferred<string>() };
    const onData = vi.fn();
    const { result, rerender } = renderHook(
      ({ id }: { id: "a" | "b" }) => useBridgeQuery({ key: ["k", id], read: () => replies[id].promise, onData }),
      { initialProps: { id: "a" as "a" | "b" } }
    );
    rerender({ id: "b" });
    expect(result.current.isLoading).toBe(true);
    await act(async () => {
      replies.b.resolve("for b");
      await replies.b.promise;
    });
    expect(result.current.data).toBe("for b");
    await act(async () => {
      replies.a.resolve("for a");
      await replies.a.promise;
    });
    expect(result.current.data).toBe("for b");
    expect(onData).toHaveBeenCalledTimes(1);

    rerender({ id: "a" });
    expect(result.current.data).toBeNull();
  });

  it("drops a rejection whose key changed", async () => {
    const stale = deferred<string>();
    const onError = vi.fn();
    const { result, rerender } = renderHook(
      ({ id }: { id: string }) =>
        useBridgeQuery({ key: [id], read: () => (id === "a" ? stale.promise : Promise.resolve("b")), onError }),
      { initialProps: { id: "a" } }
    );
    rerender({ id: "b" });
    await waitFor(() => expect(result.current.data).toBe("b"));
    await act(async () => {
      stale.reject(new Error("too late"));
      await stale.promise.catch(() => undefined);
    });
    expect(result.current.error).toBeNull();
    expect(onError).not.toHaveBeenCalled();
  });

  it("lets only the newest of two overlapping reads land", async () => {
    const first = deferred<string>();
    const second = deferred<string>();
    const read = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const { result } = renderHook(() => useBridgeQuery({ key: ["k"], read }));
    let refetchResult: unknown;
    const refetching = act(async () => {
      refetchResult = await result.current.refetch();
    });
    second.resolve("newer");
    await refetching;
    expect(refetchResult).toEqual({ status: "data", data: "newer" });
    await act(async () => {
      first.resolve("older");
      await first.promise;
    });
    expect(result.current.data).toBe("newer");
  });

  it("drops a reply that arrives after unmount", async () => {
    const reply = deferred<string>();
    const onData = vi.fn();
    const { unmount } = renderHook(() => useBridgeQuery({ key: ["k"], read: () => reply.promise, onData }));
    unmount();
    reply.resolve("too late");
    await reply.promise;
    await Promise.resolve();
    expect(onData).not.toHaveBeenCalled();
  });

  it("isCurrent turns false for a handler from an earlier key", async () => {
    const { result, rerender } = renderHook(
      ({ id }: { id: string }) => useBridgeQuery({ key: [id], read: () => Promise.resolve(id) }),
      { initialProps: { id: "a" } }
    );
    await waitFor(() => expect(result.current.data).toBe("a"));
    const handlerFromA = result.current;
    expect(handlerFromA.isCurrent()).toBe(true);
    rerender({ id: "b" });
    await waitFor(() => expect(result.current.data).toBe("b"));
    expect(handlerFromA.isCurrent()).toBe(false);
    act(() => handlerFromA.setData(() => "write for a"));
    expect(result.current.data).toBe("b");
  });

  it("drops an earlier page after the first page reloads, even with enabled off", async () => {
    const page = deferred<string>();
    const onData = vi.fn();
    const { result, rerender } = renderHook(
      ({ revision }: { revision: number }) =>
        useBridgeQuery({ key: ["earlier", revision], enabled: false, read: () => page.promise, onData }),
      { initialProps: { revision: 0 } }
    );
    expect(result.current.isLoading).toBe(false);
    act(() => void result.current.refetch());
    expect(result.current.isLoading).toBe(true);
    rerender({ revision: 1 });
    expect(result.current.isLoading).toBe(false);
    await act(async () => {
      page.resolve("old page");
      await page.promise;
    });
    expect(onData).not.toHaveBeenCalled();
  });

  // Replay of c92af94e. The review panel refreshed a file's stat, a read or save
  // of that file finished first, and the older stat then overwrote the newer
  // mtime. It needed a second token map. Here the local write replaces the read.
  it("c92af94e: a stat reply cannot land over a newer local write or after the file closes", async () => {
    const statReply = deferred<WorkspaceFileStat>();
    const statFile = vi.fn().mockReturnValue(statReply.promise);
    installBridge({ workspace: { statFile } });
    const useStat = (path: string) =>
      useBridgeQuery<WorkspaceFileStat>({
        key: ["workspace.statFile", path],
        read: (api) => api.workspace.statFile({ kind: "workspace", id: "w" }, path)
      });
    const { result, rerender } = renderHook(({ path }: { path: string }) => useStat(path), {
      initialProps: { path: "a.ts" }
    });
    const saved = { mtimeMs: 200 } as unknown as WorkspaceFileStat;
    act(() => result.current.setData(() => saved));
    await act(async () => {
      statReply.resolve({ mtimeMs: 100 } as WorkspaceFileStat);
      await statReply.promise;
    });
    expect(result.current.data).toBe(saved);

    const closedReply = deferred<WorkspaceFileStat>();
    statFile.mockReturnValueOnce(closedReply.promise);
    statFile.mockReturnValue(new Promise<WorkspaceFileStat>(() => undefined));
    act(() => void result.current.refetch());
    rerender({ path: "b.ts" });
    await act(async () => {
      closedReply.resolve({ mtimeMs: 300 } as WorkspaceFileStat);
      await closedReply.promise;
    });
    expect(result.current.data).toBeNull();
  });

  // Replay of c05f38d1, through the real panel. Before that fix the panel called
  // `learnings.list` in an effect with no guard, so project A's reply landed on
  // project B after a switch.
  it("c05f38d1: project A's learnings do not land after switching to project B", async () => {
    const replies = { a: deferred<Learning[]>(), b: deferred<Learning[]>() };
    const list = vi.fn(({ projectId }: { projectId: string }) => replies[projectId as "a" | "b"].promise);
    installBridge({ learnings: { list } });
    const projectA = { id: "a", name: "A" } as ProjectSummary;
    const projectB = { id: "b", name: "B" } as ProjectSummary;
    const learning = (id: string, summary: string) =>
      ({ id, summary, verified: false, projectId: id, kind: "fact", createdAt: "", updatedAt: "" }) as unknown as Learning;

    const { rerender } = render(<ProjectKnowledgePanel projects={[projectA]} />);
    rerender(<ProjectKnowledgePanel projects={[projectB]} />);
    await waitFor(() => expect(list).toHaveBeenCalledWith({ projectId: "b" }));
    await act(async () => {
      replies.b.resolve([learning("b1", "From project B")]);
      await replies.b.promise;
    });
    await act(async () => {
      replies.a.resolve([learning("a1", "From project A")]);
      await replies.a.promise;
    });
    expect(screen.getByDisplayValue("From project B")).toBeInTheDocument();
    expect(screen.queryByDisplayValue("From project A")).not.toBeInTheDocument();
  });
});
