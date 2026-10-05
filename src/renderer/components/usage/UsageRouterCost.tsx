import { ChevronRight } from "lucide-react";
import { useEffect, useId, useRef, useState, type JSX } from "react";
import type { RouterCostSummary, RouterModelCost, RouterTierCost, UsageWindow } from "../../../shared/types.js";
import { modelLabelFor } from "../../../shared/providerModels.js";
import { formatElapsedSeconds } from "../../formatElapsed.js";
import { AUTO_TIER_SHORT_LABELS } from "../../lib/models.js";
import { formatCount, formatPercent, formatUsd } from "./usageFormat.js";
import { providerLabel } from "./usagePresentation.js";

/** Same cadence as the ledger above it. */
const REFRESH_MS = 60_000;

async function fetchRouterCost(window: UsageWindow): Promise<RouterCostSummary | null> {
  const api = globalThis.window?.argmax;
  if (api) return api.usage.routerCost?.({ window }) ?? null;
  // No bridge: the browser preview reads the same fixture module as the rest
  // of the page, dynamic-imported so it never reaches the packaged bundle.
  const { demoRouterCost } = await import("../../demoUsage.js");
  return demoRouterCost();
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

/** Past this many models the mix folds into "+N more"; the decisions hold the rest. */
const MIX_MODELS = 2;

function modelName(model: Pick<RouterModelCost, "provider" | "modelId">): string {
  return modelLabelFor(model.provider, model.modelId) ?? model.modelId;
}

/** The tier's models as the rest of the page draws them: provider dot, name, share. */
function ModelMix({ tier }: { tier: RouterTierCost }): JSX.Element {
  const shown = tier.models.slice(0, MIX_MODELS);
  const folded = tier.models.slice(MIX_MODELS);
  return (
    <span className="usage-router-mix">
      {shown.map((model, index) => (
        <span
          key={`${model.provider}:${model.modelId}`}
          className="usage-router-model usage-series"
          data-provider={model.provider}
          title={`${modelName(model)}, ${providerLabel(model.provider)}: ${plural(model.turns, "turn")}`}
        >
          <span className="usage-series-dot" aria-hidden="true" />
          {modelName(model)}
          <span className="usage-router-model-share">
            {formatPercent(tier.turns > 0 ? model.turns / tier.turns : null)}
          </span>
          {/* Held on the last model's line, so a wrap never strands it alone. */}
          {index === shown.length - 1 && folded.length > 0 ? (
            <span
              className="usage-router-more"
              title={folded.map((rest) => `${modelName(rest)} ×${formatCount(rest.turns)}`).join(" · ")}
            >
              +{formatCount(folded.length)} more
            </span>
          ) : null}
        </span>
      ))}
    </span>
  );
}

function plural(count: number, noun: string): string {
  return `${formatCount(count)} ${count === 1 ? noun : `${noun}s`}`;
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
                {modelName(decision)}
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
          <span className="usage-router-name">
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
            {/* Fully priced is the normal case, so only the exception is flagged. */}
            {tier.unpricedTurns > 0 ? (
              <span
                className="usage-badge"
                data-tone="unpriced"
                title={`${formatCount(pricedTurns)}/${formatCount(tier.turns)} turns priced`}
              >
                {formatCount(tier.unpricedTurns)} unpriced
              </span>
            ) : null}
          </span>
          {tier.models.length > 0 ? <ModelMix tier={tier} /> : null}
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
  const routedTurns = summary.tiers.reduce((sum, tier) => sum + tier.turns, 0);
  return (
    <section className="usage-section usage-router" aria-label="Router">
      <div className="usage-section-head">
        <h2 className="usage-section-title">Router</h2>
        <span className="usage-table-count">{plural(routedTurns, "routed turn")}</span>
      </div>
      <div className="usage-table-scroll">
        <table className="usage-table usage-router-tiers" aria-label="Router cost by tier">
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
