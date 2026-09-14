# Phone activity group, opened — mockups

Opening a folded activity group in the phone transcript (`MobileTranscriptRowView`
in `MobileTranscriptRows.swift`, rows in `TranscriptRows.swift`) reads rough:
every command is a filled card, the card prints the `/bin/zsh -lc` wrapper at
ink weight across two or three lines, "Thought process" rows alternate with the
cards at the same 44pt height, narration inside the fold sits at answer size,
and an opened command shows `Input` as one clipped line of JSON. The desktop
settled this surface as text, not chrome (`docs/chat-cards.md`, "Activity
Rows"); the phone diverged.

```bash
npx vite --port 5243 --strictPort            # from the repo root
open http://127.0.0.1:5243/docs/design/phone-activity-group/index.html
```

Real `tokens.css` and Geist faces; `?theme=light`, `?only=B` as usual. One turn
from a real chat in every frame: narration, five commands, one edit, four
thoughts, the answer, with the `sed` command opened.

## The frames

- **Shipped** — a reproduction of today's row, for the side-by-side.
- **A · Ledger** — the desktop grammar ported: `icon · verb · target` on one
  36pt line, verb in muted-strong, target in muted (mono one step down for a
  command, wrapper stripped), stat with the file. No fills, no chevrons. A
  thought is a ledger row titled by its own first line. Narration inside the
  fold drops to 15pt muted-strong. An opened row grows one block: payload, then
  a footer with lines, time, and Show all.
- **B · Timeline** — steps on a rail with a dot per step, coloured by the kind
  of work, a headline and a second line for the command or files, elapsed time
  on the right. An opened thought shows its reasoning in place at 13pt.
- **C · Story, inspector as a sheet** — the transcript stays prose. The work
  between two pieces of narration folds to one quiet line with counts and
  elapsed time; tapping it opens a bottom sheet holding the ledger.

## Captures

`all-dark.png` is the sheet; `shipped-`, `a-ledger-`, `b-timeline-`,
`c-story-dark.png` are one frame each at 2x.

## Decision

**A · Ledger**, ported 2026-09-12 into `TranscriptRows.swift`
(`TranscriptActivityRow`, `TranscriptToolRow`, the compact `TranscriptThoughtRow`),
`MobileTranscriptRows.swift` (the rail and `TranscriptDisclosureStyle`'s
chevron-less rows), `TranscriptMarkdown.swift` (the `foldedNarration` tone) and
`TranscriptProjection.unwrapShellCommand`. Narration in a fold at 15pt
muted-strong, commands at 12pt mono. Not drawn: per-file `+n −n` stats, which
the phone's tool model does not carry.
