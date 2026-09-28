import {
  MODEL_PRICING,
  normalizeModelId,
  REASONING_EFFORTS,
  type ReasoningEffort
} from "../../shared/providerModels.js";
import type { ProviderId } from "../../shared/types.js";

/** The session fields a route sets, under their SessionSummary names. */
export interface RoutedModel {
  provider: ProviderId;
  modelId: string;
  modelLabel: string;
  reasoningEffort: ReasoningEffort | null;
}

/**
 * The router moving a chat it drives to another model or effort, as the
 * composer's chip shows it. Its motion is one shot per switch: `id` keys it,
 * and `at` lets a chip that mounts mid-switch (the composer swaps pickers as
 * the rerouted turn starts running) pick the motion up where it is instead of
 * replaying it or skipping it.
 */
export interface RouteSwitch {
  /** Counts switches within one chat. */
  id: number;
  /** `Date.now()` when the switch was seen. */
  at: number;
  /** Null for a fresh launch: the router's first pick for the chat. */
  from: RoutedModel | null;
  to: RoutedModel;
  direction: "up" | "down";
  /** The router's reason for the new route (`sessions.auto_route`). */
  reason: string | null;
}

function effortRank(effort: ReasoningEffort | null): number {
  return effort ? REASONING_EFFORTS.indexOf(effort) : -1;
}

/**
 * Whether a switch moved to a stronger or a lighter route. A model change is
 * judged by output price, which orders every ladder the router climbs (Opus →
 * Fable, Sol → Astra, Grok → Opus); an unpriced model (Cursor's) or an
 * effort-only change is judged by effort. A tie reads as up: the router only
 * switches sideways to restore a route, and a restore is a step back up.
 */
export function routeSwitchDirection(from: RoutedModel, to: RoutedModel): "up" | "down" {
  if (from.modelId !== to.modelId) {
    const fromPrice = MODEL_PRICING[normalizeModelId(from.modelId)]?.output;
    const toPrice = MODEL_PRICING[normalizeModelId(to.modelId)]?.output;
    if (fromPrice !== undefined && toPrice !== undefined && fromPrice !== toPrice) {
      return toPrice > fromPrice ? "up" : "down";
    }
  }
  return effortRank(to.reasoningEffort) < effortRank(from.reasoningEffort) ? "down" : "up";
}

/** How long each piece of a switch's motion on the chip takes, in ms. Slow
 *  enough to read: at a snappier pace the pick was gone before the eye
 *  found the chip. */
export interface RouteSwitchPace {
  /** Before anything moves. */
  delayMs: number;
  /** Each label's roll. */
  rollMs: number;
  /** How far the effort's roll trails the model's. */
  staggerMs: number;
  flushMs: number;
  ringMs: number;
  /** The new effort word holding the accent, then cooling. */
  inkMs: number;
  captionMs: number;
}

const PACE: Omit<RouteSwitchPace, "delayMs"> = {
  rollMs: 900,
  // Close enough that model and effort read as one motion: further apart,
  // the pill visibly grew in two steps.
  staggerMs: 120,
  flushMs: 1800,
  ringMs: 1400,
  inkMs: 2800,
  captionMs: 4500
};

// A launch waits for the new chat's pane to finish fading in (280ms) before
// the pick arrives; a reroute lands on a composer already in view.
const LAUNCH_DELAY_MS = 500;

export function routeSwitchPace(routeSwitch: RouteSwitch): RouteSwitchPace {
  return { ...PACE, delayMs: routeSwitch.from ? 0 : LAUNCH_DELAY_MS };
}

/** When the chip's motion is over: the new effort's ink, its last piece, has cooled. */
export function routeSwitchMotionMs(routeSwitch: RouteSwitch | null | undefined): number {
  if (!routeSwitch) return 0;
  const pace = routeSwitchPace(routeSwitch);
  return pace.delayMs + pace.staggerMs + pace.inkMs;
}

/** How far into a switch's motion a component seeing it now is, or null when
 *  a motion of `durationMs` would already be over. */
export function routeSwitchElapsed(
  routeSwitch: RouteSwitch,
  durationMs: number,
  now = Date.now()
): number | null {
  const elapsed = Math.max(0, now - routeSwitch.at);
  return elapsed < durationMs ? elapsed : null;
}

/** Splits two labels at the first word that differs, so only the words that
 *  changed roll: "Balance → Opus 5.5" → "Balance → Fable 5.1" rolls only the
 *  model. */
export function splitAtChange(from: string, to: string): [prefix: string, fromRest: string, toRest: string] {
  let common = 0;
  while (common < from.length && common < to.length && from[common] === to[common]) common += 1;
  // A label that only grows ("Balance" → "Balance → Opus 5.5") keeps what it
  // had and rolls in the rest.
  const cut =
    common === from.length && (common === to.length || to[common] === " ")
      ? common
      : to.lastIndexOf(" ", common - 1) + 1;
  return [to.slice(0, cut), from.slice(cut), to.slice(cut)];
}

export function prefersReducedMotion(): boolean {
  return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
}
