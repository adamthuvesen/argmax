# IPC

Renderer IPC talks to Rust through `window.argmax`. Commands use explicit names (`"providers:launch"`, `"session:events-since"`, etc.). Window drag and zoom controls use Tauri's window API directly via [windowChrome.ts](../src/renderer/lib/windowChrome.ts). ⌘+/⌘− run through the menu ([menu.rs](../src-tauri/src/menu.rs)), which sets the webview's page zoom and publishes the factor on the `ui:zoom` event — restated on every page load. The renderer mirrors it onto `--app-zoom`, and the CSS that reserves the native traffic lights' band divides it back out ([shell-layout.css](../src/renderer/styles/shell-layout.css)): page zoom scales CSS px, AppKit's buttons keep their size in window points.

`window.argmax.system.confirm(message)` resolves to a boolean. The desktop
bridge uses the official dialog plugin's message command with OK and Cancel
buttons. The remote browser shows its own confirmation locally. Callers await
the result and treat dialog errors as failed actions. The plugin's injected
`window.confirm` is asynchronous and must not be used as a synchronous guard.

## Files

| File | Role |
|---|---|
| [src-tauri/src/ipc](../src-tauri/src/ipc) | Command handlers with `#[tauri::command(rename = "...")]` |
| [src-tauri/src/ipc/catalogue.rs](../src-tauri/src/ipc/catalogue.rs) | Command registration, remote dispatch, and exposure policy |
| [src-tauri/src/ipc/inputs.rs](../src-tauri/src/ipc/inputs.rs) | Transport inputs and application input re-exports |
| [src-tauri/src/application/validation.rs](../src-tauri/src/application/validation.rs) | Validated application scalar types |
| [src-tauri/tests/fixtures/channels.txt](../src-tauri/tests/fixtures/channels.txt) | Generated request/response channel list |
| [src/shared/bindings.d.ts](../src/shared/bindings.d.ts) | Generated TypeScript types |
| [src/shared/ipcSchemas.ts](../src/shared/ipcSchemas.ts) | Generated channel names and request/result associations |
| [src/renderer/lib/tauriBridge.ts](../src/renderer/lib/tauriBridge.ts) | `window.argmax` implementation |

## Request Channels

Commands are registered once in [ipc/catalogue.rs](../src-tauri/src/ipc/catalogue.rs).
Each entry names its Tauri handler, remote dispatch body, and desktop/read/control exposure.
The catalogue builds the Specta registration and exports channel-specific request and result types.
The remote adapter adds only the connection-owned `dashboard:changes` cursor.

Rust validates request structs and application scalar types before executing operations.
`BridgeTransport.invoke` associates the channel with its generated input and result types.
Push subscriptions use the generated `PushPayloads` map from `ipc/events.rs`.
The renderer facade validates persisted string enums before exposing narrower client types.
These decoders are shared by command results and dashboard pushes.
Raw malformed timeline payloads remain available in an explicit diagnostic envelope.

File and review operations use a `{ kind: "workspace" | "project", id }` target resolved in Rust.

`session:agent-events` fetches subagent activity for `{ sessionId, parentToolUseId }`. It imports trace events for the parent tool call and returns rows scoped to the subagent lifecycle. Main chat views use `session:events-since` to avoid trace disk scans.

`questions:resolve` answers a pending Codex question with
`{ sessionId, requestId, answers, dismissed? }`. `answers` maps question IDs to
arrays of answer strings. Dismissal uses `dismissed: true` with no answers.
The response resumes the original provider request. Pending and settled cards
arrive through the session timeline, including after a UI reconnect.

`session:events-since` accepts a `changeCursor` for mutation-aware recovery.
The first response pairs an authoritative bounded tail with a cursor from the
same SQLite read transaction. `resetRequired` replaces retained history,
`deletedEventIds` and `deletedRawOutputIds` remove rows, and `hasMore` asks the
client to continue paging. Legacy event/raw row cursors remain supported.

