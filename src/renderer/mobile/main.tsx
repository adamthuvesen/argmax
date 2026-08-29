import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
// Installs window.argmax. The inline script in mobile.html sets
// `argmax.remote` before this module graph loads, so the bridge picks the
// WebSocket transport.
import "../lib/tauriBridge.js";
import { AppErrorBoundary } from "../components/AppErrorBoundary.js";
import { MobileApp } from "./MobileApp.js";
import "../styles.css";
import "../styles/mobile.css";

const root = (
  <AppErrorBoundary>
    <MobileApp />
  </AppErrorBoundary>
);

createRoot(document.getElementById("root") as HTMLElement).render(
  import.meta.env.DEV ? <StrictMode>{root}</StrictMode> : root
);
