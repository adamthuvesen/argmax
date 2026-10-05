# Agent browser tools reach into iframes

An agent can read and drive a page that lives in a cross-origin, sandboxed
iframe — a Claude artifact, an embedded slide deck — the way it drives any
other page.

Source: scripts/verify.mjs, scripts/verification/workflows.mjs, src-tauri/src/browser/frames.rs, src-tauri/src/browser/automation.rs, src-tauri/src/browser/snapshot.js, src-tauri/src/browser/frame_probe.js
Inventory-id: scenario:browser-frames

## Sub-features

- `browser-frames` opens a hidden tab for the seeded chat through `browser:open-for-session`, the path an agent's `browser_open` takes. The page is a host on one loopback port whose only content is a `sandbox="allow-scripts"` iframe served from a second port, so a different origin. The host focuses the iframe and cannot scroll. The drive then calls snapshot, find, get-text, act (press key, click, wait for, scroll) and a ref-cropped screenshot through the agent IPC channels, which run the same `browser::automation` code as the MCP tools.

## How to get to it (user POV)

Ask an agent to page through a Claude artifact deck, or to read an app embedded
in an iframe, with Argmax's browser.

## Driving it with verify.mjs

Preconditions: `launch` completed and `doctor` exits 0. No source edits during the run.

- **Run.** `node .agents/skills/verify-argmax/verify.mjs drive browser-frames`.
- **Proof.** `native/browser-frames.json` lists the assertions, and
  `native/browser-frames-steps.json` holds every answer the tab gave:
  - the snapshot prints `- iframe "Slides" [frame=fN] url=…` with the frame's heading spliced under it
  - `find` returns a frame-qualified ref (`fNeM`)
  - ArrowRight with no click first is carried into the frame (focus sat on the iframe), so the slide turns and the detail names the frame
  - get-text carries the frame's text under `[frame fN: url]`
  - a click on the frame ref turns the slide again
  - wait-for sees text the frame adds 1.5 s after load
  - a scroll the host cannot take scrolls the frame
  - a screenshot cropped to the frame's button is a small fraction of the full capture

## Gotchas

Agent evaluate is MCP-only (no IPC channel), so its CSP fallback is not driven
here; `eval::is_eval_refused` has a unit test and a live MCP check is the
proof for that path. The key press is a synthetic DOM event, as every agent
input is, so a page that ignores `isTrusted: false` events would not react.
