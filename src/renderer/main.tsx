import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import { AppErrorBoundary } from "./components/AppErrorBoundary.js";
import "./lib/tauriBridge.js";
import "./lib/windowChrome.js";
// Non-default font CSS bundles download only when the user picks them in
// Settings → Appearance.
import "./styles.css";

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
