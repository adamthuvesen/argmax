import { useCallback, useEffect, useState } from "react";
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
 * invokes `retry`. The fetcher reference must be stable (useCallback) — the
 * hook does not refetch on identity change because most call sites want the
 * fetcher to mount-once-retry-many semantic.
 */
export function useAsyncLoad<T>(
  fetcher: () => Promise<T>,
  options?: AsyncLoadOptions
): AsyncLoadState<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  const retry = useCallback(async (): Promise<void> => {
    if (typeof window === "undefined" || !window.argmax) {
      if (options?.missingApiMessage) {
        setError(options.missingApiMessage);
      }
      return;
    }
    setIsLoading(true);
    setError(null);
    try {
      const result = await fetcher();
      setData(result);
    } catch (caught) {
      setError(errorMessage(caught) || options?.fallbackMessage || "Request failed.");
    } finally {
      setIsLoading(false);
    }
    // Intentionally omitting `fetcher` from deps: callers pass an inline
    // closure each render. Re-firing on identity change would defeat the
    // mount-once contract; callers explicitly call `retry` when they want
    // another pass.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [options?.missingApiMessage, options?.fallbackMessage]);

  useEffect(() => {
    void retry();
  }, [retry]);

  return { data, error, isLoading, retry };
}
