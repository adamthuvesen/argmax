import { useEffect, useRef } from "react";

/**
 * Mirror the phone's screen depth into browser history so Android's back
 * button and iOS's back-swipe pop one screen instead of leaving the app —
 * from a home-screen PWA, leaving means killing the session view outright.
 *
 * Screen state stays the source of truth; history is a shadow of its depth.
 * Going deeper pushes entries, and a `popstate` below the synced depth is a
 * real back gesture, so it calls `goBack`. Closing a screen in-app rewinds
 * history by the same amount, and those self-inflicted pops are counted and
 * ignored rather than bounced back into `goBack`.
 */
export function useMobileBackNavigation(depth: number, goBack: () => void): void {
  const syncedDepthRef = useRef(0);
  const selfPopsRef = useRef(0);
  const goBackRef = useRef(goBack);
  goBackRef.current = goBack;

  useEffect(() => {
    const onPopState = (): void => {
      if (selfPopsRef.current > 0) {
        selfPopsRef.current -= 1;
        return;
      }
      if (syncedDepthRef.current === 0) return;
      syncedDepthRef.current -= 1;
      goBackRef.current();
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  useEffect(() => {
    const synced = syncedDepthRef.current;
    if (depth === synced) return;
    syncedDepthRef.current = depth;
    if (depth > synced) {
      for (let entry = synced; entry < depth; entry += 1) {
        window.history.pushState({ argmaxScreenDepth: entry + 1 }, "");
      }
      return;
    }
    // Popping our own entries keeps the history stack the same length as the
    // screen stack, so the next hardware back still lands one screen up.
    selfPopsRef.current += synced - depth;
    window.history.go(depth - synced);
  }, [depth]);
}
