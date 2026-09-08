# Dark-mode prose ink — mockups

The dark theme's prose ink reads a touch too bright, most of all on bold. This
page puts every candidate level next to the current one so the choice is made by
looking, not by arguing about hex codes.

```bash
python3 -m http.server 8123 --bind 127.0.0.1   # from the repo root
open http://127.0.0.1:8123/docs/design/prose-ink/index.html
```

It loads the real `tokens.css`, the real `chat-conversation.css`, and the real
Geist Sans faces the app bundles. Nothing is re-implemented; each block only
overrides `--prose-ink` and `--prose-ink-strong`.

- **Shipped** — no override; reads the live `tokens.css` and reports the painted
  colour and resolved weight back. The regression view.
- **A · Side by side** — every level in one grid. `a-side-by-side.png`.
- **B · Flicker compare** — one block, ← / → to swap levels in place. The only
  reliable way to judge a two-percent lightness move.
- **C · At length** — full column and real measure. A level that looks fine in a
  card can read grey over a long answer.
- **D · Weight, not ink** — `d-weight.png`, `d-weight-medium.png`.

## Decision

**03 Half step, with `strong` at 500.** Shipped in `tokens.css`
(`--prose-ink: #ebe9e4`, `--prose-ink-strong: #f5f3ed`) and
`chat-conversation.css` (`.markdown strong { font-weight: 500 }`). The ladder is
pinned by `accentTokens.test.ts`.

## The levels

Ink pairs are OKLCH at C 0.008 / H 90 — the warm cast the charcoal theme already
carries — except the two neutrals, which drop to C 0.001.

| | body | bold | L (body / bold) |
| --- | --- | --- | --- |
| 00 Pure white | `#ffffff` | `#ffffff` | 100 / 100 |
| 01 Current | `#f1efe9` | `#fbf9f5` | 95.2 / 98.3 |
| 02 Bold eased | `#f1efe9` | `#f5f3ed` | 95.2 / 96.5 |
| 03 Half step | `#ebe9e4` | `#f5f3ed` | 93.5 / 96.5 |
| 04 One step | `#e6e4df` | `#f0eee9` | 92.0 / 95.0 |
| 05 Two steps | `#e0ded8` | `#eae8e2` | 90.0 / 93.0 |
| 06 Three steps | `#d9d7d2` | `#e3e1db` | 88.0 / 91.0 |
| 07 Four steps | `#d1cfca` | `#dbd9d3` | 85.5 / 88.5 |
| 08 Grey | `#c9c7c2` | `#d3d1cb` | 83.0 / 86.0 |
| 09 Neutral mid | `#dededd` | `#e8e8e7` | 90.0 / 93.0, C 0.001 |
| 10 Neutral low | `#cfcfce` | `#d9d9d8` | 85.5 / 88.5, C 0.001 |
| 11 Flat ladder | `#e6e4df` | `#e9e7e2` | 92.0 / 92.8 |

## The weight finding

`.markdown strong` asks for `font-weight: 520`, and the app bundles Geist Sans
400 / 500 / 700 only. CSS resolves a request above 500 upward, so bold prose
renders **Geist 700**, not the medium the number suggests. Headings ask 570–600
and land on 700 as well, which is why bold and headings are the same face today.
Measured in the page, at 40px: 400 → 485.8px, 500 → 496.1px, 520 / 600 / 700 →
516.6px.

So part of "too white" is "too heavy", and dropping `strong` to `500` renders a
real Geist Medium with no new font in the bundle. Section D holds the ink still
and moves only the weight, so the two effects can be judged apart.
