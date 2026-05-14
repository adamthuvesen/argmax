import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import { AppErrorBoundary } from "./components/AppErrorBoundary.js";
// Alternative font CSS bundles (@fontsource-variable/jetbrains-mono, fira-code,
// geist-mono, @fontsource/ibm-plex-mono) used to load eagerly here. Ralph B6
// moved them to `loadFontAssets()` so they download only when the user picks
// a non-default font in Settings → Appearance.
import "./styles.css";

createRoot(document.getElementById("root") as HTMLElement).render(
  <StrictMode>
    <AppErrorBoundary>
      <App />
    </AppErrorBoundary>
  </StrictMode>
);
