import { useCallback, useEffect, useRef, useState } from "react";
import { errorMessage } from "../../shared/error.js";
import type { ArgmaxApi, DashboardDelta } from "../../shared/types.js";
import { retainReply, retainedReply, startRetainedRead } from "./retainedReads.js";

export interface BridgeQueryOptions<T> {
  /** What this read depends on. A new key drops the old data and any reply still in flight. */
  key: readonly unknown[];
  /** The bridge call. Return `undefined` when the host has nothing to read. */
  read: (api: ArgmaxApi) => Promise<T> | undefined;
  enabled?: boolean;
  /** Runs only for a reply that is still current, so a component can seed its own state. */
  onData?: (data: T) => void;
  onError?: (error: unknown) => void;
  /**
   * Keep the reply after unmount (`retainedReads.ts`), so a remount with the
   * same key shows it at once and does not read. Use it only when the key, or
   * a delta, says when the reply goes stale: a function names the deltas that
   * drop it, and a resync always does. `refetch` still reads.
   */
  retain?: boolean | ((delta: DashboardDelta) => boolean);
}

type BridgeQueryResult<T> =
  | { status: "data"; data: T }
  | { status: "error"; error: unknown }
  /** A newer read, a local write, a new key, or an unmount replaced this read. */
  | { status: "stale" }
  /** No bridge, or `read` returned nothing. */
  | { status: "skipped" };

export interface BridgeQuery<T> {
  data: T | null;
  error: string | null;
  isLoading: boolean;
  /** False outside the Tauri host and the phone bridge: browser demo, some tests. */
  isAvailable: boolean;
  refetch: () => Promise<BridgeQueryResult<T>>;
  /** A local update. It replaces any read in flight. After the key changes it does nothing. */
  setData: (update: (current: T | null) => T | null) => void;
  /** Check this after an `await` in a handler from this render: true while its key is still shown. */
  isCurrent: () => boolean;
}

interface QueryState<T> {
  keyHash: string;
  data: T | null;
  error: string | null;
  isLoading: boolean;
}

/**
 * The one way a component reads from the bridge. Dashboard state does not use
 * it: that state comes from `loadDashboardSnapshot` and `dashboard:delta`.
 *
 * Every read takes a generation. A reply lands only if its generation is the
 * newest, so it cannot land after its key changed, a newer read started, a
 * local write replaced it, or the component unmounted.
 */
export function useBridgeQuery<T>(options: BridgeQueryOptions<T>): BridgeQuery<T> {
  const keyHash = JSON.stringify(options.key);
  const enabled = options.enabled !== false;
  const isAvailable = typeof window !== "undefined" && Boolean(window.argmax);
  const retained = options.retain ? retainedReply<T>(keyHash) : undefined;
  const [state, setState] = useState<QueryState<T>>(() =>
    retained
      ? { keyHash, data: retained.data, error: null, isLoading: false }
      : { keyHash, data: null, error: null, isLoading: enabled && isAvailable },
  );
  const latestOptions = useRef(options);
  latestOptions.current = options;
  const shownKey = useRef(keyHash);
  shownKey.current = keyHash;
  const generation = useRef(0);
  const mounted = useRef(true);

  const refetch = useCallback(async (): Promise<BridgeQueryResult<T>> => {
    const api = typeof window !== "undefined" ? window.argmax : undefined;
    if (!api) return { status: "skipped" };
    const thisGeneration = ++generation.current;
    const thisKey = shownKey.current;
    const landing = (update: (current: QueryState<T>) => QueryState<T>): void => {
      setState((current) => update(current.keyHash === thisKey ? current : emptyState<T>(thisKey)));
    };
    landing((current) => (current.isLoading ? current : { ...current, isLoading: true }));
    let pending: Promise<T> | undefined;
    const retain = latestOptions.current.retain;
    const retained = retain
      ? startRetainedRead<T>(thisKey, typeof retain === "function" ? retain : null)
      : null;
    try {
      pending = latestOptions.current.read(api);
      if (pending === undefined) {
        landing((current) => ({ ...current, isLoading: false }));
        return { status: "skipped" };
      }
      const data = await pending;
      if (generation.current !== thisGeneration) return { status: "stale" };
      landing(() => ({ keyHash: thisKey, data, error: null, isLoading: false }));
      retained?.keep(data);
      latestOptions.current.onData?.(data);
      return { status: "data", data };
    } catch (error) {
      if (generation.current !== thisGeneration) return { status: "stale" };
      landing((current) => ({
        ...current,
        error: errorMessage(error) || "Could not load that.",
        isLoading: false,
      }));
      latestOptions.current.onError?.(error);
      return { status: "error", error };
    } finally {
      retained?.discard();
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    const hit = latestOptions.current.retain ? retainedReply<T>(keyHash) : undefined;
    if (enabled && hit) {
      setState((current) =>
        current.keyHash === keyHash && current.data === hit.data && !current.isLoading
          ? current
          : { keyHash, data: hit.data, error: null, isLoading: false },
      );
      latestOptions.current.onData?.(hit.data);
    } else if (enabled) void refetch();
    else setState((current) => (current.isLoading ? { ...current, isLoading: false } : current));
    return () => {
      generation.current += 1;
    };
  }, [enabled, keyHash, refetch]);

  const setData = useCallback(
    (update: (current: T | null) => T | null): void => {
      if (shownKey.current !== keyHash) return;
      generation.current += 1;
      setState((current) => {
        const base = current.keyHash === keyHash ? current : emptyState<T>(keyHash);
        const data = update(base.data);
        keep(latestOptions.current.retain, keyHash, data);
        return { ...base, data, isLoading: false };
      });
    },
    [keyHash],
  );

  const isCurrent = useCallback(() => mounted.current && shownKey.current === keyHash, [keyHash]);

  const shown =
    state.keyHash === keyHash
      ? state
      : retained
        ? { keyHash, data: retained.data, error: null, isLoading: false }
        : emptyState<T>(keyHash);
  return {
    data: shown.data,
    error: shown.error,
    isLoading: state.keyHash === keyHash || retained ? shown.isLoading : enabled && isAvailable,
    isAvailable,
    refetch,
    setData,
    isCurrent,
  };
}

function keep<T>(retain: BridgeQueryOptions<T>["retain"], keyHash: string, data: T): void {
  if (retain) retainReply(keyHash, data, typeof retain === "function" ? retain : null);
}

function emptyState<T>(keyHash: string): QueryState<T> {
  return { keyHash, data: null, error: null, isLoading: false };
}
