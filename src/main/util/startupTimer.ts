import { performance } from "node:perf_hooks";

export type StartupPhase =
  | "boot"
  | "db.open"
  | "services.construct"
  | "ipc.register"
  | "window.create"
  | "window.ready-to-show";

export interface StartupPhaseRecord {
  phase: StartupPhase;
  /** ms since the process started (always rounded to 2 decimals). */
  elapsedMs: number;
  /** ms since the previous phase marked (or 0 for the first mark). */
  deltaMs: number;
}

const ROUND = (ms: number): number => Math.round(ms * 100) / 100;

/**
 * Captures `performance.now()` deltas at named startup phases so the
 * Diagnostics panel + the perf-budget doc can surface real numbers from the
 * current boot. Cheap (one `Map.set` per mark, no formatting until read) and
 * stays useful across the loop: a regression that pushes cold-start past the
 * `agents/docs/performance.md` budget shows up here first.
 *
 * The "boot" mark is recorded at module load. `mark()` returns the rounded
 * elapsed value so the call-site can also log it if it wants.
 */
const start = performance.now();
const phases: StartupPhaseRecord[] = [
  { phase: "boot", elapsedMs: 0, deltaMs: 0 }
];

export function mark(phase: StartupPhase): StartupPhaseRecord {
  const elapsedMs = ROUND(performance.now() - start);
  const previous = phases[phases.length - 1];
  const deltaMs = previous ? ROUND(elapsedMs - previous.elapsedMs) : 0;
  const record: StartupPhaseRecord = { phase, elapsedMs, deltaMs };
  phases.push(record);
  return record;
}

export function readPhases(): StartupPhaseRecord[] {
  return phases.slice();
}

/** Test-only: reset phases between fixtures so they don't leak across tests. */
export function resetPhasesForTesting(): void {
  phases.length = 0;
  phases.push({ phase: "boot", elapsedMs: 0, deltaMs: 0 });
}
