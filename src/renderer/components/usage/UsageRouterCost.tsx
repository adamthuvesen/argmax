import { ChevronRight } from "lucide-react";
import { useEffect, useId, useRef, useState, type CSSProperties, type JSX } from "react";
import type { RouterCostSummary, RouterModelCost, RouterTierCost, UsageWindow } from "../../../shared/types.js";
import { modelLabelFor } from "../../../shared/providerModels.js";
import { formatElapsedSeconds } from "../../formatElapsed.js";
import { AUTO_TIER_SHORT_LABELS } from "../../lib/models.js";
import { formatCount, formatPercent, formatTokens, formatUsd, formatUsdRate } from "./usageFormat.js";
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
const MIX_MODELS = 3;

function modelName(model: Pick<RouterModelCost, "provider" | "modelId">): string {
  return modelLabelFor(model.provider, model.modelId) ?? model.modelId;
}

/**
 * The tier's models as the rest of the page draws them, one per line: provider
 * dot, name, share. The shares line up in their own column.
 */
function ModelMix({ tier }: { tier: RouterTierCost }): JSX.Element {
  const shown = tier.models.slice(0, MIX_MODELS);
  const folded = tier.models.slice(MIX_MODELS);
  return (
    <span className="usage-router-mix">
      {shown.map((model) => (
        <span
          key={`${model.provider}:${model.modelId}`}
          className="usage-router-model usage-series"
          data-provider={model.provider}
          title={`${modelName(model)}, ${providerLabel(model.provider)}: ${plural(model.turns, "turn")}`}
        >
          <span className="usage-series-dot" aria-hidden="true" />
          <span className="usage-router-model-name">{modelName(model)}</span>
          <span className="usage-router-model-share">
            {formatPercent(tier.turns > 0 ? model.turns / tier.turns : null)}
          </span>
        </span>
      ))}
      {folded.length > 0 ? (
        <span
          className="usage-router-more"
          title={folded.map((rest) => `${modelName(rest)} ×${formatCount(rest.turns)}`).join(" · ")}
        >
          +{formatCount(folded.length)} more
        </span>
      ) : null}
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
                <span className="usage-router-note">
                  {decision.difficulty ?? "Difficulty not recorded"}
                </span>
              </th>
              <td>
                {modelName(decision)}
                <span className="usage-router-note">
                  {providerLabel(decision.provider)} · {decision.reasoningEffort ?? "No effort recorded"}
                </span>
              </td>
              <td>
                {DECISION_LABELS[decision.decision] ?? decision.decision}
                <span className="usage-router-note">{decision.reason}</span>
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

function totalCost(tier: RouterTierCost): number {
  return tier.measuredCostUsd + tier.estimatedCostUsd;
}

function pricedTurnsOf(tier: RouterTierCost): number {
  return tier.turns - tier.unpricedTurns;
}

type FigureGroup = "volume" | "spend" | "tokens" | "pace";

/** One figure column: its family, header, the number behind it (null when unknown), and its text. */
type Figure = {
  group: FigureGroup;
  header: string;
  title?: string;
  value: (tier: RouterTierCost) => number | null;
  format: (value: number, tier: RouterTierCost) => string;
};

const formatTierCost = (value: number, tier: RouterTierCost): string =>
  formatCost(value, tier.estimatedCostUsd > 0);

const FIGURES: readonly Figure[] = [
  { group: "volume", header: "Chats", value: (tier) => tier.chats, format: formatCount },
  { group: "volume", header: "Turns", value: (tier) => tier.turns, format: formatCount },
  {
    group: "spend",
    header: "Cost",
    value: (tier) => (pricedTurnsOf(tier) > 0 ? totalCost(tier) : null),
    format: formatTierCost
  },
  {
    group: "spend",
    header: "Per turn",
    value: (tier) => {
      const priced = pricedTurnsOf(tier);
      return priced > 0 ? totalCost(tier) / priced : null;
    },
    format: formatTierCost
  },
  {
    group: "tokens",
    header: "Per turn",
    title: "Median tokens processed per turn, cache included",
    value: (tier) => tier.medianTurnTokens,
    format: formatTokens
  },
  {
    group: "tokens",
    header: "$ / 1M",
    title: "Cost per million tokens processed, cache included",
    value: (tier) =>
      pricedTurnsOf(tier) > 0 && tier.pricedTokens > 0
        ? (totalCost(tier) / tier.pricedTokens) * 1_000_000
        : null,
    format: (value, tier) => `${tier.estimatedCostUsd > 0 ? "≈" : ""}${formatUsdRate(value)}`
  },
  { group: "pace", header: "Turn time", value: (tier) => tier.medianTurnSeconds, format: formatSeconds },
  {
    group: "pace",
    header: "Tok / s",
    title: "Output tokens per second of turn time, approval waits excluded",
    value: (tier) => tier.outputTokensPerSecond,
    format: (value) => (value === null ? "—" : String(Math.round(value)))
  },
  { group: "pace", header: "Escalations", value: (tier) => tier.escalations, format: formatCount }
];

/**
 * Each tier's figure as a share of the column's largest (0–1), so the larger
 * figure takes the deeper wash in proportion to the gap: $0.16 against $0.32
 * is half as deep, not blank against full. A lone figure or a column of
 * zeros stays at the base wash.
 */
function figureHeat(tiers: readonly RouterTierCost[]): Array<Array<number | null>> {
  const columns = FIGURES.map((figure) => tiers.map((tier) => figure.value(tier)));
  return tiers.map((_, row) =>
    columns.map((values) => {
      const value = values[row];
      if (value === null) return null;
      const known = values.filter((other): other is number => other !== null);
      // A lone figure has nothing to be compared with.
      if (known.length < 2) return 0;
      const high = Math.max(...known);
      return high > 0 ? value / high : 0;
    })
  );
}

function TierRow({ tier, heat }: { tier: RouterTierCost; heat: Array<number | null> }): JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const detailsId = useId();
  const pricedTurns = pricedTurnsOf(tier);
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
                className="usage-router-unpriced"
                title={`${formatCount(pricedTurns)}/${formatCount(tier.turns)} turns priced`}
              >
                {formatCount(tier.unpricedTurns)} unpriced
              </span>
            ) : null}
          </span>
          {tier.models.length > 0 ? <ModelMix tier={tier} /> : null}
        </th>
        {FIGURES.map((figure, index) => {
          const value = figure.value(tier);
          const level = heat[index];
          return (
            <td key={`${figure.group}:${figure.header}`} className="usage-table-num" data-group={figure.group}>
              {value === null ? (
                <span className="usage-router-none">—</span>
              ) : (
                <span
                  className="usage-router-figure"
                  data-zero={value === 0 ? "" : undefined}
                  style={{ "--router-heat": level ?? 0 } as CSSProperties}
                >
                  {figure.format(value, tier)}
                </span>
              )}
            </td>
          );
        })}
      </tr>
      {hasDecisions && expanded ? (
        <tr>
          <td colSpan={FIGURES.length + 1} className="usage-router-detail-cell" id={detailsId}>
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
  const heat = figureHeat(summary.tiers);
  return (
    <section className="usage-section usage-router" aria-label="Router">
      <div className="usage-section-head">
        <h2 className="usage-section-title">Router</h2>
        <span className="usage-table-count">{plural(routedTurns, "routed turn")}</span>
      </div>
      <div className="usage-table-scroll">
        <table className="usage-table usage-router-tiers" aria-label="Router cost by tier">
          <thead>
            {/* Each family of figures carries one hue, so the eye can tell
                spend from tokens from time without reading every header. */}
            <tr className="usage-router-groups">
              <td />
              <th scope="colgroup" colSpan={2} data-group="volume">Volume</th>
              <th scope="colgroup" colSpan={2} data-group="spend">Spend</th>
              <th scope="colgroup" colSpan={2} data-group="tokens">Tokens</th>
              <th scope="colgroup" colSpan={2} data-group="pace">Pace</th>
            </tr>
            <tr>
              <th scope="col">Tier</th>
              {FIGURES.map((figure) => (
                <th
                  key={`${figure.group}:${figure.header}`}
                  scope="col"
                  className="usage-table-num"
                  data-group={figure.group}
                  title={figure.title}
                >
                  {figure.header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {summary.tiers.map((tier, index) => (
              <TierRow key={tier.tier} tier={tier} heat={heat[index] ?? []} />
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