`session:fork` takes `{ sessionId, boundaryEventId?, workspace? }` and returns `{ workspace, session, fork }`. `boundaryEventId` is the user message that started the finished turn to fork at; omitted, it forks the whole chat. `workspace` is `shared` (default) or `isolated`. `fork` says how the first message continues: `portable`, `codex-turn`, or `latest`. `session:fork-lineage` (read) returns `{ forkId, sourceSessionId, boundaryEventId, workspace, lastMergedThroughEventId }` for a fork, else `null`. `session:fork-merge-preview` (read) returns what bringing findings back would send, including `throughEventId`, which `session:fork-merge` takes back to send exactly that range. Preview writes nothing: a stale merge claim is only left out of its answer, and `session:fork-merge` withdraws it. See [workspaces.md](workspaces.md#bringing-findings-back).

`session:multitask` dispatches a sibling chat from a session that may still be mid-turn, and returns the new session and workspace ids so the composer can draw the card without waiting for the dashboard delta. See [multitask.md](multitask.md).

`cloud:prepare` takes exactly one source, `{ sessionId }` for a handoff or
`{ projectId }` for a launch from the composer, plus an explicit `provider`
(`claude`, `codex`, or `cursor`). It returns that provider, the verified GitHub
repository, branch, source commit, bounded chat context, and available hosted
environments. A single environment is selected automatically. Multiple Codex
environments require a choice before sending. A session source supplies a bounded chat
brief; a project source supplies an empty brief for the composer prompt.
`cloud:launch` takes the same source plus that preview and the task brief,
revalidates the checkout and environment, dispatches to the selected provider,
and returns `{ url }`. Only one launch per source may be in flight.
A successful session handoff appends a linked `session.note`; a project launch
does not create a local session or agent. The cloud conversation itself is not
mirrored into the local timeline. If a handoff launches but the note write
fails, the result also carries a `warning` so the caller keeps the returned URL
visible.

`workspaces:mark-viewed` acknowledges a batch of `{ workspaceId, observedActivityAt }`
entries under `workspaces`. Read stamps only advance to activity the client
observed, so a newer reply remains unread. Updated workspace rows carry
`lastViewedAt` through `dashboard:delta` so desktop and mobile agree on unread
completed replies.

`projects:check-prompt` takes `{ projectId, prompt, pickedByHand }` and returns Project check's verdict: `decision` (`none` / `suggest` / `switch`), a `checkId`, the suggested and runner-up project ids, both probabilities, and the reasons to show. It never fails for want of an answer — no key, a Jev error or a short prompt come back as `none`. `projects:resolve-check` takes `{ checkId, outcome, sessionId }` for a check this process handed out. `settings:set-project-check` takes `{ mode: "off" | "suggest" | "switch" }` and returns `RoutingSettings`, which carries the mode as `projectCheck`. See [routing.md](routing.md#project-check).

`settings:preview-chat-cleanup` returns a fixed seven-day cutoff, a confirmation id, and the number of eligible chats. `settings:delete-old-chats` accepts that id and applies only the previewed candidate set. The deletion transaction rechecks activity and active work, and reports chats skipped because they changed after the preview.

`system:open-file-in` takes `{ path, cwd, app }` and reveals the path in Finder (`app: "finder"`) or opens it in VS Code, Cursor, Windsurf, or Zed. The path must resolve inside `cwd`. Terminal apps are not accepted, because `open -a Terminal <file>` runs the file as a script. The Files view's right-click menu uses it, and the remote bridge does not support it.

`connections:list` takes a provider and optional workspace id. It returns the MCP servers, plugins, and provider connectors available at that scope, plus the strongest authentication result the provider exposes. The handler runs provider health checks with a timeout and returns **Unknown** when a CLI does not report token validity.

`usage:summary` takes `{ window: "24h" | "7d" | "30d", timeZone, provider? }` and returns the Usage page in one shape: totals, per-provider rows, the chart series, and the model and day breakdowns, plus the scan's progress. A `provider` narrows everything but the per-provider rows to that provider; Cursor's figures are estimated from the chats Argmax ran. A ledger that has completed before is swept inline so the answer is current; the first cold sweep runs in the background and the page polls. See [usage.md](usage.md).

`usage:remaining` takes no fields and returns live remaining usage per provider login: plan kind (`subscription` / `enterprise` / `api_key` / `unavailable` / `error`), optional plan label, remaining-percent windows with reset times, and a per-row message. One provider failing does not fail the channel. See [usage.md](usage.md).

`usage:router-cost` takes `{ window: "24h" | "7d" | "30d" }` and returns what each Auto tier cost in that window: chats, turns, escalations, reroutes, measured and estimated (Cursor) dollars, unpriced turns, the model mix, and grouped routing decisions, or `null` when no chat was routed in it. Each decision group carries task kind, difficulty, provider, model, effort, decision, reason, decision count, and turns. Dispatched over the remote bridge like `usage:summary`. See [usage.md](usage.md#router-cost).

`activity:summary` takes `{ window: "24h" | "7d" | "30d" | "12m" | "year", projectId?, timeZone }` and returns the Activity page in one shape: totals, the previous-window comparison, per-repository rows, the chart series, a year-long heatmap, streaks, cadence, and the pull requests and reviews from `gh`. A `projectId` narrows everything but the repository rows and the heatmap. `timeZone` must be an IANA name — every bucket is cut on it, so an unresolvable name is rejected rather than silently read as UTC. The commit ledger is swept inline once it has completed before; the GitHub half is a cache the call refreshes in the background when stale and never waits on. Dispatched over the remote bridge like `usage:summary`. See [activity.md](activity.md).

Scheduled tasks ("routines") expose `routines:list`, `routines:upsert`, `routines:delete`, `routines:set-enabled`, and `routines:run-now`.

The browser pane's own commands (`browser:open`, `browser:navigate`, …) address one tab by id. The agent-facing ones (`browser:list-tabs`, `browser:open-for-session`, `browser:snapshot`, `browser:find`, `browser:get-text`, `browser:act`, and `browser:screenshot`) take `{ tabId? , sessionId? }` instead: naming a session acts on the tab that session touched most recently. All of them are desktop-only — see [browser.md](browser.md).

## Push Channels

Subscribed in `tauriBridge.ts`:

- `dashboard:delta`
- `terminal:data`
- `terminal:exit`
- `menu:command` (to the window that last had focus; see [runtime.md](runtime.md#chat-windows))
- `window:focus-session` (selects the notified chat in the window being raised)
- `browser:state`
- `browser:new-tab`
- `browser:page-command`
- `browser:tabs`
- `browser:agent-open`

Push channels are not listed in `channels.txt`. Their payload types come from `ipc/events.rs`.

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
3. Add one entry to `ipc/catalogue.rs` with its handler and remote access policy.
4. Implement the typed remote operation in that entry, or mark it `desktop`.
5. Add the method to `ArgmaxApi` in `src/shared/types.ts` and `src/renderer/lib/tauriBridge.ts`.
6. Run `npm run generate:contracts`. Refer to new input and result types through `Bindings.*` from `types.ts`. Never re-declare the shape by hand. Then run `npm run precheck` (the Rust lane's `cargo test` includes the generated-file freshness test; the script also runs `check:tauri-bridge` and `check:main-thread`).

A synchronous handler resolves on the macOS main thread. Make the handler
`async` (or `spawn_blocking` for genuinely blocking work) unless it does no IO,
in which case add it to the allowlist in `scripts/check-main-thread-handlers.mjs`
with the reason.

## Existing checkouts

`projects:list-checkouts` (`read`) takes `{ projectId }` and returns `{ branch, path, isMain }` for each checkout in the project's `git worktree list` that a chat can use: not a detached or bare entry, not one git marks prunable or whose directory is gone, and not one in archive recovery storage or whose owner is mid-archive. `projects:list-branches` still returns names only. `workspaces:create-alongside` (`control`) takes `{ projectId, taskLabel, path, branch }`, validates `path` the way an agent's `session_launch` path is validated, refuses it with `CHECKOUT_BRANCH_CHANGED` when the checkout is on another branch than `branch`, and returns the new shared `WorkspaceSummary`. See [workspaces.md](workspaces.md#lifecycle--watchers).

## Workspace settings channels

`linked-repos:list`, `linked-repos:add`, `linked-repos:set-enabled`, and `linked-repos:remove` manage a project's linked repositories ([memory.md](memory.md#linked-repositories)). `projects:set-branch-template` sets or clears (`null`) a project's branch template, and `settings:branch-template` / `settings:set-branch-template` read and write the app-wide one ([workspaces.md](workspaces.md#branch-name-templates)). A template is validated on save, and a rejection arrives as `InvalidInput` whose issue message the settings form shows (`validationMessage` in `src/shared`). `workspaces:set-snoozed-until` takes `{ workspaceId, until }` with a future RFC 3339 instant, or `null` to unsnooze ([workspaces.md](workspaces.md#snooze-shelf)). All are `desktop` except the snooze write, which is `control` like the other row writes; `WorkspaceSummary.snoozedUntil` rides every snapshot and delta and is omitted when unset.

## Project sources

`sources:list`, `sources:add`, `sources:update`, and `sources:delete` manage
project-scoped source references through `ipc/sources.rs`. They use the live
database off the main thread. Reads are available to the remote bridge's read
access mode, while mutations require control access. Agent source content reads
use session-control tools and record source activity in the session timeline.
See [memory.md](memory.md).

## Arcs

`arc:create`, `arc:list`, `arc:get`, `arc:update`, `arc:set-state`, and
`arc:launch-coordinator` manage Arcs through `ipc/arcs.rs`, backed by
`persistence/arcs.rs` and, for the launch, `arcs::launch_coordinator`.
`arc:create` takes `{ name, brief, homeProjectId, dir? }`; an absolute `dir`
must already exist and its `BRIEF.md`/`NOTES.md` are never overwritten, while
an omitted `dir` gets a fresh one under the app data dir. `arc:update` takes
`{ id, name?, brief? }` — a new brief rewrites `BRIEF.md` in place.
`arc:set-state` takes `{ id, state }` with `state` one of `active` / `paused`
/ `done`. All nine are available over the remote bridge. Mutations call
`publish_dashboard_changed`, which sets `dashboardChanged` on the next
`dashboard:delta` so `dashboard:list`'s `arcs` summaries refresh; there is no
focused `arc:*` push channel the way `goal:*` has one.

`arc:launch-coordinator` takes `{ arcId, provider, modelLabel?, modelId?,
reasoningEffort? }` and returns the updated `ArcRecord`. It refuses `ARC_DONE`
on a done Arc, launches through the ordinary session-launch path into the
home project's shared checkout (never a worktree) with the coordinator
preamble as its prompt, and points `coordinatorSessionId` at the new session.
A previous coordinator, if any, is left running with its own `arcId` intact —
the pointer just moves. See [agent-tools.md](agent-tools.md) for the
preambles, membership inheritance, and the launch caps an Arc's own sessions
run under, and [data.md](data.md) for the persisted shape.

`arc:timeline` takes `{ arcId, before, limit? }` and returns
`{ events, nextCursor }`, newest first; pass the previous page's `nextCursor`
as `before` for the next one (default page 60, maximum 200).

`arc:draft-from-session` takes `{ sessionId }` and returns `{ name, brief }`,
both null when the one-shot helper failed. It reads the chat's transcript tail
(16 KB) with the session provider's helper model and a 45-second budget.
`arc:promote` takes `{ sessionId, name, brief, dir }`, returns the new
`ArcRecord`, and refuses `ARC_SESSION_IN_ARC`, `ARC_SESSION_BUSY` (a turn is
running), and `ARC_SESSION_ARCHIVED`. When the arc is created but the chat
cannot be sent its notice, it fails with `ARC_PROMOTE_NOTICE_FAILED`, whose
message starts "The arc was created"; the arc still exists.

## Session PR selection

`prs:set-primary` takes `{ sessionId, prNumber }`, with null selecting automatic
ordering. `prs:dismiss` takes `{ sessionId, prNumber }` and suppresses that
association even if the transcript is replayed. Both return session PR summaries
and publish affected workspace metadata. Remote mutations use the same handlers.
`prs:cleanup` takes `{ sessionId, prNumber }` and runs
[PR cleanup](workspaces.md#pr-cleanup) for a merged PR. It returns the
structured report with its plain `text`, and it never archives the chat.

Existing PR links open their stored URL. `git:view-or-create-pr` is the separate
checkout creation action and accepts `expectedBranch` to reject a stale card
before calling GitHub.

## Contract checks

`npm run check:contracts` checks handler names, application dependency direction, and generated client contracts.
The Rust integration tests also check generated TypeScript freshness.
`remoteReadChannels.json` is generated from the catalogue, with the remote-only delta cursor added explicitly.
MCP tools retain their own explicit session-control exposure. Registering an IPC channel does not expose an agent tool.

The Swift generator reads Rust-generated bindings and emits the phone's wire DTOs.
Phone presentation models remain in Swift. Request wrappers preserve compatibility policies for omitted and null fields.
