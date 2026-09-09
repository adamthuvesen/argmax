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
 *
 * `history.go` is asynchronous. Pushes that land while those pops are still
 * in flight would be the next things popped, so the stack is left short of
 * the screen and the next hardware back leaves the app. Depth changes wait
 * for the in-flight rewind to drain before they push.
 */
export function useMobileBackNavigation(depth: number, goBack: () => void): void {
  const syncedDepthRef = useRef(0);
  const selfPopsRef = useRef(0);
  const pendingDepthRef = useRef(depth);
  const goBackRef = useRef(goBack);
  goBackRef.current = goBack;

  const applyDepth = (next: number): void => {
    if (selfPopsRef.current > 0) return;
    const synced = syncedDepthRef.current;
    if (next === synced) return;
    syncedDepthRef.current = next;
    if (next > synced) {
      for (let entry = synced; entry < next; entry += 1) {
        window.history.pushState({ argmaxScreenDepth: entry + 1 }, "");
      }
      return;
    }
    // Popping our own entries keeps the history stack the same length as the
    // screen stack, so the next hardware back still lands one screen up.
    selfPopsRef.current += synced - next;
    window.history.go(next - synced);
  };

  useEffect(() => {
    const onPopState = (): void => {
      if (selfPopsRef.current > 0) {
        selfPopsRef.current -= 1;
        if (selfPopsRef.current === 0) applyDepth(pendingDepthRef.current);
        return;
      }
      if (syncedDepthRef.current === 0) return;
      syncedDepthRef.current -= 1;
      pendingDepthRef.current = syncedDepthRef.current;
      goBackRef.current();
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  useEffect(() => {
    pendingDepthRef.current = depth;
    applyDepth(depth);
  }, [depth]);
}
