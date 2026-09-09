# Agent todo list — mockups

Every provider Argmax drives can publish a plan, and Argmax shows none of them.
Claude writes `TaskCreate` / `TaskUpdate`, Codex emits a `todo_list` item,
OpenCode `todowrite`, Grok `todo_write`, Cursor `updateTodosToolCall` — and the
agent's own account of what it is doing and how far along it is never reaches
the transcript. This page puts four answers next to each other in the real chat
surface so the choice is made by looking.

```bash
npx vite --port 5242 --strictPort            # from the repo root
open http://localhost:5242/docs/design/todo-list/index.html
```

It loads the real `tokens.css`, `chat-turns.css`, `working-nest.css`,
`motion.css` and the Geist faces the app bundles. Surrounding tool rows and
bubbles use the app's own class names, so each candidate is judged against the
register it would actually live in. The candidates use private `.td-*` classes
so the cascade cannot leak either way.

Header controls: theme, app font size, accent, and list length (5 items / 12
items / wrapping labels). Query parameters do the same for capture —
`?theme=light&size=6&len=wrap`, `?only=<section>` renders one section alone, and
`?frame=a|b|c|d` renders section 4 with a single candidate.

## What is wrong today

Not "the surface is plain" — there is no surface. Three separate reasons, and
fixing one does not fix the others:

| | Where | What happens |
| --- | --- | --- |
| Claude | `toolCalls.ts:223` | `taskcreate` and `taskupdate` are in `HIDDEN_TOOL_NAMES`, so both rows are filtered out of the timeline. The task id exists only inside the result string `Task #5 created successfully: <subject>` — nothing else carries it. |
| Codex | `adapters.rs:177` **and** `normalizer/codex.rs:354` | Two blockers, upstream first: `codex exec` does not expose `update_plan` at all unless launched with `-c tools.update_plan.enabled=true`, so Codex emits nothing to drop. With the flag on it emits `todo_list` as `item.started` + `item.updated`; those are then dropped by the normalizer, which has a test pinning the behaviour (`codex_todo_list_item_does_not_become_command_event`). |
| OpenCode / Grok / Cursor | — | The payloads *are* persisted, and then `todowrite` is hidden too. Cursor's `updateTodosToolCall` survives as an unlabelled "other" row. |

There is also an independent bug the same investigation turned up: only
`todowrite` was in `HIDDEN_TOOL_NAMES`, so Grok's `todo_write` — with the
underscore — stayed visible, and it matches the edit-bucket regex at
`toolCalls.ts:264` (`/write|edit|create|patch|replace|…/`). A turn whose only
"edit" was todo bookkeeping therefore read *"Edited a file"*. The `+N −N` stat
was never affected: `interpretFileChange` returns null for these payloads, so
only the rolled-up headline was wrong. Grok has 69 such rows locally.

Claude Code headless is also not the interactive CLI: `TodoWrite` is absent from
the init `tools` array even with `--allowedTools TodoWrite`. Any implementation
has to read `TaskCreate` / `TaskUpdate`, not `TodoWrite`.

## The shared base

All four candidates agree on the parts that carry meaning, and differ only in
how much furniture they wrap around it:

- **One lead column, on the transcript's own grid.** `--td-lead: 12px` with a
  `--space-1_5` gap is exactly the tool row's chevron column and gap, so a
  plan item's mark lands where every disclosure chevron lands and its label
  lands on the verb column. The list reads as more transcript, not as a widget
  dropped into it.
- **Four marks, four states.** A `--sage` check for done, a hollow 7px ring
  drawn in CSS for pending, a strikethrough plus × for cancelled, and — for the
  one active item — the app's own **WorkingNest**, at 12px. Not a second
  spinner invented for this surface.
- **A three-step ink ladder**, which is what makes the list scannable at a
  glance: done recedes to `--muted`, pending waits at `--text-soft`, active
  leads at full `--text` and weight 500.
- **One card that updates in place**, never one card per `TaskUpdate` — a
  six-step plan would otherwise leave fourteen cards in the scrollback.
- **Baseline-aligned marks**, so a wrapping label keeps its mark beside the
  first line rather than centred across two.

## The variants

- **A · Checklist** — no shell at all. Just the eyebrow (`Plan · 2 of 5`) and
  the rows, sitting in the transcript the way tool rows do. This is the reading
  `docs/styling.md` argues for with QuestionCard: a plan in progress is a beat
  in the conversation, not a document.
- **B · Spine** — A plus one continuous 1px rule behind the lead column, with
  the finished fraction painted over it in sage. The spine *is* the progress
  meter, so there is no separate bar. Measured from the last finished mark at
  render time rather than assumed, because rows wrap and no fraction of the
  list's height is the right answer.
- **C · Slab** — PlanCard's grammar: `--panel` fill, `--radius-2xl`, hairline,
  header rule, and a small meter in the header. A document in the scrollback.
- **D · Marquee** — one collapsed line carrying the count and the current step,
  expanding on click. The smallest possible footprint.

Section 5 is not a fifth candidate but a different answer to the same question:
pin the strip **outside** the scrollback, above the composer, the way
QuestionDock takes the composer's slot. A turn that keeps working never scrolls
it away — at the cost of competing with the composer for the one place the eye
rests, and of having no history at all.

