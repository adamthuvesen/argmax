# Architecture

Argmax pairs a Rust/Tauri runtime with a React/Vite renderer over a `window.argmax` bridge.

## Map

The doc index is canonical in [AGENTS.md](../AGENTS.md#read-the-docs-first).
This doc is the entry point: read it, then the subsystem doc for the area
you are changing.

## Runtime: `src-tauri`

[src-tauri/src/lib.rs](../src-tauri/src/lib.rs) initializes app state, SQLite, services, menus, and event channels. The desktop composition root stores services in [state.rs](../src-tauri/src/state.rs). Transport adapters resolve them through `tauri::State`. The scheduler receives explicit service dependencies.

## Layers

The Rust code is a Cargo workspace rooted at `src-tauri/Cargo.toml`. Imports point down, and the compiler rejects an import that points up.

| Crate | Holds | May import |
|---|---|---|
| `crates/argmax-contracts` | Errors, validated ids, enums, and wire types with specta derives. | Nothing else in Argmax. |
| `crates/argmax-process` | The login-shell environment, provider environments, and the one git runner. | Contracts. |
| `crates/argmax-store` | SQLite: migrations, every query, and the event normalization that reads depend on. | Contracts and process. |
| `argmax` (`src-tauri/src`) | Services, providers, IPC, the remote bridge, and the Tauri shell. | All of the above. |

Inside the `argmax` crate, `ipc/` and `remote/` are the transport edges. Nothing else imports them. `check:rust-boundaries` enforces that rule and the rules below, because one crate cannot state them to the compiler:

- SQL text and `prepare` or `query_row` calls stay in `argmax-store`. Naming a `Connection` or a `Transaction` to pass it through is fine.
- Only a person IPC handler mints a `PersonAttestation`. The type lives in the store, so this is a source check, and Rust visibility cannot do it across crates.

Each item has one path. Import it from the crate and module that define it, for example `argmax_store::events` or `argmax_contracts::validation`, not through a re-export in the app crate. One name per thing means a search for a path finds every caller, and a move breaks the build at each caller instead of hiding behind an alias. Two kinds of `pub use` stay. A module may expose items from its private submodules, because that is still the only public path. `ipc::inputs` gathers every command's input type so each IPC handler imports one module.

## Key directories


- `application/`: Validated command values and transport-independent session launch.
- `ipc/`: Request/response adapters and the typed command catalogue.
- `providers/`: Adapter CLIs (Claude, Codex, Cursor, OpenCode, Grok Build), PTY runtime, normalizers, and the event flush queue.
- `session_control/`: Private socket transport for agent-initiated session launch, move, list, and message commands.
- `workspaces/`, `review/`, `files/`, `git/`: Worktree lifecycle, diffs, file operations, and git commands.
- `approvals/`, `checks/`, `gh/`, `terminal/`, `attachments/`, `ide/`, `skills/`, `routines/`: Subsystem services.

Dashboard state is SQLite-first: UI reads (`dashboard:list`, `session:events-since`, `workspace:status`) paired with post-commit `dashboard:delta` push events.

Pushes invalidate data instead of carrying stale copies. Session reads use a
transactional mutation sequence to recover updates and deletions as well as
inserts. Queue overflow and a remote `resync` use the same authoritative
snapshot recovery; the phone catches a chat it read live up from its change
cursor after a reconnect or reopen, and rereads only a copy loaded from disk. Pending follow-ups are journaled in SQLite before the send
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

Components reach the bridge through one layer. [useBridgeQuery](../src/renderer/data/useBridgeQuery.ts) owns reads and drops a reply whose key changed. [bridgeActions.ts](../src/renderer/data/bridgeActions.ts) owns writes. See [ipc.md](ipc.md#calling-a-channel-from-a-component). The spike chose a local hook over TanStack Query: the library added 33,212 eager bytes and put the desktop entry 13,395 bytes over the [bundle budget](performance.md#eager-bundle).

An action on a project folder carries a required [ProjectTarget](../src/renderer/lib/projectTarget.ts), so a surface cannot leave the folder out.

The saved appearance is painted before any module loads by a script inlined in `index.html` and `mobile.html`. [appearanceBootstrap.ts](../src/renderer/lib/appearanceBootstrap.ts) is its source, and `npm run build:appearance-bootstrap` writes it. Do not edit it in the HTML.

Snapshot and selection stay in [useDashboardSession](../src/renderer/hooks/useDashboardSession.ts); [useAppGridSelection](../src/renderer/hooks/useAppGridSelection.ts) resolves grid moves against that snapshot and writes them to `paneGrid`.

Shell policy has separate owners. [useAppMenuCommands](../src/renderer/hooks/useAppMenuCommands.ts) resolves native menu commands, and [useAppDestinations](../src/renderer/hooks/useAppDestinations.ts) applies explicit sidebar and session navigation. [useProjectActions](../src/renderer/hooks/useProjectActions.ts) and [useWorkspaceActions](../src/renderer/hooks/useWorkspaceActions.ts) own catalog and workspace mutations with their selection repair. `App` supplies current selection and renders surfaces. The grid lays out cells, while `SessionPane` owns review state and approval resolution. [useSessionComposerState](../src/renderer/hooks/useSessionComposerState.ts) owns each conversation's model choice, status, and attached annotations; the transcript reads timeline events independently.

Mouse back and forward buttons move through each window's app navigation
history: chats, New chat, Settings groups, Schedule, Usage, Activity, arcs, and
the Browser page. History is bounded and stays in memory until the window
closes. Opening a new destination after going back discards forward history.
Dashboard refreshes and transient dialogs do not add navigation entries.
Clicks inside a browser pane use that tab's web history instead.

Dashboard React state contains metadata and approvals. Transcript events, raw output, and read cursors live together in [SessionTimelines](../src/renderer/lib/sessionTimelines.ts). Each conversation subscribes to its session through `useSessionTimeline`, so a token does not update unrelated panes or the dashboard shell. Agent traces use their parent session's history, while multitasks subscribe to their own session. Subscribed histories stay resident, and the store retains at most 12 inactive histories. Eviction drops the history and its cursors together so reopening a session fetches a complete tail.

Rust owns timeline meaning in [timeline_semantics.rs](../src-tauri/crates/argmax-store/src/timeline_semantics.rs).
Every event read carries a versioned semantic contract, including historical rows.
Generated types serve both desktop and phone projections.
The renderer's [canonicalTimeline.ts](../src/renderer/lib/canonicalTimeline.ts) adds presentation models and caches them.
Provider payload interpretation remains only for older hosts without the supported contract.
Raw payloads remain available for diagnostics and tool input or output bodies.

[SessionMultiGrid.tsx](../src/renderer/components/SessionMultiGrid.tsx) manages two pane types, plus one review-panel mode:
- **Session panes**: Primary conversation views.
- **Launcher panes**: In-grid session creation. Each launcher has its own `projectId` via `setLauncherPaneProject` ([paneGrid.ts](../src/renderer/state/paneGrid.ts)), so launching in another repo does not change the global app selection.
- **Agents view**: Subagent traces linked to a parent session and tool use ID, shown as one mode of that session's review panel (Changes / Files / Agents / Browser / Terminal). They live and die with the session's pane.

The [Browser page](browser.md) is a workspace-column surface, not a grid cell: the left-rail Browser item fills the workspace with the in-app browser while the session sidebar stays. Settings, Schedule, and Usage still replace the sidebar; this page does not.

"New chat here" in the pane menu opens a launcher adjacent to the active pane without replacing the grid. The grid supports at most four cells in two rows and two columns. Two cells can sit side by side or stack vertically. Three cells use a split row and a full-width row, and four form an aligned 2×2 grid. Both rows share the same column divider, and layout changes rebalance it.

Dragging a sidebar session over a cell previews an available split in the outer quarter of each edge. The center opens it in that cell. At capacity the whole cell is a replacement target. Dragging an already-open session onto another cell swaps them. Drop previews label the action, and divider movement is batched to animation frames.

## Shared: `src/shared`

- [bindings.d.ts](../src/shared/bindings.d.ts): Generated Rust types from `tauri-specta`.
- [types.ts](../src/shared/types.ts): the `ArgmaxApi` interface, renderer-only shapes, and the wire types re-exported from `bindings.d.ts`. A type that crosses IPC is never declared by hand here: it is an alias of the generated binding, or a `Retype<>` of it that narrows the columns Rust stores as plain strings (`provider`, `state` on workspaces, event `type`). `WireSubtype<>` covers the two untagged enums the binding cannot narrow on its own.
- [ipcSchemas.ts](../src/shared/ipcSchemas.ts): Generated associations between command names, input types, and result types.
- [providerModels.ts](../src/shared/providerModels.ts): Model metadata, defaults, and pricing.
