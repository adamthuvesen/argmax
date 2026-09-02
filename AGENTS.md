# AGENTS.md: Argmax

Argmax is a local Tauri desktop app that orchestrates AI coding agents (Claude Code, Codex, Cursor, OpenCode, Grok Build) in parallel git worktrees. Single-user, on-device, no cloud, no auth.

User-level guidance (tone, principles, git etiquette) lives in `~/.claude/CLAUDE.md` and `~/dotfiles/agents/AGENTS.md` and is *not* duplicated here. This file is for project-specific facts.

## Layout

```
src/
├── renderer/     React UI (Vite-built; talks to Rust via window.argmax)
├── shared/       Shared TS types + generated Tauri bindings
└── test/         Vitest setup

src-tauri/        Rust runtime, services, IPC handlers, persistence, packaging
scripts/          Lightweight CI/check scripts
docs/             Deeper subsystem docs; see Index
assets/           App icon sources the icon generator reads, and the mascot sprite
dist/             Renderer build output (gitignored)
release/          Packaged distributable output (gitignored)
```

## Quickstart

```bash
npm run tauri:dev       # Tauri dev app
npm test                # Vitest + perf + Cargo tests
npm run lint            # eslint
npm run typecheck       # renderer/shared tsc
npm run tauri:build     # production Tauri bundle
```

## Critical Conventions

- **Imports inside `src/`** end in `.js`: `import { foo } from "./foo.js"` even though the file is `foo.ts`.
- **All IPC** flows through `window.argmax.*`. Request/response channels are Rust `#[tauri::command]` handlers in [src-tauri/src/ipc](src-tauri/src/ipc), collected by `tauri-specta`, and exposed in [src/renderer/lib/tauriBridge.ts](src/renderer/lib/tauriBridge.ts). `src-tauri/tests/fixtures/channels.txt` and `npm run check:tauri-bridge` enforce channel parity.
- **No native Node rebuild dance.** SQLite and PTYs live in Rust (`rusqlite`, `portable-pty`). Do not reintroduce `better-sqlite3`, `node-pty`, or native builder scripts.
- **Renderer tests** query by **role / aria-label / title**, never by `className`.
- **Three themes: Light / Dark / System.** Tokens live in [src/renderer/styles/tokens.css](src/renderer/styles/tokens.css); see [docs/styling.md](docs/styling.md).
- **Shared values, not duplicates.** Model labels, ids, reasoning levels, and pricing live in [src/shared/providerModels.ts](src/shared/providerModels.ts).
- **Provider protocol output is not chat.** Visible chat comes from normalized timeline events; raw transcript fallback is only for human-readable stdout/stderr.
- **Dashboard state is SQLite-first and delta-driven.** Focused reads plus `dashboard:delta`; no recurring renderer poll.
- **Thinking state yields to content.** Hide the pre-answer Thinking bubble as soon as any visible assistant event arrives.
- **Auto-approve is the default permission mode.** Keep provider bypass flags centralized in [src-tauri/src/providers/adapters.rs](src-tauri/src/providers/adapters.rs).
- **The mascot and the app icon are one sprite.** [assets/fox-mascot.txt](assets/fox-mascot.txt) is the source; [Mascot.tsx](src/renderer/components/Mascot.tsx) and [scripts/build-icons.mjs](scripts/build-icons.mjs) both read it, so an edit moves both. Icon artifacts are generated — run `npm run build:icons` and never hand-edit `assets/icon*`, `assets/Argmax.icon`, or `src-tauri/icons`. See [docs/release.md](docs/release.md).
- **SQLite migrations are append-only and checksummed.** Never edit an applied migration; see [docs/data.md](docs/data.md).
- **Never commit secrets, `.env`, or AI-attribution lines.**

## Read The Docs First

Before editing a subsystem, read the matching `docs/*.md`:

- **Start here / Architecture** → [architecture.md](docs/architecture.md)
- **Runtime / lifecycle / bridge** → [runtime.md](docs/runtime.md)
- **IPC / `window.argmax`** → [ipc.md](docs/ipc.md)
- **Database / migrations** → [data.md](docs/data.md)
- **Providers** → [providers.md](docs/providers.md)
- **Agent tools (the `argmax` MCP server)** → [agent-tools.md](docs/agent-tools.md)
- **Session sync (import from provider CLIs)** → [session-sync.md](docs/session-sync.md)
- **Worktrees, archive, review** → [workspaces.md](docs/workspaces.md)
- **Multitask (a chat dispatched from inside a chat)** → [multitask.md](docs/multitask.md)
- **Approvals and checks** → [approvals-checks.md](docs/approvals-checks.md)
- **Scheduled tasks / routines** → [scheduled-tasks.md](docs/scheduled-tasks.md)
- **Integrated terminal panel** → [terminal.md](docs/terminal.md)
- **In-app browser panel** → [browser.md](docs/browser.md)
- **Mobile remote / WS bridge** → [remote.md](docs/remote.md)
- **GitHub PR / CI feedback loop** → [gh.md](docs/gh.md)
- **Learnings extraction / project memory** → [memory.md](docs/memory.md)
- **Skills / slash autocomplete** → [skills.md](docs/skills.md)
- **Chat surface** → [chat-cards.md](docs/chat-cards.md)
- **Debug panel / diagnostics** → [debugging.md](docs/debugging.md)
- **Styling** → [styling.md](docs/styling.md)
- **Tests** → [testing.md](docs/testing.md)
- **Verifying a change end to end** → [verification.md](docs/verification.md)
- **Perf budgets** → [performance.md](docs/performance.md)
- **Release** → [release.md](docs/release.md)

If a doc disagrees with code, fix the doc in the same change.

## Index

Start in [architecture.md](docs/architecture.md), then follow the subsystem docs above.

[CONTEXT.md](CONTEXT.md) is the domain glossary: the canonical word for each concept and the ones not to use. Read it before naming anything. Decisions that would otherwise look arbitrary are recorded in [docs/adr](docs/adr).