## Captures

Dark unless the name says otherwise, default font size, 5-item list.

- `mid-dark.png`, `mid-light.png` — section 1, all four mid-run between real
  tool rows. The load-bearing comparison.
- `settled-dark.png` — section 2, every item done. This is the state the list
  spends most of its life in, scrolled past and read once.
- `fresh-dark.png` — section 3, nothing started: no progress to report and no
  current step, so anything built around "3 of 6" or "now: …" holds up empty.
- `frame-a.png` … `frame-d.png` — section 4, one candidate inside a full turn
  with the prompt above it and real work below.
- `pinned-dark.png` — section 5, the strip above the composer.
- `lifecycle-dark.png` — section 6: published → working → collapsed on turn end.
- `edge-dark.png` — section 7: a cancelled item (Cursor's
  `TODO_STATUS_CANCELLED`), an item Grok referenced by id before ever sending
  its text (`Task 7`), and the twelve-item wall an always-expanded list becomes.
- `wrap-dark.png` — section 1 with labels long enough to wrap.

## Will A work for every provider?

Measured from the local database (every payload below is a real persisted call)
plus two live `codex exec` probes on CLI 0.153.4.

| Provider | Tool | Shape | Item text | Statuses | Stable id |
| --- | --- | --- | --- | --- | --- |
| Claude | `TaskCreate` / `TaskUpdate` | delta, one task per call | `subject` on create only | `pending` `in_progress` `completed` `deleted` | only inside the result string |
| Codex | `update_plan` → app-server `turn/plan/updated` | full snapshot | `step` | `pending` `inProgress` `completed` | yes (`turnId`) |
| OpenCode | `todowrite` | full snapshot every call | `content` | `pending` `in_progress` `completed` | none |
| Grok | `todo_write` | `merge:false` snapshot, `merge:true` delta | snapshots only — 33 of 69 calls carry none | `pending` `in_progress` `completed` | yes |
| Cursor | four different names | mixed | mixed | `TODO_STATUS_*` or plain | mixed |

The consequences for A, in order of how much work they are:

1. **A is fed by a reducer, not by a payload.** Three of five providers send
   deltas, so the card is per-session state folded from the event stream, not a
   projection of one tool call. That is the single structural decision.
2. **Codex needs a launch flag**, on the app-server rather than on `exec`.
   `runtime.rs:289` routes every Codex turn through `codex_app_server`, so the
   `exec` argv is not the live path; both now carry
   `-c tools.update_plan.enabled=true`. Without it the model is told the tool
   does not exist, which is the real reason nothing had been persisted since
   2026-07-01.
3. **Codex's active state is not derived after all.** The `exec` projection
   flattens the plan to `{text, completed}`, but the app-server's
   `turn/plan/updated` names the running step. Only the `exec` path falls back
   to "first incomplete".
4. **Grok and Cursor need id → text memory.** Their merge deltas carry a status
   and an id and no text. Lose the earlier snapshot and the row has no label,
   which is the `Task 7` case in `edge-dark.png`.
5. **Claude's task id is only in prose.** `TaskCreate` returns
   `Task #${id} created successfully: ${subject}` as its tool result, and
   `TaskUpdate` addresses that id. Reading it means parsing an undocumented
   result string — the one genuinely brittle dependency in the set.
6. **Cursor's ACP path carries nothing.** `updateTodos` arrives as
   `args: {"_toolName":"updateTodos"}` on both `started` and `completed` — the
   list is stripped before Argmax sees it. Cursor's other three names
   (`updateTodosToolCall`, `todo_write`, `todowrite`) do carry data, so Cursor
   works for some models and not others. This is the only case A cannot serve,
   and it is a Cursor-side gap, not a design one.
7. **Cancellation is Cursor-only.** `TODO_STATUS_CANCELLED` exists nowhere else;
   Claude's `deleted` means remove-from-list rather than struck through. The
   cancelled row in A is real but rare.

## Decision

**A · Checklist, expanded while the turn runs and collapsed to one line when it
ends** — D's headline as A's resting state rather than a fifth variant. Chosen
2026-09-08 and shipped as `TodoCard.tsx` + `todo-card.css`; the architecture is
in [docs/plan/todo-list-surface.md](../../plan/todo-list-surface.md) and the
provider matrix in [docs/chat-cards.md](../../chat-cards.md).

The case, from the captures: in `mid-dark.png` A is the only candidate that
reads as the agent talking rather than as a panel; C's slab is a 300px document
that stays in the scrollback forever, which `settled-dark.png` makes plain. B's
spine is the best idea on the page in the mid-run state and the worst in the
settled one — five checks strung on a green rope is more furniture than a
finished list needs, and in light mode the sage-over-line progress rule is
nearly indistinguishable from the plain rule. D alone hides the thing the user
wants while the turn is running.

If a shell is wanted after all, C is the one to take, not B: it is already the
app's PlanCard grammar and adds no new vocabulary.

Not in scope here: whether the raw `taskcreate` / `taskupdate` rows stay hidden
once the card exists (they should), and the `todo_write` edit-bucket bug, which
is a one-line fix worth doing on its own.
