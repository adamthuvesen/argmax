# AGENTS.md: Argmax

Argmax is a local Tauri desktop app that orchestrates AI coding agents (Claude Code, Codex, Cursor, OpenCode, Grok Build) in parallel git worktrees. App state is local. Provider CLIs use their own services and authentication. Optional remote access uses Tailscale.

User-level guidance (tone, principles, git etiquette) lives in `~/.claude/CLAUDE.md` and `~/dotfiles/agents/AGENTS.md` and is *not* duplicated here. This file is for project-specific facts.

## Layout

```
src/
├── renderer/     React UI (Vite-built; talks to Rust via window.argmax)
├── shared/       Shared TS types + generated Tauri bindings
└── test/         Vitest setup

src-tauri/        Cargo workspace. src/: services, IPC, packaging. crates/: contracts, process, store (see docs/architecture.md#layers)
ios/Argmax/       SwiftUI phone app: Sources/, Tests/ (XCTest, `npm run test:ios`), Resources/ (providerModels.json is generated); see docs/ios-performance.md
fixtures/parity/  Case tables both the desktop and the phone run, for rules that exist in both
scripts/          Lightweight CI/check scripts
docs/             Deeper subsystem docs; see Index
assets/           App icon sources the icon generator reads, and the mascot sprite
dist/             Renderer build output (gitignored)
release/          Packaged distributable output (gitignored)
```

## Quickstart

```bash
npm run tauri:dev       # Tauri dev app (refuses to start while the installed app runs; see below)
npm run tauri:dev:isolated  # dev app on its own profile (~/.argmax-dev), side by side with the installed app
npm test                # Vitest + perf + Cargo tests
npm run test:ios        # XCTest suite on a simulator
npm run lint            # eslint
npm run typecheck       # renderer/shared tsc
npm run precheck        # pre-push gate: CI's checks, scoped to what the branch changed
npm run tauri:build     # production Tauri bundle
```

Rebuild and install:

```bash
npm run tauri:dev:isolated  # dev rebuild: starts the dev instance (watch build), never the installed app
npm run install:ios         # build ios/Argmax and install it on the connected iPhone
# Release build: no script installs it. Adam runs this, or a chat the installed app does not host:
npm run tauri:build && osascript -e 'quit app "Argmax"' && rm -rf /Applications/Argmax.app \
  && ditto src-tauri/target/release/bundle/macos/Argmax.app /Applications/Argmax.app && open /Applications/Argmax.app
```

## Critical Conventions

