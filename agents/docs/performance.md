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

The phase records survive across the app lifetime and are surfaced through `system:perfStats` (Phase 7 — pending). A phase whose `deltaMs` exceeds its budget will be flagged red in the diagnostics panel.

## Bench harness

Run the perf suite from a clean checkout:

```bash
npm test -- src/test/perf.test.ts
```

(Suite TBD as part of P4.10 — placeholder section.)

Documented budgets:

- `mergeDashboardDelta` over a 200-session payload: p95 < 5 ms.
- `buildFileTree` over 10 000 entries: < 50 ms.
- `runMigrations` on an empty DB: < 200 ms.

The first two ride on existing test files (`snapshot.test.ts`, `WorkspaceTree.test.tsx`). `runMigrations` runs implicitly inside every `createDatabase(":memory:")` call in `database.test.ts` — its wall-clock cost shows up in vitest's per-test duration.

## IPC latency (planned, P4.02)

`withValidation` will wrap each handler with a rolling-window timer (last 100 invocations) and expose p50 / p99 / count via `system:perfStats`. The Diagnostics panel will render the histogram. Budget: any handler whose p99 exceeds 100 ms is investigated.
