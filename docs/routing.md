# Auto routing

Auto routing (the **Router** in the UI) picks a chat's provider, model and
effort from what the prompt asks for, instead of the user picking a model. A
classifier labels the prompt; a fixed grid in Rust turns the label into a
model. The renderer only shows the result. Intent and the measurements behind
the grid are in [plan/auto-model-routing.md](plan/auto-model-routing.md); this
doc describes what the code does.

Code: [routing/](../src-tauri/src/routing) (`mod.rs` launch, `table.rs` grid,
`jev.rs` classifier, `reroute.rs` follow-ups, `api_key.rs` key storage,
`cost.rs` Router cost), [turn_routes.rs](../src-tauri/src/persistence/turn_routes.rs),
and `route_follow_up` / `apply_auto_follow_up` in
[session_service.rs](../src-tauri/src/providers/session_service.rs).

## Tiers

Three picker entries, one per tier. The UI names and the stored values differ:

| UI | Stored `auto_tier` | Aims for |
|---|---|---|
| Router Frontier | `intelligence` | frontier models, deeper reasoning |
| Router Balance | `balanced` | the default Auto tier |
| Router Speed | `cost` | cheap and fast models |

A routed chat's chip reads `Balance → Opus 5.5` while the router drives it.
When the router moves the chat to another model or effort, the chip plays the
switch once ([useRouteSwitch.ts](../src/renderer/hooks/useRouteSwitch.ts)):
the words that changed roll, up for a stronger route and down for a lighter
one (judged by output price, else by effort, in
[routeSwitch.ts](../src/renderer/lib/routeSwitch.ts)). A stronger route also
flushes the pill and blooms one halo out of it, brighter at Extra High and
above, and the new effort lands in the accent before cooling. The
route's reason takes the empty composer's placeholder line for about four
seconds.
A chat opened within ten seconds of its launch plays the router's first pick
the same way, unfolding the model from the tier name, with the flush but no
halo. Reopening an older routed chat plays nothing. Design notes are in
[design/router-switch](design/router-switch/README.md).
Agents launch a routed chat through `session_launch` with `model: "auto"`
(Balance) or `"auto:cost" | "auto:balanced" | "auto:intelligence"`; an explicit
`reasoning` there still overrides the routed effort
([agent-tools.md](agent-tools.md)).

## Jev, the classifier

TypeSafe's Jev (`jev-latest` at `https://api.typesafe.ai/v1/systemone`) answers
typed questions about a text with calibrated probabilities. Argmax sends:

- for launches, the prompt capped at 8,000 characters
- for follow-ups, bounded conversation and invoked skill context, with the new
  request first, recent visible messages and routing decisions, and relevant
  skill instructions using provider and checkout precedence. Clear hides earlier
  context, subagent traces are excluded, and missing or clipped context is marked;
- a **kind** question (choice: coding, mechanical, research, review, question);
- a **difficulty** question (score 0 trivial – 4 very hard), folded to
  **Light** (≤ 1), **Standard** (2), **Heavy** (≥ 3);
- for follow-ups only, a **correction** question: the probability the user is
  unhappy with the previous work (failing, disliked, or to be redone)
- for follow-ups, the relationship to earlier tasks (continuation, independent
  new task, or bounded finishing step), its confidence, and whether the entire
  upcoming workflow clearly needs less capability.

The request has a 1.5 s connect and total timeout, no retries and no
redirects. A 401/403 is `ROUTING_KEY_INVALID`; any other failure is
`ROUTING_JEV_FAILED`, which the callers turn into a fallback, never a failed
launch.

Low confidence is settled before the grid (`settle` in `mod.rs`): kind
confidence below 0.5 is treated as **coding**, and difficulty confidence below
0.5 rounds difficulty **up** one level, but only when Jev's level probabilities
put at least half their weight on that higher level or above (moderate+ for
Light → Standard, hard+ for Standard → Heavy). Confidence alone swings across
0.5 between identical calls; a moderate/hard split of 0.48/0.41 stays Standard.
Without probabilities in the answer, an unsure difficulty always rounds up.

### The key

