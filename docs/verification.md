# Verification

How to prove a change works, beyond suites passing. The rungs are ordered by cost. Climb only as high as the claim you need to make.

| Rung | Proves | Cost |
|---|---|---|
| 1. `npm test` and checks | logic, budgets, parity gates | seconds |
| 2. Renderer in a browser | how the UI renders, per theme | ~10 s |
| 3. Scratch instance and bridge | real sessions through the real backend | ~1 min |
| 4. Real-window screenshot | pixel truth, native chrome included | seconds |
| Scenario runner | production backend and native UI with a scripted provider | minutes |
| Dev instance next to the installed app | the change, hands-on | ~1 min |

The `verify-argmax` skill at `.agents/skills/verify-argmax/SKILL.md` drives these for user-facing changes.

## Local scenario verification

```bash
npm run doctor
npm run verify -- --scenario <name> [--native off] [--out <dir>] [--keep]
```

[scripts/verify.mjs](../scripts/verify.mjs) lists the scenarios and owns each one's assertions. Each run prints a JSON result with its evidence location, and per-phase PNG and JSON files show the UI and its state. These are local checks, not part of CI or the pre-push gate.

The runner builds a verification binary and renderer from the current checkout, creates a temporary project and profile, and drives the real backend with a scripted provider. That exercises the production launcher and normalizer without calling a paid provider.

Rules that make the evidence mean something:

- **Verification mode must never reach the host's credentials.** `routing/api_key.rs` returns no key and refuses writes. The `launch` tripwires (`security`, `defaults`, `op`, `launchctl`, `brew`, `crontab`, `systemctl`) stay in place, and a test proves they fail and log a call.
- **The driver exists only with the nondefault `verification` Cargo feature.** A verification request sent to an ordinary binary fails before startup instead of falling back to installed providers.
- **Finish edits before starting a run.** The runner checks the source fingerprint before and after the build and after the scenario, and an edit fails the stability check.
- **Native UI is the default.** `--native off` selects the remote-browser path, and its report records that narrower coverage. Use the native path for desktop UI claims.
- **A fixture does not establish provider support.** For the `persistent-*-subagent` scenarios, also run a live exchange through the scratch app, restart it, and continue the same child.

Run `doctor` from the host that will run verification, because it reports that process's capabilities. Whole-window screenshots and native interaction may need Screen Recording or Accessibility permission. A foreground failure is classified `foreground-activation-timeout`, with diagnostics in its evidence.

Native `cancellation` waits past the early-stop window to verify a retained cancelled session. Renderer tests cover early stop.

## Rung 1: suites and checks

`npm run precheck` runs the CI checks scoped to what the branch changed, and `git push` runs it as a hook ([testing.md](testing.md)). Run them always. Everything above this rung exists for claims these cannot make.

