# AGENTS.md — Maestro

Maestro is a local Electron desktop app that orchestrates AI coding agents (Claude Code, Codex) in parallel git worktrees. Single-user, on-device, no cloud, no auth.

User-level guidance (tone, principles, git etiquette) lives in `~/.claude/CLAUDE.md` and `~/dotfiles/agents/AGENTS.md` and is *not* duplicated here. This file is for project-specific facts.

## Layout

```
src/
├── main/         Electron main — services, IPC handlers, lifecycle
├── renderer/     React UI (Vite-built; talks to main via window.maestro)
└── shared/       Types + Zod schemas crossing the main↔renderer boundary

scripts/          Native-module rebuild helpers
openspec/         OpenSpec change & spec artifacts
agents/docs/      Deeper agent docs — see Index
dist/             Build output (gitignored)
```

## Quickstart

```bash
npm run dev          # rebuild:electron + vite + tsc-watch + electron
npm test             # rebuild:node + vitest
npm run lint         # eslint
npm run typecheck    # tsc for both renderer and main configs
npm run build        # production build
```

Two TS configs: [tsconfig.json](tsconfig.json) for renderer/shared, [tsconfig.main.json](tsconfig.main.json) for main.

## Critical conventions

- **Imports inside `src/`** end in `.js` (NodeNext): `import { foo } from "./foo.js"` even though the file is `foo.ts`. ESLint enforces this.
- **All IPC** flows through `window.maestro.*`. Schemas in [src/shared/ipcSchemas.ts](src/shared/ipcSchemas.ts) validate every payload via `withValidation()` in [src/main/ipc.ts](src/main/ipc.ts). The `REGISTERED_IPC_CHANNELS` constant is enforced by a regression test — keep it in sync when adding channels.
- **Native modules** (`better-sqlite3`, `node-pty`) compile per-runtime. `npm run dev` runs `rebuild:electron`; `npm test` runs `rebuild:node`. A `NODE_MODULE_VERSION` mismatch means you skipped one of those — re-run, don't reinstall.
- **Renderer tests** query by **role / aria-label / title**, never by `className`. Visual changes must not break tests; `aria-pressed`, `aria-label`, and `title` are part of the contract.
- **Light theme + Lilex font are non-negotiable.** No dark mode, no font swaps. See [agents/docs/styling.md](agents/docs/styling.md).
- **Shared values, not duplicates.** Model labels/ids live in [src/shared/providerModels.ts](src/shared/providerModels.ts) — `PROVIDER_MODEL_DEFAULTS` is the single source of truth.
- **Never commit secrets, `.env`, or AI-attribution lines.** Match recent commit style: `type(scope): lowercase imperative` (run `git log --oneline -10`).

## Index

- [agents/docs/architecture.md](agents/docs/architecture.md) — main/renderer/shared boundaries, IPC contract, services, persistence
- [agents/docs/providers.md](agents/docs/providers.md) — Claude/Codex session launch end-to-end, adding a provider
- [agents/docs/electron.md](agents/docs/electron.md) — native-module rebuild dance, lifecycle, preload bridge
- [agents/docs/testing.md](agents/docs/testing.md) — vitest layout, jsdom setup, native-binding traps
- [agents/docs/styling.md](agents/docs/styling.md) — design tokens, motion, the Lilex/light constraint
- [agents/docs/openspec.md](agents/docs/openspec.md) — change → propose → apply → archive workflow
