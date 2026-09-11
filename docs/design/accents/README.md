# Accent tints — side by side

Every accent in both themes on one page, each column reading the real
`tokens.css` block for its `data-accent`. The choice is made by looking at the
seven next to each other, not one at a time in Settings.

```bash
python3 -m http.server 8123 --bind 127.0.0.1   # from the repo root
open http://127.0.0.1:8123/docs/design/accents/index.html
open "http://127.0.0.1:8123/docs/design/accents/index.html?set=previous"
```

Each cell shows the surfaces an accent actually lands on: the working dot,
a selected row on `--accent-soft`, the user bubble, inline code and a path in
the derived mono inks, a link on `--accent-deep`, a focus ring, the three
semantic chips the tint must never be confused with (rose, amber, sage), and
the soft / accent / deep steps as bare swatches.

`?set=previous` overlays the values shipped before 2026-09-12 so the two can
be flicked between. `previous.png` and `shipped.png` are those two captures
(`scripts/ui-screenshot.mjs --url … --width 1920 --height 880`).

## Decision (2026-09-12)

**One lightness per role, chroma per hue.** Light accents sit at OKLCH
L 0.50 (orange a half step up at 0.53, because orange at L 0.50 is brown),
light deeps at L 0.41–0.43, dark accents at L 0.71–0.72, dark deeps at
L 0.77–0.78, dark bubbles at L 0.44–0.49. Green and neutral were already
there and did not move; black is grayscale ink and sits outside the ladder.

What that fixed:

- **Orange was the one loud column.** Light `#b15810` was the lightest and
  most saturated accent (L 0.56, C 0.14, white ink at 4.9:1 — the only one
  under 5). Its dark bubble `#ad510c` was the same slab in both themes while
  every other dark bubble receded to L 0.44–0.47. Now `#a25408` / `#924a15`.
  The light soft `#fff0e2` was a peach cream two chroma steps warmer than its
  siblings; `#f8eae1` sits with them.
- **Coral read as the error red.** Hue 24 against rose at hue 14 is one
  tint, so a coral bubble and a "2 failed" chip were the same colour at a
  glance. Coral now sits at hue 32 (`#944b3e`), terracotta rather than
  raspberry, halfway between rose and orange.
- **Green's dark deep ran the wrong way.** `--accent-deep` aliased
  `--sage-deep`, which in dark is a *darker* sage for status glyphs, so the
  default accent's nest leader and link ink were the only ones dimmer than
  the accent (4.5:1). Dark green now lifts to `#8cc3a1` like the others;
  `--sage-deep` keeps its semantic value.
- **Blue and purple were a touch under the family.** Blue lifted from C 0.08
  to 0.09 on paper so it stops reading steel; dark purple lifted from L 0.68
  to 0.71 so it is no longer the dimmest dark accent.
- The Settings list carried a neutral swatch (`#2f2f2b`) that matched no
  token; it now shows the accent it applies.

## Ladder

| accent | light `--accent` | light `--accent-deep` | dark `--accent` | dark `--accent-deep` | dark bubble |
| --- | --- | --- | --- | --- | --- |
| green | `#446c56` L.50 C.058 H159 | `#2e503e` | `#6dab86` L.69 | `#8cc3a1` L.77 | `#3a664c` L.47 |
| purple | `#70558f` L.50 C.094 H305 | `#553b73` | `#ad94d0` L.71 | `#c1ace1` L.78 | `#5c4778` L.44 |
| neutral | `#6c6960` L.52 C.014 H92 | `#4a473e` | `#a8a49b` L.72 | `#c2beb4` L.80 | `#4f4d47` L.42 |
| orange | `#a25408` L.53 C.128 H55 | `#7d3a00` | `#db9152` L.72 | `#e5a978` L.78 | `#924a15` L.49 |
| blue | `#396696` L.50 C.092 H252 | `#244c77` | `#7ea6cf` L.71 | `#9abbde` L.78 | `#3e5978` L.46 |
| coral | `#944b3e` L.50 C.100 H32 | `#753428` | `#d18e82` L.71 | `#e2a79c` L.78 | `#7d453a` L.46 |

Floors, pinned by `accentTokens.test.ts`: accent and deep ≥ 4.5:1 on `--bg`,
`--sidebar`, `--panel`; white on every bubble ≥ 4.5:1 (now ≥ 5.5:1); dark
bubbles darker than their accent.

The phone keeps its own accent table in `ios/Argmax/Sources/Design/Theme.swift`
and re-derives from its ground, so it is not a mirror of these values.
