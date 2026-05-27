import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import { AppErrorBoundary } from "./components/AppErrorBoundary.js";
import "./lib/tauriBridge.js";
// Alternative font CSS bundles (@fontsource-variable/jetbrains-mono, fira-code,
// geist-mono, @fontsource/ibm-plex-mono) used to load eagerly here. Ralph B6
// moved them to `loadFontAssets()` so they download only when the user picks
// a non-default font in Settings → Appearance.
import "./styles.css";

// StrictMode double-invokes effects + commit in development so it catches
// unsafe lifecycles early. In production it's pure overhead — the same
// effect runs twice on every mount. Ralph B8 strips it from prod builds.
const root = (
  <AppErrorBoundary>
    <App />
  </AppErrorBoundary>
);

createRoot(document.getElementById("root") as HTMLElement).render(
  import.meta.env.DEV ? <StrictMode>{root}</StrictMode> : root
);
