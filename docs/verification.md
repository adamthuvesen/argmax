# Verification

How to prove a change works — not just that the suites pass, but that the app
behaves and looks right. The rungs are ordered by cost; climb only as high as
the claim you need to make. An agent working in this repo should treat the
ladder as the definition of "verified".

| Rung | Proves | Cost |
|---|---|---|
| `npm test` + checks | logic, budgets, parity gates | seconds |
| Renderer in a browser | how the UI renders, per theme | ~10 s |
| Scratch instance + bridge | real sessions through the real backend | ~1 min |
| Real-window screenshot | pixel truth, native chrome included | seconds |

## Rung 1: suites and checks

`npm test`, `npm run lint`, `npm run typecheck`, and the `check:*` scripts
([testing.md](testing.md)). Cheap, deterministic, run them always. Everything
above this rung exists for the claims these cannot make: "the app starts",
"the session streams", "the launcher looks right".

## Rung 2: the renderer in a real browser

Without `window.argmax` the renderer boots against the demo snapshot
([loadDashboardSnapshot.ts](../src/renderer/lib/loadDashboardSnapshot.ts)), so
the full UI renders in any browser with no Rust backend.

```bash
node scripts/ui-screenshot.mjs --out shot.png --theme dark
node scripts/ui-screenshot.mjs --mobile --width 390 --height 844
node scripts/ui-screenshot.mjs --eval 'document.querySelector("[aria-label=\"Settings\"]").click()'
```

The script serves the renderer with vite, opens it in headless Chrome over
CDP, and captures a PNG. `--theme` seeds `localStorage["argmax.theme.mode"]`
before boot; `--eval` runs arbitrary JS after load, so the UI can be clicked
into the state under test. An agent can read the PNG back and *look* at it.

## Rung 3: a scratch instance, driven over the bridge

`ARGMAX_DATA_DIR` points the app at an alternate data directory —
database, instance lock, attachments, `remote.json`, logs all move with it
([util/data_dir.rs](../src-tauri/src/util/data_dir.rs)). A scratch profile
therefore runs a second, fully real instance alongside the daily one.

```bash
# Boot (add --build to compile first; stays in the foreground, Ctrl-C stops it)
node scripts/scratch-app.mjs --data-dir /tmp/argmax-scratch --build
# → {"ready":true,"port":59665,"token":"…","dataDir":"/tmp/argmax-scratch",…}
```

The binary must be built with the `custom-protocol` feature
(`cargo build --manifest-path src-tauri/Cargo.toml --features custom-protocol`)
— without it a debug binary tries to load the vite dev server instead of its
bundled renderer.

The scratch `remote.json` is seeded with the bridge enabled, so the instance
is scriptable through the remote bridge ([remote.md](remote.md)) — the same
`*_impl` handlers the desktop IPC uses:

```bash
node scripts/bridge.mjs call dashboard:list --data-dir /tmp/argmax-scratch
node scripts/bridge.mjs watch --seconds 30            # stream dashboard:delta
node scripts/bridge.mjs logs                          # system:debug-snapshot: log ring + IPC p50/p99
node scripts/bridge.mjs chat --repo /tmp/some-repo --prompt 'do the thing'
```

`chat` is the end-to-end rung: it registers the repo, creates a workspace,
launches a real provider session, streams timeline events as NDJSON, and exits
0 / 2 / 3 for complete / failed / timeout, with the cost summary on the last
line. Model defaults mirror `PROVIDER_MODEL_DEFAULTS`
([providerModels.ts](../src/shared/providerModels.ts)); the copy in
`scripts/bridge.mjs` is pinned by `src/test/bridgeDefaults.test.ts`.

Without `--data-dir` the bridge CLI targets the real app's profile
(`~/Library/Application Support/com.argmax.rs`), which works once remote
access is enabled in Settings → Integrations.

`system:debug-snapshot` is served over the bridge precisely for this loop:
a script can assert on log lines and per-channel latency instead of eyeballing
the debug panel ([debugging.md](debugging.md)). For performance claims,
measure through the bridge against a release build ([performance.md](performance.md)).

## Rung 4: the real window

```bash
node scripts/app-screenshot.mjs --out real.png [--pid <pid>]
```

Captures an on-screen Argmax window with `screencapture` (window id via a
Swift `CGWindowList` lookup). `--pid` picks between the real app and a scratch
instance — `scratch-app.mjs` prints its pid. Needs the Screen Recording
permission for whatever runs the script, and a window on another Space is not
capturable; the browser rung covers everything except native chrome, so this
is the last mile, not the default.