Auto routing is off until a Jev API key is saved in **Settings → Agents**.
Saving checks the format (16–512 characters of `[A-Za-z0-9._-]`), proves the
key with one live classification, and only then stores it. The key lives in
the macOS Keychain (service `Argmax Jev API key`, account `ARGMAX_DATA_DIR` or
`default`, so a dev profile never shares the installed app's key), written via
`security -i` on stdin so it never appears in an argv. It is cached in memory
after the first read. Without a key the picker hides the Router entries, an
Auto launch fails with `ROUTING_NOT_CONFIGURED`, and existing routed chats stop
re-routing.

## Launch

`route_launch` (renderer launches) and `session_launch` (agent launches) call
`resolve_route`: classify, settle, then look up the grid in
[table.rs](../src-tauri/src/routing/table.rs).

Tier × difficulty picks a column and an effort:

| Difficulty | Speed | Balance | Frontier |
|---|---|---|---|
| Light | Cheap · low | Cheap · medium | Value · medium |
| Standard | Cheap · medium | Value · medium | Frontier · high |
| Heavy | Value · medium | Value · high | Frontier · high |

Kind × column picks the model:

| Kind | Cheap | Value | Frontier |
|---|---|---|---|
| coding | Composer 2.5 | Opus 5.5 | Opus 5.5 |
| mechanical | Composer 2.5 | Composer 2.5 | Opus 5.5 |
| research | Composer 2.5 | Opus 5.5 | Opus 5.5 |
| review | Opus 5.5 · low | Opus 5.5 | GPT-6 Astra |
| question | Grok 4.7 | Opus 5.5 | Opus 5.5 |

Overrides on top of the grid:

- Frontier · Heavy sends **research to GPT-6 Astra** and **questions to Fable
  5.1**; coding stays on Opus 5.5.
- Mechanical work never runs above medium; the cheap review cell is Opus 5.5
  at low.
- Effort is clamped to what the model's CLI accepts (the `clampEffort` rule in
  [providerModels.ts](../src/shared/providerModels.ts)); Composer takes none.
- **A launch never runs above high.** xhigh and max are only reached by
  escalation.

If Jev fails, the tier's **fallback** is used and recorded with the reason
`unrouted: …`: Speed → Composer 2.5, Balance and Frontier → Opus 5.5 · medium.

**Fast is never used for a routed turn.** `route_launch` clears `fast_mode`,
and so does every follow-up the router still drives, including one it leaves
on its model.

## Follow-ups

The router reassesses the entire next task between turns. It uses a separate
same-provider policy in [table.rs](../src-tauri/src/routing/table.rs), so a
cross-provider launch preference cannot prevent adaptation within the existing
native conversation. Model capability is explicit policy, independent of price.

The router considers a follow-up only when the chat still has an `auto_tier`
and the send is headed for a relaunch. Steering does not reclassify the active
turn. Pending messages classify when dispatched. Goal turns keep their existing
policy. A missing key, unavailable context, or Jev failure retains the current
model and effort with a recorded reason.

The bounded classifier context includes invoked skills as task data. `/ship`,
`$ship`, and a request to use the ship skill include its workflow instructions
and bounded relevant direct references. Merely mentioning a skill does not
invoke it. Shipping with reviews, CI feedback, and unresolved repairs is judged
as the whole workflow. Multiple steps alone do not imply maximum effort.
`Continue`, `implement that`, and a return to earlier work inherit the relevant
task's complexity. Labeled recent routes let Jev match a resumed task to its
earlier model and effort, including an escalated effort above high. Restoration
requires scope and match confidence of at least 0.9 and stays on the same provider. Missing skill context blocks reductions, while ordinary
requests need no skill body.

Each classified follow-up ends in one decision:

- `escalate`: correction probability at least 0.85 moves one rung up the existing
  ladder. At the top, the route is kept.
- `reroute` upward: kind and difficulty confidence at least 0.7 justify increased
  capability, including a return to difficult work after a simple interlude.
  This bypasses the cooldown and economic test.
- `reroute` downward: complete relevant context plus kind, difficulty, scope,
  and simpler-task scores at least 0.9 are required. These are policy thresholds,
  not measured calibration of the new follow-up questions. Effort reduction on
  the current model is preferred. A five-minute anti-oscillation cooldown applies
  to continuing work, with a bypass for a confidently independent task or bounded
  finishing step.
