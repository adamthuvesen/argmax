# Testing

Vitest + jsdom + colocated `*.test.ts(x)` files. Config: [vitest.config.ts](../../vitest.config.ts). Setup: [src/test/setup.ts](../../src/test/setup.ts) (loads `@testing-library/jest-dom`).

## Running

```bash
npm test                                  # all tests, rebuild:node first
npx vitest run src/renderer/              # one folder
npx vitest run src/renderer/App.test.tsx  # one file
npx vitest                                # watch mode (no rebuild)
```

If you skipped `rebuild:node`, main-process tests fail with `NODE_MODULE_VERSION` errors from `better-sqlite3`. **Renderer + shared tests don't touch native modules** — `npx vitest run src/renderer/ src/shared/` is the fast path when iterating on UI.

**Never run `npm test` in parallel.** Each starts with `npm run rebuild:node`; concurrent native rebuilds can corrupt the in-place `better-sqlite3` / `node-pty` build directories. Use one `npm test` at a time, or use `npx vitest run …` for renderer/shared-only checks when the native runtime is already correct.

## Renderer conventions

- **Query by role / `aria-label` / `title`** — never by `className`. Visual changes shouldn't break tests.
- `aria-pressed`, `aria-label`, `title`, and visible button text are part of the contract. Treat them like a public API.
- Mock `window.argmax` in `beforeEach`. The component falls back to `demoSnapshot` only when `window.argmax` is `undefined` (browser-preview mode), so renderer tests must explicitly set the mock.
- Include `dashboard.onDelta(listener)` in `ArgmaxApi` mocks: capture the listener, return an unsubscribe spy, and use `act()` when invoking the captured listener so React observes streamed updates.
- Include the focused dashboard APIs: `dashboard.list()`, `session.eventsSince()`, `workspaces.status()`, `approvals.pending()`. Normal renderer refresh should not call `dashboard.load()`.
- The renderer is delta-driven: there's no recurring `setInterval` poll. `workspaces.status()` + `approvals.pending()` fire on `document.visibilitychange` (tab focus). `App.test.tsx` pins this with `expect(setIntervalSpy).not.toHaveBeenCalledWith(expect.any(Function), 1200)` — leave that assertion in place so a regression that reintroduces background polling fails loudly.
- See [src/renderer/App.test.tsx](../../src/renderer/App.test.tsx) for the canonical pattern — mocks of every IPC namespace, a fixture `snapshot`, captured listeners.

## Main-process conventions

Most services have unit tests next to them: `approvalService.test.ts`, `providerSessionService.test.ts`, `database.test.ts`, `gitReviewService.test.ts`, `terminalService.test.ts`, `ghPoller` tests under `gh/__tests__/`, etc. They construct an in-memory SQLite via `createDatabase(":memory:")` where applicable.

- Tests that need real git operate against `os.tmpdir()` scratch repos created and destroyed per-test. Never against the working repo.
- Provider-session tests verify delta publishing happens **after** the SQLite write commits. For failure-path coverage, force persistence to throw and assert no `DashboardDelta` is published before the transaction completes.
- Focused dashboard DB tests cover `listDashboard()`, `listWorkspaceStatus()`, `listPendingApprovals()`, and `listSessionEventsSince()`. For event tails, assert SQLite `rowid` cursor behavior, not timestamp ordering — timestamps can tie during provider streaming.
- Migration tests live in `persistence/database.test.ts`. A failing one usually means the in-source `expectedColumns` manifest in `migrations.ts` drifted from the SQL; see [data.md](data.md) for the drift-detection contract.

## Regression tests worth knowing

| Test | What it guards |
|---|---|
| [src/main/__tests__/ipcHandlers.test.ts](../../src/main/__tests__/ipcHandlers.test.ts) | `IPC_CHANNELS` and the actually-registered `ipcMain.handle` set match exactly |
| [src/shared/ipcSchemas.test.ts](../../src/shared/ipcSchemas.test.ts) | Zod schemas accept realistic inputs and reject malformed ones |
| [src/shared/safeJson.test.ts](../../src/shared/safeJson.test.ts) | JSON parsing guards that wrap untrusted provider output |
| [src/shared/providerModels.test.ts](../../src/shared/providerModels.test.ts) | `costOf()` math and unknown-model fallback |
| [src/main/__tests__/menu.test.ts](../../src/main/__tests__/menu.test.ts) | App menu template structure |
| `src/main/providers/providerEventNormalizer.test.ts` | Per-provider event normalization (uses `__fixtures__/`) |

Run them after any change to IPC, schemas, the model registry, or the event normalizer.
