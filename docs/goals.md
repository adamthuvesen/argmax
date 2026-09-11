# Goals

A Goal is one free-text condition a chat keeps working toward. After every turn
a cheap one-shot evaluator reads the transcript and returns one of three
verdicts: met, not yet met, or impossible. "Not yet met" starts another turn
with the evaluator's reason as guidance. The Goal ends when the condition is
met, when the evaluator judges it unreachable, or when it exhausts its turn
budget.

That is the whole feature. There is no form: the condition is the
configuration.

## Using one

```
/goal every test in test/auth passes and lint is clean
/goal clear
```

`/goal <condition>` works in both the new-chat composer and an existing chat.
Select Goal from the `/` menu, write the condition, and submit. This sets the
Goal and starts its first turn immediately. In a new chat, the Goal is attached
before the first turn starts. `/goal clear` ends one early. `stop`, `off`,
`reset`, `none`, and `cancel` are accepted aliases. Clearing requires an existing
chat. One Goal per chat, enforced by a partial unique index on
`goals(session_id) WHERE state = 'active'` rather than by service code. Setting a new one replaces the old.

An agent can set a Goal for itself through the `argmax` MCP server's `goal_set`
and `goal_clear` tools, so "keep going until the suite is green" in prose lands
the same way the command does. See [agent-tools.md](agent-tools.md).

Setting a Goal only starts an opening turn when the chat is idle. A Goal set
from inside a running turn — which every agent `goal_set` is — gets none: that
turn is already the Goal's first turn, and an opening prompt would queue behind
it as a follow-up telling the agent to begin work it is already doing. The
driver evaluates the turn when it settles, exactly as it does for a Goal
attached at launch.

A Goal turn never joins the chat's follow-up queue. A turn can start between
the settle the driver judged and its send — the user types, or a queued
follow-up drains — and the send is refused (`SESSION_TURN_IN_FLIGHT`) rather
than queued. The driver treats that as ordinary and judges the turn that
overtook it when *it* settles. Queueing instead would leave the Goal's guidance
in the composer looking hand-typed, and put another copy behind it every time
round the loop.

Other chats may share the same checkout, branch, or worktree while a Goal is
active. Overlap is the user's to coordinate.

A compact Goal bar sits above the composer, using the same surface as queued
follow-ups. It shows the condition and a clear button, with no turn counter.
Click the condition to expand its full text. Expanded text scrolls within a
height cap of 150 px or 25% of the viewport, whichever is smaller. A settled
Goal stays there until dismissed so its outcome remains visible.

Settings → Agents → Conversation turns Goals off entirely and sets the turn
budget (5–50, default 20).

## Writing a condition

The evaluator judges the condition against what the agent surfaced in the
conversation. It runs no commands and reads no files, so the condition has to
be something the agent's own output can demonstrate. "Every test in `test/auth`
passes" works because the agent runs the tests and the result lands in the
transcript.

A condition that holds up over many turns names one measurable end state and
how the agent should prove it.

## How it ends

The driver ([service.rs](../src-tauri/src/goals/service.rs)) owns continuation.
It waits for the session to settle, evaluates, and either sends the next turn or
settles the Goal. Three things stop it besides a verdict:

- **The turn budget.** Every evaluated turn counts. At the cap the Goal settles
  `stopped` and hands control back.
- **No progress.** Three consecutive turns with no tool calls settle the Goal
  rather than letting the agent talk to the evaluator in a loop.
- **`/goal clear`**, or the Clear button on the strip.

An evaluator that fails — CLI missing, timeout, junk output — is treated as "not
yet met" with no reason and does *not* end the Goal. A transient failure ending
someone's Goal would be a worse outcome than one wasted turn.

## Why it is not deterministic

An earlier version ran ordered work steps, each with its own provider and model,
gated on a required shell-check phase, and asked an isolated reviewer process
for a structured report carrying a nonce and a candidate snapshot, with bounded
repair rounds and an attempt ledger. It was ~3,200 lines and configured through
a form nobody wanted to fill in.

Claude Code's `/goal` and Codex's goal mode both settle for a condition plus a
verdict, and they are right to: the value is in a *fresh* model judging
completion, not in the app scripting the work. Argmax runs the evaluator itself
rather than delegating to each provider's native goal, because only two of the
five CLIs have one and we want the same behaviour across all of them.

The evaluator is a one-shot call in
[one_shot.rs](../src-tauri/src/providers/one_shot.rs), which already runs
locked-down provider calls in a neutral temp dir with tools, MCP, and config
loading disabled. That containment is the reason the evaluator lives there:
it cannot touch the workspace it is judging.

## Persistence and IPC

Migration 42 creates `goals`. A row holds the condition, state, evaluated turn
count, turn budget, and the evaluator's last reason.

Desktop and remote clients share `goal:set`, `goal:get`, `goal:list`, and
`goal:clear`. The renderer consumes generated types through `window.argmax.goals`.
New chats pass `goalCondition` and `goalMaxTurns` to `providers:launch`, which
persists the Goal with the session before starting the first turn.

Checkpoints, which the Goal strip sits beside, are documented in
[workspaces.md](workspaces.md).
