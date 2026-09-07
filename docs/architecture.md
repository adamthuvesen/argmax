# Architecture

Argmax pairs a Rust/Tauri runtime with a React/Vite renderer over a `window.argmax` bridge.

## Map

| Topic | Doc |
|---|---|
| Runtime lifecycle | [runtime.md](runtime.md) |
| IPC contract | [ipc.md](ipc.md) |
| Providers | [providers.md](providers.md) |
| SQLite | [data.md](data.md) |
| Worktrees, review, files, git | [workspaces.md](workspaces.md) |
| Scheduled tasks | [scheduled-tasks.md](scheduled-tasks.md) |
| Approvals and checks | [approvals-checks.md](approvals-checks.md) |
| Terminal panel | [terminal.md](terminal.md) |
| In-app browser | [browser.md](browser.md) |
| Mobile remote | [remote.md](remote.md) |
| GitHub CI feedback | [gh.md](gh.md) |
| Learnings | [memory.md](memory.md) |
| Skills / slash autocomplete | [skills.md](skills.md) |
| Chat surface and cards | [chat-cards.md](chat-cards.md) |
| Styling | [styling.md](styling.md) |
| Perf budgets | [performance.md](performance.md) |
| Tests | [testing.md](testing.md) |
| Release | [release.md](release.md) |

## Runtime: `src-tauri`

[src-tauri/src/lib.rs](../src-tauri/src/lib.rs) initializes app state, SQLite, services, menus, and event channels. Shared services live in [state.rs](../src-tauri/src/state.rs) and are accessed via `tauri::State`.

Key directories:

- `ipc/`: Request/response command handlers.
- `persistence/`: SQLite connection, migrations, and repository queries.
- `providers/`: Adapter CLIs (Claude, Codex, Cursor, OpenCode, Grok Build), PTY runtime, normalizers, and the event flush queue.
- `session_control/`: Private socket transport for agent-initiated session launch, move, list, and message commands.
- `sessions/`: Orchestration between IPC and providers.
- `workspaces/`, `review/`, `files/`, `git/`: Worktree lifecycle, diffs, file operations, and git commands.
- `approvals/`, `checks/`, `gh/`, `terminal/`, `attachments/`, `ide/`, `skills/`, `routines/`: Subsystem services.

Dashboard state is SQLite-first: UI reads (`dashboard:list`, `session:events-since`, `workspace:status`) paired with post-commit `dashboard:delta` push events.

Pushes invalidate data instead of carrying stale copies. Session reads use a
transactional mutation sequence to recover updates and deletions as well as
inserts. Queue overflow and remote reconnect use the same authoritative
snapshot recovery. Pending follow-ups are journaled in SQLite before the send
call is acknowledged, mirrored in memory for dispatch, and included in
`dashboard:list` so they also survive a missed notification.

### Dependencies

- **tauri >= 2.11**: Enables `#[tauri::command(rename = "...")]` for stable IPC channel names.
- **rusqlite bundled-full**: Includes FTS5 for search across timeline events and learnings.
- **portable-pty 0.9**: PTY process management for providers and terminals.

## Renderer: `src/renderer`

React 19 + Vite. [App.tsx](../src/renderer/App.tsx) renders the shell; [tauriBridge.ts](../src/renderer/lib/tauriBridge.ts) handles IPC via `window.argmax`. Direct Tauri API usage is limited to window chrome in [windowChrome.ts](../src/renderer/lib/windowChrome.ts) and min-size constraints in [App.tsx](../src/renderer/App.tsx). In standalone browser previews, the renderer falls back to [demoSnapshot.ts](../src/renderer/demoSnapshot.ts).

Shell state that several surfaces move lives in `src/renderer/state/`, not in `App`: one module per concern, each a value plus named mutators and a `useSyncExternalStore` hook, and a `reset*ForTests` the App harness calls between tests. Consumers subscribe where they are instead of taking a prop from the shell.

