# AGENTS.md: Argmax

Argmax is a local Tauri desktop app that runs AI coding agents (Claude Code, Codex, Cursor, OpenCode, Grok Build) in parallel git worktrees. Provider CLIs use their own services and authentication. Optional remote access uses Tailscale.

## Layout

```
src/renderer/     React UI (Vite; talks to Rust through window.argmax)
src/shared/       Shared TS types and generated Tauri bindings
src-tauri/        Cargo workspace: src/ services and IPC, crates/ contracts, process, store
ios/Argmax/       SwiftUI phone app
fixtures/parity/  Parity tables for desktop and phone
scripts/          Check, export, and verification scripts
assets/           Icon sources and the mascot sprite
```

## Quickstart

```bash
npm run tauri:dev:isolated  # dev app on its own profile (~/.argmax-dev)
npm run check               # the fast lane (oxlint, oxfmt, static gates); CI's first job
npm run fix                 # apply oxlint and oxfmt fixes
npm run check:changed       # the agent hooks' loop: type, lint, related tests, import rules
npm run push-gate         # the pre-push gate: every CI lane, scoped to the branch
npm test                    # Vitest, perf, Cargo
npm run slow                # perf budgets and Cargo tests only
npm run bench:latency       # latency in the real app: --compare A/B, --check against the record
npm run verify -- all       # renderer drives; `verify:native` adds the native app
npm run test:ios            # XCTest on a simulator
npm run install:ios         # install the phone app on the iPhone
```

Release build (Adam, or a chat the installed app does not host):

```bash
npm run tauri:build && osascript -e 'quit app "Argmax"' && rm -rf /Applications/Argmax.app \
  && ditto src-tauri/target/release/bundle/macos/Argmax.app /Applications/Argmax.app && open /Applications/Argmax.app
```

## Judgment Calls

