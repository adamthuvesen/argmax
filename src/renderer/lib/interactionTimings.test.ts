// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { beginInteraction, markInteractionShown } from "./interactionTimings.js";
import { timeIpcCall } from "./ipcLatency.js";

function interactions(): Array<Record<string, unknown>> {
  return window.__argmaxPerf?.interactions() as Array<Record<string, unknown>>;
}

describe("interaction timings", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    window.__argmaxPerf?.clear();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("records shown, painted and settled after the page goes quiet", async () => {
    const handle = beginInteraction("page.test", { visit: "first" });
    await vi.advanceTimersByTimeAsync(40);
    handle.shown();
    await vi.advanceTimersByTimeAsync(400);

    const [record] = interactions();
    expect(record).toMatchObject({ name: "page.test", detail: { visit: "first" } });
    expect(record.shownMs).toBeGreaterThanOrEqual(40);
    expect(record.paintedMs as number).toBeGreaterThanOrEqual(record.shownMs as number);
    expect(record.settledMs as number).toBeGreaterThanOrEqual(record.paintedMs as number);
  });

  it("waits for in-flight IPC before it settles and counts the calls", async () => {
    let resolveCall: () => void = () => undefined;
    const handle = beginInteraction("chat.test");
    handle.shown();
    void timeIpcCall(
      "review:list-changed-files",
      () => new Promise<void>((resolve) => (resolveCall = resolve)),
    );
    await vi.advanceTimersByTimeAsync(1000);
    expect(interactions()).toHaveLength(0);

    resolveCall();
    await vi.advanceTimersByTimeAsync(400);
    expect(interactions()[0]).toMatchObject({ name: "chat.test", ipcCalls: 1 });
    expect(interactions()[0].settledMs as number).toBeGreaterThanOrEqual(1000);
  });

  it("does not wait for an IPC call that was already in flight when it began", async () => {
    void timeIpcCall("session:suggest-follow-up", () => new Promise<void>(() => undefined));

    const handle = beginInteraction("palette.test");
    handle.shown();
    await vi.advanceTimersByTimeAsync(400);

    expect(interactions()[0]).toMatchObject({ name: "palette.test", ipcCalls: 0 });
    expect(interactions()[0].timedOut).toBeUndefined();
  });

  it("drops an interaction that never shows anything", async () => {
    beginInteraction("input.noop");
    await vi.advanceTimersByTimeAsync(11_000);

    expect(interactions()).toHaveLength(0);
  });

  it("matches shown calls to the target the interaction began for", async () => {
    beginInteraction("chat.switch", { target: "a" });
    markInteractionShown("chat.switch", "b");
    await vi.advanceTimersByTimeAsync(400);
    expect(interactions()).toHaveLength(0);

    markInteractionShown("chat.switch", "a");
    await vi.advanceTimersByTimeAsync(400);
    expect(interactions()).toHaveLength(1);
  });
});
