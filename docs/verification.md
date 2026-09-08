# Verification

How to prove a change works — not just that the suites pass, but that the app
behaves and looks right. The rungs are ordered by cost; climb only as high as
the claim you need to make. An agent working in this repo should treat the
ladder as the definition of "verified".

## Local scenario verification

```bash
npm run doctor
npm run verify -- --scenario chat-resume
npm run verify -- --scenario persistent-subagent --native off
npm run verify -- --scenario persistent-codex-subagent --native off
npm run verify -- --scenario persistent-opencode-subagent --native off
npm run verify -- --scenario persistent-cursor-subagent --native off
npm run verify -- --scenario cancellation
npm run verify -- --scenario provider-error
```

The scenario runner builds a verification binary and renderer from the current
checkout, creates a temporary project and app profile, and drives the real
backend with a scripted provider. Native UI verification is required by
default. The fixture exercises the production launcher and normalizer without
calling a paid provider. Other providers remain unavailable in this profile.

`chat-resume` checks streaming and a follow-up turn. `cancellation` checks that
a running provider can be stopped. `provider-error` checks that a provider
failure becomes a failed session. These commands are local checks and are not
part of CI or the pre-push gate.

`persistent-subagent --native off` checks the Claude native child identity,
separate lifecycle runs for the initial launch and a `SendMessage` continuation,
queryability after a scratch backend restart, and the Agents pane in light and
dark browser renders. It uses the remote browser path because the scenario
restarts the scratch backend. This fixture does not establish provider support.
Also run a live Claude exchange through the scratch app, restart it, and verify
that `SendMessage` continues the same native child with its earlier context.

`persistent-codex-subagent --native off` exercises Codex app-server's
`spawnAgent`, `sendInput`, and `wait` events through the same restart and dock checks. It
requires persisted lifecycle rows for both assignments. A successful `wait`
reporting `pending_init` must leave the child running. Verify provider support
separately with a live Codex exchange through the scratch app, then restart and
continue the same child with `send_input` and `resume_agent` when needed.

`persistent-opencode-subagent --native off` exercises OpenCode's native HTTP
and SSE protocol for the `task` tool, including a continuation with the same
`task_id`, persisted lifecycle rows across a scratch backend restart, and the
Agents pane in light and dark browser renders. OpenCode emits the child result
in the parent's completed task part, so this fixture verifies native identity
and dock history rather than child transcript streaming.

`persistent-cursor-subagent --native off` exercises Cursor's ACP task lifecycle
through a backend restart. It checks the translation from pending `rawInput` to
completed `rawOutput`, the authoritative child id from the completed task
result, a fresh invocation id on resume, two completed dock runs, and both
light and dark browser renders.

Each run prints a JSON result with its evidence location. Failures retain the
diagnostics needed to reproduce the assertion. `--out <dir>` selects the
evidence destination, which must be empty or new. `--keep` retains the
temporary profile and project for inspection, but still stops the app and its
children. Per-phase PNG and JSON files show the UI and its diagnostic state.

Verification uses `dist/verification` and `src-tauri/target/verification` so a
normal build cannot replace its assets. The runner copies the built binary
into the temporary run directory and records its hash. It checks the source
fingerprint before and after building and after the scenario. Finish edits
before starting a run. An edit during verification fails the stability check.

`--native off` selects the remote-browser path explicitly. Its report records
that narrower coverage. Use the default native path for desktop UI claims.

The desktop driver is compiled only with the nondefault `verification` Cargo
feature and starts only when verification mode is requested. Ordinary builds
do not include the driver. A verification request sent to an ordinary binary
fails before app startup instead of falling back to installed providers.
Before native interaction, the runner brings its isolated app window to the
foreground and fails if that window remains hidden.

Run `doctor` from the same host that will run verification. It reports the
capabilities available to that process. OS permission checks it cannot prove
remain unverified. Whole-window screenshots and native OS interaction may need
Screen Recording or Accessibility permissions for that host.

| Rung | Proves | Cost |
|---|---|---|
| `npm test` + checks | logic, budgets, parity gates | seconds |
| Renderer in a browser | how the UI renders, per theme | ~10 s |
| Scratch instance + bridge | real sessions through the real backend | ~1 min |
| Real-window screenshot | pixel truth, native chrome included | seconds |

