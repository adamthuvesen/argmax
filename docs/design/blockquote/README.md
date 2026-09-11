# Blockquote in agent prose — mockups

Agents reach for `>` constantly, and almost never to quote a person: it is
"here is the sentence I propose", "here is what the file says now", "here is
what you wrote". The shipped rendering was a filled accent slab with a 3px
accent rule and the text dimmed to `--text-soft`. Three things wrong with it,
and fixing one does not fix the others:

- **It reads as a success callout.** Green fill plus green rule beside green
  code ink is three coats of the accent on one paragraph. The chat's other
  accented block is the *live* QuestionCard, whose accent rule means "waiting
  on you"; a quote borrowing it borrows the signal.
- **It dims the payload.** The quoted sentence is the point of the paragraph
  around it. `--text-soft` on the quote and `--prose-ink` on the lead-in gets
  the hierarchy backwards.
- **It is the only filled prose block.** Paragraphs, lists and headings all sit
  bare on the page; `pre` is filled because code is not prose. A quote is
  prose, so a fill puts it in the wrong family.

```bash
npx vite --port 5243 --strictPort            # from the repo root
open http://localhost:5243/docs/design/blockquote/index.html
```

It loads the real `tokens.css`, the real `chat-conversation.css`, and the Geist
faces the app bundles. Every sample is a `.chat-bubble.assistant > .markdown`
exactly as the transcript renders one; a candidate only overrides
`.markdown blockquote` under its own `[data-variant]`.

Header controls: theme, app font size, accent, and the variant sections 2 and 3
show. `←` / `→` swap the variant in place. Query parameters do the same for
capture: `?theme=light&variant=c`, `?only=1|2|3` renders one section alone.

- **1 · Side by side** — the passage from the report, shipped plus four
  candidates. `side-by-side-dark.png`, `side-by-side-light.png`.
- **2 · Edge cases** — a quote holding a list and code, a one-liner, two
  paragraphs, a nested quote, a quote after a heading. `edge-*.png`.
- **3 · Flicker compare** — one block, arrow keys swap in place.
  `passage-*.png`.

## The candidates

All four keep the quoted text on `--prose-ink` and the shared 18px not-prose
gap. They differ only in what is drawn beside the text.

| | Drawn | Lineage |
| --- | --- | --- |
| **A · Hairline** | 2px `--line-strong` rule as a `::before`, inset `0.3em` top and bottom so it spans the text rather than the padding box; 16px indent | The answered QuestionCard (`.question-ask.is-answered`), Notion, GitHub, Claude.ai |
| **B · Specimen** | `--tool-block-surface`, 1px `--line`, `--radius-md`, no rule; nested level drops the fill for a 1px line | `pre` |
| **C · Margin mark** | A hanging `“` at 1.85em `--muted`, 22px indent, nothing else | Editorial pull-quote |
| **D · Thread** | A's rule, coloured `color-mix(in oklab, var(--accent) 55%, var(--line-strong))` | Today, minus the fill |

## Decision

**A · Hairline.** It is the app's own vocabulary: a settled question in the
scrollback already draws exactly this rule, so a quote and an answered question
read as two beats of the same conversation. It survives every edge case
without a special case — a list inside it keeps its bullets, a one-word quote
stays a line rather than becoming a card, a nested quote is the same rule one
step in — and in light mode it is the only candidate that does not darken the
paper.

Why not the others:

- **B** turns "Ship it." into a card, and three proposals in a row become
  three cards stacked on the page. It also makes a quote of prose look like a
  quote of code, which is the one thing a quote of prose is not.
- **C** is the most beautiful at rest and the strongest alternative. It loses
  on two counts: the glyph competes with list bullets the moment a quote holds
  a list, and it asserts *quotation* — a speaker — where the agent usually
  means *verbatim text*. Keep it in mind if the transcript ever grows a
  "quote the user" affordance that wants a distinct mark.
- **D** keeps a whisper of the accent for no reason a reader can name. Once
  the fill is gone, the sage on the rule is decoration.

Shipped as `.markdown blockquote` in `chat-conversation.css`. Section 1's
"Shipped" column is the regression view: after the change it should match
column A.
