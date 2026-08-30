# IPC

Renderer IPC talks to Rust through `window.argmax`. Commands use explicit names (`"providers:launch"`, `"session:events-since"`, etc.). Window drag and zoom controls use Tauri's window API directly via [windowChrome.ts](../src/renderer/lib/windowChrome.ts).

## Files

| File | Role |
|---|---|
| [src-tauri/src/ipc](../src-tauri/src/ipc) | Command handlers with `#[tauri::command(rename = "...")]` |
| [src-tauri/src/ipc/inputs.rs](../src-tauri/src/ipc/inputs.rs) | Input structs and validated newtypes |
| [src-tauri/tests/fixtures/channels.txt](../src-tauri/tests/fixtures/channels.txt) | Request/response channel list |
| [src/shared/bindings.d.ts](../src/shared/bindings.d.ts) | Generated TypeScript types |
| [src/shared/ipcSchemas.ts](../src/shared/ipcSchemas.ts) | Channel-name union |
| [src/renderer/lib/tauriBridge.ts](../src/renderer/lib/tauriBridge.ts) | `window.argmax` implementation |

## Request Channels

Commands are registered in [src-tauri/src/ipc/mod.rs](../src-tauri/src/ipc/mod.rs) with `tauri-specta`. Validation happens in Rust input structs and newtypes, not in the renderer.

File and review operations use a `{ kind: "workspace" | "project", id }` target resolved in Rust.

`session:agent-events` fetches subagent activity for `{ sessionId, parentToolUseId }`. It imports trace events for the parent tool call and returns rows scoped to the subagent lifecycle. Main chat views use `session:events-since` to avoid trace disk scans.

Scheduled tasks ("routines") expose `routines:list`, `routines:upsert`, `routines:delete`, `routines:set-enabled`, and `routines:run-now`.

## Push Channels

Subscribed in `tauriBridge.ts`:

- `dashboard:delta`
- `terminal:data`
- `terminal:exit`
- `menu:command`
- `browser:state`
- `browser:new-tab`
- `browser:page-command`

Push channels are not listed in `channels.txt`.

## Adding a Channel

1. Define input/output types in `src-tauri/src/ipc/inputs.rs` or the subsystem module.
2. Implement the handler in `src-tauri/src/ipc/*.rs` with `#[tauri::command(rename = "namespace:name")]`.
3. Register the command in `ipc::specta_builder()`.
4. Add the channel name to `src-tauri/tests/fixtures/channels.txt`.
5. Add the method to `ArgmaxApi` in `src/shared/types.ts` and `src/renderer/lib/tauriBridge.ts`.
6. Run `npm run check:bindings` and `npm run check:tauri-bridge`.