## Rung 1: suites and checks

`npm run precheck` runs the CI checks (`npm test`, `npm run lint`,
`npm run lint:rust`, `npm run typecheck`, the `check:*` scripts) scoped to what
the branch changed, and `git push` runs it as the pre-push hook
([testing.md](testing.md)). Cheap, deterministic, run them always. Everything
above this rung exists for the claims these cannot make: "the app starts",
"the session streams", "the launcher looks right".

For the Usage page there is a fourth kind of claim, "the numbers are right",
and a rung for it: `node scripts/check-usage-oracle.mjs --days 7` compares
Argmax's per-day, per-model token totals with ccusage and CodexBar reading the
same transcripts. Token counts must match; see [usage.md](usage.md).

## Rung 2: the renderer in a real browser

For chat scrolling, run `node scripts/check-chat-scroll.mjs`. It mounts the
production scroll controller in a browser fixture and checks small upward
gestures during streaming, folding content, nested scrolling, viewport
resizes, and returning to live output. The command exits nonzero on a failed
position assertion. These real-layout checks complement the hook's unit tests.

Use `node scripts/check-chat-scroll.mjs --serve` to open the printed fixture
URL in Argmax's WebKit browser. Run `window.chatScrollCheck.runChecks()` there
and inspect the resolved results. This exercises the browser engine without
replacing or restarting the application hosting the chat.

Without `window.argmax` the renderer boots against the demo snapshot
([loadDashboardSnapshot.ts](../src/renderer/lib/loadDashboardSnapshot.ts)), so
the full UI renders in any browser with no Rust backend.

```bash
node scripts/ui-screenshot.mjs --out scratch/shot.png --theme dark
node scripts/ui-screenshot.mjs --mobile --width 390 --height 844
node scripts/ui-screenshot.mjs --eval 'document.querySelector("[aria-label=\"Settings\"]").click()'
```

The script serves the renderer with vite, opens it in headless Chrome over
CDP, and captures a PNG. `--theme` seeds `localStorage["argmax.theme.mode"]`
before boot; `--scale 2` captures at that device pixel ratio; `--eval` runs
arbitrary JS after load, so the UI can be clicked
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
`.session-link` buttons titled by task label and state; every group starts
collapsed, so open them via the `Show <group> chats` buttons first), then
returns whatever it measured. Start the provider session with `bridge.mjs chat`
in the background first and time the capture into the stream.

The README hero is made this way: a scratch instance on a plain-path clone,
a few `bridge.mjs chat --worktree` runs given short titles with
`workspaces:set-label`, two `--scale 2` captures (one with the review pane
open, one with the sidebar hidden), and `node scripts/readme-hero.mjs --main
<png> --side <png>` to draw the window chrome and backdrop around them.

The demo snapshot carries one subagent run with its own thinking, narration,
and tool calls, so the Agents pane renders on rung 2 as well: click the last
`.agent-launch-row-button` in the demo transcript and read the pane back. That
covers folding, the `Worked for Xs` chip, and every verbosity level. Rung 3
below is for what a fixture cannot show — a live run streaming in.

For the Agents pane the same recipe applies with two extra conditions. The
parent repo must live at a plain path (the CLI's transcript slug is lossy, so a
temp directory full of dots and dashes strands the child transcript), and the
subagent must do something the CLI forwards: tool calls always are, text and
thinking only with `--forward-subagent-text`, which the Claude adapter passes.
Open the pane by clicking the last `.agent-launch-row-button` in the parent
transcript, then sample `.agent-activity-scroll` (`scrollTop`, `scrollHeight`,
`.turn-block-body` height) and count `animationstart` events on it: an
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
user makes — and a window on another Space is not capturable.

The browser rung against the scratch backend exercises the channels supported
by the remote bridge. It cannot verify desktop-only behavior such as native
browser tabs, folder dialogs, session-sync controls, or routines. See
`REMOTE_UNSUPPORTED_CHANNELS` in
[dispatch.rs](../src-tauri/src/remote/dispatch.rs) for the exact boundary.
