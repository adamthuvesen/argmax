# Testing

Argmax has two test suites: Vitest for the frontend and Cargo for the Rust backend.

The suites are the first rung of the verification ladder; driving the real app
(scratch instance, bridge, screenshots) is covered in [verification.md](verification.md).

## Commands

```bash
npm test                # Run unit, perf, and Rust test suites
npm run test:unit       # Vitest unit and component tests
npm run test:perf       # Vitest performance benchmarks
npm run test:rust       # Cargo test suite for src-tauri
npm run check:bindings  # Verify Specta TS bindings freshness
npm run check:tauri-bridge # Check IPC channel inventory parity
```

## TypeScript Tests

- **Framework:** Vitest with Testing Library. Config in [vitest.config.ts](../vitest.config.ts) and setup in [src/test/setup.ts](../src/test/setup.ts).
- **DOM vs Node Environment:** `.test.tsx` runs under jsdom; `.test.ts` runs under node for speed. `.test.ts` files that require DOM/browser globals (`window`, `document`, `localStorage`) use a `// @vitest-environment jsdom` docblock.
- **DOM Queries:** Query by role, accessible name, label, or title rather than CSS classes.
- **Mocks:** Browser preview and shell tests mock `window.argmax` using [src/test/appTestHarness.ts](../src/test/appTestHarness.ts).
- **Performance Benchmarks:** Run through [vitest.perf.config.ts](../vitest.perf.config.ts) and [src/test/perf.test.ts](../src/test/perf.test.ts).

## Rust Tests

Rust tests are located inline and in [src-tauri/tests](../src-tauri/tests), covering IPC command parity, workspace lifecycles, provider normalization, migrations, and git operations.

### Running Specific Tests

Run a single test by name:

```bash
cargo test --manifest-path src-tauri/Cargo.toml <test_name>
```

Run tests for a package:

```bash
cargo test --manifest-path src-tauri/Cargo.toml -p argmax_lib
```
