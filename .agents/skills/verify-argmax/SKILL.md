---
name: verify-argmax
description: Drives Argmax's real renderer in headless Chrome against its demo snapshot, and points to the native scenario runner for backend claims. Use to run, launch, drive, or verify Argmax, or to prove a change to it works.
---

# Verify Argmax

One helper starts one loopback vite server and one headless Chrome. Then it drives the renderer the way a person does. With no `window.argmax`, the renderer boots against its demo snapshot, so no Rust backend, provider, or profile is involved.

## Run

```bash
npm run verify               # drives that cover files changed against main, plus uncommitted and untracked; launcher when none match
npm run verify -- all        # every drive, about 17 s
npm run verify -- launcher   # named drives; launcher writes launcher-dark.png and launcher-light.png
npm run verify -- list       # each drive, what it proves, the paths it covers
npm run verify -- control    # the launcher with a wrong expected heading; exits 0 only when FAIL is observed
```

Run `verify` after a change, and `verify -- all` before you hand over larger work. Every visual change ships the two launcher screenshots. For any other state, run `node scripts/ui-screenshot.mjs --eval '<js>'` ([docs/verification.md](../../../docs/verification.md#rung-2-the-renderer-in-a-real-browser)).

## Reading results

- Each drive prints `PASS|FAIL <drive> <seconds>s <detail>`. A FAIL detail names what was expected and what rendered.
- Evidence is in `.verify/runs/<utc>-<sha7>[-dirty]/`: `<page>.png`, `<page>.log` (command, exit, stdout, stderr), `composer-editor/` with its JSON report and PNGs, `tripwire.log`, and `summary.json`.
- The run also fails when a machine-global command (`security`, `defaults`, `launchctl`, ...) was called, or when the checkout changed during the run.
- Drives never retry, so there is no FLAKY. Run a failed drive again by name, and report a pass after a fail as flaky.

## Limits

These drives cannot prove the Rust backend, IPC, persistence, provider launches, or native window behavior. For those, use the scenario runner. It takes minutes and needs `cargo` on `PATH` (`~/.cargo/bin`). The native path also needs the Mac unlocked, because it brings a window to the front.

```bash
npm run doctor
npm run verify:native -- --scenario provider-error --native off   # --native off: remote-browser path, no window
```

It builds into `src-tauri/target/verification` with a temp HOME, profile, scripted provider, and machine-command tripwires. Finish edits before you start it: an edit during the build fails the run with `checkout changed`. Scenarios and their assertions live in `scripts/verify.mjs`. Never quit, kill, or drive the installed Argmax that hosts the chat. Live provider support needs the scratch-app rung in docs/verification.md.

Headless Chrome cannot show a WebKit paint bug, such as a clip seam or a `backdrop-filter` artifact. Use the dev instance (`npm run tauri:dev:isolated`) for those.

## Gotchas

- Headless Chrome delivers IME composition only to its default browser context. So `composer-editor` opens its tab there. The other drives each use a fresh context, so their storage stays separate.
- An IME confirms a candidate before the Enter that commits it. A keyless Enter commits whatever composition is open, so the drive sets the candidate first.
- A viewport override in the shared browser renders the prompt 51.99997 px tall, under its 52 px floor. The browser starts with `--window-size=1200,900` instead.
- Settings loads lazily, and its section links are not in a `<nav>`. Wait for the "General" heading and select a section by its text.
