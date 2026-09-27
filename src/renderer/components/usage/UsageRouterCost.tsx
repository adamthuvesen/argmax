import { ChevronRight } from "lucide-react";
import { useEffect, useId, useRef, useState, type JSX } from "react";
import type { RouterCostSummary, RouterTierCost, UsageWindow } from "../../../shared/types.js";
import { modelLabelFor } from "../../../shared/providerModels.js";
import { formatElapsedSeconds } from "../../formatElapsed.js";
import { AUTO_TIER_SHORT_LABELS } from "../../lib/models.js";
import { formatCount, formatUsd } from "./usageFormat.js";
import { providerLabel } from "./usagePresentation.js";

/** Same cadence as the ledger above it. */
const REFRESH_MS = 60_000;

async function fetchRouterCost(window: UsageWindow): Promise<RouterCostSummary | null> {
  const routerCost = globalThis.window?.argmax?.usage.routerCost;
  // No bridge (browser preview): there is no routing history to show.
  if (!routerCost) return null;
  return routerCost({ window });
}

/** Any figure built on a Cursor transcript estimate reads "≈$…". */
function formatCost(usd: number, estimated: boolean): string {
  return `${estimated ? "≈" : ""}${formatUsd(usd)}`;
}

/** Tenths under ten seconds, where first activity usually lands. */
function formatSeconds(seconds: number | null): string {
  if (seconds === null) return "—";
  if (seconds < 10) return `${seconds.toFixed(1)}s`;
  return formatElapsedSeconds(seconds * 1000);
}

function modelMix(tier: RouterTierCost): string {
  const models = tier.models.map((model) => {
    const label = modelLabelFor(model.provider, model.modelId) ?? model.modelId;
    return `${label} ×${formatCount(model.turns)}`;
  });
  return models.join(" · ");
}

const DECISION_LABELS: Record<string, string> = {
  launch: "Launch",
  fallback: "Launch · fallback",
  kept: "Follow-up · kept",
  reroute: "Follow-up · rerouted",
  escalate: "Escalated"
};

