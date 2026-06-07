# Argmax

<p align="center">
  <img src="assets/icon.png" alt="Argmax purple mascot" width="96" height="96">
</p>

A local desktop app with a Rust core and React UI for running Claude Code, Codex, and Cursor Agent in isolated git worktrees or your current checkout.

Single-user, on-device, no cloud, no auth. Built for sessions that need real repo context: persistent transcripts, review tools, checks, approvals, and optional worktree isolation for running agents in parallel.

## Status

Early and still evolving (0.2.0). Behavior, the SQLite schema, and the UI change between versions, and there are no stability guarantees yet.

## Stack

| Layer | Tooling |
|---|---|
| Runtime | Tauri 2 + Rust |
| Renderer | React 19 + Vite + plain CSS |
| Persistence | SQLite via `rusqlite` with FTS5 sidecars |
| PTY | `portable-pty` |
| IPC | `#[tauri::command]` + `tauri-specta` bindings |
| Tests | Vitest + Testing Library + Cargo tests |
| Packaging | Tauri bundler (`dmg`, `app`, updater `latest.json`) |

## Prerequisites

- **Node.js** 18+ and npm
- **Rust** 1.95+ ([install rustup](https://rustup.rs))
- **macOS**. The first public Rust/Tauri release is macOS-only; Linux and Windows are not release targets yet.

## Setup & Run

```bash
npm install
npm run tauri:dev
```

Browser-preview mode still works for fast renderer work:

```bash
npx vite --host 127.0.0.1
```

When `window.__TAURI_INTERNALS__` is absent, `window.argmax` is left unset and the renderer falls back to `src/renderer/demoSnapshot.ts`.

## Common Commands

```bash
npm run tauri:dev       # Tauri dev app
npm run tauri:build     # production Tauri bundle
npm run lint            # ESLint
npm run typecheck       # renderer/shared TypeScript
npm run test:unit       # Vitest unit/integration tests
npm run test:perf       # renderer perf budgets
npm run test:rust       # Cargo tests for src-tauri
npm test                # unit + perf + Rust tests
npm run check:bindings  # generated bindings freshness guard
npm run check:tauri-bridge
```

## Layout

```
src/
├── renderer/     React UI built by Vite
├── shared/       Shared TS types and generated Rust bindings
└── test/         Vitest setup and renderer fixtures

src-tauri/        Rust runtime, services, persistence, IPC, packaging config
agents/docs/      Subsystem docs
scripts/          Lightweight CI/check scripts
assets/           App icons
```

Local/generated paths:

```
dist/             Renderer build output
release/          Packaged distributable output
src-tauri/target/ Rust build output
*.sqlite*         Local SQLite databases and WAL/SHM files
node_modules/     Installed dependencies
```

Runtime state is stored under the Rust/Tauri app id's app-data directory in `argmax.sqlite`. This release does not import Electron-era app data. Checkpoint patches live alongside the database under `checkpoints/`. `raw_outputs` rows older than 7 days are pruned daily; everything else is retained indefinitely.

Subsystem conventions live in [`AGENTS.md`](AGENTS.md) / [`CLAUDE.md`](CLAUDE.md).
