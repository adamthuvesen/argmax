# IPC

The contract between renderer and main. Two surfaces: **request/response** (validated, registered) and **push events** (typed, never validated by Zod).

## Where everything lives

| File | Role |
|---|---|
| [src/shared/ipcSchemas.ts](../../src/shared/ipcSchemas.ts) | Zod schema per channel + `IPC_CHANNELS` (`Object.keys(ipcSchemas)`) |
| [src/shared/types.ts](../../src/shared/types.ts) | `ArgmaxApi` — the shape `window.argmax` exposes |
| [src/main/ipc.ts](../../src/main/ipc.ts) | `withValidation()` + `registerIpcHandlers()`; composes per-module handler registrations and returns `{ channels, tournaments }` |
| [src/main/ipc/registry.ts](../../src/main/ipc/registry.ts) | `createIpcRegistrar()` — shared `ipcMain.handle` + latency-wrapper factory used by every IPC submodule |
| [src/main/ipc/](../../src/main/ipc/) | Per-namespace handler modules (`approvals.ts`, `attachments.ts`, `git.ts`, `mcp.ts`, `projects.ts`, `providers.ts`, `review.ts`, `sessions.ts`, `system.ts`, `terminal.ts`, `tournaments.ts`, `workspaces.ts`) — each calls `createIpcRegistrar()` and returns the channels it registered |
| [src/main/preload.ts](../../src/main/preload.ts) | The renderer-side bridge via `contextBridge.exposeInMainWorld("argmax", api)` |

## Request/response

Every channel is validated. `withValidation(schema, fn)` parses `rawInput` with Zod; on failure it throws an `IpcInvalidInputError` (`code: "INVALID_INPUT"`, `issues: ZodIssue[]`) so the renderer's `invoke()` rejects with a structured payload instead of crashing mid-service.

```ts
// Inside a per-namespace registrar function in src/main/ipc/<namespace>.ts:
const { register, channels: registered } = createIpcRegistrar();

register(
  "channel:name",
  withValidation(channelSchema, async (input) => {
    // input is fully typed via z.infer
    return service.doThing(input);
  })
);
```

Inline `z.object` literals belong in [src/shared/ipcSchemas.ts](../../src/shared/ipcSchemas.ts) as top-level exports, not at the call site — the schema module is the single inventory the regression test reads. The registrar wraps each call in the `timed()` latency probe so every channel reports to the perf histogram.

The channel inventory is the keys of the `ipcSchemas` object in [src/shared/ipcSchemas.ts](../../src/shared/ipcSchemas.ts). The regression test [src/main/__tests__/ipcHandlers.test.ts](../../src/main/__tests__/ipcHandlers.test.ts) enforces parity between `IPC_CHANNELS` and the actually-registered `ipcMain.handle` set — if you add a channel and skip a step, this test fails.

**Namespaces** (grouped on `window.argmax`):

| Namespace | Examples | Notes |
|---|---|---|
| `dashboard` | `list`, `load`, `onDelta` | Prefer focused reads; `load` is the compat wrapper |
| `projects` | `list`, `pickFolder`, `register`, `remove`, `updateSettings`, `listBranches`, `switchBranch` | |
| `workspaces` | `createIsolated`, `createCurrent`, `refreshStatus`, `status`, `keep`, `archive`, `openInIde`, `setPinned` | `status` is the polling read |
| `providers` | `discover`, `launch`, `sendInput`, `resize`, `terminate`, `cancelQueuedMessage` | See [providers.md](providers.md) |
| `attachments` | `saveImage` | Composer image paste/drop — bytes land under userData, IPC returns an absolute path |
| `approvals` | `pending`, `resolve` | |
| `session` | `eventsSince`, `costSummary`, `search` | Cursor-based event tail |
| `review` | `listChangedFiles`, `loadDiff`, `listChangedFilesForProject`, `loadDiffForProject` | Workspace + project-scoped variants for the review surface |
| `workspace` (singular) | `listFiles`, `readFile`, `writeFile`, `statFile` (+ `…ForProject` variants), `grepContent` | File-tree + inline file editor; writes are mtime-checked. `grepContent` powers ⌘⇧F. |
| `checks` | `run` | |
| `checkpoints` | `create` | Binary patches under `${dataDirectory}/checkpoints/` |
| `attempts` | `selectPreferred` | Multi-attempt session preference |
| `git` | `commit`, `push`, `createBranch`, `viewOrCreatePr` | Mutating branch/PR actions driven by the git dropdown |
| `health` | `ping` | |
| `skills` | `list` | User + workspace skill registry (Claude / Codex / Cursor + plugins) |
| `system` | `openPath`, `listDetectedIdes`, `diagnostics`, `vacuumDatabase` | `diagnostics` powers the Settings → Diagnostics tab |
| `mcp` | `list`, `auth.{start,write,resize,terminate,onData,onExit}` | User-scope MCP registry + interactive auth PTY for OAuth-style servers |
| `learnings` | `list`, `update`, `delete` | See [memory.md](memory.md) |
| `prs` | `listForSession`, `refresh` | See [gh.md](gh.md) |
| `terminal` | `spawn`, `write`, `resize`, `terminate`, `onData`, `onExit` | See [terminal.md](terminal.md) |
| `tournaments` | `launch`, `list`, `get`, `keep` | See [tournaments.md](tournaments.md) |
| `scoring` | `listPolicies` | Tournament judge policies |
| `menu` | `onCommand` | App-menu → renderer command bus |

