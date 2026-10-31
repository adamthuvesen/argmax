# Auto routing

Auto routing (the **Router** in the UI) picks a chat's provider, model, and effort from what the prompt asks for. A classifier labels the prompt, and a fixed grid in Rust turns the label into a model. The renderer only shows the result.

The measurements behind the grid are in [plan/auto-model-routing.md](plan/auto-model-routing.md). The reason for each cell is the comment on it.

| Concern | Owner |
|---|---|
| Launch and low-confidence settling | [routing/mod.rs](../src-tauri/src/routing/mod.rs) |
| The grids, per-cell rationale, fallbacks, follow-up targets | [routing/table.rs](../src-tauri/src/routing/table.rs) |
| Classifier request and timeouts | [routing/jev.rs](../src-tauri/src/routing/jev.rs) |
| Follow-up decisions, evidence thresholds, ladders, payback | [routing/reroute.rs](../src-tauri/src/routing/reroute.rs) |
| Classifier context for follow-ups | [routing/context.rs](../src-tauri/src/routing/context.rs) |
| Prompt directive | [routing/directive.rs](../src-tauri/src/routing/directive.rs) |
| Key storage | [routing/api_key.rs](../src-tauri/src/routing/api_key.rs) |
| Router cost | [routing/cost.rs](../src-tauri/src/routing/cost.rs), [usage.md](usage.md#router-cost) |
| Decision log | [turn_routes.rs](../src-tauri/crates/argmax-store/src/turn_routes.rs) |
| Follow-up wiring | `route_follow_up` and `apply_auto_follow_up` in [session_service.rs](../src-tauri/src/providers/session_service.rs) |

When a grid cell changes, update the tier blurbs in `AUTO_TIER_DESCRIPTIONS` ([models.ts](../src/renderer/lib/models.ts)). Nothing checks them against the grid.

## Tiers

The UI names and the stored values differ:

| UI | Stored `auto_tier` | Aims for |
|---|---|---|
| Router Frontier | `intelligence` | frontier models, deeper reasoning |
| Router Balance | `balanced` | the default Auto tier |
| Router Speed | `cost` | shortest wait |
| Router Cost | `economy` | lowest API-equivalent completion cost |

`cost` means Speed because saved sessions and picker preferences hold that value. Do not rename it.

Agents launch a routed chat with `model: "auto"` (Balance) or `"auto:<stored tier>"`. An explicit `reasoning` overrides the routed effort. A chat on Auto that omits both `model` and `provider` launches on its own tier, so its children route too ([agent-tools.md](agent-tools.md)).

The chip plays a route switch once ([useRouteSwitch.ts](../src/renderer/hooks/useRouteSwitch.ts)). Reopening an older chat plays nothing. Design notes: [design/router-switch](design/router-switch/README.md).

## Jev, the classifier

TypeSafe's Jev answers typed questions about a text with calibrated probabilities. Argmax asks for kind, difficulty, whether the task is visual UI work, and, on follow-ups, correction, relationship to earlier tasks, and whether the workflow needs less capability.

A failed call never fails a launch. `ROUTING_JEV_FAILED` becomes the tier's `fallback`, recorded with the reason `unrouted: …`. `JEV_TIMEOUT` bounds the call.

Low confidence is settled before the grid (`settle` in `mod.rs`):

- An unsure kind becomes **coding**, unless Jev's top kind beats coding by a wide margin. "Does this look right?" scored review 0.58 and coding 0.04.
- An unsure difficulty rounds **up**, but only when Jev's level probabilities put at least half their weight on the higher level. Confidence alone swings across 0.5 between identical calls.

### The key

Auto routing is off until a Jev key is saved in Settings → Agents. Saving proves the key with one live classification. The key lives in the macOS Keychain, with the account set from `ARGMAX_DATA_DIR`, so a dev profile never shares the installed app's key. It is written over stdin, so it never appears in an argv. Verification mode returns no key and refuses writes ([verification.md](verification.md)).

## Launch

`route_launch` (renderer launches) and `session_launch` (agent launches) call `resolve_route`: classify, settle, then look up the grid.

Invariants of the grid in [table.rs](../src-tauri/src/routing/table.rs):

- **A launch never runs above high.** xhigh and max are reached only by escalation.
- **Mechanical work never runs above medium,** because renames do not repay it.
- **The launch grid does not pick Grok or Composer.** Chats already there keep their own policy.
- **Effort is clamped** to what the model's CLI accepts (`clamp_effort`, the same rule as `clampEffort` in [providerModels.ts](../src/shared/providerModels.ts)).
- **Fast is never used for a routed turn.** The exception is a Composer chat already on Cursor, because the Cursor provider always turns it on.
- **Frontier reviews stay on a second model family,** so another family checks the work.

Many cells rest on bounded measurements, and some have no agent-task quality comparison yet. Read the cell's comment before you treat a choice as proven. A change to the grid needs the same kind of evidence.

**The prompt can steer the launch** ([directive.rs](../src-tauri/src/routing/directive.rs)). A prompt that opens with, or ends on a line of, `use <model> [effort]` launches that model, and Jev is not called. The request counts only when the tier's own grid can reach it. A request outside the tier is ignored, and the reason says so. Follow-ups are not steered.

## Follow-ups

The router reassesses the next task between turns, using a same-provider policy (`follow_up_target`). A cross-provider launch preference therefore cannot prevent adaptation within the native conversation. Model capability is explicit policy, independent of price (`capability`).

The router considers a follow-up only when the chat has an `auto_tier` and the send is headed for a relaunch. Steering does not reclassify. Pending messages classify when dispatched. A missing key, unavailable context, or a Jev failure keeps the current route with a recorded reason.

Classifier context includes invoked skills as task data, so `/ship` is judged as its whole workflow. Merely mentioning a skill does not invoke it. Missing skill context blocks reductions. Clear hides earlier context, and subagent traces are excluded.

`Continue` and a return to earlier work inherit the relevant task's complexity. Restoring an earlier route needs high confidence and stays on the same provider.

### The decision

The evidence for a move is Jev's weight on the task's difficulty bucket, not its confidence in the exact 0–4 score. That confidence sits near 0.5 even when most weight is on one bucket, and gating on it blocked almost every upgrade. Thresholds are constants in [reroute.rs](../src-tauri/src/routing/reroute.rs), and they are policy, not measured calibration. Every route row stores Jev's raw answers (`signals_json`), so they can be tuned from real decisions.

- `escalate`: the correction probability moves one rung up the ladder.
- `reroute` upward goes straight to the target. A turn on too weak a model is the expensive mistake.
- `reroute` downward needs complete relevant context. A model downgrade that pays for itself is taken first. Otherwise effort drops one level per follow-up, so a misread turn cannot drop a chat to the floor at once.
- `kept`: insufficient evidence, an unsupported target, or a switch that does not repay its rebuild. The reason names the limiting gate.

A short OpenCode continuation moves to Claude, because short "yes" or "try again" follow-ups on DeepSeek turned light questions into long command turns.

### Cache and economics

Same-model effort changes are task-sizing decisions with no cache test. A model downgrade must pay for itself (`switch_pays_back`):

- **The rebuild:** re-reading the context uncached on the new model.
- **What staying would cost:** nothing within the cache TTL. Past it, staying is expected to rebuild too, so most of that cost is credited against the switch. A miss does not imply deletion.
- **The savings:** the price gap over the expected follow-ups, capped by last-turn usage.

Missing context size, pricing, or usage cannot establish payback, and Cursor is unpriced. No automatic cross-provider downgrade occurs.

Deterministic tests cover policy and native adapter requests. They cannot prove inference cache reuse. No live measurement has been run: unchanged → effort down → effort back and model A → B → A, recording cached and uncached inputs.

### Escalation ladders

Rungs per provider live in [reroute.rs](../src-tauri/src/routing/reroute.rs). A chat on a rung climbs to the next. A chat off the ladder goes to the first stronger rung. Position orders a ladder, not price.

The last Grok and OpenCode rungs are the router's automatic provider switches. They use the ordinary provider-switch path, which starts Claude fresh with the visible transcript. Cursor climbs to Opus inside the same conversation.

## User pins

A follow-up that names a different provider, model, or effort is the user picking by hand. It ends Auto routing for that chat. A follow-up that names no model is not a pin, even if another window changed the route.

The pin writes a `pinned` row. That row closes the chat's routing, and it is neither a turn nor a switch. It exists so the Router cost card can end the last window there.

## Goals

A Goal's own turns are not classified. In a chat the router drives, two "not yet" verdicts in a row escalate it one rung ([goals.md](goals.md)).

## Persistence

`sessions.auto_tier` is NULL for a chat the router does not drive. `sessions.auto_route` holds the latest reason, so dashboard reads need no join. `turn_routes` has one row per decision, and decisions including `kept` refresh those fields. See [data.md](data.md).

A follow-up's row is written only once the send is admitted, so a send that Stop cancelled leaves no route. Admission checks the session against the classification snapshot, so a changed session keeps its route rather than applying a stale one.

## Project check

Project check asks Jev a second question: before a new chat starts, does the prompt belong in the project the launcher is aimed at?

Code: [project_check.rs](../src-tauri/src/routing/project_check.rs), [project_checks.rs](../src-tauri/crates/argmax-store/src/project_checks.rs), [useProjectCheck.ts](../src/renderer/hooks/useProjectCheck.ts), and [ProjectCheckDialog.tsx](../src/renderer/components/ProjectCheckDialog.tsx).

It runs for a local launcher launch and an agent `session_launch`, with a Jev key, Project check not Off, and at least two projects. Side chats, cloud tasks, follow-ups, multitask, routines, and the Arc coordinator's launch are not checked.

**Profiles come from the user's own history, never a curated list.** Options describe a project by its README and `AGENTS.md` prose, its languages and folders, and the user's opening prompts there, including Claude Code transcripts. Each check builds option text against the other options, so a notes vault that discusses Argmax is not evidence for Argmax.

**A narrow `none`.** A broad "needs no codebase" option outbid personal-ops projects, whose work is exactly that.

**Pasted screenshot paths are stripped.** They said nothing about the project and pulled every prompt toward Argmax.

**The decision.** `p` is the best other project's probability and `c` is the current project's. The prompt *names* a project when it says its name or a monorepo child's name as a whole word, and *cites* it when it gives a path only that checkout has.

| Result | Rule |
|---|---|
| Switch | `p ≥ 0.90`, `c ≤ 0.05`, the prompt names or cites the project, mode is Suggest & switch, and the project was not picked by hand |
| Suggest | `p ≥ 0.50` and `c ≤ 0.10`; or the prompt names or cites the project, `p ≥ 0.35` and `c ≤ 0.10` |
| None | anything else, a Jev error, or no answer within 3.5 s of Enter |

A suggestion opens a dialog. A switch launches in the suggested project and shows an Undo toast.

**Agent launches.** `session_launch` asks the same question. Passing `project` or `path` is the aim, not a hand pick, so it does not raise the bar. There is no dialog and no Undo, so only a switch moves the launch. `path` is kept only when it is a checkout of the new project, and `branch` is not carried, because a ref from another repository could fail the launch. A repository Argmax has never registered is not checked first, because inserting it would leave a row behind when the launch starts elsewhere. A switch never teaches the project it left.

**Where the numbers came from.** Two evals on 2026-09-27 against the live database. One replayed 362 opening prompts. One held out nine projects' newest prompts (120, hand-labelled) and built options from older history. The profiles catch 70% of misplaced launches in replay, against 58% for the first version. On where prompts were really started, the final cutoffs catch 9 of 12 misplaced launches and ask on about one in nine correctly placed ones. The cutoffs lean toward asking, because a wrong question costs one keypress and a wrong silent move costs an Undo. A switch bar of 0.85 moved one correctly placed chat on its own. Repository-only profiles, dropping `none`, averaging two calls, and a local nearest-neighbour score were tried and lost.

**Known limit.** A misplaced chat nobody moved becomes history of the wrong project. Accepted suggestions launch in the right place, so the history heals as the check is used.

**Outcomes.** `projects:resolve-check` stores one row per answered suggestion or switch. `stayed` and `undone` rows are wrong calls. Fix the classifier and thresholds from them. Argmax does not quietly learn to stop suggesting a pair, and profiles stay derived from history.
