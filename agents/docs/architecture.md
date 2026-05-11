# Architecture

Two processes, three folders, one IPC contract.

## Main process — `src/main/`

Owns the SQLite database, child processes (provider PTYs, check runs), the IPC surface, and Electron lifecycle.

Entry: [src/main/main.ts](../../src/main/main.ts) — boots `BrowserWindow`, instantiates `ArgmaxDatabase` and `ProviderSessionService` in `app.whenReady()`, registers IPC handlers, binds shutdown to `before-quit`.

Subdirectories:

| Folder | Role |
|---|---|
| `approvals/` | `approvalService` requests + `dangerousActionPolicy` risk classifier |
| `checks/` | `checkService` spawns commands (5-min timeout, cancellation support) |
| `persistence/` | `database`, `migrations`, `seed`. SQLite at `app.getPath("userData")/local-state/argmax.sqlite` |
| `projects/` | Project registration + settings |
| `providers/` | Claude/Codex adapters and session lifecycle (see [providers.md](providers.md)) |
| `review/` | `gitReviewService`, `commitPreparationService`, `checkpointService` (binary patches under `${dataDirectory}/checkpoints/`) |
| `workspaces/` | `workspaceOrchestration`: creates/removes git worktrees under `project.settings.worktreeLocation`, validated to stay inside `repoPath` |

## Renderer — `src/renderer/`

React 19 + Vite. One [App.tsx](../../src/renderer/App.tsx). State starts from focused dashboard reads, then stays fresh through pushed `dashboard.onDelta()` updates, lightweight status refreshes, and selected-session `session.eventsSince()` cursor reads. Browser-preview mode (no Electron bridge) falls back to [demoSnapshot.ts](../../src/renderer/demoSnapshot.ts) — see `isBrowserPreview()` in `App.tsx`.

Dashboard freshness is SQLite-first:

- `dashboard.list()` returns dashboard-level state: projects, workspaces, sessions, checks, and checkpoints. Initial renderer load composes it with `approvals.pending()`.
- `session.eventsSince({ sessionId, eventCursor?, rawOutputCursor? })` returns one session's timeline events and raw outputs. It uses SQLite `rowid` cursors; omitted cursors return the latest tail (50 events, 100 raw outputs) sorted ascending for rendering.
- `workspaces.status({ workspaceIds? })` returns refreshed workspaces, sessions, checks, and checkpoints, optionally filtered by workspace ids. Active-work polling uses this plus `approvals.pending()`, not a full dashboard read.
- `dashboard.load()` remains public as a compatibility wrapper for older callers, tests, and demo/browser compatibility. New renderer work should prefer the focused reads above.
- `dashboard.onDelta()` is a latency optimization. Main publishes provider-session deltas only after rows are committed, and the renderer upserts by `id`, sorts by timestamp fields, and caps live `events` / `rawOutputs` to match dashboard limits.

The conversation surface intentionally separates normalized chat from raw provider output. Assistant bubbles come from timeline events; the raw transcript fallback is only for human-readable stdout/stderr and filters provider protocol JSON (`type` payloads such as Claude `init` and Codex lifecycle events). The "Thinking" indicator is hidden as soon as visible assistant output exists.

## Shared — `src/shared/`

The contract layer.

- [types.ts](../../src/shared/types.ts) — TS types for dashboard data + the `ArgmaxApi` interface
- [ipcSchemas.ts](../../src/shared/ipcSchemas.ts) — Zod schemas + parsed-input type aliases
- [providerModels.ts](../../src/shared/providerModels.ts) — `PROVIDER_MODEL_DEFAULTS` (single source of truth for model id + label + reasoning effort + launch mode)
- [safeJson.ts](../../src/shared/safeJson.ts) — guarded JSON utilities

**Renderer imports types only from shared.** Zod schemas are imported by main; the renderer never validates payloads itself.

## IPC contract

[src/main/ipc.ts](../../src/main/ipc.ts) registers request/response channels via `withValidation()` + `ipcMain.handle`. Channel names are kept in sync by `REGISTERED_IPC_CHANNELS` (a regression test enforces parity).

The preload bridge ([src/main/preload.ts](../../src/main/preload.ts)) exposes `window.argmax` with grouped namespaces: `dashboard`, `projects`, `workspaces`, `providers`, `approvals`, `session`, `review`, `checks`, `checkpoints`, `attempts`, `commits`, `health`.

`dashboard:delta` is different: it is a `webContents.send()` / `ipcRenderer.on()` event channel used by `dashboard.onDelta(listener)`, not an `ipcMain.handle` channel. It should be typed in [types.ts](../../src/shared/types.ts) and exposed in preload, but it should not be added to `REGISTERED_IPC_CHANNELS` or `ipcSchemas.ts`.

Focused dashboard request/response channels:

| Channel | Preload method | Purpose |
|---|---|---|
| `dashboard:list` | `dashboard.list()` | Initial dashboard shell without events/raw output/approvals |
| `session:eventsSince` | `session.eventsSince(input)` | Cursor-based selected-session events + raw outputs |
| `workspace:status` | `workspaces.status(input?)` | Workspaces/sessions/checks/checkpoints refresh, optionally filtered |
| `approvals:pending` | `approvals.pending()` | Pending approvals only |
| `dashboard:load` | `dashboard.load()` | Compatibility full snapshot wrapper |

### Adding a new IPC channel

1. Define the input schema in `ipcSchemas.ts` (with a parsed-type alias)
2. Register the handler in `ipc.ts` using `withValidation()`
3. Add the channel name to `REGISTERED_IPC_CHANNELS`
4. Expose it through `preload.ts`
5. Add the typed method to `ArgmaxApi` in `types.ts`

Skipping any of these will fail the regression test or surface as a runtime `Method not found`.

For push-only events, skip steps 1–3: publish from main with `webContents.send()`, subscribe/unsubscribe in preload with `ipcRenderer.on()` / `removeListener()`, and type the callback surface in `ArgmaxApi`.
