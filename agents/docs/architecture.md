# Architecture

Two processes, three folders, one IPC contract.

## Main process — `src/main/`

Owns the SQLite database, child processes (provider PTYs, check runs), the IPC surface, and Electron lifecycle.

Entry: [src/main/main.ts](../../src/main/main.ts) — boots `BrowserWindow`, instantiates `MaestroDatabase` and `ProviderSessionService` in `app.whenReady()`, registers IPC handlers, binds shutdown to `before-quit`.

Subdirectories:

| Folder | Role |
|---|---|
| `approvals/` | `approvalService` requests + `dangerousActionPolicy` risk classifier |
| `checks/` | `checkService` spawns commands (5-min timeout, cancellation support) |
| `persistence/` | `database`, `migrations`, `seed`. SQLite at `app.getPath("userData")/local-state/maestro.sqlite` |
| `projects/` | Project registration + settings |
| `providers/` | Claude/Codex adapters and session lifecycle (see [providers.md](providers.md)) |
| `review/` | `gitReviewService`, `commitPreparationService`, `checkpointService` (binary patches under `${dataDirectory}/checkpoints/`) |
| `workspaces/` | `workspaceOrchestration`: creates/removes git worktrees under `project.settings.worktreeLocation`, validated to stay inside `repoPath` |

## Renderer — `src/renderer/`

React 19 + Vite. One [App.tsx](../../src/renderer/App.tsx). State is driven by `dashboard.load()` IPC + lightweight polling while sessions are active. Browser-preview mode (no Electron bridge) falls back to [demoSnapshot.ts](../../src/renderer/demoSnapshot.ts) — see `isBrowserPreview()` in `App.tsx`.

## Shared — `src/shared/`

The contract layer.

- [types.ts](../../src/shared/types.ts) — TS types for dashboard data + the `MaestroApi` interface
- [ipcSchemas.ts](../../src/shared/ipcSchemas.ts) — Zod schemas + parsed-input type aliases
- [providerModels.ts](../../src/shared/providerModels.ts) — `PROVIDER_MODEL_DEFAULTS` (single source of truth for model id + label + reasoning effort)
- [safeJson.ts](../../src/shared/safeJson.ts) — guarded JSON utilities

**Renderer imports types only from shared.** Zod schemas are imported by main; the renderer never validates payloads itself.

## IPC contract

[src/main/ipc.ts](../../src/main/ipc.ts) registers ~22 channels via `withValidation()` + `ipcMain.handle`. Channel names are kept in sync by `REGISTERED_IPC_CHANNELS` (a regression test enforces parity).

The preload bridge ([src/main/preload.ts](../../src/main/preload.ts)) exposes `window.maestro` with grouped namespaces: `dashboard`, `projects`, `workspaces`, `providers`, `approvals`, `review`, `checks`, `checkpoints`, `attempts`, `commits`, `health`.

### Adding a new IPC channel

1. Define the input schema in `ipcSchemas.ts` (with a parsed-type alias)
2. Register the handler in `ipc.ts` using `withValidation()`
3. Add the channel name to `REGISTERED_IPC_CHANNELS`
4. Expose it through `preload.ts`
5. Add the typed method to `MaestroApi` in `types.ts`

Skipping any of these will fail the regression test or surface as a runtime `Method not found`.
