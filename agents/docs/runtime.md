# Runtime (Tauri / Rust)

> Placeholder. This doc will replace `electron.md` at cutover (port task 13.6).
> Until then, both runtimes coexist on the `adam/rust-port` branch.

## Dev loop

```bash
npm run tauri dev      # rebuilds the Rust crate, launches the webview, watches the renderer
npm run tauri build    # signed/notarized DMG + ZIP (release pipeline)
npm run test:rust      # `cargo test` across the src-tauri/ crate
```

The renderer (`src/renderer/`, `src/shared/`) ships unchanged into the Tauri
webview. `src/renderer/lib/tauriBridge.ts` (added in port task 4.7) is the
sole renderer file that knows about Tauri — it installs `window.argmax` by
delegating to `@tauri-apps/api` `invoke` / `listen`.

## Native-module dance: gone

The Electron build needs `rebuild:electron` before `npm run dev` and
`rebuild:node` before `npm test`. The Tauri build has no native Node
modules — `better-sqlite3` is replaced by `rusqlite`, `node-pty` by
`portable-pty`. `cargo build` is the only build step; `npm install`
no longer triggers a `node-gyp` rebuild.

## Crate layout

`src-tauri/src/` is the Rust core. Module boundaries:

- `error.rs` — `ArgmaxError` enum (serializes with a stable `code`).
- `state.rs` — `AppState` carrying `Arc<Database>` and per-subsystem services.
- `util/` — cross-cutting helpers: startup timer, IPC latency histograms,
  delta coalescer, process control (SIGTERM → wait → SIGKILL escalation),
  workspace-path validation.
- `persistence/` — SQLite migrations, drift detection, prepared-statement
  cache, repository functions per table family.
- `providers/` — Claude / Codex / Cursor adapters, PTY orchestration,
  event normalizer (with the Cursor cumulative-delta state machine),
  flush queue.
- `workspaces/`, `review/`, `git/`, `files/`, `gh/`, `mcp/`, `terminal/`,
  `approvals/`, `checks/`, `memory/`, `attachments/`,
  `ide/`, `skills/`, `updater/`, `menu/` — one folder per subsystem.
- `ipc/` — `#[tauri::command]` handlers, one file per channel group.

See [architecture.md](architecture.md) for the main↔renderer boundary and
[ipc.md](ipc.md) for the channel inventory.

## Binding regeneration

`src/shared/bindings.d.ts` is emitted by `tauri-specta` from the Rust
command surface at app startup in debug mode. A CI guard
(`scripts/check-bindings-fresh.mjs`, wired via `npm run check:bindings`)
fails when the file is older than any input under `src-tauri/`.