## Push channels

Push events use `webContents.send` from main and `ipcRenderer.on` in preload. They do **not** belong in `IPC_CHANNELS` and do **not** get Zod schemas. The preload bridge returns an unsubscribe function — components must call it on unmount.

| Channel | Carrier type | Where it fires |
|---|---|---|
| `dashboard:delta` | `DashboardDelta` | `ProviderSessionService` after a SQLite commit. Main coalesces pushes through `DeltaCoalescer` at ~60 fps so streaming bursts don't pin the renderer (see [src/main/util/deltaCoalescer.ts](../../src/main/util/deltaCoalescer.ts)) |
| `terminal:data` | `TerminalDataEvent` | `TerminalService` per PTY chunk |
| `terminal:exit` | `TerminalExitEvent` | `TerminalService` on PTY exit |
| `mcp:auth:data` | `McpAuthDataEvent` | `McpAuthService` per chunk of the MCP-auth PTY |
| `mcp:auth:exit` | `McpAuthExitEvent` | `McpAuthService` when the auth PTY exits |
| `menu:command` | `MenuCommand` union | App menu accelerators |

## Adding a request/response channel

Five steps. Skip any and you break the boot, the regression test, or the renderer:

1. **Schema** — add a Zod schema + parsed-type alias in [ipcSchemas.ts](../../src/shared/ipcSchemas.ts) as a top-level export, and reference it in the `ipcSchemas` map. The key in that map becomes the channel name and gets typed automatically into `IpcChannel`.
2. **Handler** — call `register("channel:name", withValidation(schema, async (input) => …))` inside the matching per-namespace function in [src/main/ipc/](../../src/main/ipc/) (e.g. `registerWorkspaceHandlers` for `workspaces:*`). The registrar is built via `createIpcRegistrar()` and the returned channel list is concatenated in [src/main/ipc.ts](../../src/main/ipc.ts).
3. **Preload** — expose the method on the right namespace in [preload.ts](../../src/main/preload.ts), invoking `ipcRenderer.invoke`.
4. **API type** — add the typed signature to `ArgmaxApi` in [types.ts](../../src/shared/types.ts).
5. **Test** — `npx vitest run src/main/__tests__/ipcHandlers.test.ts` to confirm parity, then add coverage where the service handler lives.

## Adding a push channel

Three steps:

1. **Sender** — `mainWindow.webContents.send("channel:name", payload)` from main. Iterate `BrowserWindow.getAllWindows()` and filter `isDestroyed()` for multi-window safety (see `publishDashboardDelta` in `main.ts`).
2. **Preload** — subscribe via `ipcRenderer.on("channel:name", handler)` and return `() => ipcRenderer.removeListener(...)`.
3. **API type** — type the callback surface in `ArgmaxApi`.

Skip schemas and `IPC_CHANNELS` entries — these channels don't go through `withValidation`.

## Errors

- Schema mismatches reject with `Error & { code: "INVALID_INPUT", issues }`.
- Service-level errors propagate as plain `Error` instances; treat the renderer side defensively (a stale workspace id is a normal race during deletion).
- `RecordNotFoundError` from the database layer is the one to special-case if you write a handler that races against deletion — see [data.md](data.md).
