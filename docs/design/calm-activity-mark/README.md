# Calmer activity marks — mockups

The activity mark started with four energetic styles. `nest`
relays a leader around a 2x2 every 900ms, which is a moving bright point 67
times a minute, per running row. In a sidebar holding six live chats that reads
as weather. This page puts five quieter candidates next to the shipped nest so
the choice was made by looking rather than by arguing. `halo` was selected and
added as the fifth style.

```bash
npx vite --port 5244 --strictPort            # from the repo root
open http://127.0.0.1:5244/docs/design/calm-activity-mark/index.html
```

It loads the real `tokens.css` and the real `working-nest.css`, so the **Nest**
column is the app, not an imitation. The studies use their own `.cm-*` classes
so the cascade cannot leak either way.

Header controls: theme, accent, tempo, phase, and how many rows are running.
Query parameters do the same for capture, plus `?frame=strip` and `?frame=rail`
to render one section alone at capture size:

    ?theme=light&accent=purple&tempo=1.4&phase=off&rows=12
    ?frame=strip
    ?frame=rail&rows=12

## The candidates

| | Shape | Cycle | Gestures/min | Parts |
| --- | --- | --- | --- | --- |
| `nest` (shipped) | Four dots, leader relaying clockwise | 900ms | 267 | 12 |
| `breath` | One dot, swelling and fading | 2600ms | 23 | 1 |
| `halo` | Still core, breathing ring | 2600ms | 23 | 1 |
| `ping` | Still core, ring leaves and fades | 2600ms | 23 | 1 |
| `ember` | Still core, soft bloom behind it | 2600ms | 23 | 1 |
| `pulse` | Two beats, then a long rest | 2600ms | 46 | 1 |

2600ms on a symmetric sine is not a new number: the thought-block eyebrow and
the compaction notice already breathe at exactly that, so a calm mark joins the
app's existing "this is live" rhythm instead of inventing a third one.

Every candidate animates only `transform` and `opacity`, takes its colour from
`--working-nest-lead` / `--working-nest-rest` / `currentColor`, and opts into
`--loop-play-state`. None of them hard-codes green: the default accent already
*is* sage, and a literal green would break the other fourteen accents and the
per-agent identity colours that tint the mark for free.

## What the page settles

- **Brightness alone cannot separate live from calm.** A calm row's marker is a
  5px dot at `--muted`, half opacity. Checked at 16px on charcoal, a single dot
  dipping below about 0.45 opacity *becomes* that marker — `breath` at its dim
  frame reads as an idle row, not as a quieter live one. Structure separates
  them at any brightness; that is the argument for `halo` and `ember` over
  `breath`, and it is why every floor on this page was raised.
- **`ping` is a bare dot for 40% of its cycle**, by design, which means it
  inherits the same collision intermittently.
- **Performance is not the axis.** All six are compositor-only and the sidebar
  already skips off-screen rows with `content-visibility` and pauses loops on a
  hidden window. `nest` costs 12 animated boxes against 1, which is real but
  not why it feels chaotic — the frequency is.
- **Phase is worth reconsidering for a slow mark.** Phasing keeps separate jobs
  legible when the mark is fast. At 2600ms it turns a tidy column into a
  shimmer, and agreeing looks calmer than disagreeing. Try `phase=off`.

Recommendation: **`halo`**. The core never moves, so the gutter keeps a fixed
anchor to scan, and the ring carries the liveness at a tenth of the nest's
frequency. `ember` is the prettier one and the better fit if the ring reads too
technical; `breath` is the floor of the range if even a ring is too much.

## Implementation

Halo uses the existing style axis:

1. `src/renderer/lib/activityMark.ts` adds the id to `ActivityMarkId`, an
   option to `ACTIVITY_MARK_OPTIONS`, and its part count to
   `ACTIVITY_MARK_PART_COUNT`.
2. `src/renderer/styles/working-nest.css` defines `[data-mark="halo"]`,
   including its still frame in the reduced-motion and `[data-still]` blocks.
   The shared box, landing, and colours apply without extra rules.
3. `docs/styling.md` records the five available styles.

`WorkingNest.tsx` needs no change: it builds parts from
`ACTIVITY_MARK_PART_COUNT`, and the settings picker renders every option with a
live mark as its glyph.

## Capturing from this page

The marks are dynamically inserted and animated, and a screenshot of this page
can catch a stale composite in which the nest's parts have correct computed
styles but paint nothing. Nudge a repaint first, then capture:

```js
document.body.style.opacity = "0.999";
void document.body.offsetHeight;
document.body.style.opacity = "";
```

Section 3's filmstrip holds each frame by seeking the Web Animations API rather
than by pausing in CSS, for the same reason: `animation-play-state: paused` in
the cascade computes the right style but left this WebKit painting nothing.
`WorkingNest.tsx` already reaches for WAAPI to anchor `startTime`, so the
harness borrows the app's own lever. Seeking `currentTime` preserves each
part's own `animation-delay`, which is what keeps the nest's four dots in
their choreography instead of collapsing onto one phase.