- `kept`: insufficient evidence, an unsupported target, cooldown, or a model switch
  that cannot cover a possible cache rebuild. The reason names the limiting gate.

The provider targets are:

| Provider | Follow-up policy |
|---|---|
| Claude | Opus with supported low, medium, or high effort. Frontier heavy questions target Fable. A retained stronger model can reduce or restore effort in place. |
| Codex | Sol for lighter work, Astra for heavy substantive work and Frontier standard review or research. Effort can fall on the current model before considering a cheaper one. |
| Cursor | Composer for lighter work, Cursor Opus for review and more demanding work. Opus effort can fall in place. Model downgrades stay blocked while pricing is unavailable. |
| OpenCode | DeepSeek V4.1 Flash, clamped to the routing policy's high or max levels. A simpler task can step down from max to high. |
| Grok Build | Grok 4.7 at low. Higher efforts have no demonstrated quality benefit in the current routing evidence. A previous higher effort can step down. |

### Cache and economics

Same-model effort changes are supported task-sizing decisions. Their reasons
explicitly say the cache effect is unverified and make no savings claim. Claude
Code documents conditional effort-cache preservation, but Argmax does not yet
establish every endpoint, billing, and configuration precondition at runtime.
Codex's experimental effort override is not enabled by this routing change.
The native transport contracts and limits are in [providers.md](providers.md).

Model downgrades require positive estimated savings for the next turn sufficient
to pay for a full possible context rebuild. The estimate caps previous input and
output observations at 256 each for a finishing step, 1,000 input and 500 output
for Light work, and 4,000 input and 2,000 output otherwise. It credits at most one
context read and no later turns. These are conservative policy caps, not forecasts
validated by live measurements. Missing context size, pricing, or usable usage
observations cannot establish payback. Claude's rebuild estimate allows the
one-hour write rate.

Elapsed idle time never proves a switch is free. Cache retention depends on the
provider and serving path. A miss does not imply deletion, and switching back
may reuse a surviving prefix without guaranteeing it. The cooldown is a routing
policy, independent of retention. No automatic cross-provider downgrade occurs.

Deterministic tests cover policy and native adapter requests. They cannot prove
inference cache reuse. The live measurement matrix remains unchanged → effort
down → effort back and model A → B → A, recording cached and uncached inputs,
writes, latency, cost, process restart/resume, and compaction. No live matrix was
run for this implementation under the shared-checkout execution restriction.

### Escalation ladders

Rungs per provider, weakest first. A chat on a rung climbs to the next one; a
chat off the ladder goes to the first stronger rung. Position orders a ladder,
not price.

| Provider | Ladder |
|---|---|
| Claude | Opus 5.5 · medium → Opus 5.5 · high → Fable 5.1 · high → Fable 5.1 · xhigh |
| Codex | GPT-6 Sol · medium → Sol · high → GPT-6 Astra · high → Astra · xhigh |
| Cursor | Composer 2.5 → Claude Opus 5.5 (Cursor) · medium → · high |
| Grok | Grok 4.7 · low → **Opus 5.5 · high on Claude** |
| OpenCode | DeepSeek V4.1 Flash · high → · max → **Opus 5.5 · high on Claude** |

The last Grok and OpenCode rungs are the router's only automatic provider
switch: the send goes through the ordinary provider-switch path, which starts
Claude fresh with the visible transcript as context. Cursor climbs to Opus
inside the same Cursor conversation.

## User pins

A follow-up that names a different provider, model or effort than the chat's
current one is the user picking by hand. It ends Auto routing for that chat:
`sessions.auto_tier` and `auto_route` are cleared and the chip drops its tier.
The renderer sends no model override when its selection follows Auto. A
follow-up that names no model (an Auto composer send, an agent's message, or a
script) is not a pin, even if another window has changed the route meanwhile.

The pin also writes a `pinned` row to `turn_routes`. A `pinned` row closes the
chat's routing; it is not a turn and not a switch. It exists so the Router
cost card can end the last route's window there instead of charging every
later hand-picked turn to the tier.