For the Usage page, `node scripts/check-usage-oracle.mjs --days 7` proves the numbers ([usage.md](usage.md#checking-the-numbers)).

## Rung 2: the renderer in a real browser

Without `window.argmax`, the renderer boots against a demo snapshot ([loadDashboardSnapshot.ts](../src/renderer/lib/loadDashboardSnapshot.ts)), so the full UI renders with no Rust backend.

```bash
node scripts/ui-screenshot.mjs --out scratch/shot.png --theme dark
node scripts/ui-screenshot.mjs --mobile --width 390 --height 844
node scripts/ui-screenshot.mjs --eval 'document.querySelector("[aria-label=\"Customize\"]").click()'
```

`--eval` runs JS after load, and its value comes back in the ready line. An async expression can click a row, wait, and return a measurement alongside the PNG. An agent can read the PNG back and look at it.

**Headless Chrome cannot show a WebKit paint bug.** A composited-clip seam, a mask edge, or a `backdrop-filter` artifact needs the dev instance.

**Chat scrolling:** `node scripts/check-chat-scroll.mjs` mounts the production controller in a browser fixture. Add `--serve` to open the fixture in Argmax's WebKit browser, without restarting the app hosting the chat, and run `window.chatScrollCheck.runChecks()`.

**The prompt editor:** `node scripts/verification/composer-editor.mjs --out scratch/composer-editor` sends trusted input over CDP, because chips, undo, IME, and the clipboard depend on a real `contenteditable` that jsdom cannot host. It cannot show a real input method's candidate window.

**The Agents pane:** the demo snapshot carries one subagent run, so click the last `.agent-launch-row-button`.

## The dev instance next to the installed app

Argmax is developed from inside Argmax. The installed app hosts the chats doing the work, and the build under test is a second instance on its own profile:

```bash
npm run tauri:dev:isolated      # ARGMAX_DATA_DIR=~/.argmax-dev tauri dev
```

Plain `npm run tauri:dev` shares the installed app's data dir, hits the instance lock, and exits. The override moves everything that would collide: database, lock, attachments, `remote.json`, logs, and worktrees. The session-launch socket is per process, and the MCP server is the instance's own binary.

What to expect:

- **The profile persists.** Do not copy the installed app's database over, because its rows point at worktrees the installed app owns.
- **No desktop notifications.** `tauri dev` is unbundled ([runtime.md](runtime.md)).
- **Remote bridge is off** until enabled. Pick a port other than 8790, because a bind failure leaves the bridge silently off.
- **Provider CLIs are shared,** so session sync imports the same transcripts into both databases.
- **A Rust edit restarts the binary** and kills every session it hosts. Keep only throwaway chats there.
- **Never quit, kill, or replace the installed app** from a chat it hosts, because that ends the provider mid-turn. Build in the workspace and give the user the install steps.

To stop it, end both processes. A stale binary keeps the profile's lock:

```bash
pkill -f 'node_modules/.bin/tauri dev'; pkill -f 'target/debug/argmax$'
```

The main checkout carries other sessions' edits, and one can break the Rust build. Run from a worktree at a known commit instead, sharing compiled dependencies:

```bash
git worktree add --detach /tmp/argmax-dev <commit>
ln -s "$PWD/node_modules" /tmp/argmax-dev/node_modules
cd /tmp/argmax-dev && CARGO_TARGET_DIR="$OLDPWD/src-tauri/target" npm run tauri:dev:isolated
```

## Rung 3: a scratch instance, driven over the bridge

`ARGMAX_DATA_DIR` moves the app to an alternate data directory ([data_dir.rs](../src-tauri/src/util/data_dir.rs)), so a scratch profile is a second, fully real instance.

```bash
node scripts/scratch-app.mjs --data-dir /tmp/argmax-scratch --build
```

The binary needs the `custom-protocol` feature, or a debug build tries to load the vite dev server.

The scratch `remote.json` enables the bridge, so the instance is scriptable through the same `*_impl` handlers the desktop IPC uses ([remote.md](remote.md)). [scripts/bridge.mjs](../scripts/bridge.mjs) documents its commands:

```bash
node scripts/bridge.mjs call dashboard:list --data-dir /tmp/argmax-scratch
node scripts/bridge.mjs logs        # log ring, IPC p50 and p99
node scripts/bridge.mjs chat --repo /tmp/some-repo --prompt 'do the thing'
node scripts/bridge.mjs reply --session <id> --prompt 'now add tests'
```

`chat` is the end-to-end rung. It exits 0, 2, or 3 for complete, failed, or timeout. `reply` exercises the resume path. Without `--data-dir`, the CLI targets the real app's profile once remote access is enabled.

### The desktop renderer against the scratch backend

The remote server also serves the desktop renderer, so point `ui-screenshot.mjs` at it. This is the rung for streaming, Thought blocks, tool rows, and follow-scroll:

```bash
TOKEN=$(node -e 'console.log(JSON.parse(require("fs").readFileSync("/tmp/argmax-scratch/remote.json")).token)')
node scripts/ui-screenshot.mjs --url "http://127.0.0.1:<port>/?remote#token=$TOKEN" \
  --eval "<JS that opens a session row and measures>" --out chat.png
```

Rows are `.session-link` buttons, and groups start collapsed. Start `bridge.mjs chat` in the background first. [readme-hero.mjs](../scripts/readme-hero.mjs) holds the recipe for the README hero.

For the Agents pane, the parent repo must live at a plain path, because the CLI's transcript slug is lossy. Sample `.agent-activity-scroll`. An entrance animation on an existing bubble is a remount, and a `scrollHeight` drop while pinned is what a reader sees.

For the agent tools, see [agent-tools.md](agent-tools.md#verifying).

**Grok and Cursor's non-composer models** write a config into the checkout, so they need extra checks. Confirm that `git status` is clean, a seeded `.cursor/mcp.json` is byte-identical afterwards, and no line remains in `.git/info/exclude`. Run with `GROK_HOME=<dir>` and copied auth, so the trust grant never lands in the real `~/.grok/trusted_folders.toml`.

For performance claims, measure through the bridge against a release build ([performance.md](performance.md)).

The bridge covers the channels the catalogue exposes. It cannot verify desktop-only behavior such as native browser tabs, folder dialogs, or routines. The `desktop` policy in [catalogue.rs](../src-tauri/src/ipc/catalogue.rs) is the boundary.

## Rung 4: the real window

```bash
node scripts/app-screenshot.mjs --out real.png [--pid <pid>]
```

`--pid` picks between the real app and a scratch instance. It needs Screen Recording permission for whatever runs the script, which is a change the user makes. A window on another Space is not capturable.
