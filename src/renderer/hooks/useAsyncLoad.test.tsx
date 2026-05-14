import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
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

  it("returns the missingApiMessage when window.argmax is absent", async () => {
    delete (window as unknown as { argmax?: unknown }).argmax;
    const fetcher = vi.fn();

    const { result } = renderHook(() =>
      useAsyncLoad(fetcher, { missingApiMessage: "Open the Electron host." })
    );

    await waitFor(() => expect(result.current.error).toBe("Open the Electron host."));
    expect(fetcher).not.toHaveBeenCalled();
  });
});
