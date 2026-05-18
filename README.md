# Argmax

A local Electron command center for running AI coding agents in parallel git worktrees.

Single-user, on-device, no cloud, no auth. Designed for Claude Code, Codex, and Cursor Agent sessions that need real repo context — persistent transcripts, review tools, checks, approvals, and worktree isolation.

```
┌────────────────────────────┐         ┌────────────────────────────┐
│ React renderer (Vite)      │   IPC   │ Electron main (Node)       │
│ • Focused reads + deltas   │ ◀────▶  │ • SQLite (better-sqlite3)  │
│ • window.argmax only       │         │ • Provider PTYs / stdio    │
└────────────────────────────┘         │ • Workspaces, checks, gh   │
                                       └────────────────────────────┘
```

## What it does

- Registers local projects and creates task-specific git worktrees.
- Launches **Claude Code**, **Codex**, or **Cursor Agent** in those worktrees.
- Persists sessions, normalized timeline events, raw provider output, approvals, checks, checkpoints, and workspace state in local SQLite.
- Streams normalized provider events into a React dashboard — protocol JSON never leaks into chat.
- Reviews diffs, prepares commits, and runs configurable workspace checks.
- Watches PR check status via `gh` and auto-launches a follow-up session when CI fails.
- Captures project-scoped learnings and replays them as prompt preambles in future sessions.

## Stack

| Layer | Tooling |
|---|---|
| Runtime | Electron 35, Node.js (system Node for tests) |
| Renderer | React 19 + Vite + plain CSS (light theme only) |
| Language | TypeScript, ESM, NodeNext imports |
| Persistence | SQLite via `better-sqlite3`; FTS5 sidecars for events + learnings |
| PTY | `node-pty` (provider sessions + integrated terminal) |
| Validation | Zod schemas at the IPC boundary |
| Tests | Vitest + Testing Library + jsdom |
| Packaging | `electron-builder` (signed/notarized macOS DMG + ZIP) |

## Requirements

- Node.js and npm.
- Git.
- One or more of: Claude Code, Codex, Cursor Agent CLIs — installed and authenticated.
- (Optional) GitHub CLI (`gh`) for the CI feedback loop.

Native modules compile separately for Electron and system Node. Use the npm scripts below — `vite` / `vitest` directly will surface `NODE_MODULE_VERSION` errors.

## Setup & run

```bash
npm install
npm run dev          # rebuild:electron, then concurrently: Vite + tsc-watch + electron
```

For fast renderer-only visual work without rebuilding native modules:

```bash
npx vite --host 127.0.0.1
```

Browser-preview mode detects the missing `window.argmax` and falls back to `src/renderer/demoSnapshot.ts`. The bridge-missing banner is suppressed on `127.0.0.1` / `localhost`.

## Common commands

```bash
npm run dev          # rebuild native modules for Electron, then run the app
npm test             # rebuild native modules for Node, then run Vitest
npm run lint         # ESLint
npm run typecheck    # typecheck renderer/shared and main configs
npm run build        # build main and renderer output
npm run package      # signed/notarized macOS app (output: release/)
```

Targeted test runs:

```bash
npx vitest run src/renderer/                  # renderer + shared only — no native rebuild needed
npx vitest run src/renderer/App.test.tsx
npx vitest                                    # watch mode
```

**Do not run multiple `npm test` commands in parallel.** Each starts with a native rebuild; concurrent rebuilds can corrupt `better-sqlite3` / `node-pty` build directories.

CI runs `npm run lint`, `npm run typecheck`, and `npm test` on macOS for every push and PR — see [.github/workflows/ci.yml](.github/workflows/ci.yml).

## Project layout

```
src/
├── main/         Electron main process — services, IPC, persistence, lifecycle
├── renderer/     React UI built by Vite
├── shared/       Types + Zod schemas crossing the main/renderer boundary
└── test/         Vitest setup

agents/docs/      Deep-dive docs (architecture, providers, data, …)
openspec/         OpenSpec change & spec artifacts
scripts/          Native-module rebuild helpers
assets/           App icon
build/            Hardened-runtime entitlements
dist/             Build output (gitignored)
release/          Packaged distributable output (gitignored)
```

## Going deeper

Start with the map in [`AGENTS.md`](AGENTS.md) (also reachable as `CLAUDE.md`). It indexes the deep-dive docs under `agents/docs/`:

| Topic | Doc |
|---|---|
| Process boundaries, services, dashboard reads | [agents/docs/architecture.md](agents/docs/architecture.md) |
| IPC channels, schemas, adding a channel | [agents/docs/ipc.md](agents/docs/ipc.md) |
| SQLite schema, migrations, retention, FTS5 | [agents/docs/data.md](agents/docs/data.md) |
| Claude / Codex / Cursor adapters | [agents/docs/providers.md](agents/docs/providers.md) |
| Worktrees, review, checkpoints, file preview | [agents/docs/workspaces.md](agents/docs/workspaces.md) |
| Risk policy, approvals, workspace checks | [agents/docs/approvals-checks.md](agents/docs/approvals-checks.md) |
| Plan / Question cards in chat, tool-deny handling | [agents/docs/chat-cards.md](agents/docs/chat-cards.md) |
| Integrated terminal panel | [agents/docs/terminal.md](agents/docs/terminal.md) |
| GitHub CI feedback loop | [agents/docs/gh.md](agents/docs/gh.md) |
| Project-scoped learnings (memory) | [agents/docs/memory.md](agents/docs/memory.md) |
| Native rebuilds, lifecycle, preload, packaging | [agents/docs/electron.md](agents/docs/electron.md) |
| Test conventions and regression tests | [agents/docs/testing.md](agents/docs/testing.md) |
| Design tokens, motion, the light-theme rule | [agents/docs/styling.md](agents/docs/styling.md) |
| Signing + notarization | [agents/docs/release.md](agents/docs/release.md) |
| OpenSpec workflow | [agents/docs/openspec.md](agents/docs/openspec.md) |

## Local data

Runtime state is stored under `app.getPath("userData")/local-state/argmax.sqlite`. Checkpoint patches live alongside the database under `checkpoints/`. Generated build output lives in `dist/`; packaged distributables land in `release/`.

`raw_outputs` rows older than 7 days are pruned daily; everything else is retained indefinitely. The Help menu exposes a one-shot `Vacuum database` action if you need to reclaim space after deleting projects.

## Status

Argmax is pre-1.0. The IPC contract, schema, and main-process surfaces are still moving. The `AGENTS.md` conventions are the load-bearing rules — read them before adding a feature, especially anything touching IPC, the model registry, or SQLite migrations.
