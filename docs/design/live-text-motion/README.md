# Live text motion — mockups

The iPhone transcript marks live work with `WorkingNest` in front of two lines:
the thinking cue (`TranscriptThinkingLabel`) and a running tool fold's headline
(`TranscriptFoldLabel` in `TranscriptRows.swift`). These frames drop the nest and
move the text itself instead.

```bash
npx vite --port 5251 --strictPort            # from the repo root
open http://localhost:5251/docs/design/live-text-motion/index.html
```

iPhone `Theme.swift` colours and Geist; `?theme=light`, `?accent=purple`,
`?only=A`. Each phone loops one turn: a fold whose headline changes three times
(the last wraps to two lines and crossfades mid-pass), then the fold settles and
the thinking cue takes the gap. A held "Triangulating 12s" sits below.

All options run the same renderer — a per-glyph Gaussian in reading order, clocked
off absolute time — with different numbers, which is how the SwiftUI port would
work (`TextRenderer`, iOS 18).

- **Shipped** — the nest, still text.
- **A · Reading wave** — σ 1.5em, 6.5em/s, 0.7s rest, peak ink + 30% accent,
  running base a quarter step toward muted-strong. Advisor pick.
- **B · Ink wave** — A without the accent.
- **C · Slow light** — σ 3em, 4em/s, no rest.
- **D · Lift** — A plus a 1pt rise on lit glyphs.
- **Reduce Motion** — no travel; the line breathes muted ↔ muted-strong over 2.6s.

Elapsed seconds and tool icons stay still in every option.

## Decision

**A+**, in `ios/Argmax/Sources/Design/ReadingWave.swift`: σ 1.1em, 11.05em/s (the page's 1.7×),
0.7s pause, peak ink + 40% accent in dark. Light mode needs its own numbers — a
dark band on a mid-grey line barely registers on paper — so it rests the line
45% from muted toward the ground and keeps the peak at ink + 10% accent.
