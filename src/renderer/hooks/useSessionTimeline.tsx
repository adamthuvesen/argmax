/* eslint-disable react-refresh/only-export-components -- provider and hooks share one private context */
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useSyncExternalStore
} from "react";
import type { ReactElement, ReactNode } from "react";
import type { RawProviderOutput, TimelineEvent } from "../../shared/types.js";
import type {
  SessionTimelines,
  SessionTimelineSnapshot
} from "../lib/sessionTimelines.js";
import { useStableFilter } from "./useStableFilter.js";

const SessionTimelineContext = createContext<SessionTimelines | null>(null);
const NO_SESSION_KEY = "__argmax_no_session__";

const EMPTY_SESSION_TIMELINE: SessionTimelineSnapshot = {
  events: [],
  rawOutputs: []
};

export function SessionTimelineProvider({
  store,
  children
}: {
  store: SessionTimelines;
  children: ReactNode;
}): ReactElement {
  return (
    <SessionTimelineContext.Provider value={store}>
      {children}
    </SessionTimelineContext.Provider>
  );
}

export function useSessionTimelineStore(): SessionTimelines | null {
  return useContext(SessionTimelineContext);
}

export function useSessionTimeline(
  sessionId: string | null,
  fallbackEvents: TimelineEvent[] = [],
  fallbackRawOutputs: RawProviderOutput[] = [],
  explicitStore?: SessionTimelines | null
): SessionTimelineSnapshot {
  const contextStore = useSessionTimelineStore();
  const store = explicitStore === undefined ? contextStore : explicitStore;
  const filterKey = sessionId ?? NO_SESSION_KEY;
  const events = useStableFilter(
    store ? EMPTY_SESSION_TIMELINE.events : fallbackEvents,
    filterKey,
    (event) => sessionId !== null && event.sessionId === sessionId
  );
  const rawOutputs = useStableFilter(
    store ? EMPTY_SESSION_TIMELINE.rawOutputs : fallbackRawOutputs,
    filterKey,
    (output) => sessionId !== null && output.sessionId === sessionId
  );
  const fallback = useMemo<SessionTimelineSnapshot>(
    () =>
      sessionId === null
        ? EMPTY_SESSION_TIMELINE
        : {
            events,
            rawOutputs
          },
    [events, rawOutputs, sessionId]
  );
  const subscribe = useCallback(
    (listener: () => void): (() => void) =>
      store && sessionId !== null ? store.subscribe(sessionId, listener) : () => undefined,
    [sessionId, store]
  );
  const getSnapshot = useCallback(
    (): SessionTimelineSnapshot =>
      store && sessionId !== null ? store.getSnapshot(sessionId) : fallback,
    [fallback, sessionId, store]
  );

  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
