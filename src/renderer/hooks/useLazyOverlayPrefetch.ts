import { lazy, useEffect } from "react";

// Heavy overlays are dynamic-imported on first open so the launcher's first
// paint doesn't construct the palette / search code paths (audit P4.03).
// The import functions are extracted so we can also warm them on idle after
// first paint — that way the cold ⌘K / ⌘F / Settings open hits a cached
// module instead of paying for transform+fetch+parse on the keypress.
const importCommandPalette = () => import("../components/CommandPalette.js");
const importSearchOverlay = () => import("../components/SearchOverlay.js");
const importSettingsPanel = () => import("../components/SettingsPanel.js");
// ReviewPanel pulls in CodeMirror + every @codemirror/lang-* package — ~680KB.
// LaunchSurface and SessionPane each lazy-import it locally; warming it from
// here means the first ⌘P Enter (which opens ReviewPanel in Files mode) hits a
// cached module rather than paying for the chunk fetch on the keypress. Vite
// dedupes by resolved URL so the lazy `import("./ReviewPanel.js")` sites and
// this prefetch share the same module instance.
const importReviewPanel = () => import("../components/ReviewPanel.js");
const importWorkspaceContentSearch = () => import("../components/WorkspaceContentSearchOverlay.js");

export const CommandPalette = lazy(async () => ({
  default: (await importCommandPalette()).CommandPalette
}));
export const WorkspaceContentSearchOverlay = lazy(async () => ({
  default: (await importWorkspaceContentSearch()).WorkspaceContentSearchOverlay
}));
export const SearchOverlay = lazy(async () => ({
  default: (await importSearchOverlay()).SearchOverlay
}));
export const SettingsPanel = lazy(async () => ({
  default: (await importSettingsPanel()).SettingsPanel
}));

/** Warm lazy overlay chunks after first paint so the first ⌘K / ⌘F / Settings open isn't paying for transform+fetch+parse on the keypress. */
export function useLazyOverlayPrefetch(): void {
  useEffect(() => {
    if (typeof window === "undefined") return;
    // Each .catch(() => {}) avoids an unhandled rejection on a transient
    // chunk-fetch failure. The on-demand Suspense import retries
    // independently so functionality isn't lost; this just keeps the
    // unhandledrejection handler quiet (R-032).
    const swallow = (): void => undefined;
    const ric = (window as Window & {
      requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
      cancelIdleCallback?: (id: number) => void;
    }).requestIdleCallback;
    const cic = (window as Window & { cancelIdleCallback?: (id: number) => void }).cancelIdleCallback;
    const timers: number[] = [];
    const ricIds: number[] = [];
    // Two passes, in priority order. The ⌘K / ⌘F overlays are small and on
    // the hot path, so warm them first. The heavy chunks — ReviewPanel pulls
    // CodeMirror + every @codemirror/lang-* (~680KB) and SettingsPanel is
    // bulky too — warm on a *later* idle tick. In dev (unbundled modules) that
    // keeps CodeMirror's large transform from queueing ahead of the search
    // chunks and slowing the first ⌘K open; in prod it just orders the fetches.
    const warmHeavy = (): void => {
      importSettingsPanel().catch(swallow);
      importReviewPanel().catch(swallow);
    };
    const scheduleHeavy = (): void => {
      if (typeof ric === "function") {
        ricIds.push(ric(warmHeavy, { timeout: 3000 }));
      } else {
        timers.push(window.setTimeout(warmHeavy, 600));
      }
    };
    const warmSearch = (): void => {
      importCommandPalette().catch(swallow);
      importSearchOverlay().catch(swallow);
      importWorkspaceContentSearch().catch(swallow);
      scheduleHeavy();
    };
    if (typeof ric === "function") {
      ricIds.push(ric(warmSearch, { timeout: 800 }));
    } else {
      timers.push(window.setTimeout(warmSearch, 400));
    }
    return () => {
      if (typeof cic === "function") ricIds.forEach((id) => cic(id));
      timers.forEach((id) => window.clearTimeout(id));
    };
  }, []);
}
