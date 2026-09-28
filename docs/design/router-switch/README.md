# Router switch — mockups

When the router reroutes a follow-up (see [routing.md](../../routing.md#follow-ups)), the composer's
model chip changes from, say, `Balance → Opus 5.5 High` to `Balance → Fable 5.1 Extra High`. Today the
text just swaps. These frames animate the switch. It lands on send, when the eye is already on
the composer.

```bash
npx vite --port 5252 --strictPort            # from the repo root
open http://localhost:5252/docs/design/router-switch/index.html
```

`?theme=light|dark` and `?reason` (turns on the reason caption). All six cards play the same
switch at once. The loop chains effort up → model up → escalate → step down; Grok → Claude is
there to pick on its own. Slow ×4, Reduce motion and three sizes are in the toolbar.

- **A · Odometer:** only the changed words roll, up for a stronger pick and down for a lighter one.
- **B · Handoff:** the arrow nudges, the old model slides out right, the new one comes in from behind the arrow.
- **C · Decode:** the changed words scramble and resolve left to right, like a departure board. The loudest option.
- **D · Glint:** one accent band crosses the pill and the words crossfade as it passes. The reading wave's cousin, and the calmest option.
- **E · Route trace:** a hairline draws from the tier to the new pick, then lifts away.
- **F · Heat:** the odometer plus the effort slider's heat language. A stronger pick flushes the pill and sends out a ring (two rings at Extra High and up). A lighter pick exhales. The new effort word holds the accent, then cools.

**Reason caption** (a toggle, works with any option): the draft has just emptied on send, so
the reason (`↑ Escalated · looked like a redo`) borrows the placeholder line for about 2.5s. The
reasons map to the `turn_routes.decision` values (`reroute`, `escalate`).

Under Reduce motion every option becomes a 160ms crossfade. The motion is transform and opacity,
plus the changed segment's width and one word's colour.

## Decision

**F · Heat, with the reason caption**, shipped in `ModelSelector.tsx` (the chip),
`RollingText.tsx` (the roll), `useRouteSwitch.ts` (detection) and the
`Router switch` block in `chat-chrome.css`. The caption sits on the placeholder
line, not beside the chip: the toolbar has no free width once the branch and
changes chips are showing. A fresh launch uses the same motion without the
ring, unfolding `Balance` into `Balance → Opus 5.5`.

Shipped smoother than the mockup: one decelerating curve for every piece with
no overshoot, words that cross over part of a line rather than a whole one,
one halo that clears the pill evenly instead of rings stretched off its ends,
and no dip on a lighter pick. The dip scaled the label with the pill and read
as a shake. Widths are measured fractionally, so the chip no longer snaps
half a pixel when a roll ends.

A reroute and the turn going `running` arrive in the same dashboard row, which
swaps the composer's picker component. Every piece of the motion therefore
takes its offset from the switch's timestamp, so the remounted chip continues
the motion instead of restarting or skipping it.
