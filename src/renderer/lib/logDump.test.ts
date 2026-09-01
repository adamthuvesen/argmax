import { describe, expect, it } from "vitest";
import {
  isMcpClientTracingTarget,
  isNoisyProviderTracing,
  logBlockLabel,
  matchTracingRecord,
  parseLogDump,
  splitConcatenatedLogRecords,
  splitLogSegments,
  splitTrailingLogFields
} from "./logDump.js";

const FIRST =
  '2026-09-01T07:21:37.004170Z ERROR rmcp::transport::streamable_http_client: fail to delete session: Auth error: OAuth token refresh failed: Server returned error response: invalid_refresh_token session_id="8DgJvqwOzrU_xrEYFWWrF8OwkaGftJqTqtkp8qZDnCOmrdVtqa5WT6-lMVZpOrGhVflCWkC3VpaXaCvjyT4nDA"';
const SECOND =
  '2026-09-01T07:21:37.017965Z ERROR rmcp::transport::streamable_http_client: fail to delete session: Auth error: OAuth token refresh failed: Server returned error response: invalid_refresh_token session_id="other-id"';
const CORE =
  '2026-09-01T07:21:37.004170Z ERROR codex_core::session: stream disconnected session_id="abc"';
const CORE_SECOND =
  '2026-09-01T07:21:37.017965Z ERROR codex_core::session: stream disconnected session_id="def"';
const MISSING_OUTPUT =
  "2026-09-01T08:17:32.875356Z ERROR codex_core::util: Custom tool call output is missing for call id: call_BGd71K6CkePKfLZku6sYyP7q";
const APPLY_PATCH =
  "2026-09-01T09:08:10.411255Z ERROR codex_core::tools::router: error=apply_patch verification failed: Failed to find expected lines in /Users/adamthuvesen/dev/menti/mri/analysis/run_two_model_serving.py:";

describe("splitConcatenatedLogRecords", () => {
  it("inserts a newline when the next record starts mid-line", () => {
    expect(splitConcatenatedLogRecords(`${FIRST}${SECOND}`)).toBe(`${FIRST}\n${SECOND}`);
  });

  it("leaves already-separated records alone", () => {
    expect(splitConcatenatedLogRecords(`${FIRST}\n${SECOND}`)).toBe(`${FIRST}\n${SECOND}`);
  });
});

describe("splitTrailingLogFields", () => {
  it("puts a trailing session_id on its own line", () => {
    expect(splitTrailingLogFields('invalid_refresh_token session_id="abc"')).toBe(
      'invalid_refresh_token\nsession_id="abc"'
    );
  });
});

describe("parseLogDump", () => {
  it("drops MCP HTTP client tracing records", () => {
    expect(parseLogDump(`${FIRST}${SECOND}`)).toEqual([]);
    expect(parseLogDump(FIRST)).toEqual([]);
  });

  it("drops cancelled custom-tool bookkeeping", () => {
    expect(parseLogDump(MISSING_OUTPUT)).toEqual([]);
  });

  it("drops Codex apply_patch router tracing", () => {
    expect(parseLogDump(APPLY_PATCH)).toEqual([]);
    expect(parseLogDump(`${APPLY_PATCH}\npoint = points[tau]`)).toEqual([]);
  });

  it("keeps tracing from other crates and lifts the session_id field", () => {
    const records = parseLogDump(`${CORE}\n${FIRST}`);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      timestamp: "2026-09-01T07:21:37.004170Z",
      level: "ERROR",
      target: "codex_core::session"
    });
    expect(records[0]?.message).toContain("stream disconnected");
    expect(records[0]?.message).toMatch(/\nsession_id=/);
  });

  it("keeps a plain error sentence as one record", () => {
    expect(parseLogDump("Provider exited")).toEqual([
      { timestamp: null, level: null, target: null, message: "Provider exited" }
    ]);
  });
});

