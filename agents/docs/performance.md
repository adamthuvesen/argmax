# Performance Budgets

Budgets cover cold start, IPC latency, and renderer hot paths.

## Startup

[src-tauri/src/util/startup_timer.rs](../../src-tauri/src/util/startup_timer.rs) records app boot phases and `system:diagnostics` exposes them. Target `boot → window.ready-to-show` is ≤ 800 ms for the Tauri build.

## Renderer Perf

Run:

```bash
npm run test:perf
```

Pinned budgets in [src/test/perf.test.ts](../../src/test/perf.test.ts):

- `mergeDashboardDelta` over 200 sessions: p95 < 5 ms.
- `buildFileTree` over 10,000 entries: < 75 ms.
- `parseUnifiedDiff` over a 500-hunk synthetic diff: p95 < 20 ms.

## IPC Latency

[src-tauri/src/util/ipc_latency.rs](../../src-tauri/src/util/ipc_latency.rs) tracks per-channel p50/p99/count. `system:diagnostics` returns the histogram for Settings → Diagnostics. Investigate any request channel whose p99 exceeds 100 ms.
