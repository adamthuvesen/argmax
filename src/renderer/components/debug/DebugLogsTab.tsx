import { useEffect, useMemo, useRef, useState, type JSX } from "react";
import type { BackendLogEntry } from "../../../shared/types.js";
import { useCopyToClipboard } from "../../hooks/useCopyToClipboard.js";

/** Levels in severity order; the filter keeps this one and everything above. */
const LEVELS = ["trace", "debug", "info", "warn", "error"] as const;
type Level = (typeof LEVELS)[number];

export function DebugLogsTab({
  logs,
  error,
  onClear
}: {
  logs: BackendLogEntry[];
  error: string | null;
  onClear: () => void;
}): JSX.Element {
  const [minLevel, setMinLevel] = useState<Level>("debug");
  const [scope, setScope] = useState("all");
  const [query, setQuery] = useState("");
  const [follow, setFollow] = useState(true);
  const bottom = useRef<HTMLDivElement | null>(null);

  const scopes = useMemo(() => [...new Set(logs.map((entry) => entry.scope))].sort(), [logs]);
  const threshold = LEVELS.indexOf(minLevel);
  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return logs.filter((entry) => {
      const rank = LEVELS.indexOf(entry.level as Level);
      // An unrecognized level is never hidden — a filter that silently eats
      // lines is worse than one that shows too many.
      if (rank !== -1 && rank < threshold) return false;
      if (scope !== "all" && entry.scope !== scope) return false;
      if (!needle) return true;
      return `${entry.scope} ${entry.message} ${JSON.stringify(entry.fields)}`.toLowerCase().includes(needle);
    });
  }, [logs, threshold, scope, query]);

  useEffect(() => {
    if (follow) bottom.current?.scrollIntoView({ block: "end" });
  }, [follow, visible.length]);

  useEffect(() => {
    if (scope !== "all" && !scopes.includes(scope)) setScope("all");
  }, [scope, scopes]);

  return (
    <div
      className="debug-tab"
      role="tabpanel"
      id="debug-panel-logs"
      aria-labelledby="debug-tab-logs"
    >
      <div className="debug-filters">
        <select
          className="debug-select"
          aria-label="Minimum level"
          value={minLevel}
          onChange={(event) => setMinLevel(event.target.value as Level)}
        >
          {LEVELS.map((level) => (
            <option key={level} value={level}>
              {level}+
            </option>
          ))}
        </select>
        <select
          className="debug-select"
          aria-label="Filter by scope"
          value={scope}
          onChange={(event) => setScope(event.target.value)}
        >
          <option value="all">All scopes</option>
          {scopes.map((value) => (
            <option key={value} value={value}>
              {value}
            </option>
          ))}
        </select>
        <input
          className="debug-search"
          type="search"
          placeholder="Search logs"
          aria-label="Search logs"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </div>
      <div className="debug-count" role="status">
        <span>
          {visible.length === logs.length ? `${logs.length} lines` : `${visible.length} of ${logs.length} lines`}
        </span>
        <span className="debug-count-actions">
          <button type="button" aria-pressed={follow} onClick={() => setFollow((on) => !on)}>
            {follow ? "Following" : "Paused"}
          </button>
          <button type="button" onClick={onClear}>
            Clear
          </button>
        </span>
      </div>
      {error ? (
        <p className="debug-error" role="alert">
          {error}
        </p>
      ) : null}
      <div className="debug-rows">
        {visible.length === 0 ? (
          <p className="debug-empty">
            No log lines yet. The backend emits at <code>info</code>, and <code>argmax_lib</code> at{" "}
            <code>debug</code>, unless <code>RUST_LOG</code> says otherwise.
          </p>
        ) : (
          visible.map((entry) => <LogRow key={entry.seq} entry={entry} />)
        )}
        <div ref={bottom} />
      </div>
    </div>
  );
}

function LogRow({ entry }: { entry: BackendLogEntry }): JSX.Element {
  const [, copy] = useCopyToClipboard();
  const fields = Object.entries(entry.fields ?? {});
  return (
    <div
      className="debug-log-row"
      data-level={entry.level}
      onDoubleClick={() => void copy(JSON.stringify(entry))}
      title="Double-click to copy this line as JSON"
    >
      <span className="debug-log-time">{entry.timestamp.slice(11, 23)}</span>
      <span className="debug-log-level">{entry.level}</span>
      <code className="debug-log-scope">{entry.scope}</code>
      <span className="debug-log-message">{entry.message}</span>
      {fields.length > 0 ? (
        <span className="debug-log-fields">
          {fields.map(([key, value]) => (
            <span key={key}>
              {key}=<b>{value}</b>
            </span>
          ))}
        </span>
      ) : null}
    </div>
  );
}
