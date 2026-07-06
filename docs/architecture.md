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

[src-tauri/src/lib.rs](../src-tauri/src/lib.rs) initializes the app, database, services, menu, protocols, and event publishers. Long-lived services are stored in [state.rs](../src-tauri/src/state.rs) and exposed to command handlers through `tauri::State`.

Key folders:

- `ipc/` — request/response commands grouped by namespace.
- `persistence/` — SQLite connection, migrations, and table-family repositories.
- `providers/` — Claude/Codex/Cursor adapters, PTY process runtime, normalizers, and event flush queue.
- `sessions/` — session orchestration that sits between `ipc/` and `providers/`.
- `workspaces/`, `review/`, `files/`, `git/` — worktree lifecycle, diffs, file previews/writes, and branch/PR actions.
- `approvals/`, `checks/`, `gh/`, `memory/`, `mcp/`, `terminal/`, `attachments/`, `ide/`, `skills/` — subsystem services. `notifications.rs` and `updater.rs` are top-level modules.

Dashboard freshness is SQLite-first: focused reads (`dashboard:list`, `session:events-since`, `workspaces:status`) plus post-commit `dashboard:delta` pushes.

### Dependency Notes

- **tauri >= 2.11** required for `#[tauri::command(rename = "...")]` to keep stable IPC channel names across the bridge.
- **rusqlite bundled-full** ships FTS5 for full-text search on `events_fts` and `learnings_fts` sidecars.
- **portable-pty 0.9** for cross-platform PTY process management (provider launches and terminal emulation).

## Renderer — `src/renderer`

React 19 + Vite. [App.tsx](../src/renderer/App.tsx) composes the shell; [tauriBridge.ts](../src/renderer/lib/tauriBridge.ts) centralizes app command IPC through `window.argmax`. The overlay-titlebar helper [windowChrome.ts](../src/renderer/lib/windowChrome.ts) is the one direct renderer Tauri API exception: it uses the window API for drag/zoom chrome, not app IPC. Browser-preview mode detects missing Tauri internals and falls back to [demoSnapshot.ts](../src/renderer/demoSnapshot.ts).

Heavy panels are lazy-loaded. Renderer tests use [src/test/appTestHarness.ts](../src/test/appTestHarness.ts) and [src/test/fixtures/dashboardSnapshot.ts](../src/test/fixtures/dashboardSnapshot.ts).

## Shared — `src/shared`

- [bindings.d.ts](../src/shared/bindings.d.ts) — generated Rust types.
- [types.ts](../src/shared/types.ts) — hand-written `ArgmaxApi` and renderer domain aliases.
- [ipcSchemas.ts](../src/shared/ipcSchemas.ts) — request channel-name union for the bridge; runtime validation lives in Rust.
- [providerModels.ts](../src/shared/providerModels.ts) — model lists, defaults, and pricing.
