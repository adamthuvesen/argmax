# Live activity timing — harness

The activity line and the Thinking cue read as flashes: a running group's
headline re-renders on every tool event (and dips its opacity on each one), and
the cue appears after a 700ms gap but is then held `THINKING_MIN_VISIBLE_MS`
even once a tool line has taken the beat, so a short gap pops a word on screen
and takes it away again.

This page replays one turn's events through several rule sets at once, on one
virtual clock, so the only difference between panes is the timing and the
transition.

```bash
npx vite --port 5251 --strictPort            # from the repo root
open http://localhost:5251/docs/design/live-activity-timing/index.html
```

`?stream=short-gaps|claude-edits|burst|slow-start`, `?theme=light`, `?speed=0.25`.
`window.__measure(stream)` runs the whole stream on a fixed 16ms grid with no
animation frames and returns each pane's metrics, which is what the table below
came from — a background tab gets no frames, so the live loop cannot be trusted
for numbers.

## The rule sets

- **Today** — 700ms wait, 600ms minimum visible, whole-headline opacity dip per change.
- **A · Timing only** — 1000ms wait, no minimum visible (the cue yields the frame a
  tool line takes over), headline changes coalesced to one commit per 500ms with an
  800ms dwell. No motion changes at all.
- **B** — A plus a 200ms colour cross-fade of the whole headline.
- **C** — A plus segment diff: the verb holds, only a new clause fades in, and the
  icon cross-fades between two stacked glyphs.
- **E** — C plus an adaptive wait: 0.8× the median gap so far, clamped 0.9–2.5s.
- **F · pick** — E plus soft edges: 600ms before the first beat, 160ms fade in,
  140ms fade out.

## Metrics

`pops` counts Thinking lifetimes under 800ms; `both` counts frames with a
Thinking cue and a running tool line on screen at once (the flash).

| stream | today | A/B/C | E | F |
| --- | --- | --- | --- | --- |
| short gaps (300–1500ms) | 13 chg, 2 pops, 44 both | 9, 2, 0 | 9, 2, 0 | 9, 2, 0 |
| Claude edit-heavy | 11, 2, 23 | 11, 3, 0 | 11, 3, 0 | **9, 2, 0** |
| 12 calls in 3s | 16, 2, 14 | 5, 0, 0 | 5, 0, 0 | 5, 0, 0 |
| warm follow-up, long think | 8, 2, 6 | 8, 2, 0 | 6, 1, 0 | **4, 0, 0** |

Timing alone removes every double-cue frame and two thirds of the visible-state
changes in a burst; the motion work (B/C) is polish on top, and the adaptive wait
plus soft edges (E/F) is what stops the cue flickering between two calls of a
turn whose calls land a second apart.

The harness models the rules, not the app's components: same tokens, fonts and
reading wave, but the transcript, follow-scroll and React reconciliation are not
in it. Judge motion in the dev instance after the port.
