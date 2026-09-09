# Plan — the agent todo list surface

Render the agent's own plan in the transcript, for every provider that can
publish one. Design is settled: `docs/design/todo-list/README.md`, variant
**A · Checklist**. This document is the architecture and the sequence.

## Verdict

**Normalize per call in Rust with no list memory; fold the event sequence in
the renderer.**

Rust turns each provider's todo payload into one canonical `todo.updated`
event. It never accumulates a list. The renderer folds the persisted sequence
into the card.

### Why not fold in Rust

`ProviderEventFlushQueue` (`flush_queue.rs:130`) holds `NormalizerSessionContext`
in an in-memory `HashMap`, and `initialize_session` seeds a fresh one per
**provider invocation** — not per session. A Rust-side list would therefore
reset on every follow-up turn, not merely on app restart, and Grok's
`merge:true` deltas would fold into an empty list on the second turn of every
session. Recovering means reading the last persisted snapshot back into Rust on
every relaunch, which is exactly the plumbing this choice avoids.

### Why not parse in the renderer

`AGENTS.md`: *provider protocol output is not chat*. Five payload shapes, four
of them Cursor's, must not reach `sessionConversationModel.ts`. Session sync
replays imported transcripts through the same normalizer
(`sync/claude.rs:11`), so one emitter serves live launches, `exec resume`, and
imported sessions; a renderer parser would serve only the first. The mobile
remote renders the same persisted rows and would need the parser duplicated.

## The canonical event

Type string `todo.updated` — `noun.past-verb`, matching `command.completed` and
`approval.requested`. Not `plan.*`: `CONTEXT.md:144` already binds "plan card"
to Claude's ExitPlanMode. Not `task.*`: collides with subagent Task and
scheduled tasks.

```jsonc
{
  "mode": "snapshot" | "merge",
  "items": [{ "id": string | null, "text": string | null, "status": Status }],
  "toolUseId": string | null   // the command.started this came from
}
```

`Status` is `pending | active | done | cancelled | removed`, fully resolved by
the normalizer. The renderer's fold is provider-blind.

Three rules the emitters must hold:

1. **No list in the payload means no event.** Never
   `{mode:"snapshot", items:[]}`. This is what stops Cursor's stripped
   `updateTodos` from wiping a live list.
2. **`merge` carries only what changed.** An item with `text: null` is a status
   change against an id the fold already knows.
3. **One event per provider call**, deduped on the provider's own item id so
   Codex's `item.started` + `item.updated` pair does not emit twice.

