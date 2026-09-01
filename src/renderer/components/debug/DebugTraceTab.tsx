import { ChevronDown, ChevronRight, Copy } from "lucide-react";
import { useEffect, useMemo, useState, type JSX } from "react";
import {
  buildTraceRows,
  filterTraceRows,
  formatDelta,
  traceLabels,
  type TraceRow,
  type TraceSource
} from "../../lib/debugTrace.js";
import { useCopyToClipboard } from "../../hooks/useCopyToClipboard.js";
import type { RawProviderOutput, TimelineEvent } from "../../../shared/types.js";

/**
 * Rows kept in the DOM. A busy stream-json session produces tens of thousands
 * of lines per turn; the tail is what you are looking at, and the header says
 * how much was dropped so the cap never reads as "that's all there was".
 */
const RENDER_CAP = 400;

/** Gap after which a row is flagged as a stall worth explaining. */
const STALL_MS = 1_500;

export function DebugTraceTab({
  events,
  rawOutputs
}: {
  events: TimelineEvent[];
  rawOutputs: RawProviderOutput[];
}): JSX.Element {
  const [source, setSource] = useState<TraceSource>("all");
  const [label, setLabel] = useState("all");
  const [query, setQuery] = useState("");

  const rows = useMemo(() => buildTraceRows(events, rawOutputs), [events, rawOutputs]);
  const labels = useMemo(() => traceLabels(rows, source), [rows, source]);
  const matched = useMemo(() => filterTraceRows(rows, { source, label, query }), [rows, source, label, query]);
  const visible = matched.slice(-RENDER_CAP);

  // A label chosen under one source facet usually doesn't exist under the
  // next one, which would silently filter everything away.
  useEffect(() => {
    if (label !== "all" && !labels.includes(label)) setLabel("all");
  }, [label, labels]);

  return (
    <div className="debug-tab">
      <div className="debug-filters">
        <div className="debug-segmented" role="group" aria-label="Trace source">
          {(
            [
              ["all", "All"],
              ["event", "Events"],
              ["raw", "Raw"]
            ] as const
          ).map(([value, text]) => (
            <button
              key={value}
              type="button"
              aria-pressed={source === value}
              onClick={() => setSource(value)}
            >
              {text}
            </button>
          ))}
        </div>
        <select
          className="debug-select"
          aria-label="Filter by type"
          value={label}
          onChange={(event) => setLabel(event.target.value)}
        >
          <option value="all">All types</option>
          {labels.map((value) => (
            <option key={value} value={value}>
              {value}
            </option>
          ))}
        </select>
        <input
          className="debug-search"
          type="search"
          placeholder="Search trace"
          aria-label="Search trace"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </div>
      <p className="debug-count" role="status">
        {matched.length === rows.length
          ? `${rows.length} rows`
          : `${matched.length} of ${rows.length} rows`}
        {matched.length > visible.length ? ` · showing last ${visible.length}` : ""}
      </p>
      <div className="debug-rows">
        {visible.length === 0 ? (
          <p className="debug-empty">Nothing matches. Raw provider output appears here as the session streams.</p>
        ) : (
          visible.map((row) => <TraceRowView key={row.id} row={row} />)
        )}
      </div>
    </div>
  );
}

function TraceRowView({ row }: { row: TraceRow }): JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const [flash, copy] = useCopyToClipboard();
  const stalled = row.deltaMs >= STALL_MS;

  return (
    <div className="debug-row" data-source={row.source} data-stream={row.stream ?? undefined}>
      <button
        type="button"
        className="debug-row-head"
        aria-expanded={expanded}
        onClick={() => setExpanded((open) => !open)}
      >
        {expanded ? <ChevronDown size={12} aria-hidden="true" /> : <ChevronRight size={12} aria-hidden="true" />}
        <span className="debug-row-label">{row.label}</span>
        <span className="debug-row-summary">{row.summary}</span>
        <span className="debug-row-delta" data-stalled={stalled || undefined} title="Time since previous row">
          {formatDelta(row.deltaMs)}
        </span>
      </button>
      {expanded ? (
        <div className="debug-row-detail">
          <pre>{row.detail}</pre>
          <button type="button" className="debug-copy" onClick={() => void copy(row.raw)} aria-label="Copy row">
            <Copy size={12} aria-hidden="true" />
            <span>{flash === "copied" ? "Copied" : flash === "failed" ? "Failed" : "Copy"}</span>
          </button>
        </div>
      ) : null}
    </div>
  );
}
