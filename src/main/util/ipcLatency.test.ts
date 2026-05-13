// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readHistogram, recordSample, resetHistogramForTesting, timed } from "./ipcLatency.js";

describe("ipcLatency histogram", () => {
  beforeEach(() => {
    resetHistogramForTesting();
  });

  it("computes p50 / p99 across a synthetic distribution", () => {
    // Insert 100 ascending samples — p50 should be near the 50th, p99 near
    // the 99th. Percentile uses ceiling-rank so 50% of 100 = 50, value at
    // index 49 (zero-based) = 50.
    for (let i = 1; i <= 100; i++) {
      recordSample("test:channel", i);
    }
    const stats = readHistogram();
    expect(stats).toHaveLength(1);
    expect(stats[0]?.channel).toBe("test:channel");
    expect(stats[0]?.count).toBe(100);
    expect(stats[0]?.p50).toBe(50);
    expect(stats[0]?.p99).toBe(99);
    expect(stats[0]?.totalRecorded).toBe(100);
  });

  it("rolls the window to keep at most 100 samples per channel", () => {
    for (let i = 1; i <= 150; i++) {
      recordSample("test:channel", i);
    }
    const stats = readHistogram();
    expect(stats[0]?.count).toBe(100);
    expect(stats[0]?.totalRecorded).toBe(150);
    // The first 50 samples (values 1..50) should have dropped off; the
    // remaining window holds 51..150. p50 of that window = 100.
    expect(stats[0]?.p50).toBe(100);
  });

  it("tracks multiple channels independently and sorts results", () => {
    recordSample("b:channel", 10);
    recordSample("a:channel", 20);
    recordSample("c:channel", 30);
    const stats = readHistogram();
    expect(stats.map((s) => s.channel)).toEqual(["a:channel", "b:channel", "c:channel"]);
  });

  it("timed() wraps a handler and records both success and failure paths", async () => {
    const successful = timed("ok:channel", () => Promise.resolve("done"));
    await successful(null);

    const failing = timed("err:channel", () => Promise.reject(new Error("boom")));
    await expect(failing(null)).rejects.toThrow("boom");

    const stats = readHistogram();
    const okChannel = stats.find((s) => s.channel === "ok:channel");
    const errChannel = stats.find((s) => s.channel === "err:channel");
    expect(okChannel?.count).toBe(1);
    expect(errChannel?.count).toBe(1);
  });

  it("timed() forwards positional args + the event arg through to the handler", async () => {
    const handler = vi.fn((_event: unknown, a: number, b: number) => Promise.resolve(a + b));
    const wrapped = timed("sum:channel", handler);
    const result = await wrapped(null, 2, 3);
    expect(result).toBe(5);
    expect(handler).toHaveBeenCalledWith(null, 2, 3);
  });
});
