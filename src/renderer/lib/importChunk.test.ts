// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { importChunk } from "./importChunk.js";

const reload = vi.fn();

beforeEach(() => {
  reload.mockClear();
  window.sessionStorage.clear();
  Object.defineProperty(window, "location", {
    configurable: true,
    value: { reload }
  });
});

/** A chunk whose hash the running bundle no longer has. */
function missingChunk(): Promise<string> {
  return Promise.reject(
    new TypeError("Failed to load module script: expected JavaScript, got text/html")
  );
}

/** Let the rejected load and the recovery behind it run. */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * Start a load that cannot succeed and let the recovery run. The pending
 * promise stays here on purpose: returning it from an async function would
 * adopt a promise that never settles.
 */
async function loadMissingChunk(): Promise<void> {
  void importChunk(missingChunk);
  await flush();
}

describe("importChunk", () => {
  it("reloads the page when the chunk has gone missing", async () => {
    const pending = importChunk(missingChunk);
    await flush();

    expect(reload).toHaveBeenCalledTimes(1);
    // Pending on purpose: the caller keeps showing its fallback rather than
    // rendering against the bundle that just failed.
    const settled = await Promise.race([
      pending.then(() => "settled"),
      flush().then(() => "pending")
    ]);
    expect(settled).toBe("pending");
  });

  it("gives up after one reload so a broken chunk still surfaces", async () => {
    await loadMissingChunk();

    await expect(importChunk(missingChunk)).rejects.toThrow(/text\/html/);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("re-arms once a chunk loads, so the next stale bundle recovers too", async () => {
    await loadMissingChunk();
    await expect(importChunk(() => Promise.resolve("loaded"))).resolves.toBe("loaded");

    await loadMissingChunk();
    expect(reload).toHaveBeenCalledTimes(2);
  });

  it("passes a loaded chunk straight through", async () => {
    await expect(importChunk(() => Promise.resolve({ default: 1 }))).resolves.toEqual({
      default: 1
    });
    expect(reload).not.toHaveBeenCalled();
  });
});
