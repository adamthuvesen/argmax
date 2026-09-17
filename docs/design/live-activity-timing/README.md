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
- **F** — E plus soft edges: 600ms before the first beat, 160ms fade in,
  140ms fade out.
- **G** — F plus an overlapped hand-off: the leaving line fades out over 140ms
  while the arriving one fades in over 160ms, 60ms of them together.
- **H · pick** — G plus the baton: on every hand-off the arriving line starts a
  fresh wave pass from its own left edge, so the light moves from the verb down
  to the tool line and back. Between hand-offs the phase runs off the wall clock.

## Who owns the beat

Exactly one line is live at a time, and every change of owner is a hand-off:

| state | live line |
| --- | --- |
| turn sent, nothing back yet | Thinking, after 600ms |
| a top-level tool is running | the tool line; Thinking is down the same frame |
| gap between two calls | the tool line stays settled; Thinking appears only once the gap passes the adaptive wait |
| answer streaming, or a card waiting | neither |
| turn settled | neither; nothing is left animating |

## Real streams

`real-c50454f0` and `real-6d041243` are pulled from the app's own event log
(`command.started` / `command.completed` with their timestamps, trimmed to the
first 40s of a turn). They are burstier than anything worth inventing: four to
six calls start in the *same millisecond*, then nothing happens for eight to
sixteen seconds. That is the churn the pacing rules have to absorb — a line that
re-words per event is re-wording per burst member.

On `real-c50454f0` (40s, 26 wording changes today):

| rules | changes |
| --- | --- |
| today | 26 |
| A–I (coalesce + dwell + kind-only wording) | 22 |
| K, burst 400ms / dwell 1000ms | 17 |
| **K, burst 800ms / dwell 1500ms** | **15** |
| K, burst 1500ms / dwell 2500ms | 15 |

15 is the floor: one change every ~2.7s, and every one of them is a real change
of *kind* — search → read → edit → command. Holding longer than 1.5s buys
nothing, which is where K's numbers come from.

## Metrics

`pops` counts Thinking lifetimes under 800ms; `both` counts frames with a
Thinking cue and a running tool line on screen at once (the flash).

| stream | today | A/B/C | E | F |
| --- | --- | --- | --- | --- |
| short gaps (300–1500ms) | 13 chg, 2 pops, 44 both | 9, 2, 0 | 9, 2, 0 | 9, 2, 0 |
| Claude edit-heavy | 11, 2, 23 | 11, 3, 0 | 11, 3, 0 | **9, 2, 0** |
| 12 calls in 3s | 16, 2, 14 | 5, 0, 0 | 5, 0, 0 | 5, 0, 0 |
| warm follow-up, long think | 8, 2, 6 | 8, 2, 0 | 6, 1, 0 | **4, 0, 0** |

`hand-offs` counts owner changes: the timing rules alone cut them from 3 to 1 on
the short-gap stream, because the cue no longer appears between calls that land a
second apart.

Timing alone removes every double-cue frame and two thirds of the visible-state
changes in a burst; the motion work (B/C) is polish on top, and the adaptive wait
plus soft edges (E/F) is what stops the cue flickering between two calls of a
turn whose calls land a second apart.

Two bugs worth remembering, both about the band rather than the rules:

- Size the band from the width of a line's *words*, as `lib/readingWave.ts` does.
  Sizing it from the flex row — the full column wide — stretched one pass to 7.7s
  and read as though the animation had stopped.
- Touch the phase only when the geometry changes, and then carry the head over.
  Rewriting `animation-delay` from the wall clock on every frame made the head
  advance twice and wrap each cycle: fast, then a jump, then a restart. The
  harness now reports `wave re-anchors` — one per real wording change (about 6 in
  an 11s turn), not one per frame. The app had the milder version of the same bug:
  it re-anchored on every wording change, which jumped the band mid-pass.

The harness models the rules, not the app's components: same tokens, fonts and
reading wave, but the transcript, follow-scroll and React reconciliation are not
in it. Judge motion in the dev instance after the port.
