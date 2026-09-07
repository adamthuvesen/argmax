# Argmax

![License](https://img.shields.io/github/license/adamthuvesen/argmax) ![Rust](https://img.shields.io/badge/rust-1.95%2B-orange)

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/icon-dark.png">
    <img src="assets/icon.png" alt="Argmax mascot" width="96" height="96">
  </picture>
</p>

A local desktop app for running Claude Code, Codex, Cursor Agent, OpenCode, and Grok Build in parallel, in isolated git worktrees or a shared checkout.

Argmax stores chats and app state locally and uses your installed provider CLIs and their authentication.

![Argmax running agent sessions across parallel git worktrees](assets/screenshots/hero.png)

## Features

- Parallel chats, persistent transcripts, and subagent activity views.
- Diff review, file editing, local checks, and GitHub PR / CI tracking.
- Integrated terminal and browser, with MCP tools for agents to use the browser and coordinate sessions.
- Scheduled tasks, token usage and cost estimates, and project learnings.
- Side chats without choosing a project, and multitasks dispatched from an ongoing chat.
- Import and resume external Claude Code chats with [chat sync](docs/session-sync.md).
- Optional [mobile access over Tailscale](docs/remote.md).

## Status

macOS is the primary release target. See [CHANGELOG.md](CHANGELOG.md) for release history.

## Setup & Run

- Node.js 20.19+ or 22.12+ and npm
- Rust 1.95+
- macOS with Xcode Command Line Tools and Git
- At least one supported provider CLI installed and configured

```bash
npm install
npm run tauri:dev
```

Add a local Git project, choose a provider and model, and send your first prompt. Turn on **Worktree** for an isolated checkout, or leave it off to work in the shared checkout. Configure project setup and check commands in Settings.

Argmax detects `claude`, `codex`, `cursor-agent`, `opencode`, and `grok` from your shell environment. Configure the CLI you want to use in your terminal first. See [providers](docs/providers.md) for capabilities and limitations. GitHub PR / CI integration also requires an authenticated `gh` CLI.

### Static UI Demo

Run the renderer in a browser using mock data from [`src/renderer/demoSnapshot.ts`](src/renderer/demoSnapshot.ts):

```bash
npx vite --host 127.0.0.1
```

## Using Argmax

- [Review and workspaces](docs/workspaces.md): inspect diffs, edit files, and archive completed work. Agents in a shared checkout see each other's edits.
- [Agent tools](docs/agent-tools.md): providers receive the `argmax` MCP tools for browser interaction and session coordination.
- [Scheduled tasks](docs/scheduled-tasks.md): run saved prompts on a schedule while the app is running. Missed runs collapse into one run when it reopens.
- [Usage](docs/usage.md): inspect tokens and cost estimates. Coverage varies by provider, and list-price estimates can differ from subscription charges.
- [Mobile access](docs/remote.md): enable Remote access in Settings and pair a phone over Tailscale.
- [Approvals and checks](docs/approvals-checks.md): auto-approve is the default. Native permission handling varies by provider.

## Stack

| Layer | Tooling |
|---|---|
| Runtime | Tauri 2 + Rust |
| Renderer | React 19 + Vite + plain CSS |
| Persistence | SQLite via `rusqlite` with FTS5 sidecars |
| PTY | `portable-pty` |
| IPC | `#[tauri::command]` + `tauri-specta` bindings |
| Tests | Vitest + Testing Library + Cargo tests |
| Packaging | Tauri bundler (`dmg`, `app`) and Tauri updater |

## Commands

```bash
npm run tauri:dev          # Start Tauri dev app
npm run tauri:build        # Build production bundle
npm run build:renderer     # Build renderer bundle
npm run lint               # ESLint
npm run typecheck          # TypeScript check
npm run test:unit          # Vitest unit tests
npm run test:perf          # Performance benchmarks
npm run test:rust          # Cargo test suite
npm test                   # Run all test suites
npm run lint:rust          # cargo clippy, warnings are errors
npm run precheck           # CI checks scoped to the branch's changes
npm run check:tauri-bridge # Check IPC channel parity
npm run check:bundle       # Verify bundle size budget
npm run doctor             # Check local verification capabilities
```

See [package.json](package.json) for all commands, [testing](docs/testing.md) for checks, [verification](docs/verification.md) for end-to-end scenarios, and [release](docs/release.md) for packaging. Production bundles are written to `src-tauri/target/release/bundle/`.

## Layout

```text
src/
├── renderer/     React UI, including the mobile interface
├── shared/       Shared TypeScript types and generated bindings
└── test/         Vitest configuration and test harness

src-tauri/        Rust runtime, services, persistence, IPC handlers
docs/            Subsystem documentation
scripts/         CI and verification scripts
assets/          Application icons, mascot sources, and screenshots
```

Runtime database state is stored in `argmax.sqlite` under the Tauri app data folder. `ARGMAX_DATA_DIR` overrides the app data folder for a separate local profile. See [data](docs/data.md) for persistence details.

Start with the [architecture guide](docs/architecture.md) for subsystem documentation and [AGENTS.md](AGENTS.md) for contributor conventions.
