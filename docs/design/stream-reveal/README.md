# Streaming prose reveal — mockup

The chat types an answer out on a 64 ms tick. Before this page, every tick's
characters landed at full ink, so a streaming answer read as a stutter of
blocks. This page is where the fade that replaced that was tuned.

```bash
npx vite --port 5251 --strictPort            # from the repo root
open http://localhost:5251/docs/design/stream-reveal/index.html
```

It renders the shipped [StreamingMarkdown](../../../src/renderer/components/StreamingMarkdown.tsx)
with the shipped prose styles and the shipped cadence — nothing here
re-implements the transcript — and scripts the three delivery shapes the app
actually sees: Claude's ~130-character chunks every 0.7 s, Cursor's burst of
word-sized deltas, and Codex landing a whole answer at once. **Replay** starts
the turn again.

## Decision

**Per-tick opacity fade**, in [streamFreshRuns.ts](../../../src/renderer/lib/streamFreshRuns.ts):
each tick's characters fade from 0.3 to their own ink over 420 ms, which puts
about six runs in flight and reads as one soft gradient trailing the writing
head.

Two things were tried and rejected on this page:

- **A gradient tail** — one span over the last N characters, painted with a
  `background-clip: text` ramp. It is smooth in space but stepped in time: the
  ramp can only move when the reveal ticks, so every character's ink changes at
  15 fps. It also seams wherever the tail is shorter than the ramp, which is
  every paragraph that has just started and every run that crosses a `**bold**`.
- **A CSS animation per run** — correct until the markdown is re-parsed. React
  reconciles the rebuilt tree by position, so the span holding the newest run is
  usually the same element that held the previous one, and a CSS animation bound
  to that element has already finished. Anchoring a Web Animations animation's
  `startTime` to the moment the run was revealed makes the handover invisible.

`startTime` is on the document's timeline, which shares an origin with
`performance.now()` in Blink but not in WebKit — where the difference is however
long the app has been open, which parks every fade before its first frame. The
painter converts.
