# AGENTS.md: Argmax

Argmax is a local Tauri desktop app that runs AI coding agents (Claude Code, Codex, Cursor, OpenCode, Grok Build) in parallel git worktrees. App state is local. Provider CLIs use their own services and authentication. Optional remote access uses Tailscale.

## Layout

```
src/renderer/     React UI (Vite; talks to Rust through window.argmax)
src/shared/       Shared TS types and generated Tauri bindings
src-tauri/        Cargo workspace: src/ services and IPC, crates/ contracts, process, store
ios/Argmax/       SwiftUI phone app (Sources/, Tests/, Resources/)
fixtures/parity/  Case tables that the desktop and the phone both run
scripts/          Check, export, and verification scripts
assets/           Icon sources and the mascot sprite
```

## Quickstart

```bash
npm run tauri:dev:isolated  # dev app on its own profile (~/.argmax-dev), next to the installed app
npm run check               # the fast lane: oxlint with type check, oxfmt, and static gates in parallel; CI's first job runs it
npm run fix                 # apply the oxlint and oxfmt auto-fixes
npm run check:changed       # the agent hooks' loop: type, lint, related tests, and import rules for changed files
npm run push-gate         # the pre-push gate: every CI lane, scoped to what the branch changed
npm test                    # Vitest, perf, and Cargo tests
npm run slow                # the perf budgets and Cargo tests, without Vitest
npm run verify -- all       # the renderer drives (verify-argmax); `verify:native` is the extra native-app lane
npm run test:ios            # XCTest on a simulator
npm run install:ios         # build and install the phone app on the connected iPhone
```

Release build, which Adam runs or a chat the installed app does not host:

```bash
npm run tauri:build && osascript -e 'quit app "Argmax"' && rm -rf /Applications/Argmax.app \
  && ditto src-tauri/target/release/bundle/macos/Argmax.app /Applications/Argmax.app && open /Applications/Argmax.app
```

## Judgment Calls