- **Argmax is developed from inside Argmax.** The installed app (`/Applications/Argmax.app`) hosts the chats that do the work; the build under test is a second instance on its own profile: `npm run tauri:dev:isolated` (`ARGMAX_DATA_DIR=~/.argmax-dev`). Plain `tauri dev` shares the installed app's data dir, hits the instance lock, and exits. Never quit, kill, or replace the installed app from a chat it hosts. Rust edits restart the dev instance and kill every session it hosts, so only throwaway verification chats belong there. Details in [docs/verification.md](docs/verification.md#the-dev-instance-next-to-the-installed-app).
- **Imports inside `src/`** end in `.js`: `import { foo } from "./foo.js"` even though the file is `foo.ts`.
- **All IPC** flows through `window.argmax.*`. Request/response channels are Rust `#[tauri::command]` handlers in [src-tauri/src/ipc](src-tauri/src/ipc), collected by `tauri-specta`, and exposed in [src/renderer/lib/tauriBridge.ts](src/renderer/lib/tauriBridge.ts). `src-tauri/tests/fixtures/channels.txt` and `npm run check:tauri-bridge` enforce channel parity.
- **No native Node rebuild dance.** SQLite and PTYs live in Rust (`rusqlite`, `portable-pty`). Do not reintroduce `better-sqlite3`, `node-pty`, or native builder scripts.
- **iPhone type goes through the roles in [Typography.swift](ios/Argmax/Sources/Design/Typography.swift).** A `.font(...)` at a call site is a surface Settings → Typeface cannot reach; `npm run check:ios-fonts` enforces it, and `npm run build:ios-fonts` regenerates the bundled Geist faces.
- **Three themes: Light / Dark / System.** Tokens live in [src/renderer/styles/tokens.css](src/renderer/styles/tokens.css); see [docs/styling.md](docs/styling.md).
- **A visual-design ask gets 3 mockups before code.** Build only the one the user picks.
- **Every visual change ships light and dark screenshots.** `node .agents/skills/verify-argmax/verify.mjs ui` writes `ui-light.png` and `ui-dark.png` under `.verify/runs/`; put both in the report.
- **Shared values, not duplicates.** Model labels, ids, reasoning levels, and pricing live in [src/shared/providerModels.ts](src/shared/providerModels.ts), and Rust and the iPhone read generated copies. Use the recipe in [docs/providers.md](docs/providers.md#adding-or-retiring-a-model) to add or retire one.
- **Provider protocol output is not chat.** Visible chat comes from normalized timeline events; raw transcript fallback is only for human-readable stdout/stderr.
- **An image reaches the user only through Markdown.** `![what it shows](path)` on its own line, pointing inside the checkout or at a path Argmax handed you (a `browser_screenshot`'s `path`). An image a tool returned lands in the model's context, not the chat, and a remote `http(s)` image is drawn as a link rather than fetched. See [docs/chat-cards.md](docs/chat-cards.md).
- **A diagram reaches the user as a mermaid fence.** A fenced `mermaid` / `mmd` block in the answer is drawn as SVG, wider than the prose column. Prefer mermaid for architecture, sequence, and flow; prefer a Markdown image for a screenshot or chart already on disk. Skip hex `classDef` / `style` colors — Argmax themes the diagram. See [docs/chat-cards.md](docs/chat-cards.md).
- **Dashboard state is SQLite-first and delta-driven.** Focused reads and `dashboard:delta` carry updates. See [runtime](docs/runtime.md#event-delivery) for the running-session fallback.
- **Thinking state yields to content.** Hide the pre-answer Thinking bubble as soon as any visible assistant event arrives.
- **Provider defaults apply to new installations.** Keep permission handling consistent with [approvals and checks](docs/approvals-checks.md).
- **The mascot and the app icon are one sprite.** [assets/fox-mascot.txt](assets/fox-mascot.txt) is the source; [Mascot.tsx](src/renderer/components/Mascot.tsx) and [scripts/build-icons.mjs](scripts/build-icons.mjs) both read it, so an edit moves both. Icon artifacts are generated — run `npm run build:icons` and never hand-edit `assets/icon*`, `assets/Argmax.icon`, `src-tauri/icons`, or `ios/Argmax/Sources/Assets.xcassets`. See [docs/release.md](docs/release.md). The expression sprites ([fox-mascot-wink.txt](assets/fox-mascot-wink.txt), `-sleepy`, `-shades`) share that grid and palette and are read only by `Mascot.tsx`, so a body edit to the base sprite has to be mirrored into all three.
- **SQLite migrations are append-only and checksummed.** Never edit an applied migration; see [docs/data.md](docs/data.md).
- **Never commit secrets, `.env`, or AI-attribution lines.**

## Enforced Rules

| Rule | Enforced by | Added |
|---|---|---|
| Do not hand-edit generated files | `scripts/agent-hooks/pre-tool-use.mjs`, list in `scripts/generated-files.json` | 2026-11-04 |
| Do not use blanket staging, stash, or restore in a shared checkout | `scripts/agent-hooks/pre-tool-use.mjs` | 2026-11-04 |
| No AI attribution in commit messages | `.githooks/commit-msg` | 2026-11-04 |
| Renderer tests query by role, label, or title | ESLint `testing-library/no-node-access`, `no-container`, with a ratchet | 2026-11-04 |
| Decode timeline semantics with `decodeTimelineEvent()` | ESLint `no-restricted-syntax`, with a ratchet | 2026-11-04 |
| The store, process, and contracts crates cannot import upward | Cargo crate graph, compile errors E0432 and E0433 | 2026-11-04 |
| SQL lives in `argmax-store` | `check:rust-boundaries` rule `sql-outside-store`, with a ratchet | 2026-11-04 |
| Run git through `argmax_process::git_exec` | `check:rust-boundaries` rule `git-outside-exec` | 2026-11-04 |
| Only `ipc/` and `remote/` import `crate::ipc` | `check:rust-boundaries` rule `lower-layer-imports-ipc` | 2026-11-04 |
| Only a person IPC handler mints a `PersonAttestation` | `check:rust-boundaries` rule `person-attestation-outside-ipc`, and a test in `ipc/mod.rs` | 2026-11-04 |
| A route lands only on a provider the availability probe reported | Rust type `AvailableProvider`, built only in `providers/discovery.rs` | 2026-11-04 |
| A turn ends only through `commit_turn_end` | `check:rust-boundaries` rule `turn-end-outside-owner` | 2026-11-04 |
| Renderer imports point down: shared, lib and state, hooks, components | `dependency-cruiser` in `check:static`, with a ratchet | 2026-11-04 |
| No secrets in staged files | `gitleaks` in `.githooks/pre-commit` | 2026-11-04 |
| Components read with `useBridgeQuery` and write through `data/bridgeActions.ts`, never `window.argmax` | ESLint `no-restricted-properties` | 2026-11-04 |
| An action on a project folder carries a required `ProjectTarget` | TypeScript | 2026-11-04 |
| Do not hand-edit the appearance script in `index.html` or `mobile.html` | `check:static`, `scripts/build-appearance-bootstrap.mjs --check` | 2026-11-04 |
| Exports and dependencies stay in use | `knip` in `check:static` | 2026-11-04 |
| Model facts live in `src/shared/providerModels.ts`; Rust and the phone read generated copies | `check:provider-models`, list in `scripts/generated-files.json` | 2026-11-04 |
| Production code does not name a retired model id | `check:provider-models` | 2026-11-04 |
| Every catalogue model has a price and a routing answer | `cargo test catalogue` (`pricing.rs`, `routing/table.rs`) | 2026-11-04 |
| A stored model id reaches a launch or a route only as a resolved id | Rust type `ModelId`, TS type `ResolvedModelId`, ESLint `no-restricted-syntax` | 2026-11-04 |
| A dispatch on a provider names every provider | Exhaustive `ProviderId` match, parsed with `ProviderId::parse` | 2026-11-04 |
| Chat-detail levels, inline-math pairing, and the workspace's chat agree on desktop and phone | One table in `fixtures/parity/`, run by `parityTables.test.ts` and `ParityTableTests.swift` | 2026-11-04 |
| The phone's chat-list and transcript responses come from the Rust bindings | `export-swift-contracts.mjs --check` in `check:static` | 2026-11-04 |
| A change the phone's suite can see runs that suite | `npm run test:ios` in precheck and in the CI `ios` job | 2026-11-04 |
| Transcript scroll decisions live in `TranscriptScrollModel`, not the view | Recorded sequences in `TranscriptScrollModelTests` | 2026-11-04 |

## Agent Feedback

Claude Code and Codex hooks in `scripts/agent-hooks/` give feedback at three speeds:

1. After each edit: an instant check of the file, the subsystem doc to read, and the generator to run.
2. At the end of a turn: type, lint, related tests, import rules, and `cargo check` on the files this session edited. A failure sends the agent back to fix it.
3. At push: `precheck` runs every lane.

Agents in other clients run `npm run check:changed` before they finish. To add guidance for a path, edit `scripts/agent-hooks/feedback-rules.json`.

Precheck and CI run the same static gates through `npm run check:static`. See [docs/testing.md](docs/testing.md#ratchets).

## Agent Delegation

- Keep bounded delegated work in the current chat. Use provider-native subagents for research, review, and implementation that the launcher will integrate into the current turn. A native subagent dies with the turn that spawned it: collect its result before answering, never report it as still running.
- Use `session_launch` when the user explicitly requests a separate session or the work needs its own independent, durable lifecycle that remains visible and steerable after this turn, such as a separate repository investigation or a long-running build. Do not launch a session merely for parallelism, fresh context, model choice, or context relief.
- The user-facing multitask flow is for work that should run alongside a chat. Keep delegation one hop unless the brief explicitly requires further decomposition. The launcher owns synthesis and verification.

## Read The Docs First

Prove user-facing changes with the `verify-argmax` skill at `.agents/skills/verify-argmax/SKILL.md`.

Before editing a subsystem, read the matching `docs/*.md`:

- **Start here / Architecture** → [architecture.md](docs/architecture.md)
- **Runtime / lifecycle / bridge** → [runtime.md](docs/runtime.md)
- **IPC / `window.argmax`** → [ipc.md](docs/ipc.md)
- **Database / migrations / live DB path** → [data.md](docs/data.md)
- **Providers** → [providers.md](docs/providers.md)
- **Auto routing (Router tiers, Jev classifier)** → [routing.md](docs/routing.md)
- **Agent tools (the `argmax` MCP server)** → [agent-tools.md](docs/agent-tools.md)
- **Session sync (import from provider CLIs)** → [session-sync.md](docs/session-sync.md)
- **Worktrees, archive, review** → [workspaces.md](docs/workspaces.md)
- **Multitask (a chat dispatched from inside a chat)** → [multitask.md](docs/multitask.md)
- **Arcs (long-lived bodies of work with a coordinator)** → [arcs.md](docs/arcs.md)
- **Goals (`/goal`, the after-each-turn evaluator)** → [goals.md](docs/goals.md)
- **Approvals and checks** → [approvals-checks.md](docs/approvals-checks.md)
- **Scheduled tasks / routines** → [scheduled-tasks.md](docs/scheduled-tasks.md)
- **Usage page (tokens and cost across providers)** → [usage.md](docs/usage.md)
- **Activity page (the user's own commits, streaks, PRs, reviews)** → [activity.md](docs/activity.md)
- **Integrated terminal panel** → [terminal.md](docs/terminal.md)
- **In-app browser panel** → [browser.md](docs/browser.md)
- **Mobile remote / WS bridge** → [remote.md](docs/remote.md)
- **Window snapshot (global chord, frontmost window → composer)** → [window-snapshot.md](docs/window-snapshot.md)
- **GitHub PR / CI feedback loop** → [gh.md](docs/gh.md)
- **Learnings extraction / project memory** → [memory.md](docs/memory.md)
- **Skills / slash autocomplete** → [skills.md](docs/skills.md)
- **Chat surface** → [chat-cards.md](docs/chat-cards.md)
- **Debug panel / diagnostics** → [debugging.md](docs/debugging.md)
- **Styling** → [styling.md](docs/styling.md)
- **Tests** → [testing.md](docs/testing.md)
- **Verifying a change end to end** → [verification.md](docs/verification.md)
- **Perf budgets** → [performance.md](docs/performance.md)
- **Plans (dated snapshots, not kept current)** → [docs/plan](docs/plan/README.md)
- **Design explorations (decision evidence, not specs)** → [docs/design](docs/design/README.md)
- **Release** → [release.md](docs/release.md)
- **Homebrew cask / tap** → [homebrew.md](docs/homebrew.md)

If a doc disagrees with code, fix the doc in the same change.

## Index

Start in [architecture.md](docs/architecture.md), then follow the subsystem docs above.

[GLOSSARY.md](GLOSSARY.md) is the domain glossary: the canonical word for each concept and the ones not to use. Read it before naming anything. Decisions that would otherwise look arbitrary are recorded in [docs/adr](docs/adr).
