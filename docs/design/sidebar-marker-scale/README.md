# The sidebar marker scale

One 14px column in the chat list holds five different marks: a picked icon, the
working nest, a PR or status glyph, the unread dot, and the calm-row ring. They
were each sized on their own day, so the column carries 14 / 6 / 8 with no rule
tying them together — and the ring, which marks the rows with the least to say,
is the widest of the small marks.

```bash
npx vite --port 5243 --strictPort            # from the repo root
open http://localhost:5243/docs/design/sidebar-marker-scale/index.html
```

Every option on the sheet is **three numbers** — glyph, dot, ring — fed to the
same CSS variables, which is the proposal as much as any single option: the
column should have one ladder, not five independent sizes. Each frame shows the
specimen strip (all five marks at size, then the three circles at 4x) above the
list they live in. `?theme=light` flips the palette, `?only=<key>` (comma
separated) renders a subset.

## The options

- **Shipped · 14 / 6 / 8** — today. Ring a third wider than the unread dot.
- **A · Equal circles · 14 / 6 / 6** — one diameter for every circle; fill is
  the only difference between "nothing here" and "unread".
- **B · Optical match · 14 / 6 / 7** — the ring gets 1px back because a hollow
  circle reads lighter than a filled one. Measures differently, weighs the same.
- **C · Circles at 7 · 14 / 7 / 7** — both circles at exactly half the glyph. A
  2:1 ladder: 14 for anything with a shape, 7 for anything that is just a circle.
- **D · Whole column down · 13 / 6 / 6** — A's ratios with a smaller glyph.

## Captures

`all-dark.png` / `all-light.png` are the sheet; `circles-compare-dark.png` is
the four that differ only in circle size.

## Decision

**C · Circles at 7 · 14 / 7 / 7**, chosen 2026-09-20 and shipped. The column
now states the ladder where it is defined (`shell-sessions.css`): 14px for any
mark with a shape — picked icon, status glyph, working nest — and 7px for any
mark that is only a circle, which is the unread dot (6px → 7px) and the calm
row's ring (8px → 7px). A new mark picks the step its shape belongs to instead
of a size of its own.

Deliberately left at 6px: `.session-custom-icon-overlay`, the corner dot that
puts live state back on a row whose icon took the column. It is a badge on a
glyph, not a mark in the column, and it has to stay smaller than what it sits
on.
