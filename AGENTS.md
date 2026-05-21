# AGENTS.md — Argmax

Argmax is a local Electron desktop app that orchestrates AI coding agents (Claude Code, Codex, Cursor) in parallel git worktrees. Single-user, on-device, no cloud, no auth.

User-level guidance (tone, principles, git etiquette) lives in `~/.claude/CLAUDE.md` and `~/dotfiles/agents/AGENTS.md` and is *not* duplicated here. This file is for project-specific facts.

## Layout

```
src/
├── main/         Electron main — services, IPC handlers, lifecycle
├── renderer/     React UI (Vite-built; talks to main via window.argmax)
├── shared/       Types + Zod schemas crossing the main↔renderer boundary
└── test/         Vitest setup

scripts/          Native-module rebuild helpers
openspec/         OpenSpec change & spec artifacts (see agents/docs/openspec.md)
agents/docs/      Deeper agent docs — see Index
assets/           App icon (icns + png) bundled into release builds
build/            Hardened-runtime entitlements
dist/             Build output (gitignored)
release/          Packaged distributable output (gitignored)
```

## Quickstart

```bash
npm run dev          # rebuild:electron + vite + tsc-watch + electron
npm test             # rebuild:node + vitest
npm run lint         # eslint
npm run typecheck    # tsc for both renderer and main configs
npm run build        # production build
npm run package      # signed/notarized .dmg + .zip in release/
```

Two TS configs: [tsconfig.json](tsconfig.json) for renderer/shared, [tsconfig.main.json](tsconfig.main.json) for main.

## Critical conventions

- **Imports inside `src/`** end in `.js` (NodeNext): `import { foo } from "./foo.js"` even though the file is `foo.ts`. ESLint enforces this.
- **All IPC** flows through `window.argmax.*`. Request/response channels use schemas in [src/shared/ipcSchemas.ts](src/shared/ipcSchemas.ts) and `withValidation()` in [src/main/ipc.ts](src/main/ipc.ts). `IPC_CHANNELS` is derived from `Object.keys(ipcSchemas)` and is enforced by a regression test — adding a request/response channel is a five-step dance ([agents/docs/ipc.md](agents/docs/ipc.md#adding-a-requestresponse-channel)). Push-only event channels (`dashboard:delta`, `terminal:data`, `terminal:exit`, `mcp:auth:data`, `mcp:auth:exit`, `menu:command`) are typed in preload but do **not** belong in `IPC_CHANNELS`.
- **Native modules** (`better-sqlite3`, `node-pty`) compile per-runtime. `npm run dev` runs `rebuild:electron`; `npm test` runs `rebuild:node`. A `NODE_MODULE_VERSION` mismatch means you skipped one of those — re-run, don't reinstall.
- **Renderer tests** query by **role / aria-label / title**, never by `className`. Visual changes must not break tests; `aria-pressed`, `aria-label`, and `title` are part of the contract.
- **Three themes: Light / Dark / System.** Default is System (tracks macOS via `prefers-color-scheme`). Dark mode is warm charcoal — yellow-leaning grays, never midnight blue. Tokens live in `:root` (light) and `:root[data-theme="dark"]` in [src/renderer/styles.css](src/renderer/styles.css); persist via `argmax.theme.mode` localStorage key + `userData/theme.json` for Electron-side no-flash. Font family is user-pickable from Settings → Appearance (Lilex is the default; alternates load via `@fontsource`). See [agents/docs/styling.md](agents/docs/styling.md).
- **Shared values, not duplicates.** Model labels/ids/reasoning/launch mode and pricing live in [src/shared/providerModels.ts](src/shared/providerModels.ts) — `PROVIDER_MODEL_DEFAULTS` and `MODEL_PRICING` are the single source of truth. Current launch fallbacks: Claude Haiku 4.5 (structured JSON), Codex Spark medium (structured JSON), Cursor Composer 2 (structured JSON). Renderer ships a picker; defaults are only the fallback.
- **Provider protocol output is not chat.** Raw JSONL provider events (`type: "init"`, `thread.started`, `turn.started`, etc.) may be persisted for debugging, but the renderer must not show them as assistant bubbles. Visible chat comes from normalized timeline events; raw transcript fallback is only for human-readable stdout/stderr.
- **Dashboard state is SQLite-first and delta-driven.** `dashboard:load` stays public as a compatibility wrapper, but normal renderer refresh uses focused reads: `dashboard.list()` + `approvals.pending()` for initial state, `workspaces.status()` + `approvals.pending()` for visibility-change refresh, and `session.eventsSince()` rowid cursors for the selected session's event/raw-output tail. Steady-state freshness is the `dashboard:delta` push (coalesced at ~60 fps in main); there is no recurring renderer poll. Do not reread the whole dashboard just because one token streamed.
- **Thinking state yields to content.** The chat "Thinking" bubble is a pre-answer affordance only. Hide it as soon as any visible assistant event arrives, even if the session is still marked `running`.
- **Auto-approve is the default permission mode.** Provider sessions launch with broad permissions (`bypassPermissions` / `--dangerously-bypass-approvals-and-sandbox` / `--force --trust`) because Argmax is a trusted single-user desktop app. Keep these flags centralized in [src/main/providers/providerAdapters.ts](src/main/providers/providerAdapters.ts).
- **SQLite migrations are append-only and checksummed.** Never edit a previously-applied migration; the boot path refuses to run a tampered one. See [agents/docs/data.md](agents/docs/data.md#writing-a-new-column).
- **Never commit secrets, `.env`, or AI-attribution lines.** Match recent commit style: `type(scope): lowercase imperative` (run `git log --oneline -10`).

## Index

Start in **[architecture.md](agents/docs/architecture.md)** — it's the map. Follow the deeper docs as the task demands.

### Architecture & contracts
- [architecture.md](agents/docs/architecture.md) — main/renderer/shared boundaries, services, dashboard reads
- [ipc.md](agents/docs/ipc.md) — IPC channels, schemas, push events, adding a channel
- [data.md](agents/docs/data.md) — SQLite schema, migrations, retention, FTS5 sidecars
- [performance.md](agents/docs/performance.md) — startup, IPC, and renderer/database perf budgets

### Subsystems
- [providers.md](agents/docs/providers.md) — Claude / Codex / Cursor adapters, launch & resume, model registry
- [workspaces.md](agents/docs/workspaces.md) — git worktrees, review, checkpoints, file preview
- [approvals-checks.md](agents/docs/approvals-checks.md) — command-risk policy, approval flow, workspace checks
- [terminal.md](agents/docs/terminal.md) — integrated terminal panel (separate from provider PTYs)
- [gh.md](agents/docs/gh.md) — GitHub CI feedback loop (poller, follow-up sessions)
- [memory.md](agents/docs/memory.md) — project-scoped learnings, extraction, injection
- [tournaments.md](agents/docs/tournaments.md) — parallel agents in worktrees, deterministic judge, keep-winner flow
- [chat-cards.md](agents/docs/chat-cards.md) — PlanCard / QuestionCard rendering, tool-deny handling, thinking-gate, submit-terminate flow

### Build & test
- [electron.md](agents/docs/electron.md) — native-module rebuild dance, lifecycle, preload bridge, packaging
- [testing.md](agents/docs/testing.md) — vitest layout, jsdom setup, native-binding traps, regression tests
- [styling.md](agents/docs/styling.md) — design tokens, motion, the Lilex/light constraint
- [release.md](agents/docs/release.md) — signing, notarization, smoke procedure
- [openspec.md](agents/docs/openspec.md) — change → propose → apply → verify → archive workflow
