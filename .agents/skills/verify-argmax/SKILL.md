---
name: verify-argmax
description: Run, launch, drive, or verify Argmax's disposable native desktop scenarios, or prove a renderer, chat follow-up, queued restart, session move, cancellation, or provider failure change works.
---

# Verify Argmax

Prove native chat behavior with the real Rust backend and scripted providers,
or renderer changes with a quick demo-snapshot screenshot. Read
[features/README.md](features/README.md) for coverage and prerequisites.

## Pick a rung

- **Renderer only** (styles, components, copy, layout): run `ui`. About 10 seconds, no build.
- **Chat runtime, IPC, persistence, or native controls**: run the native drives below. Several minutes.

## UI

```bash
node .agents/skills/verify-argmax/verify.mjs ui
node .agents/skills/verify-argmax/verify.mjs ui -- --eval 'document.querySelector("[aria-label=\"Customize\"]").click()'
```

Serves the renderer against its demo snapshot in headless Chrome and captures
`ui-dark.png` and `ui-light.png` into a new `.verify/runs/<...>-ui/` directory.
Options after `--` pass to `scripts/ui-screenshot.mjs` (`--eval`, `--width`,
`--height`, `--mobile`, `--touch`, `--settle`, `--scale`). The helper owns `--out`
and `--theme`, and refuses `--url` so it never reaches a live Argmax. `UI` lists the
PNGs. Open each and check the change; exit 0 only means capture. To find a
control, make `--eval` throw its labels, for example
`throw new Error([...document.querySelectorAll("[aria-label]")].map((e) => e.getAttribute("aria-label")).join(", "))`,
then read them in `ui.log`. Failed captures keep their directory as evidence. It cannot prove
backend data, IPC, or native window behavior.
Use Argmax MCP for the hosting app's workspace and check operations. This skill
drives only the separate app started by the repository's verification runner.

## Launch / Reset

From the repository root:

```bash
node .agents/skills/verify-argmax/verify.mjs launch
```

`READY <run directory>` means the verification build and host doctor passed.
Install prerequisites using [the quickstart](../../../README.md) and
[verification docs](../../../docs/verification.md). On a sandboxed host,
launch, drive, doctor, and clean need permission to launch native processes
and inspect their identities. A sandbox denial is not an app failure.

The existing runner owns a fresh app, project, profile, and fixture HOME per
drive, then stops them. `reset` checks the host again and authorizes one retry.
Build caches are reused in `dist/verification` and `src-tauri/target/verification`.
The helper reuses installed Rust tooling and Cargo caches. App state, provider
config, shell startup, browser profiles, npm cache, and temporary files are isolated.
Complete edits before launch. Any tracked or untracked source change makes the run stale.

## Doctor

```bash
node .agents/skills/verify-argmax/verify.mjs doctor
```

Checks the checkout fingerprint, owned run directory, allowed target, empty
machine-command tripwire, toolchain, loopback, browser, and native driver tools.
The scenario then verifies its running binary, isolated database, and native
window. Screen Recording and Accessibility are reported in the run's `doctor.json`,
not the terminal. Do not treat a missing optional permission as a passed OS interaction.
Drives bring a native window to the front, so the Mac must stay unlocked and awake.
Doctor refuses a locked screen. If the screen locks mid-drive, the result is
`unreachable`, which does not spend the retry. Unlock and drive again.

## Drive

Run `launch`, `doctor`, one or more `drive <feature-id>`, `control`, then `clean`.
An exclusive command lock keeps drives serial. Each drive and `control` re-runs
doctor first, so its output starts with `READY`. Each starts its own native app. The fixture launches via
production IPC. Follow-up and Stop use native controls. `composer-reference`
also drives the New chat launcher. This does not verify other app surfaces or
live provider service support.

```bash
node .agents/skills/verify-argmax/verify.mjs drive chat-resume
```

Select `chat-resume`, `queued-restart`, `session-move`, `composer-reference`,
`composer-editor`, `fork-merge`, `workspace-settings`, `cancellation`, or `provider-error` from the feature map.
A failed drive stays FAIL. After `doctor` and `reset`, one retry is allowed and
a successful retry is `flaky`. After any surprising result, inspect evidence
and doctor before continuing. A tripwire hit requires cleanup and an isolation fix.

## Evidence

A passing drive writes screenshots, native UI diagnostics, timeline events, provider
invocations, a SQLite snapshot, build hashes, and `verdict.json` in its own
`drive-<feature>-<epoch-ms>/` folder under the printed `.verify/runs/<utc>-<id>-<sha7>[-dirty]/`
run directory. A drive that fails before the app is driven may have only
`report.json`, logs, and `verdict.json`. Its result is `fail`, or `unreachable` for a host cause. `manifest.txt` records feature,
entry, replay command, process exit, result, target, SHA, dirty status, start time,
and artifact path. Replays require a fresh launch and allocate a new output path.
Credentials are excluded from children and redacted from evidence logs.

- **Control:** `node .agents/skills/verify-argmax/verify.mjs control` re-drives
  `provider-error` but expects `complete` instead of `failed`. A healthy native
  run must reject that assertion with worker exit 1 and `fail-observed`.
  The helper itself exits 0 only for that expected rejection. A crashed run is no control proof.

## Cleanup

`node .agents/skills/verify-argmax/verify.mjs clean` verifies the scenario-owned
app has exited, records `tripwire.txt`, and removes `.verify/state/`. Evidence
under `.verify/runs/` survives. Use clean after failed attempts too. If a command
is active, interrupt its owning helper and wait for it to finish before cleanup.
Never stop the installed Argmax that hosts this chat.

## Helper

- `node .agents/skills/verify-argmax/verify.mjs ui [-- <options>]`: screenshot the demo renderer in both themes.
- `node .agents/skills/verify-argmax/verify.mjs launch`: prepare isolation and build.
- `node .agents/skills/verify-argmax/verify.mjs doctor`: validate this run and host.
- `node .agents/skills/verify-argmax/verify.mjs reset`: return to the fresh-drive baseline.
- `node .agents/skills/verify-argmax/verify.mjs drive provider-error`: drive one mapped feature.
- `node .agents/skills/verify-argmax/verify.mjs control`: prove a wrong assertion fails.
- `node .agents/skills/verify-argmax/verify.mjs clean`: check teardown and retain evidence.
- `node .agents/skills/verify-argmax/verify.mjs exec -- node --version`: diagnose inside isolation.
- `node .agents/skills/verify-argmax/verify.mjs inventory`: enumerate existing scenario entry points.

`VERIFY_TARGET` is the sole target override. Only `native-local` is accepted.
`VERIFY_TARGET=https://example.invalid node .agents/skills/verify-argmax/verify.mjs doctor`
and the same prefix on `drive provider-error` must both refuse before launching anything.
