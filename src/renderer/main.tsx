import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import { AppErrorBoundary } from "./components/AppErrorBoundary.js";
import "./lib/tauriBridge.js";
import "./lib/windowChrome.js";
import { initActivityMark } from "./lib/activityMark.js";
import { installDragBreadcrumbs } from "./lib/dragLog.js";
import { installVerificationDiagnostics } from "./lib/verificationDiagnostics.js";
// Non-default font CSS bundles download only when the user picks them in
// Settings → Appearance.
import "./styles.css";

// Before the first mark paints, so the sidebar underline (a stylesheet-only
// effect keyed off `<html data-activity-mark>`) is never a frame behind.
initActivityMark();

if (import.meta.env.VITE_ARGMAX_VERIFICATION === "1") {
  installVerificationDiagnostics();
}

// Drag and drop stops working window-wide after hours of use, and the page
// keeps no record of whether the events still arrive. Debug → Logs, scope
// `renderer::drag`.
installDragBreadcrumbs();

// Counterpart of the delta-burst warning in tauriBridge.ts: when streaming
// visibly freezes and then floods in, a long task logged here pins the stall
// on this JS thread; no long task plus a delivery-burst warning pins it on
// the backend event-loop hop. Long tasks are rare enough in this app that
// logging every one >500ms costs nothing.
if (typeof PerformanceObserver !== "undefined") {
  try {
    new PerformanceObserver((entries) => {
      for (const entry of entries.getEntries()) {
        if (entry.duration > 500) {
          console.warn(
            `[argmax] renderer long task: JS thread blocked ${Math.round(entry.duration)}ms`
          );
        }
      }
    }).observe({ entryTypes: ["longtask"] });
  } catch {
    // longtask is unsupported in some WebKit builds; the diagnostic is optional.
  }
}

// StrictMode double-invokes effects + commit in development so it catches
// unsafe lifecycles early. Production renders the app once.
const root = (
  <AppErrorBoundary>
    <App />
  </AppErrorBoundary>
);

createRoot(document.getElementById("root") as HTMLElement).render(
  import.meta.env.DEV ? <StrictMode>{root}</StrictMode> : root
);
