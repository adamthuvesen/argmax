// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DashboardDelta } from "../../shared/types.js";
import { DeltaCoalescer, mergeDeltas } from "./deltaCoalescer.js";

function mkSession(id: string, lastActivityAt = "2026-05-14T00:00:00.000Z"): DashboardDelta["sessions"] {
  return [
    {
      id,
      workspaceId: `workspace-${id}`,
      provider: "claude",
      modelLabel: "Claude Haiku 4.5",
      modelId: "claude-haiku-4-5",
      permissionMode: "auto-approve",
      providerConversationId: null,
      prompt: "prompt",
      state: "running",
      attention: "normal",
      startedAt: "2026-05-14T00:00:00.000Z",
      completedAt: null,
      lastActivityAt,
      preferred: false
    }
  ];
}

describe("DeltaCoalescer", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("flushes at most once per interval window", () => {
    const sent = vi.fn();
    const coalescer = new DeltaCoalescer(sent, 16);

    coalescer.publish({ sessions: mkSession("s1") });
    coalescer.publish({ sessions: mkSession("s1", "2026-05-14T00:00:01.000Z") });
    coalescer.publish({ sessions: mkSession("s1", "2026-05-14T00:00:02.000Z") });

    expect(sent).not.toHaveBeenCalled();
    vi.advanceTimersByTime(16);
    expect(sent).toHaveBeenCalledTimes(1);
    // Concatenated by mergeDeltas — renderer's mergeDashboardDelta dedupes.
    const flushed = sent.mock.calls[0][0] as DashboardDelta;
    expect(flushed.sessions).toHaveLength(3);
  });

  it("100 publishes in one tick produce a single send", () => {
    const sent = vi.fn();
    const coalescer = new DeltaCoalescer(sent, 16);

    for (let i = 0; i < 100; i++) {
      coalescer.publish({ sessions: mkSession("s1", `2026-05-14T00:00:${String(i).padStart(2, "0")}.000Z`) });
    }

    expect(sent).not.toHaveBeenCalled();
    vi.advanceTimersByTime(16);
    expect(sent).toHaveBeenCalledTimes(1);
  });

  it("flushNow() drains the buffer immediately", () => {
    const sent = vi.fn();
    const coalescer = new DeltaCoalescer(sent, 16);

    coalescer.publish({ sessions: mkSession("s1") });
    coalescer.flushNow();
    expect(sent).toHaveBeenCalledTimes(1);

    // Subsequent flushNow with no pending data is a no-op.
    coalescer.flushNow();
    expect(sent).toHaveBeenCalledTimes(1);
  });
});

describe("mergeDeltas", () => {
  it("concats arrays per slice", () => {
    const a: DashboardDelta = { sessions: mkSession("s1") };
    const b: DashboardDelta = { sessions: mkSession("s2") };
    const merged = mergeDeltas(a, b);
    expect(merged.sessions).toHaveLength(2);
    expect(merged.sessions?.map((s) => s.id)).toEqual(["s1", "s2"]);
  });

  it("preserves slices that only appear on one side", () => {
    const a: DashboardDelta = { sessions: mkSession("s1") };
    const b: DashboardDelta = { workspaces: [] };
    const merged = mergeDeltas(a, b);
    expect(merged.sessions).toHaveLength(1);
    expect(merged.workspaces).toEqual([]);
  });
});
