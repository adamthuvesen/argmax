# Testing

Vitest, jsdom, colocated `*.test.ts(x)` files. Config: [vitest.config.ts](../../vitest.config.ts), setup: [src/test/setup.ts](../../src/test/setup.ts) (loads `@testing-library/jest-dom`).

## Running

```bash
npm test                                        # all tests, with rebuild:node first
npx vitest run src/renderer/                    # one folder
npx vitest run src/renderer/App.test.tsx        # one file
npx vitest                                      # watch mode
```

If you skipped `rebuild:node`, main-process tests will fail with `NODE_MODULE_VERSION` errors from better-sqlite3. **Renderer + shared tests don't touch native modules** — `npx vitest run src/renderer/ src/shared/` is the fast path when iterating on UI without a rebuild.

Do not run multiple `npm test` commands in parallel. Each one starts with `npm run rebuild:node`, and concurrent native rebuilds can corrupt the in-place `better-sqlite3` / `node-pty` build directories. Use one `npm test -- --run ...` at a time, or use `npx vitest run ...` for renderer/shared-only checks when native modules are already in the right runtime.

## Renderer-test conventions

- Query by **role / aria-label / title** — never by `className`. Visual changes shouldn't break tests.
- `aria-pressed`, `aria-label`, `title`, and visible button text are part of the contract; tests rely on them. Treat them like a public API.
- Mock `window.maestro` in `beforeEach`. The component falls back to `demoSnapshot` only when `window.maestro` is undefined (browser-preview mode), so renderer tests must explicitly set it.
- Include `dashboard.onDelta(listener)` in Maestro API mocks. Capture the listener, return an unsubscribe spy, and use `act()` when invoking the captured listener so React observes streamed updates.
- Include the focused dashboard APIs in Maestro mocks: `dashboard.list()`, `session.eventsSince()`, `workspaces.status()`, and `approvals.pending()`. Normal renderer refresh should not call `dashboard.load()`.
- Active provider sessions may schedule a 1200ms focused poll. Assert polling uses `workspaces.status()` / `approvals.pending()` and, for the selected running/waiting session, `session.eventsSince()`; streamed deltas should render without another `dashboard.load()` call.
- See [src/renderer/App.test.tsx](../../src/renderer/App.test.tsx) for the canonical pattern (mocks of every IPC namespace, fixture `snapshot`, etc.).

## Main-process tests

Most main services have unit tests next to them: `approvalService.test.ts`, `providerSessionService.test.ts`, `database.test.ts`, `gitReviewService.test.ts`, etc. They construct an in-memory SQLite DB via `createDatabase(":memory:")` where applicable.

Tests that need real git operate against `os.tmpdir()` scratch repos created/destroyed per-test; never against the working repo.

Provider-session tests should verify delta publishing after the SQLite write path succeeds. For failure-path coverage, force persistence to throw and assert no `DashboardDelta` is published before the transaction completes.

Focused dashboard database tests should cover `listDashboard()`, `listWorkspaceStatus()`, `listPendingApprovals()`, and `listSessionEventsSince()`. For event tails, assert SQLite `rowid` cursor behavior rather than timestamp ordering; timestamps can tie during provider streaming.

## Regression tests worth knowing

- [src/main/__tests__/ipcHandlers.test.ts](../../src/main/__tests__/ipcHandlers.test.ts) — verifies `REGISTERED_IPC_CHANNELS` matches the actual handlers. Run this after touching request/response IPC.
- [src/shared/ipcSchemas.test.ts](../../src/shared/ipcSchemas.test.ts) — exercises the Zod schemas with realistic + malformed inputs.
- [src/shared/safeJson.test.ts](../../src/shared/safeJson.test.ts) — covers the JSON parsing guards that wrap untrusted provider output.
