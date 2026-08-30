# Performance Budgets

Performance budgets define targets for cold start, IPC response times, and frontend data transformations.

## Startup Budget

Tracked by [src-tauri/src/util/startup_timer.rs](../src-tauri/src/util/startup_timer.rs) and exposed via `system:diagnostics`. Target `boot → window.ready-to-show` is ≤ 800 ms on macOS.

- `sessions.recover`: Uses the `idx_events_restart_recovery` partial index (migration v13) to keep startup orphan detection bounded to O(sessions).
- Process orphan scans run in background tasks to avoid blocking the setup hook.

## Renderer Benchmarks

Run via:

```bash
npm run test:perf
```

Targets defined in [src/test/perf.test.ts](../src/test/perf.test.ts):

- `mergeDashboardDelta` across 200 sessions: p95 < 5 ms.
- `mergeDashboardDelta` with 500 deltas + tool rows: p95 < 5 ms.
- `buildFileTree` across 10,000 files: < 75 ms.
- `searchFilePaths` across 10,000 paths: p95 < 25 ms.
- `parseUnifiedDiff` across a 500-hunk diff: p95 < 20 ms.

## IPC Latency

[src-tauri/src/util/ipc_latency.rs](../src-tauri/src/util/ipc_latency.rs) tracks latency histograms accessible in Settings → Diagnostics. Target p99 is < 100 ms.

To prevent IPC bottlenecks:
- General timeline polling uses `session:events-since`.
- `session:agent-events` is only invoked when an agent activity pane is mounted, bounded by `SESSION_AGENT_EVENT_SCAN_LIMIT` (2,000 rows).
