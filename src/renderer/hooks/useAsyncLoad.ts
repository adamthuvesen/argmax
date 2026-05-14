import { useCallback, useEffect, useRef, useState } from "react";
import { errorMessage } from "../../shared/error.js";

interface AsyncLoadOptions {
  /**
   * Error string surfaced when `window.argmax` is missing — common when the
   * Settings panel is rendered outside the Electron host (vitest, storybook).
   * Bypasses the fetcher so jsdom tests don't have to mock the IPC layer.
   */
  missingApiMessage?: string;
  /**
   * Fallback error string when the fetcher throws a non-Error. Most callers
   * leave this at the default — `errorMessage()` already handles the common
   * shapes — but providing a custom fallback lets the UI read in domain
   * language ("Provider discovery failed.") instead of a stringified value.
   */
  fallbackMessage?: string;
}

export interface AsyncLoadState<T> {
  data: T | null;
  error: string | null;
  isLoading: boolean;
  retry: () => Promise<void>;
}

/**
 * Single-promise async loader with `{ data, error, isLoading }` state and a
 * stable `retry` callback. Fires once on mount and again whenever the caller
 * invokes `retry`.
 *
 * Race safety: every fetch issues a monotonically increasing request id. Only
 * the most recent in-flight request is allowed to commit to state — so a slow
 * first call followed by a faster `retry()` cannot overwrite the newer result.
 * The fetcher ref is updated each render so `retry` always invokes the
 * caller's latest closure (deps don't churn `retry`'s identity).
 */
export function useAsyncLoad<T>(
  fetcher: () => Promise<T>,
  options?: AsyncLoadOptions
): AsyncLoadState<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const fetcherRef = useRef(fetcher);
  const requestId = useRef(0);
  const mounted = useRef(true);

  // Keep the ref pointed at the latest fetcher so `retry` (whose identity is
  // intentionally stable) calls the current closure, not the one captured on
  // first render. Callers don't need `useCallback` — the ref does the same
  // job without forcing every parent to memoize.
  useEffect(() => {
    fetcherRef.current = fetcher;
  });

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const retry = useCallback(async (): Promise<void> => {
    if (typeof window === "undefined" || !window.argmax) {
      if (options?.missingApiMessage) {
        setError(options.missingApiMessage);
      }
      return;
    }
    const id = ++requestId.current;
    setIsLoading(true);
    setError(null);
    try {
      const result = await fetcherRef.current();
      if (!mounted.current || id !== requestId.current) return;
      setData(result);
    } catch (caught) {
      if (!mounted.current || id !== requestId.current) return;
      setError(errorMessage(caught) || options?.fallbackMessage || "Request failed.");
    } finally {
      if (mounted.current && id === requestId.current) {
        setIsLoading(false);
      }
    }
  }, [options?.missingApiMessage, options?.fallbackMessage]);

  useEffect(() => {
    void retry();
  }, [retry]);

  return { data, error, isLoading, retry };
}
