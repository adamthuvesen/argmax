import { useEffect } from "react";

/** Mirror a React state value into `localStorage` whenever it changes. */
export function usePersistedSetting(key: string, value: string): void {
  useEffect(() => {
    try {
      window.localStorage.setItem(key, value);
    } catch {
      // Quota or private-mode failures are non-fatal for appearance prefs.
    }
  }, [key, value]);
}
