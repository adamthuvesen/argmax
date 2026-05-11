import { ChevronRight } from "lucide-react";
import { useEffect, useState, type JSX } from "react";
import type { SessionCostSummary, SessionSummary, TimelineEvent } from "../../shared/types.js";
import { formatCostUsd } from "../formatCost.js";
import { costForBucket, emptyCostSummary } from "../lib/models.js";

const COST_PANEL_EXPANDED_KEY = "argmax.costPanel.expanded";

export function CostPanel({
  session,
  events
}: {
  session: SessionSummary;
  events: TimelineEvent[];
}): JSX.Element {
  // The cost summary refreshes on session change and whenever the event tail
  // ticks — usage events ride the same micro-batch flush so a new event
  // means a fresh cost is available.
  const [summary, setSummary] = useState<SessionCostSummary>(() => emptyCostSummary(session.id));
  const [expanded, setExpanded] = useState<boolean>(() => {
    const raw = typeof window !== "undefined" ? window.localStorage.getItem(COST_PANEL_EXPANDED_KEY) : null;
    return raw === null ? false : raw === "true";
  });

  const eventTick = events.length;
  const sessionId = session.id;

  useEffect(() => {
    window.localStorage.setItem(COST_PANEL_EXPANDED_KEY, String(expanded));
  }, [expanded]);

  useEffect(() => {
    let cancelled = false;
    if (!window.argmax) return;
    void window.argmax.session
      .costSummary({ sessionId })
      .then((next) => {
        if (!cancelled) setSummary(next);
      })
      .catch(() => {
        /* surface elsewhere; the panel just stays at last known totals */
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId, eventTick]);

  const modelLabel = summary.modelId ?? session.modelId ?? "—";
  const rows: Array<{ key: keyof SessionCostSummary["tokens"]; label: string }> = [
    { key: "input", label: "Input" },
    { key: "output", label: "Output" },
    { key: "cacheRead", label: "Cache read" },
    { key: "cacheWrite", label: "Cache write" }
  ];

  return (
    <section className="cost-panel" aria-label="Session cost summary">
      <button
        className="cost-panel-header"
        type="button"
        aria-expanded={expanded}
        aria-label="Toggle cost breakdown"
        onClick={() => setExpanded((v) => !v)}
      >
        <span className="cost-panel-title">Cost</span>
        <span className="cost-panel-model" title={`Model: ${modelLabel}`}>{modelLabel}</span>
        <span
          className="cost-panel-total"
          aria-label={`Total cost: ${formatCostUsd(summary.costUsd)}`}
          title={`Total cost: ${formatCostUsd(summary.costUsd)}`}
        >
          {formatCostUsd(summary.costUsd)}
        </span>
        <ChevronRight size={11} className={`cost-panel-chevron${expanded ? " expanded" : ""}`} />
      </button>
      {expanded ? (
        <table className="cost-panel-table" aria-label="Per-bucket usage">
          <thead>
            <tr>
              <th scope="col">Bucket</th>
              <th scope="col">Tokens</th>
              <th scope="col">Cost</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ key, label }) => {
              const tokens = summary.tokens[key];
              return (
                <tr key={key} aria-label={`${label} usage`}>
                  <th scope="row">{label}</th>
                  <td title={`${label} tokens: ${tokens.toLocaleString()}`}>{tokens.toLocaleString()}</td>
                  <td title={`${label} cost: ${formatCostUsd(costForBucket(key, tokens, summary.modelId))}`}>
                    {formatCostUsd(costForBucket(key, tokens, summary.modelId))}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      ) : null}
    </section>
  );
}
