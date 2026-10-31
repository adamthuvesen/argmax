# Testing

Argmax has Vitest suites for the frontend, Cargo suites for the Rust backend, and XCTest suites for the iPhone app.

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
npm run test:ios        # XCTest suite on a simulator (see "iPhone Tests" below)
npm run lint:rust       # cargo clippy over every target, warnings are errors
npm run check:static    # Every static gate; precheck and CI run this same list
npm run check:rust-boundaries # Rust layer rules, with a ratchet on existing violations
npm run doctor          # Check the local verification environment
npm run verify          # Build and exercise a disposable app with scripted providers
```

`verify` is a local end-to-end loop described in [verification.md](verification.md).
It is intentionally separate from CI and `precheck`.

## Ratchets

A common bad pattern fails only on new additions. ESLint records existing
violations in `eslint-suppressions.json`, and the Rust layer rules record them
in `scripts/rust-boundaries-baseline.json`. After you fix a violation, tighten
the record:

```bash
npx eslint . --prune-suppressions
node scripts/check-rust-boundaries.mjs --update
```

Do not add a new suppression. Use the fix that the error message names.

## The pre-push gate

`git push` runs [scripts/precheck.mjs](../scripts/precheck.mjs) through the
project-owned hook in [.githooks/pre-push](../.githooks/pre-push); `npm install`
points `core.hooksPath` there. The script diffs the branch against `main`
(committed and uncommitted changes alike) and runs only the lanes that diff
touches:

| Touched | Runs |
|---|---|
| any path, docs included | `check:static` ([scripts/static-checks.mjs](../scripts/static-checks.mjs)) |
| `src/**`, `src-tauri/**`, `ios/**`, `fixtures/parity/**`, assets, HTML entrypoints, package or tool config, `scripts/**` | eslint, tsc, `vitest run --changed <merge-base>`, perf budgets |
| `src-tauri/**`, browser-blocking assets, Cargo or workflow config | `cargo fmt --check`, `cargo test`, `cargo clippy -D warnings` |
| any JS lane change | `vite build` + the bundle budget |
| `ios/**`, `fixtures/parity/**`, `scripts/ios-tests.mjs` | `npm run test:ios` |

`npm run typecheck` (the tsc lane here and in CI) runs TypeScript 7, the native
compiler, installed as the `typescript-7` alias: it checks the renderer in about
1 s against 4.5–4.9 s for TypeScript 5.9, and reports the same diagnostics. The
`typescript` 5.9 package stays because typescript-eslint's type-aware rules
support only `<6.1`, and editors load their language service from it.

`cargo fmt --check` runs first in the Rust lane, because it takes about a second and is the likeliest push-time failure. `git push` re-runs the whole script through the pre-push hook, so a tool call that pushes needs a 600 s timeout.

Workflow changes run both language lanes. Paths are read from Git without quoting,
so spaces and non-ASCII filenames cannot hide a change. Documentation-only
changes skip checks. An unclassified path runs both language lanes until it is
deliberately classified.

CI runs the same lanes with the same path filter. CI also runs `npm audit` and
`cargo audit`, because advisories change without a code change and need network.
Never bypass the hook with `--no-verify`; if a lane is wrong for the change,
fix the filters in `precheck.mjs` and `.github/workflows/ci.yml`.

### CI execution

CI distributes the complete Vitest suite across eight shards. The first shard
also runs the performance budgets. ESLint reuses cached results only when all
TypeScript sources and configuration match. Its type-aware rules can report an
error in an unchanged file when an imported type changes, so a per-file content
cache alone is insufficient. Fresh checkout timestamps do not invalidate a
matching cache.

Two macOS Rust lanes run library tests and integration checks. The integration
lane builds its test binary first, then runs tests, doctests, and Clippy in
parallel, waiting for every command and propagating failures. Both lanes must
succeed. Keep new integration tests in
the existing binary so this list remains complete. CI enables incremental
compilation for both tests and Clippy and
omits debug symbols through environment overrides. Local Cargo profiles retain
their existing debug information.

Each Rust lane caches its dependencies, workspace artifacts, and incremental
state. Keys include the lane, platform, Cargo manifest and lockfile, toolchain
file, and workflow. Each successful main build refreshes the cache under its commit
SHA. A PR with no compatible cache can seed a cache scoped to that PR, which
allows measuring warm runs before merging the workflow change.

The dependency audit runs on every pull request and every push to `main`.
Advisories can appear without a lockfile change, so limiting the PR audit to
dependency updates lets an unrelated merge discover a new advisory only after
it lands.

## TypeScript Tests

- **Framework:** Vitest with Testing Library. Config in [vitest.config.ts](../vitest.config.ts) and setup in [src/test/setup.ts](../src/test/setup.ts).
- **DOM vs Node Environment:** `.test.tsx` runs under jsdom; `.test.ts` runs under node for speed. `.test.ts` files that require DOM/browser globals (`window`, `document`, `localStorage`) use a `// @vitest-environment jsdom` docblock.
- **DOM Queries:** Query by role, accessible name, label, or title rather than CSS classes.
- **Mocks:** Browser preview and shell tests mock `window.argmax` using [src/test/appTestHarness.ts](../src/test/appTestHarness.ts).
- **The prompt editor:** jsdom has no layout, so the suite renders the composers' lazy `ComposerEditor` as the textarea it shows while the CodeMirror chunk loads (`ComposerFallbackField`, wired in [composerEditorMock.tsx](../src/test/composerEditorMock.tsx)), the way it already swaps the file editor. That mock proves the composers' own behavior and nothing about CodeMirror. The editor is covered against a real `EditorView` in [composerEditor/extensions.test.tsx](../src/renderer/components/composerEditor/extensions.test.tsx) and [ComposerEditorView.test.tsx](../src/renderer/components/ComposerEditorView.test.tsx) (chips, atomic Backspace, clipboard, IME guard, undo) and [ComposerEditor.test.tsx](../src/renderer/components/ComposerEditor.test.tsx) (the hand-over from the textarea), and in a real browser by `node scripts/verification/composer-editor.mjs`. A test that needs the real wrapper calls `vi.unmock("./ComposerEditor.js")`; one that needs the editor inside a composer remaps the module to the view (`vi.mock("./ComposerEditor.js", ...)` returning `ComposerEditorView`), as [SessionComposer.editor.test.tsx](../src/renderer/components/SessionComposer.editor.test.tsx) and [LaunchSurface.editor.test.tsx](../src/renderer/components/LaunchSurface.editor.test.tsx) do for undo, cut, submit and the draft switch. [jsdomCodeMirror.ts](../src/test/jsdomCodeMirror.ts) gives jsdom the zeroed layout CodeMirror measures.
- **Timers:** A test that waits on a `setInterval` or `setTimeout` in the component must fake it (`vi.useFakeTimers`, or `toFake: ["setInterval", "clearInterval"]` when `waitFor` still needs real `setTimeout`) and advance it with `vi.advanceTimersByTimeAsync`. Sleeping through a real interval is the suite's largest cost and its main flake source on shared CI runners.
- **Performance Benchmarks:** Run through [vitest.perf.config.ts](../vitest.perf.config.ts) and [src/test/perf.test.ts](../src/test/perf.test.ts).

## iPhone Tests

`npm run test:ios` ([scripts/ios-tests.mjs](../scripts/ios-tests.mjs)) regenerates
the Xcode project, builds the `ArgmaxTests` target, and runs it on a simulator
named "Argmax Test Lane", which it creates when it is missing. Precheck runs it
when the diff touches the paths in the table above. CI runs the same command in
a path-filtered macOS job, and on every push to `main`. The log goes to
`node_modules/.cache/ios-tests/last-run.log`. `--only ParityTableTests` narrows a
run to one class, or to `Class/testMethod`.

On 4 November 2026 the suite ran 494 tests on an already booted simulator in
81 s from empty DerivedData (59 s build, 22 s tests) and 21 s with nothing to
rebuild. Booting the simulator first raised the test step to 50–60 s.

UI tests and `NativePerformanceTests` stay out of this lane. See
[ios-performance.md](ios-performance.md#run-the-checks).

When `xcodebuild -checkFirstLaunchStatus` fails, xcodebuild lists no simulator.
The script then warns and injects the test bundle into the app through the
CoreSimulator `simctl`, so a push from that machine still gets a real result.
The fix is `sudo xcodebuild -runFirstLaunch`, which needs an administrator.

### Rules that exist on both platforms

A rule that the desktop and the phone both implement has one case table in
[fixtures/parity](../fixtures/parity):

| Table | Desktop | Phone |
|---|---|---|
| `chat-detail.json` | `sessionTurnView.ts`, `uiPreferences.ts` | `MobileChatDetail.swift`, `MobileTranscriptRows.swift` |
| `inline-math.json` | `normalizeMathDelimiters.ts`, read back through remark-math | `TranscriptMarkdownPreparation.swift` |
| `workspace-chat.json` | `workspaceChat.ts` | `ChatSections.swift` |

[parityTables.test.ts](../src/renderer/lib/parityTables.test.ts) and
[ParityTableTests.swift](../ios/Argmax/Tests/ParityTableTests.swift) run each table
against the real functions. To change a rule, change the table first, then both
functions. Where the platforms really differ, a case carries a `desktop` or
`phone` object with that platform's expected value and a `reason`. A new mirrored
rule gets a new table.

### Recorded scroll sequences

[TranscriptScrollModel](../ios/Argmax/Sources/Transcript/TranscriptScrollModel.swift)
holds every transcript scroll decision. The `scroll-*.json` files in
`ios/Argmax/Tests/Fixtures` are event sequences recorded from the real list in
hosted `NativeTranscriptListTests` runs. Each step holds the event, the props, and
the decisions the model made. A deliberate behavior change needs a new recording.
Sequences a hosted test cannot perform, such as a drag during layout, are written
out in [TranscriptScrollModelTests](../ios/Argmax/Tests/TranscriptScrollModelTests.swift).

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