## Goals

A Goal's own turns are not classified. In a chat the router drives, two "not
yet" verdicts in a row escalate it one rung up its ladder, recorded as an
`escalate` row with the reason `escalated: the goal came back not met twice in
a row`, and the next goal turn is sent on that rung (with Fast off). A pinned
chat, or one at the top of its ladder, is not escalated. See
[goals.md](goals.md).

## Persistence

Migration v56 added `sessions.auto_tier` (`cost` / `balanced` /
`intelligence`, NULL for a chat the router does not drive), `sessions.auto_route`
(the latest routing reason, shown on the chip) and the `turn_routes` table;
v57 widened `turn_routes.decision` to allow `pinned`.

`turn_routes` has one row per decision: `session_id`, `created_at`, `tier`,
`provider`, `model_id`, `reasoning_effort`, `kind`, `difficulty`, the two
confidences, `decision` (`launch`, `reroute`, `escalate`, `kept`, `fallback`,
`pinned`) and `reason`. Decisions, including `kept`, refresh the session's
`auto_tier` / `auto_route` so the chip explains retained routes too. A pin
clears those fields. Dashboard reads need no join. A
follow-up's row is written only once the send is admitted, so a send that Stop
cancelled leaves no route behind. Admission also checks the model, effort,
provider, tier, activity stamp, and native conversation ID against the
classification snapshot. A changed session retains its admitted route rather
than applying stale classification. Echoed Auto selections are removed before
queueing. The cooldown reads the latest `reroute` or
`escalate` row as the chat's last switch.

## Project check

Project check uses Jev for a second question: before a new chat starts from the
launcher, does the prompt belong in the project the launcher is aimed at?
Code: [project_check.rs](../src-tauri/src/routing/project_check.rs),
[project_checks.rs](../src-tauri/src/persistence/project_checks.rs),
[useProjectCheck.ts](../src/renderer/hooks/useProjectCheck.ts) and
[ProjectCheckDialog.tsx](../src/renderer/components/ProjectCheckDialog.tsx).

It runs for a local launch from the launcher and for an agent
`session_launch`, with a Jev key saved, Settings → Agents → Project check not
Off, and at least two projects. Side chats, cloud tasks, follow-ups,
multitask, routines, and the Arc coordinator's own launch are not checked. A
prompt under 12 characters, or one starting with `/`, has nothing to judge.

**The question.** One Jev Choice (`projects:check-prompt`) over up to ten
options: the current project and the ones the user started the most chats in
over the last 30 days (recency breaks ties), plus up to two more the prompt
names outright, plus a narrow `none` for trivia, creative writing or questions
about the agent itself. A broad "work that needs no codebase" `none` outbid
personal-ops projects (a notes vault, a work tracker) whose work is exactly
that. The request has its own 3 s timeout; the options are long.

Everything an option says is derived from that user's own checkouts and
history, so it works for anyone's projects, not a curated list. What is known
about a project is cached for ten minutes:

- its description: the opening prose of the README and of `AGENTS.md` /
  `CLAUDE.md`, skipping setup, install and contributing sections (≤ 420
  characters) — for a project with no history yet, most of what Jev reads;
- the top languages and top-level folders from `git ls-files`, and what a
  monorepo contains: the children of `applications/`, `apps/`, `services/`
  and `packages/`;
- the user's opening prompts there, newest first: Argmax's own chats (an
  Arc member's task counts, minus the Arc header) plus the first prompt of the
  newest 80 Claude Code transcripts filed under the project's checkout and
  worktrees, which reach back before Argmax. Left out: agents' launches
  outside an Arc, chats later moved to another project, Argmax's handoff and
  continuation text, slash commands, and duplicates.

Each check then builds the option text against the other options: the 16
newest prompts that name no other option (a notes vault that discusses
argmax is not evidence for argmax), and up to 20 topic words the project's
prompts use markedly more than the others' do.

Paths under Argmax's own data directory — pasted screenshots — are stripped
from the prompt and the history first; they said nothing about the project
and pulled every prompt toward argmax. A checkout of at most 20 files whose
name is another option's app (a pointer README saying the app now lives in a
monorepo) is dropped as an option, so it cannot split that app's weight.

