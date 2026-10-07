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

Four picker entries, one per tier. The UI names and the stored values differ:

| UI | Stored `auto_tier` | Aims for |
|---|---|---|
| Router Frontier | `intelligence` | frontier models, deeper reasoning |
| Router Balance | `balanced` | the default Auto tier |
| Router Speed | `cost` | shortest wait |
| Router Cost | `economy` | lowest API-equivalent completion cost |

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
(Balance) or `"auto:cost"` (Speed), `"auto:economy"` (Cost),
`"auto:balanced"` or `"auto:intelligence"`; an explicit
`reasoning` there still overrides the routed effort
([agent-tools.md](agent-tools.md)). A chat already on Auto that omits both
`model` and `provider` launches on its own tier, so its children route too.

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
- a **UI** question: the probability the task is mainly visual UI or design
  work (layout, styling, colour, spacing, typography, animation, icons). At
  0.7 or above the task counts as UI. On 16 real prompts, UI requests scored
  0.89–0.98, and git, docs, tests and questions scored 0.22 or less;
- for follow-ups only, a **correction** question: the probability the user is
  unhappy with the previous work (failing, disliked, or to be redone)
- for follow-ups, the relationship to earlier tasks (continuation, independent
  new task, or bounded finishing step), its confidence, and whether the entire
  upcoming workflow clearly needs less capability.

The request has a 1.5 s connect and total timeout, no retries and no
redirects. A 401/403 is `ROUTING_KEY_INVALID`; any other failure is
`ROUTING_JEV_FAILED`, which the callers turn into a fallback, never a failed
launch.

Low confidence is settled before the grid (`settle` in `mod.rs`). When kind
confidence is below 0.5, Jev's top kind is kept if coding trails it by more
than 0.15 ("Does this look right?" scored review 0.58, coding 0.04);
otherwise the task is treated as **coding**. Difficulty confidence below
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

Cost has its own launch grid:

| Kind | Light | Standard | Heavy |
|---|---|---|---|
| coding | Luna · medium | Sol 6.1 · medium | Sol 6.1 · high |
| mechanical | Luna · medium | Luna · medium | Luna · medium |
| research | Luna · medium | Sol 6.1 · medium | Sol 6.1 · high |
| question | Luna · medium | Luna · medium | Sol 6.1 · high |
| review | Sonnet 5.5 · low | Sonnet 5.5 · medium | Sonnet 5.5 · high |

When Codex is unavailable, Cost launches on Sonnet for lighter work,
mechanical edits, and reviews, and Opus for other heavy work.

DeepSeek V4.1 Flash held these Luna cells from 2026-10-04 to 2026-10-06,
on its $0.003 cache-read rate against Luna's $0.01. Luna came back because
the whole-task cost favours it: Artificial Analysis scores the two alike
(Intelligence Index 38 vs 39) but prices a Luna index task at $0.07 against
DeepSeek's $0.27. DeepSeek writes more tokens, doubles its price at peak
hours, and OpenRouter's host choice moves its cache-read rate from $0.003 to
$0.048. DeepSeek keeps the cells where its latency is the point, on Speed and
Balance. A Claude chat keeps its native model on follow-ups (Sonnet).

Luna is GPT-6 Luna. Cost optimizes API-equivalent completion cost rather
than subscription allowance or provider. The initial policy follows the
2026-09-29 Sol comparison and 2026-09-30 Luna queue task. Evidence outside
those bounded tasks is provisional. On 2026-10-02, reviews moved from Opus to
Sonnet 5.5 (half the per-token price) and standard questions moved from Sol to
Luna. Neither move has a review-quality benchmark behind it yet; Sonnet 5 scored
24–28% on CursorBench against Opus low's 43.7%, and Sonnet 5.5 is untested there. Existing `cost` values still mean Speed,
so saved sessions and picker preferences retain their behavior.

Tier × difficulty picks a column and an effort:

| Difficulty | Speed | Balance | Frontier |
|---|---|---|---|
| Light | Cheap · low | Cheap · medium | Value · medium |
| Standard | Cheap · medium | Value · medium | Frontier · high |
| Heavy | Value · medium | Value · high | Frontier · high |

