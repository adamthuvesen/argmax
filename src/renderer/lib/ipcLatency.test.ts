import { afterEach, describe, expect, it } from "vitest";
import {
  ipcLatencySnapshot,
  RING_CAPACITY,
  recordIpcLatency,
  resetIpcLatency,
  timeIpcCall,
} from "./ipcLatency.js";

afterEach(resetIpcLatency);

describe("ipcLatency", () => {
  it("reads percentiles over the most recent calls only", () => {
    for (let ms = 0; ms < RING_CAPACITY * 2; ms += 1) recordIpcLatency("ch", ms);

    const [stat] = ipcLatencySnapshot();
    expect(stat).toMatchObject({ channel: "ch", count: RING_CAPACITY, totalRecorded: 200 });
    // Samples 100..199 remain; the early low values are gone.
    expect(stat?.p50).toBe(150);
    expect(stat?.p99).toBe(198);
    expect(stat?.max).toBe(199);
  });

  it("lists the slowest p99 first", () => {
    recordIpcLatency("fast", 1);
    recordIpcLatency("slow", 90);

    expect(ipcLatencySnapshot().map((stat) => stat.channel)).toEqual(["slow", "fast"]);
  });

  it("times a rejected call and returns the original rejection", async () => {
    const failure = new Error("boom");

    await expect(timeIpcCall("bad", () => Promise.reject(failure))).rejects.toBe(failure);
    await Promise.resolve();

    expect(ipcLatencySnapshot()[0]).toMatchObject({ channel: "bad", totalRecorded: 1 });
  });
});
