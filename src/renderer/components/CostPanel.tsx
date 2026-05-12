import { ChevronRight } from "lucide-react";
import { useEffect, useMemo, useState, type JSX } from "react";
import type { SessionCostSummary, SessionSummary } from "../../shared/types.js";
import { formatCostUsd } from "../formatCost.js";
import { costForBucket } from "../lib/models.js";

const COST_PANEL_EXPANDED_KEY = "argmax.costPanel.expanded";

export function CostPanel({
  session
}: {
  session: SessionSummary;
}): JSX.Element {
  // Cost rides the existing dashboard:delta push: `session.tokens` and
  // `session.costUsd` arrive on every micro-batch flush from the main process.
  // No separate IPC, no debounce — the panel is a pure projection of the
  // session row.
  const [expanded, setExpanded] = useState<boolean>(() => {
    const raw = typeof window !== "undefined" ? window.localStorage.getItem(COST_PANEL_EXPANDED_KEY) : null;
    return raw === null ? false : raw === "true";
  });

  useEffect(() => {
    window.localStorage.setItem(COST_PANEL_EXPANDED_KEY, String(expanded));
  }, [expanded]);

  const summary = useMemo<SessionCostSummary>(
    () => ({
      sessionId: session.id,
      modelId: session.modelId,
      tokens: session.tokens ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      costUsd: session.costUsd ?? 0
    }),
    [session.id, session.modelId, session.tokens, session.costUsd]
  );

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
