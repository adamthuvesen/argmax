import { useState } from "react";
import type { SessionSummary } from "../../shared/types.js";
import { isAutoTier } from "../lib/models.js";
import {
  routeSwitchDirection,
  routeSwitchElapsed,
  type RoutedModel,
  type RouteSwitch
} from "../lib/routeSwitch.js";

// A routed chat opened within this long of its launch is shown the router's
// pick once, as it arrives from the launcher's tier-only chip. Launch routing
// happens before the session exists, so the first row already carries it.
const LAUNCH_WINDOW_MS = 10_000;
// When each fresh launch was first seen, so a pane that remounts during the
// motion continues it instead of replaying it.
const launchSeenAt = new Map<string, number>();

function launchSwitch(session: SessionSummary, route: RoutedModel): RouteSwitch | null {
  const now = Date.now();
  if (!(now - Date.parse(session.startedAt) < LAUNCH_WINDOW_MS)) return null;
  let at = launchSeenAt.get(session.id);
  if (at === undefined) {
    for (const [id, seenAt] of launchSeenAt) {
      if (now - seenAt >= LAUNCH_WINDOW_MS) launchSeenAt.delete(id);
    }
    at = now;
    launchSeenAt.set(session.id, at);
  }
  return { id: 1, at, from: null, to: route, direction: "up", reason: session.autoRoute ?? null };
}

interface Tracked {
  sessionId: string | null;
  route: RoutedModel | null;
  routeSwitch: RouteSwitch | null;
}

function routedModel(session: SessionSummary | null): RoutedModel | null {
  if (!session || !isAutoTier(session.autoTier)) return null;
  return {
    provider: session.provider,
    modelId: session.modelId,
    modelLabel: session.modelLabel,
    reasoningEffort: session.reasoningEffort ?? null
  };
}

function sameRoute(a: RoutedModel | null, b: RoutedModel | null): boolean {
  return (
    a?.provider === b?.provider &&
    a?.modelId === b?.modelId &&
    a?.reasoningEffort === b?.reasoningEffort
  );
}

/**
 * The latest switch the router made in this chat, or null. Derived during
 * render rather than in an effect so the switch lands in the same commit as
 * the chip's new label; an effect would paint the new label once, unmoved,
 * before the motion began. Opening another chat, or a pin that ends Auto,
 * clears it. The route a chat already had when it was opened is not a switch,
 * unless the chat was launched moments ago: then its first route is the
 * router's pick, arriving (`from` is null).
 */
export function useRouteSwitch(session: SessionSummary | null): RouteSwitch | null {
  const sessionId = session?.id ?? null;
  const route = routedModel(session);
  const [tracked, setTracked] = useState<Tracked>(() => ({
    sessionId,
    route,
    routeSwitch: session && route ? launchSwitch(session, route) : null
  }));
  if (tracked.sessionId === sessionId && sameRoute(tracked.route, route)) {
    return tracked.routeSwitch;
  }
  const sameChat = tracked.sessionId === sessionId;
  let routeSwitch: RouteSwitch | null = null;
  if (session && route && !sameChat) {
    routeSwitch = launchSwitch(session, route);
  } else if (session && route && tracked.route) {
    routeSwitch = {
      id: (tracked.routeSwitch?.id ?? 0) + 1,
      at: Date.now(),
      from: tracked.route,
      to: route,
      direction: routeSwitchDirection(tracked.route, route),
      reason: session.autoRoute ?? null
    };
  }
  const next: Tracked = { sessionId, route, routeSwitch };
  setTracked(next);
  return next.routeSwitch;
}

/**
 * How far into `routeSwitch`'s motion this component is, fixed when it first
 * sees the switch: 0 for a chip on screen as the switch lands, more for one
 * that mounted mid-motion, null once a motion of `durationMs` is over (a chip
 * remounted later must not replay it).
 */
export function useRouteSwitchElapsed(
  routeSwitch: RouteSwitch | null | undefined,
  durationMs: number
): number | null {
  const id = routeSwitch?.id ?? null;
  const read = (): { id: number | null; elapsed: number | null } => ({
    id,
    elapsed: routeSwitch ? routeSwitchElapsed(routeSwitch, durationMs) : null
  });
  const [seen, setSeen] = useState(read);
  if (seen.id === id) return seen.elapsed;
  const next = read();
  setSeen(next);
  return next.elapsed;
}
