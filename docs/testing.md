# Testing

Argmax has two test suites: Vitest for the frontend and Cargo for the Rust backend.

The suites are the first rung of the verification ladder; driving the real app
(scratch instance, bridge, screenshots) is covered in [verification.md](verification.md).

## Commands

```bash
npm run precheck        # The pre-push gate: CI's checks, scoped to the branch's diff
npm run precheck -- --all  # Every lane regardless of what changed
npm test                # Run unit, perf, and Rust test suites
npm run test:unit       # Vitest unit and component tests
npm run test:perf       # Vitest performance benchmarks
npm run test:rust       # Cargo test suite for src-tauri (includes the bindings freshness test)
npm run lint:rust       # cargo clippy over every target, warnings are errors
npm run check:tauri-bridge # Check IPC channel inventory parity
npm run check:main-thread  # Every synchronous IPC handler is on the allowlist
npm run doctor          # Check the local verification environment
npm run verify          # Build and exercise a disposable app with scripted providers
```

`verify` is a local end-to-end loop described in [verification.md](verification.md).
It is intentionally separate from CI and `precheck`.

## The pre-push gate

`git push` runs [scripts/precheck.mjs](../scripts/precheck.mjs) through the
project-owned hook in [.githooks/pre-push](../.githooks/pre-push); `npm install`
points `core.hooksPath` there. The script diffs the branch against `main`
(committed and uncommitted changes alike) and runs only the lanes that diff
touches:

| Touched | Runs |
|---|---|
| anything | `check:tauri-bridge`, `check:main-thread` |
| `src/**`, package or tool config, `scripts/**` | eslint, tsc, `vitest run --changed <merge-base>`, perf budgets |
| `src-tauri/**` | `cargo fmt --check`, `cargo test`, `cargo clippy -D warnings` |
| any JS lane change | `vite build` + the bundle budget |

Workflow changes run both language lanes. Paths are read from Git without quoting,
so spaces and non-ASCII filenames cannot hide a change.

CI runs the same lanes with the same path filter, so a push that passes the
hook should not be failed by CI for a reason the hook could have caught.
Never bypass the hook with `--no-verify`; if a lane is wrong for the change,
fix the filter in `precheck.mjs`.

### CI execution

CI distributes the complete Vitest suite across eight shards. The first shard
also runs the performance budgets. ESLint reuses cached results only when all
TypeScript sources and configuration match. Its type-aware rules can report an
error in an unchanged file when an imported type changes, so a per-file content
cache alone is insufficient. Fresh checkout timestamps do not invalidate a
matching cache.

The macOS Rust lane builds the test targets once, then runs the library tests,
the `integration` binary, doctests, and Clippy concurrently. Every command must
succeed. Keep new integration tests in the existing binary so this list remains
complete. CI enables incremental compilation for both tests and Clippy and
omits debug symbols through environment overrides. Local Cargo profiles retain
their existing debug information.

Rust uses one cache for dependencies, workspace artifacts, and incremental
state. Keys include the platform, Cargo manifest and lockfile, toolchain file,
and workflow. Each successful main build refreshes the cache under its commit
SHA. A PR with no compatible cache can seed a cache scoped to that PR, which
allows measuring warm runs before merging the workflow change.

## TypeScript Tests

- **Framework:** Vitest with Testing Library. Config in [vitest.config.ts](../vitest.config.ts) and setup in [src/test/setup.ts](../src/test/setup.ts).
- **DOM vs Node Environment:** `.test.tsx` runs under jsdom; `.test.ts` runs under node for speed. `.test.ts` files that require DOM/browser globals (`window`, `document`, `localStorage`) use a `// @vitest-environment jsdom` docblock.
- **DOM Queries:** Query by role, accessible name, label, or title rather than CSS classes.
- **Mocks:** Browser preview and shell tests mock `window.argmax` using [src/test/appTestHarness.ts](../src/test/appTestHarness.ts).
- **Timers:** A test that waits on a `setInterval` or `setTimeout` in the component must fake it (`vi.useFakeTimers`, or `toFake: ["setInterval", "clearInterval"]` when `waitFor` still needs real `setTimeout`) and advance it with `vi.advanceTimersByTimeAsync`. Sleeping through a real interval is the suite's largest cost and its main flake source on shared CI runners.
- **Performance Benchmarks:** Run through [vitest.perf.config.ts](../vitest.perf.config.ts) and [src/test/perf.test.ts](../src/test/perf.test.ts).

## Rust Tests

Unit tests live inline in `src-tauri/src`. Integration tests are one binary,
[src-tauri/tests/integration](../src-tauri/tests/integration), with one module
per subsystem (IPC command parity and bindings freshness, workspace lifecycles,
provider sessions, session sync, multitask, git operations) and shared fixtures
under `support/`. One binary means one link of the crate per `cargo test`;
add a new module to `main.rs` rather than a new file under `tests/`.

Tests marked `#[ignore]` need a real provider CLI or the developer's own
transcript store and only run by hand.

### Running Specific Tests

Run a single test by name:

```bash
cargo test --manifest-path src-tauri/Cargo.toml <test_name>
```

Run only the integration binary, or only the unit tests:

```bash
cargo test --manifest-path src-tauri/Cargo.toml --test integration
cargo test --manifest-path src-tauri/Cargo.toml --lib
```
