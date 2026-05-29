# Architecture

Argmax has a Rust/Tauri runtime and a React/Vite renderer, joined by a stable `window.argmax` API.

## Map

| Topic | Doc |
|---|---|
| Runtime lifecycle | [runtime.md](runtime.md) |
| IPC contract | [ipc.md](ipc.md) |
| Providers | [providers.md](providers.md) |
| SQLite | [data.md](data.md) |
| Worktrees, review, files, git | [workspaces.md](workspaces.md) |
| Approvals and checks | [approvals-checks.md](approvals-checks.md) |
| Terminal panel | [terminal.md](terminal.md) |
| GitHub CI feedback | [gh.md](gh.md) |
| Learnings | [memory.md](memory.md) |
| Perf budgets | [performance.md](performance.md) |
| Tests | [testing.md](testing.md) |
| Release | [release.md](release.md) |

## Runtime — `src-tauri`

[src-tauri/src/lib.rs](../../src-tauri/src/lib.rs) initializes the app, database, services, menu, protocols, and event publishers. Long-lived services are stored in [state.rs](../../src-tauri/src/state.rs) and exposed to command handlers through `tauri::State`.

Key folders:

- `ipc/` — request/response commands grouped by namespace.
- `persistence/` — SQLite connection, migrations, and table-family repositories.
- `providers/` — Claude/Codex/Cursor adapters, PTY process runtime, normalizers, and event flush queue.
- `workspaces/`, `review/`, `files/`, `git/` — worktree lifecycle, diffs, file previews/writes, and branch/PR actions.
- `approvals/`, `checks/`, `gh/`, `memory/`, `mcp/`, `terminal/`, `notifications/`, `ide/`, `skills/`, `updater/` — subsystem services.

Dashboard freshness is SQLite-first: focused reads (`dashboard:list`, `session:events-since`, `workspaces:status`) plus post-commit `dashboard:delta` pushes.

## Renderer — `src/renderer`

React 19 + Vite. [App.tsx](../../src/renderer/App.tsx) composes the shell; [tauriBridge.ts](../../src/renderer/lib/tauriBridge.ts) is the only renderer file that imports `@tauri-apps/api`. Browser-preview mode detects missing Tauri internals and falls back to [demoSnapshot.ts](../../src/renderer/demoSnapshot.ts).

Heavy panels are lazy-loaded. Renderer tests use [src/test/appTestHarness.ts](../../src/test/appTestHarness.ts) and [src/test/fixtures/dashboardSnapshot.ts](../../src/test/fixtures/dashboardSnapshot.ts).

## Shared — `src/shared`

- [bindings.d.ts](../../src/shared/bindings.d.ts) — generated Rust types.
- [types.ts](../../src/shared/types.ts) — hand-written `ArgmaxApi` and renderer domain aliases.
- [ipcSchemas.ts](../../src/shared/ipcSchemas.ts) — preserved channel-name union for the bridge; runtime validation lives in Rust.
- [providerModels.ts](../../src/shared/providerModels.ts) — model lists, defaults, and pricing.
