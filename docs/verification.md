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
into the state under test, and the expression's value comes back as `eval` in
the ready line — an async expression can click a row, wait, and return a
measurement (a scroll gap, a row count, a text probe) alongside the PNG. An
agent can read the PNG back and *look* at it, and assert on the value.

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

`reply` sends a follow-up turn to an existing session — the resume path, which
`chat` never exercises — and streams it the same way. `terminal` spawns a PTY
in a workspace, runs one command, and reports how its output reached a remote
client (chunk count, bytes, largest chunk), which is the observable side of
terminal push conflation:

```bash
node scripts/bridge.mjs reply --session <id> --prompt 'now add tests'
node scripts/bridge.mjs terminal --workspace <id> --run 'cat big.txt' --seconds 8
```

### The desktop renderer against the scratch backend

The remote server serves the desktop renderer too, so the browser rung and the
scratch rung compose: point `ui-screenshot.mjs` at the instance with `?remote`
and the pairing token in the fragment, and headless Chrome runs the full
desktop UI over the WebSocket bridge against real sessions. This is the rung
for the chat surface — streaming, Thought blocks, tool rows, follow-scroll —
because `--eval` can open a session row and sample the page while a real
provider streams into it:

```bash
TOKEN=$(node -e 'console.log(JSON.parse(require("fs").readFileSync("/tmp/argmax-scratch/remote.json")).token)')
node scripts/ui-screenshot.mjs --url "http://127.0.0.1:<port>/?remote#token=$TOKEN" \
  --eval "$(cat open-session.js)" --out chat.png
```

where `open-session.js` is an async IIFE that clicks the sidebar row (rows are
`button[title]` elements titled by task label and state; collapsed project
groups open via the `Show <project> sessions` button), then returns whatever it
measured. Start the provider session with `bridge.mjs chat` in the background
first and time the capture into the stream.

For the Agents pane the same recipe applies with two extra conditions. The
parent repo must live at a plain path (the CLI's transcript slug is lossy, so a
temp directory full of dots and dashes strands the child transcript), and the
subagent must do something the CLI forwards: tool calls always are, text and
thinking only with `--forward-subagent-text`, which the Claude adapter passes.
Open the pane by clicking the last `.agent-launch-row-button` in the parent
transcript, then sample `.agent-activity-scroll` (`scrollTop`, `scrollHeight`,
`.agent-activity-items` height) and count `animationstart` events on it: an
entrance animation firing on a bubble that already existed is a remount, and a
`scrollHeight` decrease while pinned to the bottom is the drop a reader sees.

For the agent tools, prompt a `chat` run to use them and read the tool rows out
of the NDJSON stream: `mcp__argmax__session_list` and friends must show JSON
results, and the launched session must appear in `dashboard:list` with
`launchedBySessionId` naming the caller ([agent-tools.md](agent-tools.md)).
`pgrep -f "argmax mcp"` is the teardown check — empty once the instance is
gone.

Grok and Cursor's non-composer models reach the tools through a config file
written into the checkout, so they need two checks the other providers do not.
Run the Grok scenario and a Cursor one with a *non-composer* `--model-id` (the
composer path goes through ACP and proves nothing about this), then confirm
`git status` in the scratch repo is clean, that a `.cursor/mcp.json` seeded with
the user's own server is byte-identical afterwards, and that no `.grok/` or
`.cursor/` line is left in `.git/info/exclude`. Point the app at a throwaway
Grok home first — `GROK_HOME=<dir> node scripts/scratch-app.mjs …`, with
`auth.json` and `agent_id` copied in — so the folder-trust grant lands there
and never in the real `~/.grok/trusted_folders.toml`; that file must come back
unchanged.

`system:debug-snapshot` is served over the bridge precisely for this loop:
a script can assert on log lines and per-channel latency instead of eyeballing
the debug panel ([debugging.md](debugging.md)). For performance claims,
measure through the bridge against a release build ([performance.md](performance.md)).

## Rung 4: the real window

```bash
node scripts/app-screenshot.mjs --out real.png [--pid <pid>]
```

Captures an on-screen Argmax window with `screencapture` (window id via a
Swift `CGWindowList` lookup; a debug binary reports its owner as `argmax`, a
packaged build as `Argmax`, and both match). `--pid` picks between the real
app and a scratch instance — `scratch-app.mjs` prints its pid. Needs the
Screen Recording permission for whatever runs the script — an agent's host
process usually lacks it, and granting it is a Privacy & Security change the
user makes — and a window on another Space is not capturable. The browser rung
against the scratch backend covers everything except native chrome, so this
is the last mile, not the default.
