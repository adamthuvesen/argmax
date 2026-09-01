import { tryParseJsonObject } from "../../shared/safeJson.js";
import type { RawProviderOutput, TimelineEvent } from "../../shared/types.js";
import { arrayValue, objectValue, stringValue } from "../../shared/typeGuards.js";

/**
 * One line in the debug trace. Normalized timeline events and raw provider
 * output share a single time-ordered list so a normalizer bug is visible as
 * "this JSON arrived, and *that* event came out of it" rather than as two
 * lists you diff by eye across tabs.
 */
export type TraceRow = {
  id: string;
  /** Epoch ms, used for ordering and the inter-row delta. */
  at: number;
  /** Milliseconds since the previous row; 0 for the first. */
  deltaMs: number;
  /** Everything the filter matches against, lowercased once at build time. */
  haystack: string;
  /** Collapsed one-liner. Never contains reasoning text. */
  summary: string;
  /** Expanded body: pretty JSON when the source parsed, else the raw text. */
  detail: string;
  /** Verbatim source text, for the copy button. */
  raw: string;
} & (
  | { source: "event"; label: string; stream: null }
  | { source: "raw"; label: string; stream: RawProviderOutput["stream"] }
);

export type TraceSource = "all" | "event" | "raw";

export interface TraceFilter {
  source: TraceSource;
  /** Event type or raw stream; "all" disables the facet. */
  label: string;
  query: string;
}

/**
 * Interleaves events and raw output into one ascending timeline.
 *
 * Raw output arrives as chunks that often carry several protocol lines, so
 * chunks are split per line: a stream-json burst should read as N rows, not
 * one wall of text. A chunk that ends mid-line yields a row that fails to
 * parse, which is itself the signal you want when framing is the bug.
 */
export function buildTraceRows(events: TimelineEvent[], rawOutputs: RawProviderOutput[]): TraceRow[] {
  const rows: Omit<TraceRow, "deltaMs">[] = [];

  for (const event of events) {
    const payload = Object.keys(event.payload).length > 0 ? JSON.stringify(event.payload, null, 2) : "";
    const body = JSON.stringify({ type: event.type, message: event.message, payload: event.payload }, null, 2);
    rows.push({
      id: `event:${event.id}`,
      at: Date.parse(event.createdAt),
      source: "event",
      label: event.type,
      stream: null,
      haystack: `${event.type} ${event.message} ${payload}`.toLowerCase(),
      summary: event.message || event.type,
      detail: body,
      raw: body
    });
  }

  for (const output of rawOutputs) {
    const at = Date.parse(output.createdAt);
    const lines = output.content.split(/\r?\n/);
    lines.forEach((line, index) => {
      if (!line.trim()) return;
      const record = tryParseJsonObject(line.trim());
      rows.push({
        id: `raw:${output.id}:${index}`,
        at,
        source: "raw",
        label: output.stream,
        stream: output.stream,
        haystack: line.toLowerCase(),
        summary: summarizeProtocolLine(line) ?? line,
        detail: record ? JSON.stringify(record, null, 2) : line,
        raw: line
      });
    });
  }

  // Timestamps collide constantly (chunks written in the same millisecond), so
  // the id tiebreak is what keeps ordering stable across re-renders.
  rows.sort((left, right) => left.at - right.at || left.id.localeCompare(right.id));

  let previous = 0;
  return rows.map((row) => {
    const deltaMs = previous === 0 ? 0 : Math.max(0, row.at - previous);
    previous = row.at;
    return { ...row, deltaMs } as TraceRow;
  });
}

export function filterTraceRows(rows: TraceRow[], filter: TraceFilter): TraceRow[] {
  const query = filter.query.trim().toLowerCase();
  return rows.filter((row) => {
    if (filter.source !== "all" && row.source !== filter.source) return false;
    if (filter.label !== "all" && row.label !== filter.label) return false;
    if (query && !row.haystack.includes(query)) return false;
    return true;
  });
}

/** Distinct labels present in `rows`, respecting the active source facet. */
export function traceLabels(rows: TraceRow[], source: TraceSource): string[] {
  const labels = new Set<string>();
  for (const row of rows) {
    if (source !== "all" && row.source !== source) continue;
    labels.add(row.label);
  }
  return [...labels].sort();
}

/**
 * Collapsed one-liner for a provider protocol line. Returns null when the line
 * is not protocol JSON, so callers can fall back to the text itself.
 *
 * Reasoning text is deliberately reduced to a marker: the collapsed list is
 * skimmed, and a chain of thought pasted into it buries everything else.
 * Expanding the row still shows the line verbatim.
 */
export function summarizeProtocolLine(line: string): string | null {
  const record = tryParseJsonObject(line.trim());
  const type = stringValue(record?.type);
  if (!record || !type) return null;

  const subtype = stringValue(record.subtype);
  const details = [subtype, contentSummary(record)].filter(Boolean).join(" · ");
  return details ? `${type} · ${details}` : type;
}

function contentSummary(record: Record<string, unknown>): string | null {
  const message = objectValue(record.message);
  const blocks = arrayValue(message?.content) ?? arrayValue(record.content);
  if (!blocks) return stringValue(record.message);

  const text = blocks
    .map((block) => stringValue(objectValue(block)?.text))
    .filter((value): value is string => Boolean(value))
    .join("")
    .trim();
  if (text) return truncate(text);

  const toolNames = blocks
    .map((block) => {
      const obj = objectValue(block);
      if (stringValue(obj?.type) !== "tool_use") return null;
      return stringValue(obj?.name) ?? "tool_use";
    })
    .filter((value): value is string => Boolean(value));
  if (toolNames.length > 0) return `tool_use ${toolNames.join(", ")}`;

  if (blocks.some((block) => stringValue(objectValue(block)?.type) === "thinking")) {
    return "thinking block hidden";
  }
  return null;
}

function truncate(text: string): string {
  const normalized = text.replace(/\s+/g, " ");
  return normalized.length > 160 ? `${normalized.slice(0, 157)}…` : normalized;
}

/** `1.4s` / `320ms` / `—` for the first row. Gaps are what expose stalls. */
export function formatDelta(deltaMs: number): string {
  if (deltaMs <= 0) return "—";
  if (deltaMs < 1000) return `${Math.round(deltaMs)}ms`;
  return `${(deltaMs / 1000).toFixed(deltaMs < 10_000 ? 1 : 0)}s`;
}

/** Sub-millisecond IPC calls read as "0.0ms" otherwise, which hides the win. */
export function formatLatency(ms: number): string {
  if (!Number.isFinite(ms)) return "—";
  if (ms < 1) return `${Math.round(ms * 1000)}µs`;
  if (ms < 100) return `${ms.toFixed(1)}ms`;
  return `${Math.round(ms)}ms`;
}
