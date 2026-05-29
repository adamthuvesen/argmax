import { act, cleanup, render, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ArgmaxApi } from "../../shared/types.js";
import { useAsyncLoad } from "./useAsyncLoad.js";

describe("useAsyncLoad", () => {
  beforeEach(() => {
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

  it("loads the resolving fetcher exactly once on mount", async () => {
    const fetcher = vi.fn().mockResolvedValue({ ok: true });

    const { result } = renderHook(() => useAsyncLoad(fetcher));

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(result.current.data).toEqual({ ok: true });
    expect(result.current.error).toBeNull();
  });

  it("surfaces a rejecting fetcher's error message", async () => {
    const fetcher = vi.fn().mockRejectedValue(new Error("nope"));

    const { result } = renderHook(() => useAsyncLoad(fetcher));

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.error).toBe("nope");
    expect(result.current.data).toBeNull();
  });

  it("retry refires the fetcher and clears stale errors first", async () => {
    const fetcher = vi
      .fn()
      .mockRejectedValueOnce(new Error("flaky"))
      .mockResolvedValueOnce({ ok: true });

    const { result } = renderHook(() => useAsyncLoad(fetcher));

    await waitFor(() => expect(result.current.error).toBe("flaky"));

    await act(async () => {
      await result.current.retry();
    });

    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(result.current.data).toEqual({ ok: true });
    expect(result.current.error).toBeNull();
  });

  it("ignores a slow first request when retry resolves first (audit-close H1)", async () => {
    let resolveFirst: (value: { tag: string }) => void = () => undefined;
    const fetcher = vi
      .fn<() => Promise<{ tag: string }>>()
      .mockReturnValueOnce(new Promise((r) => { resolveFirst = r; }))
      .mockResolvedValueOnce({ tag: "fresh" });

    const { result } = renderHook(() => useAsyncLoad(fetcher));

    // First call is pending. Retry kicks off the second call, which resolves
    // first because the first one is still parked.
    await act(async () => {
      await result.current.retry();
    });

    await waitFor(() => expect(result.current.data).toEqual({ tag: "fresh" }));

    // Resolve the stale first call. It should NOT clobber the fresh data.
    await act(async () => {
      resolveFirst({ tag: "stale" });
      await Promise.resolve();
    });

    expect(result.current.data).toEqual({ tag: "fresh" });
  });

  it("retry invokes the latest fetcher closure, not the mount-time one (audit-close H2)", async () => {
    const calls: string[] = [];
    function Probe({ tag }: { tag: string }): null {
      const state = useAsyncLoad(() => {
        calls.push(tag);
        return Promise.resolve(tag);
      });
      probeStateRef.current = state;
      return null;
    }
    const probeStateRef: { current: ReturnType<typeof useAsyncLoad<string>> | null } = { current: null };

    const { rerender } = render(<Probe tag="alpha" />);
    await waitFor(() => expect(calls).toEqual(["alpha"]));

    rerender(<Probe tag="beta" />);
    await act(async () => {
      await probeStateRef.current!.retry();
    });

    // Retry should have called the *current* fetcher, which closes over "beta".
    expect(calls).toEqual(["alpha", "beta"]);
  });

  it("returns the missingApiMessage when window.argmax is absent", async () => {
    delete (window as unknown as { argmax?: unknown }).argmax;
    const fetcher = vi.fn();

    const { result } = renderHook(() =>
      useAsyncLoad(fetcher, { missingApiMessage: "Open the Tauri host." })
    );

    await waitFor(() => expect(result.current.error).toBe("Open the Tauri host."));
    expect(fetcher).not.toHaveBeenCalled();
  });
});
