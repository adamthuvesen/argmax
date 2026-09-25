# Chat prose rhythm — mockups

An agent answer with headings, bold lead-ins and bullets read as one flat
river: heading, bold and body sat within one size step and 150 weight units of
each other, and the paragraph gap (15px under a 1.74 leading) was barely wider
than the gap between two lines inside a paragraph.

```bash
open docs/design/prose-rhythm/index.html
```

One real answer, driven entirely by CSS variables. Preset chips load a setting,
the sliders tune every variable live (body size, leading, weight, tracking,
paragraph gap, lead-in gap, measure, bold weight, heading size, weight,
tracking, space above and below, bullet leading and gap), and "Copy as CSS"
emits the values mapped to the real `.markdown` selectors. Light / Dark uses
the app's own prose inks. It loads Geist from Google Fonts, so it needs a
network; nothing else is fetched.

- **Current** — what shipped before, scaled to a 15px body.
- **C · 20px** — the ladder the rest vary: body 380, bold 620, heading 20px at 660.
- **C1 · 18px** — same ladder, heading two points smaller.
- **C2 · 17px heavy** — heading at 690, size does less and weight more.
- **C3 · 18px, softer bold** — bold eased to 590, body leading 1.65.
- **C4 · 17px, accent rule** — modest heading with a short accent rule above.
- **C5 · 16.5px, tight bullets** — smallest heading at 700, bullets at 5px.

## Decision

**C3.** Shipped 2026-09-25 in `chat-conversation.css` and `tokens.css`:
body 1.65 leading at 380 (dark) / 400 (light), paragraphs `1.2em` apart,
lead-in `0.4em`, `strong` at 590, `h3` at `--text-md-plus` and 660 with
`1.4em 0 0.45em` margins, `h2`/`h1` one token each above it, `li` at 1.58
with 7px between rows. A 20px heading on a 15px body started to feel like a
document rather than a reply, and a list of five 620 lead-ins turned into a
column of shouting; 18px and 590 keep the headings the loudest thing on the
page. The phone mirrors it in `TranscriptMarkdown.swift` (its own mockup is P1 in
`phone.html`): `h3` → `title3`, headings in the bold cut, `**bold**` in
semibold, two list rows 7pt apart and every other pair of blocks 13pt.
