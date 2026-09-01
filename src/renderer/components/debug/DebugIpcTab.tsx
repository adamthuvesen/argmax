import { useMemo, useState, type JSX } from "react";
import type { IpcChannelStats } from "../../../shared/types.js";
import { formatLatency } from "../../lib/debugTrace.js";

/** p99 thresholds. 16ms is one frame; past 100ms a channel is felt. */
const WARN_MS = 16;
const BAD_MS = 100;

type SortKey = "channel" | "count" | "totalRecorded" | "p50" | "p99";

const COLUMNS: ReadonlyArray<{ key: SortKey; label: string; title: string }> = [
  { key: "channel", label: "Channel", title: "IPC channel name" },
  { key: "count", label: "n", title: "Samples in the 100-deep ring the percentiles are taken from" },
  { key: "totalRecorded", label: "calls", title: "Total invocations since launch" },
  { key: "p50", label: "p50", title: "Median latency over the ring" },
  { key: "p99", label: "p99", title: "99th percentile latency over the ring" }
];

export function DebugIpcTab({ stats, error }: { stats: IpcChannelStats[]; error: string | null }): JSX.Element {
  const [sort, setSort] = useState<SortKey>("p99");
  const [query, setQuery] = useState("");

  const rows = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const filtered = needle ? stats.filter((stat) => stat.channel.toLowerCase().includes(needle)) : stats;
    return [...filtered].sort((left, right) =>
      sort === "channel" ? left.channel.localeCompare(right.channel) : right[sort] - left[sort]
    );
  }, [stats, sort, query]);

  return (
    <div
      className="debug-tab"
      role="tabpanel"
      id="debug-panel-ipc"
      aria-labelledby="debug-tab-ipc"
    >
      <div className="debug-filters">
        <input
          className="debug-search"
          type="search"
          placeholder="Search channels"
          aria-label="Search channels"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </div>
      <p className="debug-count" role="status">
        {rows.length} channels called this session · sorted by {sort}
      </p>
      {error ? (
        <p className="debug-error" role="alert">
          {error}
        </p>
      ) : null}
      <div className="debug-rows">
        {rows.length === 0 ? (
          <p className="debug-empty">No channel has been called yet.</p>
        ) : (
          <table className="debug-table" aria-label="IPC channel latency">
            <thead>
              <tr>
                {COLUMNS.map((column) => (
                  <th key={column.key} scope="col" aria-sort={sort === column.key ? "descending" : "none"}>
                    <button type="button" title={column.title} onClick={() => setSort(column.key)}>
                      {column.label}
                    </button>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((stat) => (
                <tr key={stat.channel} data-health={health(stat.p99)}>
                  <td>
                    <code>{stat.channel}</code>
                  </td>
                  <td>{stat.count}</td>
                  <td>{stat.totalRecorded.toLocaleString()}</td>
                  <td>{formatLatency(stat.p50)}</td>
                  <td>{formatLatency(stat.p99)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

function health(p99: number): "bad" | "warn" | "ok" {
  if (p99 >= BAD_MS) return "bad";
  if (p99 >= WARN_MS) return "warn";
  return "ok";
}
