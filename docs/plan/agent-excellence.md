# Plan: agent excellence (2026-11-04)

Objective: an agent that sees only the files it opened, copies the nearest
example, and takes the shortest path that compiles still produces a correct
change. A miss fails with a message that names the fix.

## Decisions

| Question | Decision | Reason |
|---|---|---|
| Scope | All phases. | Partial layering leaves a wrong example to copy. |
| Rust boundaries | Real Cargo crates after the inversions are removed. | The compiler rejects a wrong import. A script only reports it. |
| iOS tests | Run in `precheck` when `ios/` changes, and in CI. | 519 tests that nothing runs give no protection. |
| Transcript logic | Shared JSON case tables now. Move a rule to Rust when its table is stable. | Tables prove parity today and make each move safe. |
| Freeze | Implement on a local branch. Do not push until the freeze ends. | Requested by Adam. |

## Rules for the work

- Each new check must fail on a real past mistake. Record the replay in the commit.
- A class needs at least two instances.
- A common bad pattern uses a ratchet: existing sites are recorded and new ones fail.
- Remove a check or rule row when architecture removes its mistake.
- Do not split a file only because it is long. Split it where an owner is missing.

## Excluded

These have no repeated mistake behind them: pedantic clippy, `unwrap_used`,
SwiftLint, stylelint, `noUncheckedIndexedAccess`, the React Compiler rules, and
an exhaustive `isConversationVisible`.

## Phases

| Phase | Outcome | Proof |
|---|---|---|
| 0. Feedback | One check manifest for precheck and CI. A ratchet. Lint for test queries, timeline decoding, and bridge calls. Agent hooks for generated files and blanket staging. Rule table in `AGENTS.md`. | Replay #217 and #221. |
| 1. Catalogue | One data file generates the Rust, TS, and iOS model catalogues and the successor map. A `ModelId` type. `ProviderId` replaces string match arms. | Replay #223 and #225. |
| 2. Rust boundaries | `contracts` and `store` crates. SQL in `store` only. Git through `git/exec.rs`. Typed secret reads. `AvailableProvider` for routing. | Replay #235 and #222. |
| 3. Turn owner | One transition function ends a turn. `update_session_state` is private to it. | Replay `06ec46a1`, `904987c1`, #229. |
| 4. Renderer data | One query layer with a generation guard. Components do not call the bridge. A required `ProjectTarget`. One appearance bootstrap. | Replay `c92af94e`, `c05f38d1`, #238. |
| 5. Desktop and iOS | Generated response types. Shared case tables. iOS tests in the gate. Pure scroll models. | Tables fail on the known verbosity divergences. |
| 6. Prose | Generate or delete facts that code owns. Remove rules that checks now enforce. | `check:docs` passes. The model recipe is one step. |

## Metric

Files an agent must edit by hand for each change recipe (model, provider,
channel, event type, setting), measured before and after each phase.