Kind × column picks the model:

| Kind | Cheap | Value | Frontier |
|---|---|---|---|
| coding | Sonnet 5.5 | Opus 5.5 | Opus 5.5 |
| mechanical | DeepSeek V4.1 Flash · low | DeepSeek V4.1 Flash · low | Opus 5.5 |
| research | Sonnet 5.5 | Opus 5.5 | Opus 5.5 |
| review | Opus 5.5 · low | Opus 5.5 | GPT-6 Astra |
| question | Sonnet 5.5 | Opus 5.5 | Opus 5.5 |

The review row is the Balance and Frontier answer. Speed and Cost run reviews
on Sonnet 5.5 instead (see the overrides below), and `table.rs` is the source
when this table and the code disagree.

Overrides on top of the grid:

- **Balance sends light mechanical UI work to Opus 5.5 · low.** That is the
  DeepSeek cell left on Balance. Composer's UI tweaks (the model DeepSeek
  replaced) were the chats most often reported wrong. Speed keeps DeepSeek for
  mechanical work, including UI work.
- **Balance runs heavy work at high only when Jev puts at least 0.6 on hard or
  very hard.** Below that it runs the standard cell at medium, and a
  follow-up can climb. Frontier keeps high.
- **The launch grid does not pick Grok.** A chat already on Grok Build still
  follows difficulty: Light low, Standard medium, Heavy high.
- **Speed's Light questions and research launch on DeepSeek V4.1 Flash ·
  high** (2026-10-04). They edit nothing, so a weak answer is cheap to catch,
  and DeepSeek answers first (0.66 s to first token against Sonnet's 1.19 s in
  a raw API test). Light coding stays on Sonnet. No quality comparison on
  agent tasks exists yet. A Speed follow-up on that chat keeps DeepSeek; a
  reported-wrong chat climbs to DeepSeek high, then to Sonnet 5.5 high.
- **Speed's heavy coding, research, and questions stay on Sonnet 5.5 ·
  medium.** Those cells would otherwise be the Opus value column. Light is
  low and standard is medium, from the table above. A Speed follow-up that
  is already on Claude stays on Sonnet. A reported-wrong answer still climbs
  the Claude ladder, whose first rung is Opus medium.
- **Speed and Cost reviews run on Sonnet 5.5 with effort by difficulty:**
  Light low, Standard medium, Heavy high, at launch and on Claude follow-ups.
  Sonnet high finishes about as fast as Opus low (17 s vs 19 s on Artificial
  Analysis, 2026-10-02) at half the per-token price. No review benchmark backs
  the swap yet.
- **Balance sends its standard and heavy mechanical work to Sonnet 5.5 ·
  medium.** Light mechanical work stays on DeepSeek V4.1 Flash. Heavy mechanical effort
  stays medium on every tier.
- **Balance standard coding and research launch on Sonnet 5.5 · high.** Heavy
  coding and research stay on Opus 5.5 · high.
- **Frontier light mechanical work launches on Sonnet 5.5 · medium.**
- Frontier · Heavy sends **research and questions to Fable 5.1**; coding stays
  on Opus 5.5. Fable beats Astra on research-style benchmarks (HLE 65.6 vs
  57.2, GDPval 1735 vs 1542, 2026-10-06). Astra keeps Frontier reviews, so a
  second model family checks the work. A Codex chat on Frontier heavy research
  still follows up on Astra.
- **DeepSeek V4.1 Flash replaced Composer 2.5 on the mechanical cells
  (2026-10-04).** It launches on OpenCode through OpenRouter, so it needs
  OpenCode installed and an OpenRouter key; without OpenCode the route moves to
  the next installed provider. Raw API speed was measured (0.66 s to first token
  against Composer's 8.3 s through its CLI) at $0.15 in and $0.60 out per
  million tokens. No agent-task quality comparison exists yet. Its CLI takes low,
  high and max, so mechanical medium clamps to low. A DeepSeek chat keeps its
  model on follow-ups; a reported-wrong chat climbs to DeepSeek high, then to
  Sonnet 5.5 high on Claude Code. Chats already on Cursor keep the Composer
  ladder below.
- Mechanical work never runs above medium; the cheap review cell is Opus 5.5
  at low, which Balance's light reviews still use.
- Effort is clamped to what the model's CLI accepts (the `clampEffort` rule in
  [providerModels.ts](../src/shared/providerModels.ts)); Composer takes none.
