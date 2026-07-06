import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import { AppErrorBoundary } from "./components/AppErrorBoundary.js";
import "./lib/tauriBridge.js";
import "./lib/windowChrome.js";
// Non-default font CSS bundles download only when the user picks them in
// Settings → Appearance.
import "./styles.css";

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
