# AGENTS.md — Argmax

Argmax is a local Tauri desktop app that orchestrates AI coding agents (Claude Code, Codex, Cursor) in parallel git worktrees. Single-user, on-device, no cloud, no auth.

User-level guidance (tone, principles, git etiquette) lives in `~/.claude/CLAUDE.md` and `~/dotfiles/agents/AGENTS.md` and is *not* duplicated here. This file is for project-specific facts.

## Layout

```
src/
├── renderer/     React UI (Vite-built; talks to Rust via window.argmax)
├── shared/       Shared TS types + generated Tauri bindings
└── test/         Vitest setup

src-tauri/        Rust runtime, services, IPC handlers, persistence, packaging
scripts/          Lightweight CI/check scripts
openspec/         OpenSpec change & spec artifacts (see agents/docs/openspec.md)
agents/docs/      Deeper agent docs — see Index
assets/           App icon (icns + png) bundled into release builds
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
- **No native Node rebuild dance.** SQLite and PTYs live in Rust (`rusqlite`, `portable-pty`). Do not reintroduce `better-sqlite3`, `node-pty`, legacy preload code or builder scripts.
- **Renderer tests** query by **role / aria-label / title**, never by `className`.
- **Four themes: Light / Dark / System / Purple.** Tokens live in [src/renderer/styles.css](src/renderer/styles.css); see [agents/docs/styling.md](agents/docs/styling.md).
- **Shared values, not duplicates.** Model labels/ids/reasoning/launch mode and pricing live in [src/shared/providerModels.ts](src/shared/providerModels.ts).
- **Provider protocol output is not chat.** Visible chat comes from normalized timeline events; raw transcript fallback is only for human-readable stdout/stderr.
- **Dashboard state is SQLite-first and delta-driven.** Focused reads plus `dashboard:delta`; no recurring renderer poll.
- **Thinking state yields to content.** Hide the pre-answer Thinking bubble as soon as any visible assistant event arrives.
- **Auto-approve is the default permission mode.** Keep provider bypass flags centralized in [src-tauri/src/providers/adapters.rs](src-tauri/src/providers/adapters.rs).
- **SQLite migrations are append-only and checksummed.** Never edit an applied migration; see [agents/docs/data.md](agents/docs/data.md).
- **Never commit secrets, `.env`, or AI-attribution lines.**

## Read The Docs First

Before editing a subsystem, read the matching `agents/docs/*.md`:

- **Runtime / lifecycle / bridge** → [runtime.md](agents/docs/runtime.md)
- **IPC / preload / `window.argmax`** → [ipc.md](agents/docs/ipc.md)
- **Database / migrations** → [data.md](agents/docs/data.md)
- **Providers** → [providers.md](agents/docs/providers.md)
- **Worktrees, archive, review, checkpoints** → [workspaces.md](agents/docs/workspaces.md)
- **Approvals and checks** → [approvals-checks.md](agents/docs/approvals-checks.md)
- **Integrated terminal panel** → [terminal.md](agents/docs/terminal.md)
- **GitHub PR / CI feedback loop** → [gh.md](agents/docs/gh.md)
- **Learnings extraction / project memory** → [memory.md](agents/docs/memory.md)
- **Chat surface** → [chat-cards.md](agents/docs/chat-cards.md)
- **Styling** → [styling.md](agents/docs/styling.md)
- **Tests** → [testing.md](agents/docs/testing.md)
- **Perf budgets** → [performance.md](agents/docs/performance.md)
- **Release** → [release.md](agents/docs/release.md)
- **OpenSpec** → [openspec.md](agents/docs/openspec.md)

If a doc disagrees with code, fix the doc in the same change.

## Index

Start in [architecture.md](agents/docs/architecture.md), then follow the subsystem docs above.
