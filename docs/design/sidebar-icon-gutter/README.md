# Sidebar — where the session icon goes

`.session-link` reserves an 18px marker column on every row and draws nothing
in it unless the row has a picked icon or a live signal (`shell-sessions.css`,
`.session-link-lead-spacer`). In a real list most rows are calm, so the column
is mostly empty and every title sits 28px in from the gutter to keep a handful
of icons aligned. This page tries the layouts that hold up when a list is
mixed.

```bash
npx vite --port 5243 --strictPort            # from the repo root
open http://localhost:5243/docs/design/sidebar-icon-gutter/index.html
```

It loads the real `tokens.css` and the Geist faces; the glyphs are the same
lucide paths `SidebarSessionRow` uses. `?theme=light` flips the palette,
`?only=<key>` renders one frame for capture; a comma-separated list renders
several side by side (`?only=dot,dot2`). The list is the one from the
screenshot that prompted this: four picked icons, one running turn, one open
PR, five calm rows.

## The frames

- **Shipped** — the 18px reserved column, blank on calm rows.
- **A · Flush left** — no reserved column. A calm row starts at the gutter; an
  icon row indents itself. Ragged left edge, no dead space.
- **B · Dot placeholder** — a 6px muted dot fills the column on calm rows.
  Alignment kept; the list gains a column of dots.
- **B2 · Dot, smaller glyph** — the same dot with the glyph at 14px in a 16px
  column, so the icons stop out-weighing the titles.
- **C · Smaller glyph** — same structure at 13px, so the indent is 21px not
  28px and the empty column costs less.
- **D · On the meta line** — titles on the gutter, the glyph leads the project
  name at 12px. A missing glyph is a missing word, not a hole. (This is what
  the phone list chose in `chat-list-glyphs`.)
- **E · Trailing glyph** — titles on the gutter, the glyph on the right edge.
- **F · Never-empty tile** — a 22px tinted tile per row: picked icon, else the
  project's initial. Densest; reads as an app switcher.
- **G · Project initial** — same column, no tile: the icon when there is one,
  otherwise the project's initial in mono.
- **H · Hairline tick** — a 1px rule instead of a dot. The quietest placeholder
  that still holds the column.
- **J · Narrow rail** — everything shrinks to a 10px column: icons at 10px,
  calm rows a 3px dot, titles indented 18px.

## Captures

`all-dark.png` / `all-light.png` are the whole sheet; `<key>-dark.png` is one
frame each at 2x.

## Decision

**B2 · Dot, smaller glyph**, chosen 2026-09-20 and shipped in the same change:
`.session-link` runs a 14px lead column with a 9px gap, every marker glyph
dropped from 16px to 14px, and `.session-link-lead-spacer` became
`.session-link-lead-dot` — a 6px muted circle at 45% opacity. The unread marker
is the same circle in the accent at full strength, which is the one pair a
future change has to keep apart.
