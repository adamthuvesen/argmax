# IPC

Renderer app IPC talks to Rust only through `window.argmax`. Tauri commands use stable channel names (`"providers:launch"`, `"session:events-since"`, etc.) so renderer code and the generated bridge stay in lockstep. Window chrome is separate: [windowChrome.ts](../src/renderer/lib/windowChrome.ts) uses Tauri's window API directly for overlay-titlebar drag/zoom behavior.

## Files

| File | Role |
|---|---|
| [src-tauri/src/ipc](../src-tauri/src/ipc) | `#[tauri::command(rename = "...")]` handlers, grouped by namespace |
| [src-tauri/src/ipc/inputs.rs](../src-tauri/src/ipc/inputs.rs) | Input structs and validated newtypes |
| [src-tauri/tests/fixtures/channels.txt](../src-tauri/tests/fixtures/channels.txt) | Stable request/response channel inventory |
| [src/shared/bindings.d.ts](../src/shared/bindings.d.ts) | Generated command/input/output types |
| [src/shared/ipcSchemas.ts](../src/shared/ipcSchemas.ts) | TypeScript channel-name union for the bridge |
| [src/renderer/lib/tauriBridge.ts](../src/renderer/lib/tauriBridge.ts) | Installs `window.argmax` with `invoke`/`listen` calls |

## Request Channels

Every request handler is registered in [src-tauri/src/ipc/mod.rs](../src-tauri/src/ipc/mod.rs) through `tauri-specta`'s command collection. The Rust inventory test checks the fixture against the collected command surface; `npm run check:tauri-bridge` checks the renderer invokes the same channels.

Runtime validation belongs in Rust input structs/newtypes. Do not add Zod schemas or renderer-side validation for trusted app IPC.

`session:agent-events` is the focused read for subagent activity panes. It takes
`{ sessionId, parentToolUseId }`, runs provider-specific trace import
best-effort for that one parent tool, then returns the same
`SessionEventsSinceResult` shape as `session:events-since`. The result is scoped
to the parent launch/completion rows, child rows linked by `parent_tool_use_id`,
and Codex child-thread `agent_message` rows linked by receiver thread ids.
Normal session polling stays on `session:events-since` and does not trigger trace
directory scans.

## Push Channels

Push channels are emitted by Rust and subscribed in `tauriBridge.ts`:

- `dashboard:delta`
- `terminal:data`
- `terminal:exit`
- `mcp:auth:data`
- `mcp:auth:exit`
- `menu:command`

Push channels do not belong in `channels.txt`.

## Adding A Request Channel

1. Add the Rust input/output types in `src-tauri/src/ipc/inputs.rs` or the owning module.
2. Add the command handler in the matching `src-tauri/src/ipc/*.rs` file with `#[tauri::command(rename = "namespace:name")]`.
3. Register it in `ipc::specta_builder()`.
4. Add the channel to `src-tauri/tests/fixtures/channels.txt`.
5. Add the method to `ArgmaxApi` in `src/shared/types.ts` and `src/renderer/lib/tauriBridge.ts`.
6. Run `npm run check:bindings`, `npm run check:tauri-bridge`, and the relevant Rust tests.
