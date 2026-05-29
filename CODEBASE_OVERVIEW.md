# Argmax — Codebase Overview

A local desktop app that runs AI coding agents (Claude Code, Codex, Cursor) in parallel git worktrees. Single user, on-device, no cloud, no login.

## The two halves

Argmax is one app made of two parts that talk over a single bridge:

```
React UI  ──window.argmax──►  Rust runtime
(src/renderer)                (src-tauri)
   what you see                 the real work
```

- **Rust (`src-tauri/`)** does everything real: spawns agent processes, owns the database, manages git worktrees, runs terminals.
- **React (`src/renderer/`)** is just the screen. It never touches files or processes directly — it asks Rust.
- **Tauri** is the framework gluing them together (think "Electron, but the backend is Rust").

Every call from UI to backend goes through `window.argmax.*`. That's the one rule that explains the whole app.

## Top-level folders

| Folder | What's in it |
|---|---|
| `src/renderer/` | The React UI |
| `src/shared/` | Types shared by both halves |
| `src-tauri/` | The Rust backend |
| `agents/docs/` | Deep docs per subsystem — read before editing one |
| `openspec/` | Spec/change planning artifacts |
| `scripts/` | Small CI/check scripts |
| `assets/`, `dist/`, `release/` | App icon, build output, packaged app |

## Backend — `src-tauri/src/`

`lib.rs` boots the app: opens the DB, starts services, wires up the menu and IPC. Long-lived services live in `state.rs` and get handed to command handlers.

The folders are subsystems, one job each:

| Folder | Job |
|---|---|
| `ipc/` | The API. Every `window.argmax` call lands in a handler here. |
| `providers/` | Runs the agents — Claude/Codex/Cursor adapters, the process runtime, output parsing. |
| `persistence/` | SQLite: connection, migrations, data access. |
| `workspaces/`, `git/`, `review/`, `files/` | Worktrees, branches, diffs, file reads/writes. |
| `approvals/`, `checks/` | Permission prompts and post-run checks. |
| `terminal/` | The built-in terminal panel (PTYs). |
| `gh/`, `mcp/`, `memory/`, `skills/`, `ide/`, `notifications/`, `updater/` | GitHub/CI, MCP servers, learnings, skills, editor links, OS notifications, auto-update. |

`ipc/` is the map of what the app can do — scan the filenames (`session.rs`, `workspaces.rs`, `git_ops.rs`, `prs.rs`…) to see every feature.

## Frontend — `src/renderer/`

React 19 + Vite.

| Path | What it is |
|---|---|
| `App.tsx` | The shell that composes everything. |
| `components/` | UI pieces — chat bubbles, diffs, dialogs, settings. |
| `hooks/` | Reusable stateful logic (`use*`). |
| `lib/` | Pure helpers — formatting, parsing, diffing. No React. |
| `styles/` | CSS and theme tokens. |
| `lib/tauriBridge.ts` | **The only file that imports Tauri directly.** All backend calls funnel through here. |

If Tauri isn't present (browser preview), the UI falls back to fake data in `demoSnapshot.ts`.

## Shared — `src/shared/`

The contract between the two halves:

- `bindings.d.ts` — Rust types, auto-generated. Don't hand-edit.
- `types.ts` — the `window.argmax` API shape.
- `providerModels.ts` — model names, defaults, pricing. One source of truth; don't duplicate these.

## How one action flows

You click "send a message" to an agent:

1. UI calls `window.argmax.session.*` via `tauriBridge.ts`.
2. The matching handler in `src-tauri/src/ipc/session.rs` runs.
3. `providers/` spawns/feeds the agent process; output is parsed into timeline events.
4. Events are saved to SQLite and pushed back to the UI.
5. React renders the new chat.

The UI never decides anything important — it shows state and sends requests. Rust owns the truth.

## A few rules worth knowing

- Imports inside `src/` end in `.js` even for `.ts` files.
- The UI reads from SQLite + small delta pushes — no constant polling.
- Database migrations are append-only; never edit an applied one.
- Four themes (Light/Dark/System/Purple); tokens live in `styles/`.
- No native Node addons — SQLite and terminals are pure Rust.

## Where to go next

`agents/docs/` has one file per subsystem (`providers.md`, `data.md`, `workspaces.md`…). Read the matching one before changing that area. Start with `agents/docs/architecture.md`.
