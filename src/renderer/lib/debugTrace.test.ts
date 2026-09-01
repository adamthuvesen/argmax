import { describe, expect, it } from "vitest";
import type { RawProviderOutput, TimelineEvent } from "../../shared/types.js";
import {
  buildTraceRows,
  filterTraceRows,
  formatDelta,
  formatLatency,
  summarizeProtocolLine,
  traceLabels
} from "./debugTrace.js";

function event(id: string, type: string, createdAt: string, message = ""): TimelineEvent {
  return { id, sessionId: "s1", type: type as TimelineEvent["type"], message, payload: {}, createdAt };
}

function raw(id: string, content: string, createdAt: string, stream: RawProviderOutput["stream"] = "stdout"): RawProviderOutput {
  return { id, sessionId: "s1", stream, content, createdAt };
}

describe("buildTraceRows", () => {
  it("interleaves events and raw output in time order", () => {
    const rows = buildTraceRows(
      [event("e1", "assistant.message", "2026-09-01T10:00:01.000Z")],
      [raw("r1", "first", "2026-09-01T10:00:00.000Z"), raw("r2", "third", "2026-09-01T10:00:02.000Z")]
    );

    expect(rows.map((row) => row.id)).toEqual(["raw:r1:0", "event:e1", "raw:r2:0"]);
  });

  it("splits a multi-line chunk into one row per line and skips blanks", () => {
    const rows = buildTraceRows([], [raw("r1", '{"type":"system"}\n\n{"type":"result"}\n', "2026-09-01T10:00:00.000Z")]);

    expect(rows.map((row) => row.summary)).toEqual(["system", "result"]);
  });

  it("reports the gap to the previous row so stalls are visible", () => {
    const rows = buildTraceRows(
      [],
      [raw("r1", "a", "2026-09-01T10:00:00.000Z"), raw("r2", "b", "2026-09-01T10:00:03.500Z")]
    );

    expect(rows[0]?.deltaMs).toBe(0);
    expect(rows[1]?.deltaMs).toBe(3500);
  });

  it("keeps the verbatim line for copying even when the summary redacts it", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "thinking", thinking: "long private reasoning" }] }
    });
    const [row] = buildTraceRows([], [raw("r1", line, "2026-09-01T10:00:00.000Z")]);

    expect(row?.summary).toBe("assistant · thinking block hidden");
    expect(row?.summary).not.toContain("long private reasoning");
    expect(row?.raw).toBe(line);
    expect(row?.detail).toContain("long private reasoning");
  });
});

describe("filterTraceRows", () => {
  const rows = buildTraceRows(
    [event("e1", "assistant.message", "2026-09-01T10:00:01.000Z", "hello there")],
    [raw("r1", "boom", "2026-09-01T10:00:00.000Z", "stderr")]
  );

  it("filters by source", () => {
    expect(filterTraceRows(rows, { source: "event", label: "all", query: "" })).toHaveLength(1);
    expect(filterTraceRows(rows, { source: "raw", label: "all", query: "" })).toHaveLength(1);
  });

  it("filters by label and by case-insensitive search", () => {
    expect(filterTraceRows(rows, { source: "all", label: "stderr", query: "" })).toHaveLength(1);
    expect(filterTraceRows(rows, { source: "all", label: "all", query: "HELLO" })).toHaveLength(1);
    expect(filterTraceRows(rows, { source: "all", label: "all", query: "nothing" })).toHaveLength(0);
  });

  it("lists labels scoped to the active source", () => {
    expect(traceLabels(rows, "all")).toEqual(["assistant.message", "stderr"]);
    expect(traceLabels(rows, "raw")).toEqual(["stderr"]);
  });
});

describe("summarizeProtocolLine", () => {
  it("returns null for text that is not protocol JSON", () => {
    expect(summarizeProtocolLine("plain stderr line")).toBeNull();
    expect(summarizeProtocolLine("{}")).toBeNull();
  });

  it("names the tools in a tool_use turn", () => {
    const line = JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Bash" }] } });
    expect(summarizeProtocolLine(line)).toBe("assistant · tool_use Bash");
  });

  it("includes the subtype", () => {
    expect(summarizeProtocolLine(JSON.stringify({ type: "system", subtype: "init" }))).toBe("system · init");
  });
});

describe("formatters", () => {
  it("formats gaps and latencies at readable precision", () => {
    expect(formatDelta(0)).toBe("—");
    expect(formatDelta(320)).toBe("320ms");
    expect(formatDelta(3500)).toBe("3.5s");
    expect(formatLatency(0.4)).toBe("400µs");
    expect(formatLatency(12.34)).toBe("12.3ms");
    expect(formatLatency(240.6)).toBe("241ms");
  });
});
