import { rendererLogSnapshot } from "./rendererLogRing.js";

export interface VerificationDiagnosticEntry {
  timestamp: string;
  level: "warning" | "error" | "unhandled-rejection";
  message: string;
}

export interface VerificationDiagnosticsSnapshot {
  entries: VerificationDiagnosticEntry[];
  breadcrumbs: ReturnType<typeof rendererLogSnapshot>;
}

declare global {
  interface Window {
    __ARGMAX_VERIFICATION__?: {
      snapshot: () => VerificationDiagnosticsSnapshot;
    };
  }
}

const MAX_ENTRIES = 200;

function describe(value: unknown): string {
  if (value instanceof Error) return value.stack ?? value.message;
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/** Install renderer evidence capture for verification builds only. */
export function installVerificationDiagnostics(): void {
  if (window.__ARGMAX_VERIFICATION__) return;

  const entries: VerificationDiagnosticEntry[] = [];
  const record = (level: VerificationDiagnosticEntry["level"], values: unknown[]): void => {
    entries.push({
      timestamp: new Date().toISOString(),
      level,
      message: values.map(describe).join(" ")
    });
    if (entries.length > MAX_ENTRIES) entries.splice(0, entries.length - MAX_ENTRIES);
  };

  const originalWarn = console.warn.bind(console);
  const originalError = console.error.bind(console);
  console.warn = (...values: unknown[]) => {
    record("warning", values);
    originalWarn(...values);
  };
  console.error = (...values: unknown[]) => {
    record("error", values);
    originalError(...values);
  };
  window.addEventListener("error", (event) => {
    record("error", [event.error ?? event.message]);
  });
  window.addEventListener("unhandledrejection", (event) => {
    record("unhandled-rejection", [event.reason]);
  });

  window.__ARGMAX_VERIFICATION__ = {
    snapshot: () => ({ entries: entries.slice(), breadcrumbs: rendererLogSnapshot() })
  };
}
