# Phone chat list — where a row's glyph lives

The chat list reserves a 36pt leading column for one glyph per row (nest, picked
icon, PR mark, provider mark; `ChatRowGlyph.swift`). With Provider marks off,
or on a Mac where few chats picked an icon, most rows carry nothing there and
every title sits 36pt in from the gutter for no reason. The column was built on
the assumption that every row fills it. This page tries the layouts that hold
up when a list is mixed: some rows with a glyph, most without.

```bash
npx vite --port 5243 --strictPort            # from the repo root
open http://127.0.0.1:5243/docs/design/chat-list-glyphs/index.html
```

It loads the real `tokens.css`, the Geist faces, and the five provider SVGs
from the iOS asset catalogue. `?theme=light` flips the palette; `?only=B`
renders one frame for capture. Nine rows, the same in every frame: two picked
icons, two open PRs, one running turn, provider marks on the rest.

## The frames

- **Shipped · marks off / on** — the current row, both switch states.
- **A · In the meta line** — titles on the gutter; the glyph leads the second
  line at 12pt, before the project name. A missing glyph is a missing word.
- **B · Trailing, by the time** — titles on the gutter; the glyph at 16pt sits
  beside the elapsed time, where the eye already goes for state.
- **C · A tile on every row** — a 32pt tile that is never empty: picked icon on
  its tint, else the provider mark, else the project's initial.
- **D · Leading the title** — the glyph is the first word of the title, the way
  an issue list badges a row. Rows without one start at the gutter.
- **E · State in the margin, identity in the meta** — the 20pt gutter carries
  state as a 6pt dot (accent running, sage open PR, violet merged); the
  identity glyph leads the meta line.

## Without the elapsed time (`?sheet=notime`)

Dropping "23h" frees the whole right edge, so the row is a title, a place, and
at most one glyph. `notime-dark.png` is the sheet; `f-`…`i-*.png` one frame each.

- **F · Text only** — glyph leads the meta line; the right edge is empty unless
  the chat needs you.
- **G · Trailing glyph, centred** — the glyph alone at 18pt, centred on the row
  like a settings chevron. Attention sits before it.
- **H · Glyph closes the meta line** — identity as a footnote, right-aligned on
  the second line; the title's line holds only the title.
- **I · Trailing is for live state only** — the right edge shows only what is
  happening now (nest, capsule); identity leads the meta line.

## Captures

`all-dark.png` / `all-light.png` are the whole sheet; `*-dark.png` are one
frame each at 2x.

## Decision

**A · In the meta line**, chosen 2026-09-12. The elapsed time stays on the
trailing edge. Not yet ported to `ChatListView.swift` / `ChatRowGlyph.swift`.