Measured caveat: across 400+ real status values in the local database, only
`pending`, `in_progress` and `completed` (and Cursor's `TODO_STATUS_*` spelling)
have ever appeared. `cancelled` exists in Cursor's proto enum and `removed`
maps Claude's `deleted`; both stay in the model, and neither earns UI beyond
what A already draws.

## Kill name-based identity

This is the change that keeps the surface alive in six months, and it is worth
more than anything else here.

Tool identity is currently decided by name in three places:
`HIDDEN_TOOL_NAMES` (`toolCalls.ts:223`), the edit-bucket regex
(`toolCalls.ts:264`), and — once this ships — the Rust emitters. Claude already
renamed `TodoWrite` to `TaskCreate`/`TaskUpdate` once this year, and Cursor's
name is *model-dependent*: `composer-2.5` emitted three different names across
two days (`updateTodos`, `todo_write`, `todowrite`) while
`gemini-3.8-flash-medium` emitted `updateTodosToolCall`. The next rename
silently yields a stale card, an unlabelled "other" row, and an inflated
"Edited files" count, with no test failing.

**Fix at the source.** When a normalizer recognises a todo tool it stamps the
`command.started` payload with `"surface": "todo"`. The renderer then hides and
buckets on that marker:

- delete `taskcreate`, `taskupdate`, `todowrite` from `HIDDEN_TOOL_NAMES`
- exclude `surface === "todo"` rows from `summarizeFileChanges` and the fine
  bucket, which also fixes the Grok edit-count bug on the same line
- suppress the raw rows via `hiddenToolIds`, the mechanism
  `turnInteractiveCards.ts` already uses for ExitPlanMode and AskUserQuestion

One recognition list, in Rust, tested with real captured fixtures per provider.
Inside each emitter, match on **payload shape** rather than tool name wherever
the name is unstable — that is what absorbs Cursor's drift.

## Per-provider emitters

| Provider | Source | Emits |
| --- | --- | --- |
| Codex | `todo_list` item, `item.started` + `item.updated` | `snapshot`. Derive `active` = first incomplete item. |
| OpenCode | `todowrite` args | `snapshot`, no ids |
| Grok | `todo_write`, `merge` flag | `snapshot` or `merge` as flagged |
| Cursor | `updateTodosToolCall`, `todo_write`, `todowrite` | as shaped; `updateTodos` emits nothing |
| Claude | `TaskCreate` result + `TaskUpdate` args | `merge` |

**Codex needs a launch flag first**, and on the transport Argmax actually
uses. `codex exec` does not expose `update_plan` unless launched with
`-c tools.update_plan.enabled=true` — a live probe on CLI 0.153.4 had the model
reply *"The requested `update_plan` tool is not available in this session."*

But Argmax does not launch Codex through `exec`: `runtime.rs:289` routes every
Codex turn to `codex_app_server::launch_turn`, and `codex app-server` takes the
same `-c` flag. The exec argv keeps the flag too, so the two paths cannot drift.

**On the app-server, Codex's active state is not derived.** The exec JSON
flattens the plan to `{text, completed}`, but the app-server sends
`turn/plan/updated` with `{plan: [{step, status}]}` where status is
`pending | inProgress | completed` — the running step, named. The translation in
`codex_app_server.rs` reshapes that into the `todo_list` item the normalizer
reads, so both transports land on one emitter. The exec path still derives
"first incomplete", with the assumption commented: Codex's prompt asks for
in-order completion, it does not enforce it.

`EventTranslation` carried no `item/updated` case at all, so a plan revision
would have been dropped before reaching the normalizer even with the flag on.
The flag alone was not enough — the live rung is what caught that.

**Claude's id lives in prose.** `TaskCreate` returns
`` `Task #${r.id} created successfully: ${r.subject}` `` — the literal template,
read out of the CLI binary — and `TaskUpdate` addresses that id. Hold a
`pending_task_creates: HashMap<tool_use_id, subject>` in the normalizer context
and resolve at `tool_result` time; the two lines are milliseconds apart in the
same invocation, so per-invocation memory is sufficient. On a parse miss, emit
the item keyed by `tool_use_id` with a `tracing::warn!` naming the unparsed
text — the card still shows the task, later updates arrive as id-only rows (the
fold already renders those for Grok), and the regression is visible in the
transcript within one turn instead of invisible for two months the way the
Codex flag was. Pin the literal with a unit test over a captured line,
commented with the CLI version. No legacy `TodoWrite` path is needed: the
database holds zero Claude-provider `TodoWrite` rows.

**Cursor is served opportunistically and not promised.** Three of its four
names carry data and get emitters; `updateTodos` arrives as
`args: {"_toolName":"updateTodos"}` on both started and completed and emits
nothing under rule 1. No per-provider kill switch — the no-list-no-event rule
already produces the right behaviour, and a switch would be a second thing to
keep true. Record the gap in `docs/chat-cards.md`.

## Renderer

- `canonicalTimeline.ts` — decode `todo.updated` as `kind: "todo"`, alongside
  the existing eight kinds.
- New `todoList.ts` — the fold. Session-scoped, in event order: `snapshot`
  replaces, `merge` patches by id, unknown id appends. Returns the list plus
  the `createdAt` of the last event folded in.
- `turnInteractiveCards.ts` — collect per turn beside `collectExitPlanState`,
  add the raw rows to `hiddenToolIds`. A turn containing todo activity renders
  the state as of its last todo event, so scrolling back shows the plan as it
  stood then; the live turn shows current state.
- `TodoCard.tsx` + `todo-card.css` — variant A, ported from
  `docs/design/todo-list/index.html`. Marks land on the tool row's chevron
  column (`--td-lead: 12px`, `--space-1_5` gap); active row carries
  `WorkingNest`; expanded while the turn runs, collapsed to one line when it
  ends.

## Sequence

1. **Codex reaches the transcript.** Add the `-c` flag; route `todo_list` in
   `is_tool_like_item` to the new emitter. Rewrite
   `codex_todo_list_item_does_not_become_command_event` to assert it becomes
   `todo.updated` — the test currently pins the opposite behaviour, so its name
   must change with its assertion or the intent is lost.
2. **The other four emitters** plus the `surface: "todo"` stamp, each with a
   captured-payload fixture.
3. **Renderer decode and fold**, with unit tests for the fold: snapshot after
   merge, merge before any snapshot (id-only rows — correct, not a bug), a
   Cursor empty payload arriving mid-list.
4. **TodoCard**, hidden-row suppression, `HIDDEN_TOOL_NAMES` removal, bucket
   exclusion.
5. **Docs** — `docs/chat-cards.md`, `docs/providers.md`, `CONTEXT.md` if
   "todo list" earns a glossary line, and the Decision section of
   `docs/design/todo-list/README.md`.

Ships independently, first, in its own commit: the edit-bucket regex fix at
`toolCalls.ts:264`. It is a one-line correctness fix and should not wait behind
a feature.

## Risks

- `src-tauri/src/providers/adapters.rs` currently carries foreign edits in the
  working tree. Stage only the argv hunk.
- Turning on `update_plan` changes Codex's behaviour, not just its output — it
  will now spend tokens planning. Acceptable, and it is the upstream default
  outside `exec`.
- The fold is session-scoped while Codex's `item_1` is thread-scoped. A new
  `item.started` after a previous list means a new plan; treat it as a snapshot
  that replaces, which is what rule 1 already gives.
