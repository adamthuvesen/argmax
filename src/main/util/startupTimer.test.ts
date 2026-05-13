// @vitest-environment node
import { beforeEach, describe, expect, it } from "vitest";
import { mark, readPhases, resetPhasesForTesting } from "./startupTimer.js";

describe("startupTimer", () => {
  beforeEach(() => {
    resetPhasesForTesting();
  });

  it("records the boot phase at module load", () => {
    const phases = readPhases();
    expect(phases[0]?.phase).toBe("boot");
    expect(phases[0]?.elapsedMs).toBe(0);
    expect(phases[0]?.deltaMs).toBe(0);
  });

  it("mark() appends a phase with monotonically-increasing elapsedMs", () => {
    mark("db.open");
    mark("services.construct");
    mark("ipc.register");

    const phases = readPhases();
    expect(phases.map((p) => p.phase)).toEqual([
      "boot",
      "db.open",
      "services.construct",
      "ipc.register"
    ]);
    for (let i = 1; i < phases.length; i++) {
      const here = phases[i];
      const prev = phases[i - 1];
      if (!here || !prev) throw new Error("phases slice out of range");
      expect(here.elapsedMs).toBeGreaterThanOrEqual(prev.elapsedMs);
    }
  });

  it("deltaMs reflects the time since the previous mark", () => {
    const a = mark("db.open");
    const b = mark("services.construct");
    expect(b.deltaMs).toBeGreaterThanOrEqual(0);
    expect(b.elapsedMs - a.elapsedMs).toBeCloseTo(b.deltaMs, 1);
  });

  it("returns the same shape as the latest snapshot from readPhases()", () => {
    const record = mark("window.ready-to-show");
    const last = readPhases().at(-1);
    expect(last).toEqual(record);
  });
});
