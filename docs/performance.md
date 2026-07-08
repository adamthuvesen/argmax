# Performance Budgets

Budgets cover cold start, IPC latency, and renderer hot paths.

## Startup

[src-tauri/src/util/startup_timer.rs](../src-tauri/src/util/startup_timer.rs) records app boot phases and `system:diagnostics` exposes them. Target `boot → window.ready-to-show` is ≤ 800 ms for the Tauri build.

## Renderer Perf

Run:

```bash
npm run test:perf
```

Pinned budgets in [src/test/perf.test.ts](../src/test/perf.test.ts):

- `mergeDashboardDelta` over 200 sessions: p95 < 5 ms.
- `mergeDashboardDelta` with a 500-delta streamed answer + tool rows: p95 < 5 ms.
- `buildFileTree` over 10,000 entries: < 75 ms.
- `searchFilePaths` over 10,000 entries: p95 < 25 ms.
- `parseUnifiedDiff` over a 500-hunk synthetic diff: p95 < 20 ms.

## IPC Latency

[src-tauri/src/util/ipc_latency.rs](../src-tauri/src/util/ipc_latency.rs) tracks per-channel p50/p99/count. `system:diagnostics` returns the histogram for Settings → Diagnostics. Investigate any request channel whose p99 exceeds 100 ms.

Subagent trace scans must stay pane-scoped. Main chat polling uses
`session:events-since`; only an open agent activity pane calls
`session:agent-events`, and it stops polling once the parent session and parent
tool are done. The agent-events read scans at most the newest
`SESSION_AGENT_EVENT_SCAN_LIMIT` (2000) rows of the parent session, so a long
session never turns pane polling into a full-table scan. Codex discovery is bounded to the parent launch date plus nearby
session folders, and Cursor prompt fallback checks the workspace project first
before looking across other Cursor project roots.