function DecisionBreakdown({ tier }: { tier: RouterTierCost }): JSX.Element {
  return (
    <>
      <p className="usage-router-detail-caption">
        Matching decisions are grouped. One decision can cover several turns, including goal
        continuations. Escalations record a model or effort change, not whether the work succeeded.
      </p>
      <table
        className="usage-table usage-router-decisions"
        aria-label={`${AUTO_TIER_SHORT_LABELS[tier.tier]} routing decisions`}
      >
        <thead>
          <tr>
            <th scope="col">Task</th>
            <th scope="col">Model · effort</th>
            <th scope="col">Decision · reason</th>
            <th scope="col" className="usage-table-num">Decisions</th>
            <th scope="col" className="usage-table-num">Turns</th>
          </tr>
        </thead>
        <tbody>
          {tier.decisions.map((decision) => (
            <tr key={JSON.stringify([
              decision.provider, decision.modelId, decision.reasoningEffort,
              decision.kind, decision.difficulty, decision.decision, decision.reason
            ])}>
              <th scope="row">
                {decision.kind ?? "Not classified"}
                <span className="usage-router-mix">
                  {decision.difficulty ?? "Difficulty not recorded"}
                </span>
              </th>
              <td>
                {modelLabelFor(decision.provider, decision.modelId) ?? decision.modelId}
                <span className="usage-router-mix">
                  {providerLabel(decision.provider)} · {decision.reasoningEffort ?? "No effort recorded"}
                </span>
              </td>
              <td>
                {DECISION_LABELS[decision.decision] ?? decision.decision}
                <span className="usage-router-mix">{decision.reason}</span>
              </td>
              <td className="usage-table-num">{formatCount(decision.count)}</td>
              <td className="usage-table-num">{formatCount(decision.turns)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

function TierRow({ tier }: { tier: RouterTierCost }): JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const detailsId = useId();
  const total = tier.measuredCostUsd + tier.estimatedCostUsd;
  const estimated = tier.estimatedCostUsd > 0;
  const pricedTurns = tier.turns - tier.unpricedTurns;
  // A remote client may still be connected to a Mac predating the breakdown.
  const hasDecisions = (tier.decisions?.length ?? 0) > 0;
  return (
    <>
      <tr>
        <th scope="row">
          {hasDecisions ? (
            <button
              type="button"
              className="usage-router-toggle usage-router-tier"
              aria-label={`${AUTO_TIER_SHORT_LABELS[tier.tier]} routing decisions`}
              aria-expanded={expanded}
              aria-controls={detailsId}
              onClick={() => setExpanded((open) => !open)}
            >
              <ChevronRight size={14} aria-hidden="true" />
              {AUTO_TIER_SHORT_LABELS[tier.tier]}
            </button>
          ) : (
            <span className="usage-router-tier">{AUTO_TIER_SHORT_LABELS[tier.tier]}</span>
          )}
          <span className="usage-router-mix">{modelMix(tier)}</span>
          <span className="usage-router-mix">
            {formatCount(pricedTurns)}/{formatCount(tier.turns)} turns priced
          </span>
        </th>
        <td className="usage-table-num">{formatCount(tier.chats)}</td>
        <td className="usage-table-num">{formatCount(tier.turns)}</td>
        <td className="usage-table-num">{pricedTurns > 0 ? formatCost(total, estimated) : "—"}</td>
        <td className="usage-table-num">
          {pricedTurns > 0 ? formatCost(total / pricedTurns, estimated) : "—"}
        </td>
        <td className="usage-table-num">{formatSeconds(tier.medianTurnSeconds)}</td>
        <td className="usage-table-num">{formatSeconds(tier.medianFirstAnswerSeconds)}</td>
        <td className="usage-table-num">{formatCount(tier.escalations)}</td>
      </tr>
      {hasDecisions && expanded ? (
        <tr>
          <td colSpan={8} className="usage-router-detail-cell" id={detailsId}>
            <DecisionBreakdown tier={tier} />
          </td>
        </tr>
      ) : null}
    </>
  );
}

/**
 * What each Auto tier cost in the page's window, turn by turn. Hidden until a
 * chat has been routed in that window.
 */
export function RouterCostCard({
  usageWindow,
  visible
}: {
  usageWindow: UsageWindow;
  visible: boolean;
}): JSX.Element | null {
  const [summary, setSummary] = useState<RouterCostSummary | null>(null);
  // Only the newest request may write: a window switch must not be
  // overwritten by the slower read it replaced.
  const requestRef = useRef(0);

  useEffect(() => {
    if (!visible) return;
    const load = async (): Promise<void> => {
      const request = requestRef.current + 1;
      requestRef.current = request;
      try {
        const next = await fetchRouterCost(usageWindow);
        if (requestRef.current === request) setSummary(next);
      } catch (cause) {
        // A secondary card: keep the page up, but say why it went missing.
        console.warn("[usage] router cost read failed", cause);
        if (requestRef.current === request) setSummary(null);
      }
    };
    void load();
    const timer = globalThis.setInterval(() => void load(), REFRESH_MS);
    return () => globalThis.clearInterval(timer);
  }, [usageWindow, visible]);

  if (!summary || summary.tiers.length === 0) return null;
  return (
    <section className="usage-section usage-router" aria-label="Router">
      <div className="usage-section-head">
        <h2 className="usage-section-title">Router</h2>
      </div>
      <div className="usage-table-scroll">
        <table className="usage-table" aria-label="Router cost by tier">
          <thead>
            <tr>
              <th scope="col">Tier</th>
              <th scope="col" className="usage-table-num">Chats</th>
              <th scope="col" className="usage-table-num">Turns</th>
              <th scope="col" className="usage-table-num">Cost</th>
              <th scope="col" className="usage-table-num">Per turn</th>
              <th scope="col" className="usage-table-num">Turn time</th>
              <th scope="col" className="usage-table-num">First activity</th>
              <th scope="col" className="usage-table-num">Escalations</th>
            </tr>
          </thead>
          <tbody>
            {summary.tiers.map((tier) => (
              <TierRow key={tier.tier} tier={tier} />
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
