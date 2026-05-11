# Argmax

Argmax is a local Electron command center for running AI coding agents in parallel git worktrees. It is single-user, on-device, and designed for Claude Code and Codex sessions that need real repo context, persistent transcripts, review tools, checks, and branch/worktree isolation.

## What It Does

- Registers local projects and creates task-specific git worktrees.
- Launches Claude Code or Codex in those worktrees.
- Persists sessions, timeline events, raw provider output, checks, approvals, checkpoints, and workspace state in local SQLite.
- Streams normalized provider events into a React dashboard without showing provider protocol JSON as chat.
- Provides local review/checkpoint flows around git diffs and commits.

## Stack

- Electron 35 main process
- React 19 + Vite renderer
- TypeScript, ESM, NodeNext imports
- SQLite via `better-sqlite3`
- PTY support via `node-pty`
- Vitest + Testing Library

## Requirements

- Node.js and npm
- Git
- Claude Code and/or Codex CLI installed and authenticated, depending on which provider you want to run

Native modules are compiled separately for Electron and system Node. Use the npm scripts below instead of calling `vite` or `vitest` directly unless you know the native runtime is already correct.

## Setup

```bash
npm install
```

## Run

```bash
npm run dev
```

This rebuilds native modules for Electron, starts Vite, watches the main-process TypeScript build, and opens the app when both the main bundle and renderer server are ready.

For fast renderer-only visual work, you can run Vite directly and use the browser-preview fallback data:

```bash
npx vite --host 127.0.0.1
```

The real Electron app communicates with the renderer through `window.argmax`; browser preview mode uses `src/renderer/demoSnapshot.ts`.

## Common Commands

```bash
npm run dev          # rebuild native modules for Electron, then run the app
npm test             # rebuild native modules for Node, then run Vitest
npm run lint         # run ESLint
npm run typecheck    # typecheck renderer/shared and main configs
npm run build        # build main and renderer output
```

Targeted test runs:

```bash
npx vitest run src/renderer/
npx vitest run src/renderer/App.test.tsx
npx vitest
```

Renderer and shared tests do not touch native modules, so targeted `npx vitest run src/renderer/ src/shared/` is the fast path when iterating on UI. Do not run multiple `npm test` commands in parallel; each starts with a native rebuild.

## Project Layout

```text
src/
├── main/         Electron main process: services, IPC, persistence, lifecycle
├── renderer/     React UI built by Vite
├── shared/       Types and Zod schemas crossing the main/renderer boundary
└── test/         Vitest setup

agents/docs/      Deeper architecture, provider, Electron, testing, and styling notes
openspec/         OpenSpec change and spec artifacts
scripts/          Native-module rebuild helpers
dist/             Build output
```

## Architecture Notes

The main process owns SQLite, provider child processes, workspace orchestration, checks, approvals, review services, and IPC handlers. The renderer talks to main only through the preload bridge at `window.argmax`.

IPC request/response channels are registered in `src/main/ipc.ts`, validated with schemas from `src/shared/ipcSchemas.ts`, and exposed through `src/main/preload.ts`. When adding a request/response channel, keep `REGISTERED_IPC_CHANNELS`, schemas, preload, and `ArgmaxApi` in sync.

Dashboard reads are SQLite-first and focused:

- `dashboard.list()` loads the dashboard shell.
- `approvals.pending()` loads pending approvals.
- `workspaces.status()` refreshes workspace/session/check/checkpoint state.
- `session.eventsSince()` tails selected-session events and raw output with rowid cursors.
- `dashboard.onDelta()` streams committed provider-session changes.

`dashboard.load()` remains as a compatibility wrapper, but normal renderer refreshes should use focused reads.

## Provider Notes

Provider defaults live in `src/shared/providerModels.ts`. Do not duplicate model labels, ids, reasoning effort values, or launch modes elsewhere.

Structured JSON is the default launch mode. Follow-up prompts use each provider's native resume id stored as `sessions.provider_conversation_id`, so Argmax's durable UI session can continue the same provider conversation across turns.

Provider sessions intentionally run with broad local permissions because Argmax is a trusted single-user desktop app. Keep those launch flags centralized in `src/main/providers/providerAdapters.ts`.

## Native Module Gotchas

`better-sqlite3` and `node-pty` must match the runtime:

```bash
npm run rebuild:electron  # for Electron
npm run rebuild:node      # for tests and scripts
```

A `NODE_MODULE_VERSION` error usually means the module was built for the wrong runtime. Re-run the right rebuild command; do not reinstall dependencies as the first move.

## Styling

Renderer styling lives in `src/renderer/styles.css`. Argmax is light-theme only and uses the Lilex Nerd Font tokens defined in CSS. Keep UI tests resilient by querying by role, aria-label, title, or visible text rather than class names.

## Deeper Docs

- `agents/docs/architecture.md` — process boundaries, IPC, persistence, dashboard reads
- `agents/docs/providers.md` — Claude/Codex launch and resume behavior
- `agents/docs/electron.md` — native rebuilds, preload bridge, lifecycle
- `agents/docs/testing.md` — test layout and conventions
- `agents/docs/styling.md` — design tokens and renderer CSS rules
- `agents/docs/openspec.md` — OpenSpec workflow

## Local Data

Runtime state is stored under Electron's `app.getPath("userData")/local-state/argmax.sqlite`. Generated build output lives in `dist/`.
