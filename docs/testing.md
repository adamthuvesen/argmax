# Testing

Argmax has two test layers:

- Vitest for renderer/shared TypeScript.
- Cargo tests for the Rust/Tauri runtime.

## Commands

```bash
npm run test:unit
npm run test:perf
npm run test:rust
npm test
npm run check:bindings
npm run check:tauri-bridge
```

`npm test` runs unit tests, perf tests, and Rust tests. There is no native Node rebuild step.

## TypeScript Tests

Vitest config lives in [vitest.config.ts](../../vitest.config.ts); setup lives in [src/test/setup.ts](../../src/test/setup.ts). Prefer role/label/title queries. Browser-preview and app-shell tests mock `window.argmax` through [appTestHarness.ts](../../src/test/appTestHarness.ts).

Perf microbenches are isolated through [vitest.perf.config.ts](../../vitest.perf.config.ts) and [src/test/perf.test.ts](../../src/test/perf.test.ts).

## Rust Tests

Rust tests live next to the code and under [src-tauri/tests](../../src-tauri/tests). They cover IPC inventory, git/review/workspace services, provider sessions, persistence, and command validation. Use focused Cargo filters while iterating, then `npm run test:rust` before calling runtime work done.

### Rust Test Iteration

Run a single test by name:

```bash
cargo test --manifest-path src-tauri/Cargo.toml my_test_name
```

Watch mode (requires `cargo-watch`):

```bash
cargo install cargo-watch
cargo watch -x "test --manifest-path src-tauri/Cargo.toml" -c
```

Test a specific module or package:

```bash
cargo test --manifest-path src-tauri/Cargo.toml -p argmax_lib
```