| Store | Owns | Read by |
|---|---|---|
| [toast.ts](../src/renderer/state/toast.ts) | The single transient message | The shell (auto-dismiss for info toasts stays there) |
| [overlays.ts](../src/renderer/state/overlays.ts) | Which full-screen page holds the workspace column, the settings group and navigation request, palette open + scope, cheat sheet; Esc precedence | Shell, sidebar, command palette |
| [launcherSurface.ts](../src/renderer/state/launcherSurface.ts) | Full-screen launcher visibility, side-chat arming, composer reset signal | Shell, sidebar |
| [paneGrid.ts](../src/renderer/state/paneGrid.ts) | The live grid, folding the pure reducers in [gridState.ts](../src/renderer/lib/gridState.ts) | Shell, sidebar (open rows) |
| [workspaceDrag.ts](../src/renderer/state/workspaceDrag.ts) | The sidebar row being dragged towards the grid | Shell, sidebar |
| [sidebarChrome.ts](../src/renderer/state/sidebarChrome.ts) | Sidebar collapse (persisted) and peek | Shell, sidebar |

Snapshot and selection stay in [useDashboardSession](../src/renderer/hooks/useDashboardSession.ts); [useAppGridSelection](../src/renderer/hooks/useAppGridSelection.ts) resolves grid moves against that snapshot and writes them to `paneGrid`.

Dashboard React state contains metadata and approvals. Transcript events, raw output, and read cursors live together in [SessionTimelines](../src/renderer/lib/sessionTimelines.ts). Each conversation subscribes to its session through `useSessionTimeline`, so a token does not update unrelated panes or the dashboard shell. Agent traces use their parent session's history, while multitasks subscribe to their own session. Subscribed histories stay resident, and the store retains at most 12 inactive histories. Eviction drops the history and its cursors together so reopening a session fetches a complete tail.

Renderer code routes timeline meaning through [canonicalTimeline.ts](../src/renderer/lib/canonicalTimeline.ts). Its cached decoder turns each persisted `TimelineEvent` into a discriminated union for messages, tools, lifecycle rows, multitasks, approvals, errors, and unknown rows. Consumers branch on that union instead of interpreting provider payload keys independently. The original event remains available for lossless debug output and large tool input or output bodies.

[SessionMultiGrid.tsx](../src/renderer/components/SessionMultiGrid.tsx) manages two pane types:
- **Session panes**: Primary conversation views.
- **Launcher panes**: In-grid session creation. Each launcher has its own `projectId` via `setLauncherPaneProject` ([paneGrid.ts](../src/renderer/state/paneGrid.ts)), so launching in another repo does not change the global app selection.
- **Agents view**: Subagent traces linked to a parent session and tool use ID, shown as one mode of that session's review panel (Changes / Files / Agents / Browser / Terminal). They live and die with the session's pane.

The [Browser page](browser.md) is a workspace-column surface, not a grid cell: the left-rail Browser item fills the workspace with the in-app browser while the session sidebar stays. Settings, Schedule, and Usage still replace the sidebar; this page does not.

"New chat here" in the pane menu opens a launcher adjacent to the active pane without replacing the grid.

## Shared: `src/shared`

- [bindings.d.ts](../src/shared/bindings.d.ts): Generated Rust types from `tauri-specta`.
- [types.ts](../src/shared/types.ts): the `ArgmaxApi` interface, renderer-only shapes, and the wire types re-exported from `bindings.d.ts`. A type that crosses IPC is never declared by hand here: it is an alias of the generated binding, or a `Retype<>` of it that narrows the columns Rust stores as plain strings (`provider`, `state` on workspaces, event `type`). `WireSubtype<>` covers the two untagged enums the binding cannot narrow on its own.
- [ipcSchemas.ts](../src/shared/ipcSchemas.ts): Channel-name union for the bridge.
- [providerModels.ts](../src/shared/providerModels.ts): Model metadata, defaults, and pricing.