- **Argmax is developed from inside Argmax.** The installed app hosts the chats that do the work. Test a build as a second instance with `npm run tauri:dev:isolated`; plain `tauri dev` hits the instance lock and exits. Never quit, kill, or replace the installed app from a chat it hosts. A Rust edit restarts the dev instance and kills its sessions, so only throwaway chats belong there. See [docs/verification.md](docs/verification.md#the-dev-instance-next-to-the-installed-app).
- **A visual-design ask gets 3 mockups before code.** Build only the one the user picks.
- **Every visual change ships light and dark screenshots.** `npm run verify -- launcher` writes `launcher-light.png` and `launcher-dark.png` under `.verify/runs/`. Put both in the report.
- **Model facts have one home.** Add or retire a model with the recipe in [docs/providers.md](docs/providers.md#adding-or-retiring-a-model).
- **The mascot is the app icon.** [assets/fox-mascot.txt](assets/fox-mascot.txt) feeds both `Mascot.tsx` and `npm run build:icons`. The expression files are overlays on it.
- **SQLite and PTYs live in Rust.** Do not bring back `better-sqlite3`, `node-pty`, or native rebuild scripts. See [docs/adr](docs/adr).

## Enforced Rules


| Rule | Enforced by | Added |
|---|---|---|
| Do not hand-edit generated files | `scripts/agent-hooks/pre-tool-use.mjs`, list in `scripts/generated-files.json` | 2026-11-04 |
| Do not use blanket staging, stash, or restore in a shared checkout | `scripts/agent-hooks/pre-tool-use.mjs` | 2026-11-04 |
| No AI attribution in commit messages | `.githooks/commit-msg`, test `gitHooks.test.ts` | 2026-11-04 |
| Renderer tests query by role, label, or title | `scripts/oxlint-plugin.mjs::no-node-access`, `no-container`, with a ratchet in `lint-baseline.json` | 2026-11-04 |
| Decode timeline semantics with `decodeTimelineEvent()` | `scripts/oxlint-plugin.mjs::no-timeline-payload-access`, with a ratchet in `lint-baseline.json` | 2026-11-04 |
| The store, process, and contracts crates cannot import upward | Crate graph in `src-tauri/Cargo.toml::members`, compile errors E0432 and E0433; `scripts/check-rust-boundaries.mjs` | 2026-11-04 |
| SQL lives in `argmax-store` | `check:rust-boundaries` rule `sql-outside-store`, with a ratchet | 2026-11-04 |
| Run git through `argmax_process::git_exec` | `check:rust-boundaries` rule `git-outside-exec` | 2026-11-04 |
| Only `ipc/` and `remote/` import `crate::ipc` | `check:rust-boundaries` rule `lower-layer-imports-ipc` | 2026-11-04 |
| Only a person IPC handler mints a `PersonAttestation` | `check:rust-boundaries` rule `person-attestation-outside-ipc`, and a test in `ipc/mod.rs` | 2026-11-04 |
| A route lands only on a provider the availability probe reported | Rust type `AvailableProvider`, built only in `providers/discovery.rs` | 2026-11-04 |
| A turn ends only through `commit_turn_end` | `check:rust-boundaries` rule `turn-end-outside-owner` | 2026-11-04 |
| Renderer imports point down: shared, lib and state, hooks, components | `dependency-cruiser` in `check:static`, with a ratchet | 2026-11-04 |
| No secrets in staged files | `gitleaks` in `.githooks/pre-commit` | 2026-11-04 |
| Components read with `useBridgeQuery` and write through `data/bridgeActions.ts`, never `window.argmax` | `.oxlintrc.json::no-restricted-properties` | 2026-11-04 |
| An action on a project folder carries a required `ProjectTarget` | TypeScript, `tsconfig.json::strict` | 2026-11-04 |
| Do not hand-edit the appearance script in `index.html` or `mobile.html` | `check:static`, `scripts/build-appearance-bootstrap.mjs --check` | 2026-11-04 |
| Exports and dependencies stay in use | `knip` in `check:static` | 2026-11-04 |
| Model facts live in `src/shared/providerModels.ts`; Rust and the phone read generated copies | `check:provider-models`, list in `scripts/generated-files.json` | 2026-11-04 |
| Production code does not name a retired model id | `check:provider-models` | 2026-11-04 |
| Every catalogue model has a price and a routing answer | `cargo test catalogue` (`pricing.rs`, `routing/table.rs`) | 2026-11-04 |
| A stored model id reaches a launch or a route only as a resolved id | `model_catalogue.rs::ModelId`, `providerModels.ts::ResolvedModelId`, `scripts/oxlint-plugin.mjs::no-raw-model-id` | 2026-11-04 |
| A dispatch on a provider names every provider | Exhaustive `ProviderId` match, parsed with `ProviderId::parse` | 2026-11-04 |
| Chat-detail levels, inline-math pairing, and the workspace's chat agree on desktop and phone | One table in `fixtures/parity/`, run by `parityTables.test.ts` and `ParityTableTests.swift` | 2026-11-04 |
| The phone's chat-list and transcript responses come from the Rust bindings | `export-swift-contracts.mjs --check` in `check:static` | 2026-11-04 |
| A change the phone's suite can see runs that suite | `npm run test:ios` in the pre-push gate and in the CI `ios` job | 2026-11-04 |
| Transcript scroll decisions live in `TranscriptScrollModel`, not the view | Recorded sequences in `TranscriptScrollModelTests` | 2026-11-04 |
| Relative imports end in `.js`, even for a `.ts` file | `.oxlintrc.json::no-restricted-imports` | 2026-11-06 |
| IPC channels match between Rust and the bridge | `scripts/check-tauri-bridge.mjs` in `check:static`, list in `src-tauri/tests/fixtures/channels.txt` | 2026-11-06 |
| iPhone type goes through the roles in `Typography.swift` | `check:ios-fonts` | 2026-11-06 |
| Never edit an applied migration | `verify_applied_checksum` in `migrations.rs`, test `checksum_drift_is_reported_for_applied_migration` | 2026-11-06 |
| A mascot expression changes only its face | Overlay files composed by `withExpression` in `Mascot.tsx` | 2026-11-06 |
| Every enforcer this table cites exists | `check:docs` | 2026-11-06 |
| `npm run verify` passes only with a control that observes FAIL | `.agents/skills/verify-argmax/verify::CONTROL`, run by `npm run verify` in CI | 2026-11-06 |

## Agent Feedback

Hooks in `scripts/agent-hooks/` run after each edit (file checks, the doc to read, the generator to run), at the end of a turn (`check:changed` on this session's files), and at push (`push-gate`). Agents in other clients run `npm run check:changed` before they finish. Add path guidance in `scripts/agent-hooks/feedback-rules.json`. Ratchets are described in [docs/testing.md](docs/testing.md#ratchets).

## Read The Docs First

Prove changes with `npm run verify` (`verify-argmax` skill at `.agents/skills/verify-argmax/SKILL.md`). Read [GLOSSARY.md](GLOSSARY.md) before you name anything. If a doc disagrees with code, fix the doc in the same change.

Before you edit a subsystem, read its doc. Start at [architecture.md](docs/architecture.md).

- Runtime and IPC: [runtime](docs/runtime.md), [ipc](docs/ipc.md), [data](docs/data.md), [debugging](docs/debugging.md), [performance](docs/performance.md)
- Providers and routing: [providers](docs/providers.md), [routing](docs/routing.md), [approvals-checks](docs/approvals-checks.md), [session-sync](docs/session-sync.md), [usage](docs/usage.md)
- Agent features: [agent-tools](docs/agent-tools.md), [multitask](docs/multitask.md), [arcs](docs/arcs.md), [goals](docs/goals.md), [scheduled-tasks](docs/scheduled-tasks.md), [memory](docs/memory.md), [skills](docs/skills.md)
- Workspace and panels: [workspaces](docs/workspaces.md), [gh](docs/gh.md), [terminal](docs/terminal.md), [browser](docs/browser.md), [window-snapshot](docs/window-snapshot.md), [activity](docs/activity.md)
- UI: [chat-cards](docs/chat-cards.md), [styling](docs/styling.md)
- Phone: [remote](docs/remote.md), [ios-performance](docs/ios-performance.md)
- Testing and shipping: [testing](docs/testing.md), [verification](docs/verification.md), [release](docs/release.md), [homebrew](docs/homebrew.md)
- Snapshots, not kept current: [plans](docs/plan/README.md), [design explorations](docs/design/README.md), [decisions](docs/adr)
