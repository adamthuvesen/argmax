# Performance budgets

Tight feedback on cold start, IPC latency, and renderer perf. Numbers measured on an M2 Air; CI tolerates ~1.5× before failing the bench harness.

## Startup phase budget

`src/main/util/startupTimer.ts` records monotonic `performance.now()` marks at every named phase from process start to the window's `ready-to-show`. Phases:

| Phase | Budget | Notes |
|---|---|---|
| `boot` → `db.open` | ≤ 200 ms | SQLite open + `runMigrations` on an existing DB. First-boot migration is allowed up to 500 ms. |
| `db.open` → `services.construct` | ≤ 50 ms | Database wrapper + notification + dock-badge + provider/terminal services. |
| `services.construct` → `ipc.register` | ≤ 50 ms | `registerIpcHandlers`. Linear in channel count. |
| `ipc.register` → `window.create` | ≤ 100 ms | Menu template + BrowserWindow construction. |
| `window.create` → `window.ready-to-show` | ≤ 1 100 ms | Renderer bundle fetch + first React render. |
| **`boot` → `window.ready-to-show`** | **≤ 1 500 ms** | Cold-start budget, displayed in `Settings → Diagnostics → Startup`. |

The phase records survive across the app lifetime and are surfaced through `system:diagnostics` as `startupPhases`. A phase whose `deltaMs` exceeds its budget is flagged red in Settings → Diagnostics → Startup.

## Bench harness

Run the perf suite from a clean checkout:

```bash
npm run test:perf   # vitest.perf.config.ts — not in the default vitest include list
```

Documented budgets:

- `mergeDashboardDelta` over a 200-session payload: p95 < 5 ms.
- `buildFileTree` over 10 000 entries: < 75 ms (75 ms slack under full-suite load; see comment in `perf.test.ts`).
- `runMigrations` on an empty DB: < 200 ms.
- `parseUnifiedDiff` over a 500-hunk synthetic diff (50 files × 10 hunks × 20 lines): p95 < 20 ms.

These are pinned in [src/test/perf.test.ts](../../src/test/perf.test.ts) and run on every `npm test` after the parallel unit/integration suite finishes. Keep perf isolated from the main parallel Vitest run; these are wall-clock microbenches, so concurrent test workers measure scheduler noise as much as app code. The file-tree budget exercises `buildFileTree` directly; `WorkspaceTree.test.tsx` covers renderer virtualization behavior separately. The diff budget guards the ReviewPanel hot path — any regression in the parser fails CI before the user sees the slowdown.

## Renderer bundle budget

`npm run build` runs Vite and then `npm run check:bundle`. The custom bundle gate is the source of truth for renderer chunk size: the main `index-*.js` chunk must stay under 2.0 MB raw, while lazy chunks are reported separately so code-splitting wins remain visible. Vite's generic `chunkSizeWarningLimit` is set to the same 2 MB threshold to keep build output quiet until a chunk crosses the repo-owned budget.

## IPC latency

Every registered request/response IPC handler is wrapped by `timed(channel, listener)` in [src/main/ipc.ts](../../src/main/ipc.ts). The histogram keeps the last 100 samples per channel plus a total-sample count, and `system:diagnostics` exposes it as `ipcStats`. Settings → Diagnostics → IPC renders p50 / p99 / count. Budget: any handler whose p99 exceeds 100 ms is investigated.