**The decision.** With `p` the best other project's probability and `c` the
current project's. The prompt *names* a project when it says its name or the
name of one of its `applications/`, `apps/` or `services/` children as a whole
word, and *cites* it when it gives a path only that checkout has.

| Result | Rule |
|---|---|
| Switch | `p ≥ 0.90`, `c ≤ 0.05`, the prompt names or cites the project, mode is Suggest & switch, and the project was not picked by hand for this draft |
| Suggest | `p ≥ 0.50` and `c ≤ 0.10`; or the prompt names or cites the project, `p ≥ 0.35` and `c ≤ 0.10` |
| None | anything else, a Jev error, or no answer within 3.5 s of Enter |

The launcher starts the check after a 700 ms typing pause, so Enter usually
finds the answer waiting. A suggestion opens a dialog with the suggested
project preselected, the runner-up when Jev gave it ≥ 0.10, and the current
one; Enter starts in the selection and Back returns to the composer with the
draft. A switch launches in the suggested project with the composer's model
and workspace mode and shows an Undo toast for 8 s, which stops that chat,
archives its workspace and starts the same prompt in the original project.

**Agent launches.** `session_launch` asks the same question of the project it
would have started in, including when the caller passed `project` or `path`.
Passing either is the aim, not a hand pick, so it does not raise the bar. A
repository Argmax has never registered is not checked first: inserting it so
the question can name it would leave the row behind when the launch then
starts somewhere else, and the launch registers the repository it actually
starts in. There
is no dialog and no Undo. A switch happens only at the switch bar above. The
session is created in that project; `path` is kept only when it is already a
checkout there, and `branch` is not carried, so a ref from the other repository
cannot fail the launch. Anything short of a switch, including Project check set
to Suggest, starts where the caller aimed. The tool result's `projectId`,
`projectName`, and `path` are that checkout. When the check suggested or
switched, the result also carries `projectCheck` (`decision`,
`suggestedProjectId`, `suggestedProjectName`, `reasons`). A timeout or a Jev
error leaves the launch unchanged. A switch is stored as `accepted` with the
new session and is not queued for the launcher dialog. The prompt is history
only of the project the session was created in, so a switch never teaches the
project it left. An agent launch outside an Arc stays out of that history, as
it did before.

**Where the numbers came from.** Two evals on 2026-09-27 against the live
database. The first replayed 362 opening prompts and set the thresholds. The
second held out each of nine core projects' newest prompts (120, hand-labelled
as belonging there, belonging anywhere, or misplaced) and built the options
from the older history only. Replaying every prompt from each other project,
the profiles above catch 70% of misplaced launches against 58% for the first
version, with a similar false-alarm rate; on where the prompts were really
started, they flag 5 of 108 correctly placed ones and catch 8 of the 12
misplaced. The cutoffs lean toward asking: a wrong question costs one keypress, a wrong
silent move an Undo. Against the more careful first set (suggest at 0.85 /
0.15, switch at 0.95), they catch 85% of misplaced launches in the replay
instead of 71%, and 9 of the 12 real ones instead of 8, at the price of asking
on about one in nine correctly placed launches instead of one in twenty; many
of those extra questions came from prompts that were only a pasted screenshot
path, which the app strips before asking. A switch bar of 0.85 moved one
correctly placed chat on its own, so it stays at 0.90. Profiles from the
repository alone, a broad `none`, dropping
`none`, averaging two calls in different option orders, and a local
nearest-neighbour score over the history were each tried and lost.

Known limit: a misplaced chat nobody moved becomes history of the wrong
project, and pulls later prompts like it there. Accepted suggestions launch
in the right place, so the history heals as the check is used.

**Outcomes.** `projects:resolve-check` stores one `project_checks` row (v58)
per answered suggestion or switch: `accepted`, `stayed`, `undone`, or
`cancelled`. A check that found nothing is not stored. `stayed` and `undone`
rows are wrong calls — they are what the classifier and thresholds get fixed
from; Argmax does not quietly learn to stop suggesting a pair.

## Cost

What each tier spent is on the Usage page's Router card; see
[usage.md → Router cost](usage.md#router-cost).