- **A launch never runs above high.** xhigh and max are only reached by
  escalation.

**The prompt can steer the launch** ([directive.rs](../src-tauri/src/routing/directive.rs)).
A prompt that opens with, or ends on a line of, `use <model> [effort]` (for
example `use astra high`) launches that model, and Jev is not called. The
request counts only when the tier's own grid can reach it: the allowed efforts
for a model are the efforts `table::route` launches it at on that tier, over
every kind and difficulty. Frontier honors `use astra high` but not
`use deepseek` or `use astra max`. A request outside the tier is ignored: the
grid routes as usual and the reason ends `(ignored the request: …)`. With no
effort named, the request takes medium if the tier reaches it, else the next
level up. A mention deeper in the text is not a request. Follow-ups are not
steered yet.

If Jev fails, the tier's **fallback** is used and recorded with the reason
`unrouted: …`: Cost → Sol 6.1 · medium, Speed → Sonnet 5.5 · medium,
Balance and Frontier → Opus 5.5 · medium.

**Fast is never used for a routed turn, except on Composer chats already on Cursor.** `route_launch`
clears `fast_mode`, and so does every follow-up the router still drives,
including one it leaves on its model. Composer 2.5 runs Fast regardless,
because the Cursor provider always turns it on (see
[providers.md](providers.md)).

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

Each classified follow-up ends in one decision. The evidence for a move is
Jev's weight on the task's difficulty bucket (the probability it is at least,
or at most, that hard), not its confidence in the exact 0–4 score. That
confidence sits near 0.5 even when most of the weight is on one bucket, and
gating on it blocked almost every upgrade.

| Move | Evidence needed |
|---|---|
| Effort up, same model | P(at least the bucket) ≥ 0.6 |
| Model up | P(at least the bucket) ≥ 0.7 |
| Effort down, same model | kind confidence, P(at most the bucket) and the simpler-task score all ≥ 0.75 |
| Model down | the same three ≥ 0.8, and the savings cover the cache rebuild |

- `escalate`: correction probability at least 0.85 moves one rung up the existing
  ladder. At the top, the route is kept.
- `reroute` upward goes straight to the target, including a return to difficult
  work after a simple interlude. A turn on too weak a model is the expensive
  mistake.
- `reroute` downward needs complete relevant context. A model downgrade that
  pays for itself is taken first. Otherwise effort drops one level on the
  current model per follow-up, so a misread turn cannot drop a chat to the
  floor at once. There is no cooldown.
- `kept`: insufficient evidence, an unsupported target, or a model switch that
  does not repay its cache rebuild. The reason names the limiting gate and the
  evidence, for example `Not sure it needs more (55% < 60%)`.

These thresholds are policy, not measured calibration. Every route row stores
Jev's raw answers (`signals_json`) so they can be tuned from real decisions.

The provider targets are:

| Provider | Follow-up policy |
|---|---|
| Claude | Opus with supported low, medium, or high effort, except a Speed chat, which stays on Sonnet 5.5, reviews included. Frontier heavy questions and research target Fable. A retained stronger model can reduce or restore effort in place. |
| Codex | Sol for coding and mechanical work at any difficulty, and for lighter work of any kind. Astra for heavy review, research and questions, and Frontier standard review or research. A chat launched on Astra for a review moves to Sol for the code that follows when the switch pays. |
| Cursor | Composer for lighter work, Cursor Opus for review, more demanding work, and Balance UI work (low). Model downgrades stay blocked while pricing is unavailable. |
| OpenCode | A DeepSeek chat keeps its model on a new task. A continuation (scope confidence ≥ 0.6) moves to Sonnet 5.5 medium on Claude Code, from the visible transcript (a reported-wrong answer still climbs to high). Short "yes" / "try again" follow-ups turned light questions into 10–56 command turns of up to 405 s (2026-10-04..07). |
| Grok Build | The grid never launches Grok. A chat already there stays on Grok 4.7 with effort by difficulty: low, medium, high. |