- **Argmax is developed from inside Argmax.** The installed app hosts the chats that do the work. Test a build as a second instance with `npm run tauri:dev:isolated`; plain `tauri dev` exits on the instance lock. Never quit, kill, or replace the installed app from a chat it hosts. A Rust edit restarts the dev instance and kills its sessions, so use throwaway chats there. See [docs/verification.md](docs/verification.md#the-dev-instance-next-to-the-installed-app).
- **A visual-design ask gets 3 mockups before code.** Build the one the user picks.
- **Every visual change ships light and dark screenshots.** `npm run verify -- launcher` writes `launcher-light.png` and `launcher-dark.png` in `.verify/runs/`. Report both.
- **Model facts have one home.** Add or retire a model with the recipe in [docs/providers.md](docs/providers.md#adding-or-retiring-a-model).
- **The mascot is the app icon.** [assets/fox-mascot.txt](assets/fox-mascot.txt) feeds both `Mascot.tsx` and `npm run build:icons`. The expression files are overlays on it.
- **SQLite and PTYs live in Rust.** Do not bring back `better-sqlite3`, `node-pty`, or native rebuild scripts. See [docs/adr](docs/adr).

## Agent Feedback

Hooks in `scripts/agent-hooks/` run after each edit, at the end of a turn (`check:changed`), and at push (`push-gate`). Other clients run `npm run check:changed` before they finish. Add path guidance in `scripts/agent-hooks/feedback-rules.json`. Ratchets: [docs/testing.md](docs/testing.md#ratchets).

## Read The Docs First

Prove changes with `npm run verify` (`verify-argmax` skill at `.agents/skills/verify-argmax/SKILL.md`). If a doc disagrees with code, fix the doc in the same change.

Domain terms are in `GLOSSARY.md` and decisions in `docs/adr/`. A change that adds, renames, or redefines a term, or reverses a decision, updates them in the same commit.

Before you edit a subsystem, read its doc. Start at [architecture.md](docs/architecture.md).

- Runtime and IPC: [runtime](docs/runtime.md), [ipc](docs/ipc.md), [data](docs/data.md), [debugging](docs/debugging.md), [performance and the latency bench](docs/performance.md)
- Providers and routing: [providers](docs/providers.md), [routing](docs/routing.md), [approvals-checks](docs/approvals-checks.md), [session-sync](docs/session-sync.md), [usage](docs/usage.md)
- Agent features: [agent-tools](docs/agent-tools.md), [multitask](docs/multitask.md), [arcs](docs/arcs.md), [goals](docs/goals.md), [scheduled-tasks](docs/scheduled-tasks.md), [memory](docs/memory.md), [skills](docs/skills.md)
- Workspace and panels: [workspaces](docs/workspaces.md), [gh](docs/gh.md), [terminal](docs/terminal.md), [browser](docs/browser.md), [window-snapshot](docs/window-snapshot.md), [activity](docs/activity.md)
- UI: [chat-cards](docs/chat-cards.md), [styling](docs/styling.md)
- Phone: [remote](docs/remote.md), [ios-performance](docs/ios-performance.md)
- Testing and shipping: [testing](docs/testing.md), [verification](docs/verification.md), [release](docs/release.md), [homebrew](docs/homebrew.md)
- Snapshots, not kept current: [plans](docs/plan/README.md), [design explorations](docs/design/README.md), [decisions](docs/adr)

## Enforced Rules

| Rule | Enforced by |
|---|---|
| Do not hand-edit generated files | `scripts/agent-hooks/pre-tool-use.mjs`, list in `scripts/generated-files.json` |
| Do not use blanket staging, stash, or restore in a shared checkout | `scripts/agent-hooks/pre-tool-use.mjs` |
| No AI attribution in commit messages | `.githooks/commit-msg`, `src/test/gitHooks.test.ts::refuses an AI attribution trailer` |
| Decode timeline semantics with `decodeTimelineEvent()` | `.oxlintrc.json::overrides.rules.argmax/no-timeline-payload-access` |
| The store, process, and contracts crates cannot import upward | Crate graph in `src-tauri/Cargo.toml::members`, compile errors E0432 and E0433; `scripts/check-rust-boundaries.mjs` |
| SQL lives in `argmax-store` | `scripts/rust-boundaries-baseline.json::sql-outside-store` |
| Run git through `argmax_process::git_exec` | `scripts/rust-boundaries-baseline.json::git-outside-exec` |
| Only `ipc/` and `remote/` import `crate::ipc` | `scripts/rust-boundaries-baseline.json::lower-layer-imports-ipc` |
| Only a person IPC handler mints a `PersonAttestation` | `scripts/rust-boundaries-baseline.json::person-attestation-outside-ipc`, `src-tauri/src/ipc/mod.rs::person_attestation_is_minted_only_by_the_person_handlers` |
| A route lands only on a provider the availability probe reported | `src-tauri/src/providers/discovery.rs::AvailableProvider` |
| A turn ends only through `commit_turn_end` | `scripts/rust-boundaries-baseline.json::turn-end-outside-owner` |
| Renderer imports point down: shared, lib and state, hooks, components | `.dependency-cruiser.cjs` |
| No secrets in staged files | `.githooks/pre-commit::gitleaks` |
| Components read with `useBridgeQuery` and write through `data/bridgeActions.ts`, never `window.argmax` | `.oxlintrc.json::overrides.rules.no-restricted-properties` |
| Do not hand-edit the appearance script in `index.html` | `scripts/build-appearance-bootstrap.mjs`, `scripts/static-checks.mjs::CHECKS` |
| Model facts live in `src/shared/providerModels.ts`; Rust and the phone read generated copies | `package.json::scripts.check:provider-models`, `scripts/generated-files.json` |
| Production code does not name a retired model id | `scripts/export-provider-models.mjs::RETIRED_ID_ROOTS` |
| Every catalogue model has a price and a routing answer | `src-tauri/src/providers/pricing.rs::every_catalogue_model_and_retired_id_has_a_price`, `src-tauri/src/routing/table.rs::every_catalogue_model_has_a_routing_answer` |
| Tests never wait on a real timer or read the real clock | `.oxlintrc.json::overrides.rules.no-restricted-globals`, `.oxlintrc.json::overrides.rules.argmax/no-real-time` |
| A stored model id reaches a launch or a route only as a resolved id | `src-tauri/src/providers/model_catalogue.rs::ModelId`, `src/shared/providerModels.ts::ResolvedModelId`, `.oxlintrc.json::overrides.rules.argmax/no-raw-model-id` |
| A dispatch on a provider names every provider | `src-tauri/crates/argmax-contracts/src/validation.rs::ProviderId` |
| Chat-detail levels, inline-math pairing, and the workspace's chat agree on desktop and phone | `src/renderer/lib/parityTables.test.ts`, `ios/Argmax/Tests/ParityTableTests.swift` |
| The phone's chat-list and transcript responses come from the Rust bindings | `scripts/export-swift-contracts.mjs`, `scripts/static-checks.mjs::CHECKS` |
| A change the phone's suite can see runs that suite | `scripts/precheck.mjs`, `.github/workflows/ci.yml::ios`, `package.json::scripts.test:ios` |
| Transcript scroll decisions live in `TranscriptScrollModel`, not the view | `ios/Argmax/Tests/TranscriptScrollModelTests.swift` |
| IPC channels match between Rust and the bridge | `scripts/check-tauri-bridge.mjs`, list in `src-tauri/tests/fixtures/channels.txt` |
| iPhone type goes through the roles in `Typography.swift` | `scripts/check-ios-fonts.mjs` |
| Never edit an applied migration | `src-tauri/crates/argmax-store/src/migrations.rs::verify_applied_checksum`, `src-tauri/crates/argmax-store/src/migrations.rs::a_released_migration_body_is_never_edited` |
| A mascot expression changes only its face | `src/renderer/components/Mascot.tsx::withExpression` |
| `npm run verify` passes only with a control that observes FAIL | `.agents/skills/verify-argmax/verify.mjs::CONTROL` |
| A new module cannot start a process or open a socket outside a named owner | `scripts/check-process-imports.mjs`, `scripts/check-rust-boundaries.mjs` |
| A payload that crosses to the renderer or the phone stays inside a byte and row budget (sizes only, never timing) | `src-tauri/src/remote/transcript_trim.rs::the_heaviest_first_page_stays_inside_the_trim_and_wire_budgets`, `src-tauri/crates/argmax-store/src/dashboard.rs::a_full_dashboard_snapshot_stays_inside_its_byte_and_row_budgets`, `src-tauri/src/event_delivery.rs::a_burst_of_large_deltas_leaves_in_pushes_inside_the_conflation_cap` |
