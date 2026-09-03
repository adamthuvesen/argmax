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

`session:multitask` dispatches a sibling chat from a session that may still be mid-turn, and returns the new session and workspace ids so the composer can draw the card without waiting for the dashboard delta. See [multitask.md](multitask.md).

`usage:summary` takes `{ window: "24h" | "7d" | "30d", timeZone }` and returns the Usage page in one shape: totals, per-provider rows, the chart series, and the model and day breakdowns, plus the scan's progress. A ledger that has completed before is swept inline so the answer is current; the first cold sweep runs in the background and the page polls. See [usage.md](usage.md).

Scheduled tasks ("routines") expose `routines:list`, `routines:upsert`, `routines:delete`, `routines:set-enabled`, and `routines:run-now`.

The browser pane's own commands (`browser:open`, `browser:navigate`, …) address one tab by id. The agent-facing ones (`browser:list-tabs`, `browser:open-for-session`, `browser:snapshot`, `browser:find`, `browser:get-text`, `browser:act`, and `browser:screenshot`) take `{ tabId? , sessionId? }` instead: naming a session acts on the tab that session touched most recently. All of them are desktop-only — see [browser.md](browser.md).

## Push Channels

Subscribed in `tauriBridge.ts`:

- `dashboard:delta`
- `terminal:data`
- `terminal:exit`
- `menu:command`
- `browser:state`
- `browser:new-tab`
- `browser:page-command`
- `browser:tabs`
- `browser:agent-open`

Push channels are not listed in `channels.txt`.

## Adding a Channel

1. Define input/output types in `src-tauri/src/ipc/inputs.rs` or the subsystem module.
2. Implement the handler in `src-tauri/src/ipc/*.rs` with `#[tauri::command(rename = "namespace:name")]`.
3. Register the command in `ipc::specta_builder()` and in `REGISTERED_CHANNELS`.
4. Add the channel name to `src-tauri/tests/fixtures/channels.txt` and bump the count in `src-tauri/tests/ipc_inventory.rs`.
5. Either implement the channel in `src-tauri/src/remote/dispatch.rs` or list it in `REMOTE_UNSUPPORTED_CHANNELS`.
6. Add the channel name to `src/shared/ipcSchemas.ts`, and the method to `ArgmaxApi` in `src/shared/types.ts` and `src/renderer/lib/tauriBridge.ts`.
7. Run `npm run generate:bindings`, then `npm run check:bindings`, `npm run check:tauri-bridge`, and `npm run check:main-thread`.

A synchronous handler resolves on the macOS main thread. Make the handler
`async` (or `spawn_blocking` for genuinely blocking work) unless it does no IO,
in which case add it to the allowlist in `scripts/check-main-thread-handlers.mjs`
with the reason.
