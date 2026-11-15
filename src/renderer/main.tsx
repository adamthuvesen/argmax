import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import { AppErrorBoundary } from "./components/AppErrorBoundary.js";
import "./lib/tauriBridge.js";
import "./lib/windowChrome.js";
import { initActivityMark } from "./lib/activityMark.js";
import { initActivityIconColorMode } from "./lib/activityIconColorMode.js";
import { installDragBreadcrumbs } from "./lib/dragLog.js";
import { startFrameGapSampler } from "./lib/frameGapSampler.js";
import { installVerificationDiagnostics } from "./lib/verificationDiagnostics.js";
// Non-default font CSS bundles download only when the user picks them in
// Settings → Appearance.
import "./styles.css";

// Before the first icon or mark paints, so stylesheet-only appearance choices
// keyed off `<html>` are never a frame behind.
initActivityMark();
initActivityIconColorMode();

if (import.meta.env.VITE_ARGMAX_VERIFICATION === "1") {
  installVerificationDiagnostics();
}

// Drag and drop stops working window-wide after hours of use, and the page
// keeps no record of whether the events still arrive. Debug → Logs, scope
// `renderer::drag`.
installDragBreadcrumbs();

// Counterpart of the delta-burst warning in tauriBridge.ts: when streaming
// visibly freezes and then floods in, a frame gap logged here pins the stall
// on this JS thread; no gap plus a delivery-burst warning pins it on the
// backend event-loop hop. WKWebView never fires `longtask`, so frame gaps
// are the only stall signal this thread has.
startFrameGapSampler();

// StrictMode double-invokes effects + commit in development so it catches
// unsafe lifecycles early. Production renders the app once.
const root = (
  <AppErrorBoundary>
    <App />
  </AppErrorBoundary>
);

createRoot(document.getElementById("root") as HTMLElement).render(
  import.meta.env.DEV ? <StrictMode>{root}</StrictMode> : root,
);
