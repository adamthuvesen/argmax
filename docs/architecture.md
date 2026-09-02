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
- `session_control.rs`: Private socket transport for agent-initiated session launch, move, list, and message commands.
- `sessions/`: Orchestration between IPC and providers.
- `workspaces/`, `review/`, `files/`, `git/`: Worktree lifecycle, diffs, file operations, and git commands.
- `approvals/`, `checks/`, `gh/`, `terminal/`, `attachments/`, `ide/`, `skills/`, `routines/`: Subsystem services.

Dashboard state is SQLite-first: UI reads (`dashboard:list`, `session:events-since`, `workspace:status`) paired with post-commit `dashboard:delta` push events.

### Dependencies

- **tauri >= 2.11**: Enables `#[tauri::command(rename = "...")]` for stable IPC channel names.
- **rusqlite bundled-full**: Includes FTS5 for search across timeline events and learnings.
- **portable-pty 0.9**: PTY process management for providers and terminals.

## Renderer: `src/renderer`

React 19 + Vite. [App.tsx](../src/renderer/App.tsx) renders the shell; [tauriBridge.ts](../src/renderer/lib/tauriBridge.ts) handles IPC via `window.argmax`. Direct Tauri API usage is limited to window chrome in [windowChrome.ts](../src/renderer/lib/windowChrome.ts) and min-size constraints in [App.tsx](../src/renderer/App.tsx). In standalone browser previews, the renderer falls back to [demoSnapshot.ts](../src/renderer/demoSnapshot.ts).

[SessionMultiGrid.tsx](../src/renderer/components/SessionMultiGrid.tsx) manages two pane types:
- **Session panes**: Primary conversation views.
- **Launcher panes**: In-grid session creation. Each launcher has its own `projectId` via `setLauncherProject` ([gridState.ts](../src/renderer/lib/gridState.ts)), so launching in another repo does not change the global app selection.
- **Agents view**: Subagent traces linked to a parent session and tool use ID, shown as the third mode of that session's review panel (Changes / Files / Agents / Browser). They live and die with the session's pane.

"New chat here" in the pane menu opens a launcher adjacent to the active pane without replacing the grid.

## Shared: `src/shared`

- [bindings.d.ts](../src/shared/bindings.d.ts): Generated Rust types from `tauri-specta`.
- [types.ts](../src/shared/types.ts): `ArgmaxApi` interface and renderer domain types.
- [ipcSchemas.ts](../src/shared/ipcSchemas.ts): Channel-name union for the bridge.
- [providerModels.ts](../src/shared/providerModels.ts): Model metadata, defaults, and pricing.