describe("splitLogSegments", () => {
  it("strips MCP HTTP client tracing out of a surrounding sentence", () => {
    const text = `After that PR-description correction, I would consider it ready for colleague review.\n${FIRST}${SECOND}`;
    const segments = splitLogSegments(text);
    expect(segments).toEqual([
      {
        kind: "markdown",
        text: "After that PR-description correction, I would consider it ready for colleague review."
      }
    ]);
  });

  it("lifts other crate tracing out of a surrounding sentence", () => {
    const text = `Ready for review.\n${CORE}${CORE_SECOND}`;
    const segments = splitLogSegments(text);
    expect(segments.map((segment) => segment.kind)).toEqual(["markdown", "log"]);
    expect(segments[0]?.text).toContain("Ready for review.");
    expect(segments[1]?.text).toContain("stream disconnected");
    expect(splitConcatenatedLogRecords(segments[1]?.text ?? "").split("\n")).toHaveLength(2);
  });

  it("returns no segments when the dump is only MCP HTTP client tracing", () => {
    expect(splitLogSegments(FIRST)).toEqual([]);
  });

  it("returns no segments when the dump is only cancelled custom-tool bookkeeping", () => {
    expect(splitLogSegments(MISSING_OUTPUT)).toEqual([]);
  });

  it("strips Codex apply_patch router tracing out of a surrounding sentence", () => {
    const text = `The preregistration is written.\n${APPLY_PATCH}`;
    expect(splitLogSegments(text)).toEqual([
      { kind: "markdown", text: "The preregistration is written." }
    ]);
  });

  it("does not treat a date in prose as a log", () => {
    const text = "The deploy at 2026-09-01T07:21:37.004170Z failed during ERROR handling: retry.";
    expect(splitLogSegments(text)).toEqual([{ kind: "markdown", text }]);
  });

  it("leaves tracing text inside a fence as markdown", () => {
    const text = ["```", FIRST, "```"].join("\n");
    expect(splitLogSegments(text)).toEqual([{ kind: "markdown", text }]);
  });

  it("returns a single markdown segment when there is no timestamp", () => {
    expect(splitLogSegments("Hello world")).toEqual([{ kind: "markdown", text: "Hello world" }]);
  });
});

describe("logBlockLabel", () => {
  it("names an error-toned block Error even for a plain sentence", () => {
    expect(logBlockLabel([{ timestamp: null, level: null, target: null, message: "boom" }], "error")).toBe(
      "Error"
    );
  });

  it("names a dump from its highest level", () => {
    const warn = parseLogDump("2026-09-01T07:21:37.004170Z WARN crate::mod: slow");
    expect(logBlockLabel(warn, "auto")).toBe("Warning");
    expect(logBlockLabel(parseLogDump(CORE), "auto")).toBe("Error");
  });
});

describe("isMcpClientTracingTarget", () => {
  it("matches rmcp and codex_rmcp_client crate paths", () => {
    expect(isMcpClientTracingTarget("rmcp::transport::streamable_http_client")).toBe(true);
    expect(isMcpClientTracingTarget("codex_rmcp_client::oauth::refresh_transaction")).toBe(true);
    expect(isMcpClientTracingTarget("codex_core::session")).toBe(false);
    expect(isMcpClientTracingTarget(null)).toBe(false);
  });
});

describe("isNoisyProviderTracing", () => {
  it("drops cancelled custom-tool bookkeeping from codex_core::util", () => {
    expect(
      isNoisyProviderTracing(
        "codex_core::util",
        "Custom tool call output is missing for call id: call_BGd71K6CkePKfLZku6sYyP7q"
      )
    ).toBe(true);
    expect(isNoisyProviderTracing("codex_core::session", "stream disconnected")).toBe(false);
    expect(isNoisyProviderTracing("codex_core::util", "something else broke")).toBe(false);
  });

  it("drops Codex tool-router tracing", () => {
    expect(
      isNoisyProviderTracing(
        "codex_core::tools::router",
        "error=apply_patch verification failed: Failed to find expected lines"
      )
    ).toBe(true);
    expect(isNoisyProviderTracing("codex_core::session", "stream disconnected")).toBe(false);
  });
});

describe("matchTracingRecord", () => {
  it("parses a tracing prefix and leaves ordinary text alone", () => {
    expect(matchTracingRecord(CORE)).toMatchObject({
      level: "ERROR",
      target: "codex_core::session"
    });
    expect(matchTracingRecord("point = points[tau]")).toBeNull();
    expect(matchTracingRecord("The deploy at 2026-09-01T07:21:37.004170Z failed.")).toBeNull();
  });
});
