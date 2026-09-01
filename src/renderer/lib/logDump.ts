/**
 * Tracing-style records that leak into assistant markdown or stderr
 * (`2026-09-01T07:21:37Z ERROR crate::module: ...`). The chat lifts those
 * out of the paragraph into a log block, and splits records that arrived
 * glued to the previous one with no newline.
 *
 * MCP HTTP client crates (`rmcp::`, `codex_rmcp_client::`) are dropped.
 * Those lines are session-teardown noise (failed OAuth refresh on DELETE),
 * not something the chat can act on. Codex also logs
 * `codex_core::util: Custom tool call output is missing` after a cancelled
 * in-flight custom tool, and `codex_core::tools::router` apply_patch
 * verification failures (plus the expected-context dump on the next lines).
 * Those are bookkeeping for a tool the chat already shows, not a new
 * failure. Codex login errors still show: they do not use those crate paths.
 */

const MCP_CLIENT_TRACING_CRATES = ["rmcp", "codex_rmcp_client"] as const;
const MISSING_CUSTOM_TOOL_OUTPUT = "Custom tool call output is missing for call id:";

export type LogLevel = "ERROR" | "WARN" | "WARNING" | "INFO" | "DEBUG" | "TRACE";

export type LogRecord = {
  timestamp: string | null;
  level: LogLevel | null;
  target: string | null;
  message: string;
};

export type LogSegment = { kind: "markdown"; text: string } | { kind: "log"; text: string };

const ISO_TS = "\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d+)?Z";
const LEVEL = "ERROR|WARN(?:ING)?|INFO|DEBUG|TRACE";
// Target must contain `::` or `.` so a sentence like "ERROR handling: retry"
// does not count as a record.
const TARGET = "(?=\\S*(?:::[^\\s:]+|\\.[^\\s:]+))\\S+";
const RECORD_PREFIX = `(${ISO_TS})\\s+(${LEVEL})\\s+(${TARGET}):\\s`;
const FENCE_RE = /(```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$))/g;
const TRAILING_FIELD_RE = /\s+([A-Za-z_][\w]*=(?:"[^"]*"|'[^']*'|\S+))/g;

function recordPrefix(): RegExp {
  return new RegExp(`^${RECORD_PREFIX}`);
}

function recordBoundary(): RegExp {
  return new RegExp(`(?<=\\S)(?=[^\\S\\n]*${RECORD_PREFIX})`, "g");
}

function linePrefix(): RegExp {
  return new RegExp(`^\\s*${RECORD_PREFIX}`);
}

export function splitConcatenatedLogRecords(text: string): string {
  return text.replace(recordBoundary(), "\n");
}

export function splitTrailingLogFields(message: string): string {
  return message.replace(TRAILING_FIELD_RE, "\n$1").trim();
}

export function isMcpClientTracingTarget(target: string | null | undefined): boolean {
  if (!target) return false;
  return MCP_CLIENT_TRACING_CRATES.some(
    (crate) => target === crate || target.startsWith(`${crate}::`)
  );
}

export function isNoisyProviderTracing(target: string | null | undefined, message: string): boolean {
  if (isMcpClientTracingTarget(target)) return true;
  const utilCrate = target === "codex_core::util" || Boolean(target?.startsWith("codex_core::util::"));
  if (utilCrate && message.includes(MISSING_CUSTOM_TOOL_OUTPUT)) return true;
  // Tool-router records (apply_patch verification, and the like) are Codex
  // bookkeeping that leaked onto the PTY. The chat already has the tool row.
  return target === "codex_core::tools" || Boolean(target?.startsWith("codex_core::tools::"));
}

/** First tracing record on this line, or null if the line is ordinary text. */
export function matchTracingRecord(line: string): LogRecord | null {
  const trimmed = line.trim();
  if (trimmed.length === 0) return null;
  const match = trimmed.match(recordPrefix());
  if (!match) return null;
  return {
    timestamp: match[1] ?? null,
    level: (match[2] as LogLevel | undefined) ?? null,
    target: match[3] ?? null,
    message: splitTrailingLogFields(trimmed.slice(match[0].length))
  };
}

export function parseLogDump(text: string): LogRecord[] {
  const lines = splitConcatenatedLogRecords(text).split("\n");
  const records: LogRecord[] = [];
  const prefix = recordPrefix();
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    const match = trimmed.match(prefix);
    if (match) {
      const rest = trimmed.slice(match[0].length);
      records.push({
        timestamp: match[1] ?? null,
        level: (match[2] as LogLevel | undefined) ?? null,
        target: match[3] ?? null,
        message: splitTrailingLogFields(rest)
      });
      continue;
    }
    const last = records[records.length - 1];
    if (last) {
      last.message = last.message.length > 0 ? `${last.message}\n${trimmed}` : trimmed;
      continue;
    }
    records.push({ timestamp: null, level: null, target: null, message: trimmed });
  }
  return records.filter((record) => !isNoisyProviderTracing(record.target, record.message));
}

function splitProseLogSegments(text: string): LogSegment[] {
  const lines = splitConcatenatedLogRecords(text).split("\n");
  const out: LogSegment[] = [];
  let buffer: { kind: "markdown" | "log"; lines: string[] } | null = null;
  const prefix = linePrefix();
  const flush = (): void => {
    if (!buffer) return;
    const joined = buffer.lines.join("\n");
    if (joined.length > 0) out.push({ kind: buffer.kind, text: joined });
    buffer = null;
  };
  for (const line of lines) {
    const match = line.match(prefix);
    if (match && isNoisyProviderTracing(match[3], line.slice(match[0].length))) {
      continue;
    }
    const kind: "markdown" | "log" = match ? "log" : "markdown";
    if (!buffer || buffer.kind !== kind) {
      flush();
      buffer = { kind, lines: [line] };
    } else {
      buffer.lines.push(line);
    }
  }
  flush();
  return out;
}

function mergeAdjacentMarkdown(segments: readonly LogSegment[]): LogSegment[] {
  const out: LogSegment[] = [];
  for (const segment of segments) {
    const last = out[out.length - 1];
    if (last && last.kind === "markdown" && segment.kind === "markdown") {
      last.text += segment.text;
      continue;
    }
    out.push({ kind: segment.kind, text: segment.text });
  }
  return out.filter((segment) => segment.text.length > 0);
}

export function splitLogSegments(text: string): LogSegment[] {
  if (text.length === 0) return [];
  if (!/\d{4}-\d{2}-\d{2}T/.test(text)) return [{ kind: "markdown", text }];

  const pieces: LogSegment[] = [];
  const fenceRe = new RegExp(FENCE_RE.source, "g");
  let last = 0;
  let match: RegExpExecArray | null;
  while ((match = fenceRe.exec(text)) !== null) {
    if (match.index > last) {
      pieces.push(...splitProseLogSegments(text.slice(last, match.index)));
    }
    pieces.push({ kind: "markdown", text: match[0] });
    last = match.index + match[0].length;
  }
  if (last < text.length) {
    pieces.push(...splitProseLogSegments(text.slice(last)));
  }
  return mergeAdjacentMarkdown(pieces);
}

export function logBlockLabel(records: readonly LogRecord[], tone: "auto" | "error"): string {
  if (tone === "error") return "Error";
  if (records.some((record) => record.level === "ERROR")) return "Error";
  if (records.some((record) => record.level === "WARN" || record.level === "WARNING")) {
    return "Warning";
  }
  return "Log";
}
