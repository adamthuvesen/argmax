# IPC

Renderer IPC talks to Rust through `window.argmax`. Commands use explicit names (`"providers:launch"`, `"session:events-since"`, etc.). Window drag and zoom controls use Tauri's window API directly via [windowChrome.ts](../src/renderer/lib/windowChrome.ts).

## Files

| File | Role |
|---|---|
| [src-tauri/src/ipc](../src-tauri/src/ipc) | Command handlers with `#[tauri::command(rename = "...")]` |
| [src-tauri/src/ipc/inputs.rs](../src-tauri/src/ipc/inputs.rs) | Input structs and validated newtypes |
| [src-tauri/tests/fixtures/channels.txt](../src-tauri/tests/fixtures/channels.txt) | Generated request/response channel list |
| [src/shared/bindings.d.ts](../src/shared/bindings.d.ts) | Generated TypeScript types |
| [src/shared/ipcSchemas.ts](../src/shared/ipcSchemas.ts) | Generated channel-name array and union |
| [src/renderer/lib/tauriBridge.ts](../src/renderer/lib/tauriBridge.ts) | `window.argmax` implementation |

## Request Channels

Commands are registered in [src-tauri/src/ipc/mod.rs](../src-tauri/src/ipc/mod.rs) with `tauri-specta`. Validation happens in Rust input structs and newtypes, not in the renderer.

File and review operations use a `{ kind: "workspace" | "project", id }` target resolved in Rust.

`session:agent-events` fetches subagent activity for `{ sessionId, parentToolUseId }`. It imports trace events for the parent tool call and returns rows scoped to the subagent lifecycle. Main chat views use `session:events-since` to avoid trace disk scans.

`session:events-since` accepts a `changeCursor` for mutation-aware recovery.
The first response pairs an authoritative bounded tail with a cursor from the
same SQLite read transaction. `resetRequired` replaces retained history,
`deletedEventIds` and `deletedRawOutputIds` remove rows, and `hasMore` asks the
client to continue paging. Legacy event/raw row cursors remain supported.

`session:multitask` dispatches a sibling chat from a session that may still be mid-turn, and returns the new session and workspace ids so the composer can draw the card without waiting for the dashboard delta. See [multitask.md](multitask.md).

`usage:summary` takes `{ window: "24h" | "7d" | "30d", timeZone, provider? }` and returns the Usage page in one shape: totals, per-provider rows, the chart series, and the model and day breakdowns, plus the scan's progress. A `provider` narrows everything but the per-provider rows to that provider; Cursor keeps no local usage log and is rejected. A ledger that has completed before is swept inline so the answer is current; the first cold sweep runs in the background and the page polls. See [usage.md](usage.md).

`usage:remaining` takes no fields and returns live remaining usage per provider login: plan kind (`subscription` / `enterprise` / `api_key` / `unavailable` / `error`), optional plan label, remaining-percent windows with reset times, and a per-row message. One provider failing does not fail the channel. See [usage.md](usage.md).

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

`dashboard:delta` carries `changedSessionIds` for transcript reads and
`dashboardChanged` for metadata reads. Full transcript and metadata payloads
stay out of the delivery queue, except for the small session-move navigation
notice. `resyncRequired` reloads metadata, pending approvals and queued messages,
then replaces subscribed histories. Desktop and mobile use the same recovery.
Metadata invalidations are coalesced over 100 ms, while transcript reads remain
immediate and drain revision pages before settling.

## Adding a Channel

1. Define input/output types in `src-tauri/src/ipc/inputs.rs` or the subsystem module.
2. Implement the handler in `src-tauri/src/ipc/*.rs` with `#[tauri::command(rename = "namespace:name")]`.
3. Register the command in `ipc::specta_builder()` and in `REGISTERED_CHANNELS`.
4. Either implement the channel in `src-tauri/src/remote/dispatch.rs` or list it in `REMOTE_UNSUPPORTED_CHANNELS`.
5. Add the method to `ArgmaxApi` in `src/shared/types.ts` and `src/renderer/lib/tauriBridge.ts`.
6. Run `npm run generate:bindings`. Refer to new input and result types through `Bindings.*` from `types.ts`. Never re-declare the shape by hand. Then run `npm run precheck` (the Rust lane's `cargo test` includes the generated-file freshness test; the script also runs `check:tauri-bridge` and `check:main-thread`).

A synchronous handler resolves on the macOS main thread. Make the handler
`async` (or `spawn_blocking` for genuinely blocking work) unless it does no IO,
in which case add it to the allowlist in `scripts/check-main-thread-handlers.mjs`
with the reason.
