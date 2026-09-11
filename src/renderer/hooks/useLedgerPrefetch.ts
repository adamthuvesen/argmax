import { useEffect } from "react";
import { scheduleLedgerPrefetch } from "../lib/ledgerPrefetch.js";

/**
 * After the dashboard is ready, warm Usage and Activity on an idle tick. The
 * work itself runs on Rust's blocking pool; this hook only decides when to
 * ask, so boot and first paint are not competing with transcript/git walks.
 */
export function useLedgerPrefetch(ready: boolean): void {
  useEffect(() => {
    if (!ready || typeof window === "undefined" || !window.argmax) return;
    scheduleLedgerPrefetch(window.argmax);
  }, [ready]);
}