Cost follow-ups on Codex use the same Luna/Sol task cells. A review in an
existing Codex conversation uses Sol at the review's effort rather than
switching providers mid-task. A Claude conversation stays on Sonnet, reviews
included; only heavy non-mechanical work takes Opus. The normal
confidence and cache-payback rules still gate reductions. Reported-wrong
answers and incomplete Goals on Cost climb Luna medium → Sol medium → Sol high
→ Opus high. The last step changes provider and rebuilds context from the
visible transcript, then follows the Claude escalation ladder.

### Cache and economics

Same-model effort changes are task-sizing decisions with no cache test. Claude
Code documents cache-preserving effort changes on Opus 5.5 and Fable 5.1;
Codex and Cursor make no such guarantee. Codex's experimental effort override
is not enabled. The native transport contracts and limits are in
[providers.md](providers.md).

A model downgrade must pay for itself (`switch_pays_back` in `reroute.rs`):

- **The rebuild.** The switch re-reads the context uncached on the new model,
  priced at the cache-write rate over the cache-read rate. Claude's write rate
  allows the one-hour 2x input rate.
- **What staying would cost.** Within an hour of the chat's last activity (the
  longest TTL the providers document), the cache is taken as warm and staying
  is free. Past it, staying is expected to rebuild too: three quarters of the
  old model's rebuild is credited against the switch, and a quarter is left
  for a prefix that survived. A miss does not imply deletion.
- **The savings.** The price gap over two turns, the observed mean of two
  follow-ups per routed chat (134 over 65 chats, 2026-09-28). Each turn is
  capped by the last turn's usage: 256 input and output for a finishing step,
  1,000 input and 500 output for Light work, 4,000 and 2,000 otherwise, plus
  one context read.

The switch happens when savings are positive and cover the rebuild minus what
staying would have cost. With a warm cache, Astra → Sol for heavy coding pays
on a 168k context, while Fable → Opus for a light question does not. After
the hour, it does. Missing context size, pricing, or usage cannot establish
payback, and Cursor is unpriced. No automatic cross-provider downgrade occurs.

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
| Codex | GPT-6.1 Sol · medium → Sol · high → GPT-6 Astra · high → Astra · xhigh |
| Cursor | Composer 2.5 → Claude Opus 5.5 (Cursor) · medium → · high |
| OpenCode | DeepSeek V4.1 Flash · high → **Sonnet 5.5 · high on Claude** |
| Grok | Grok 4.7 · low → · medium → · high → **Opus 5.5 · high on Claude** |

The last Grok and OpenCode rungs are the router's automatic provider switches: the send goes through the ordinary provider-switch path, which starts
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
v57 widened `turn_routes.decision` to allow `pinned`. v61 adds `economy`
for Cost while preserving `cost` as Speed and all existing route history.

`turn_routes` has one row per decision: `session_id`, `created_at`, `tier`,
`provider`, `model_id`, `reasoning_effort`, `kind`, `difficulty`, the two
confidences, `decision` (`launch`, `reroute`, `escalate`, `kept`, `fallback`,
`pinned`) and `reason`. v60 added `signals_json`: every answer Jev gave
(kind and level probabilities, correction, scope, simpler, resume, UI), NULL
for a row Jev did not classify. Decisions, including `kept`, refresh the session's
`auto_tier` / `auto_route` so the chip explains retained routes too. A pin
clears those fields. Dashboard reads need no join. A
follow-up's row is written only once the send is admitted, so a send that Stop
cancelled leaves no route behind. Admission also checks the model, effort,
provider, tier, activity stamp, and native conversation ID against the
classification snapshot. A changed session retains its admitted route rather
than applying stale classification. Echoed Auto selections are removed before
queueing.

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
