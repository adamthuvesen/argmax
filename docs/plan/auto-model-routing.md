# Plan: Auto model routing

Decided 2026-09-27 with the user. This file is the governing artifact for the
build on `adam/feat-auto-routing`.

## Scope

Three picker entries — **Auto · Cost**, **Auto · Balanced**, **Auto ·
Intelligence**. At launch a classifier (TypeSafe **Jev**) labels the prompt's
kind and difficulty; a routing grid picks provider, model and effort. Follow-ups
may change effort (or model within the same provider) only when it is free
(break-even rule). Escalation moves up a per-provider ladder. Every routing
decision is recorded.

Constraints:
- **Rust owns the grid.** The renderer shows only resolved results — no TS mirror.
- **No automatic cross-provider switch mid-chat.** At the top of a ladder the
  chip offers the existing provider-switch dialog.
- **Opt-in.** Manual model choice stays the default. Prompts go to TypeSafe
  only in Auto chats.
- Migrations append-only (docs/data.md).

Out of scope: learning the grid from data, re-routing Cursor chats (no Cursor
billing data), an API-key settings UI.

Defaults taken for the user's open questions: Fable 5.1 is the top of the Claude
ladder; Review stays on GPT-6 Sol/Astra (different family from the Opus
implementer); Auto is opt-in until Phase 6 has a week of data.

## Kinds, columns, grid

Kinds (Jev Choice, 5 options): **coding** (design, debug, implement),
**mechanical** (renames, bulk edits, copy), **research** (read docs, compare,
investigate), **review**, **question**.

Difficulty (Jev Score, 5 levels: trivial, easy, moderate, hard, very hard) folds
to **Light** (trivial, easy), **Standard** (moderate), **Heavy** (hard, very hard).

| Kind | Cheap | Value | Frontier |
|---|---|---|---|
| coding | Composer 2.5 (cursor `composer-2.5`) | Opus 5.5 | Opus 5.5 |
| mechanical | Composer 2.5 | Composer 2.5 | Opus 5.5 |
| research | Composer 2.5 | Opus 5.5 | Opus 5.5 |
| review | Opus 5.5 · low | Opus 5.5 | GPT-6 Astra |
| question | Grok 4.7 (grok `grok-4.7`) | Opus 5.5 | Opus 5.5 |

Tier → column · effort:

| Difficulty | Cost | Balanced | Intelligence |
|---|---|---|---|
| Light | Cheap · low | Cheap · medium | Value · medium |
| Standard | Cheap · medium | Value · medium | Frontier · high |
| Heavy | Value · medium | Value · high | Frontier · high |

Tiers are named Speed (cost), Balance (balanced) and Frontier (intelligence) in the UI.
Frontier · Heavy spreads the heaviest work across families: **research → GPT-6 Astra · high**,
**question → Fable 5.1 · high**; coding stays on Opus 5.5, which outscores Fable high on
CursorBench (56.0% vs 49.2%).

Effort is clamped to the model's ladder (same rule as `clampEffort` in
`src/shared/providerModels.ts`: keep if supported, else the highest level below,
else the lowest). Composer takes no effort; routed chats run it on Fast (changed 2026-10-02, `33ecdf5f`; see [routing.md](../routing.md)).
V4.1 Flash is floored at high (low measured no faster). Mechanical work caps at medium. **A launch never runs above high**; xhigh and max are reserved for escalation.

Uncertainty:
- kind confidence < 0.5 → treat as **coding**
- difficulty confidence < 0.5 → round **up** one level
- Jev timeout (1.5 s) or error → the tier's fallback: Speed **Composer 2.5**, Balance/Frontier **Opus 5.5 · medium**

## Follow-ups (Phase 5)

Only for sessions with `auto_tier` set, and only when the incoming follow-up
did not change the model by hand (a manual pick pins the chat: `auto_tier`
cleared). Classify each eligible follow-up; candidate = grid cell. If the
candidate is on another provider → keep (record `kept`). Same provider, switch
when any holds:
1. idle longer than the cache TTL: Claude 5 min, Codex 30 min, others 5 min
2. upgrade with confidence ≥ 0.7
3. `context_tokens × (write_new − read_old) ≤ 2 × per-turn saving`, where the
   saving prices the last turn's `usage_events` rows on both models via
   `src-tauri/src/providers/pricing.rs` (write price 0 → use input price)

An effort-only change goes through the same test. Hysteresis: switch only when
the candidate differs by at least one level; never switch back within the same
cache window.

Escalation — triggers: Jev Noul "the user is unhappy with the previous work:
failing or wrong, disliked ("this is ugly"), or to be redone ("let's redo this",
"start over")" ≥ 0.85 (a preference, an idea, a "what about…" or a new request
does not count; measured 0.90–0.97 vs 0.16 or less), or two consecutive Goal
`NotYet` verdicts. One rung at a time:
- Claude: Opus 5.5 medium → high → **Fable 5.1 high → xhigh** (user preference)
- Codex: Sol medium → high → Astra high → xhigh
- Grok: 4.7 low → **Opus 5.5 high on Claude Code** (higher Grok efforts measured slower)
- OpenCode: V4.1 Flash high → max → **Opus 5.5 high on Claude Code**
- Cursor: Composer 2.5 → Opus 5.5 via Cursor (same conversation; Cursor picks the effort)
The cheap ladders' last rung is the one automatic provider switch (context rebuilt
from the visible transcript). At any other top rung the chat stays put.

## Evidence (why this grid)

Median real Opus 5.5 turn (973 turns, 14 days of transcripts): 4 API calls,
168k context, 2.5k output, 14k cache write, 737k cache read. Cache reads are
60–90% of every turn, so per-turn cost: V4.1 Flash $0.008, Composer ~$0.06,
Grok 4.7 $0.078, Sol $0.25, **Opus 5.5 $0.33**, Fable $0.64, Astra $1.26.
Task-completion benchmark (question/rename/debug/implement on a toy repo via the
real CLIs): Opus 58 s, Composer 66 s, V4.1 Flash 81 s, Grok 102 s, Astra 129 s,
Sol 155 s — all passed. Speed breaks ties in Cheap/Value only; Heavy and
Frontier use quality alone. Opus 5.5 leads SWE-bench Pro (89.9%), WebDev Arena,
AA Intelligence Index (58). Dropped as dominated: Sonnet 5, GLM-5.3, Kimi K3,
Haiku 4.5, Fable (outside the ladder), Luna (quit a task early), GLM-5.3-Flash
(erratic), Gemini 3.8 Flash, Big Pickle (trains on prompts).

## Jev

- Direct API: `POST https://api.typesafe.ai/v1/systemone`, model `jev-latest`,
  key `TYPESAFE_API_KEY` (verified working 2026-09-19; ~290 ms warm, ~740 ms cold
  from Sweden). Docs: https://docs.typesafe.ai (primitives: Choice, Score, Noul;
  one request = state + questions, answers carry probabilities + confidence).
- The key lives in the env or in `~/.local/share/dotfiles/agent-secrets.json`
  (`TYPESAFE_API_KEY`), read with the same 0600 / owner / no-symlink checks as
  `src-tauri/src/providers/cursor_cloud.rs:240-280`.
- Confirm the exact JSON shape against the docs (Phase 1) before writing the client.

## Phase 1: Jev validation gate

Deliverable: confirmed request/response shape and latency; option descriptions
for the 5 kinds and 5 difficulty levels; agreement against ~100 of the user's
real opening prompts (from `~/.claude/projects/*/*.jsonl` first user messages),
pre-labelled by a strong model and shown to the user for correction.
Files: scratch only. Success: ≥ ~80% kind agreement at confidence ≥ 0.5; p90
< 1 s warm. If it misses, stop and report before Phase 2.

## Phase 2: Rust routing core

Files: new `src-tauri/src/routing/{mod.rs, table.rs, jev.rs}`; move the
agent-secrets reader and `http_client` out of `cursor_cloud.rs` into shared
helpers. `resolve_route(prompt, tier) -> RouteDecision { provider, model_id,
model_label, effort, kind, difficulty, kind_confidence, difficulty_confidence,
reason, fallback }`. Success: unit tests pin every grid cell, clamp and fallback.

## Phase 3: Launch + persistence

- Migration 56 (`src-tauri/src/persistence/migrations.rs`): `sessions.auto_tier`
  TEXT NULL; table `turn_routes` (session_id, created_at, provider, model_id,
  effort, kind, difficulty, kind_confidence, difficulty_confidence, decision
  CHECK IN ('launch','reroute','escalate','kept','fallback'), reason).
- `ProvidersLaunchInput.auto_tier` (`src-tauri/src/ipc/inputs.rs:618`); resolve
  in `providers_launch_impl` (`src-tauri/src/ipc/providers.rs:45`) before
  `live_providers(state)?.launch(input)`.
- MCP `session_launch` accepts `model: "auto"` / `"auto:<tier>"`
  (`src-tauri/src/session_control/actions/launch.rs:327`; it calls
  `providers.launch` directly, so it resolves there too).
- Regenerate bindings; update docs/data.md.
Success: Auto launch through `scripts/bridge.mjs` on the dev instance
(`npm run tauri:dev:isolated`) stores the resolved model + one `turn_routes`
row; `npm run check:tauri-bridge` passes.

## Phase 4: Picker + chip

`src/renderer/components/ModelSelector.tsx` (`LaunchModelSelector` :209,
`CombinedModelSelector` :917), `src/renderer/lib/launchModelPreference.ts:45`
(accept `{auto: tier}`), `src/renderer/lib/models.ts:15` (selection union),
`src/renderer/App.tsx:1539, 1763`, `src/renderer/mobile/NewSessionScreen.tsx:293`,
`src-tauri/src/default_agent.rs`, `src/renderer/components/settings/AgentsSettings.tsx:105`.
Chip: `Auto · Balanced → Opus 5.5 · medium`, tooltip with kind + difficulty.
Success: vitest; `verify-argmax` screenshot of the chip.

## Phase 5: Follow-ups + escalation

Hook in `src-tauri/src/providers/session_service.rs` (~1624, before
`update_session_model`; read `last_activity_at` first — that call overwrites
it). New `src-tauri/src/routing/reroute.rs`. Goal trigger at
`src-tauri/src/goals/service.rs:394`. Success: table-driven tests (idle > TTL,
big-context refusal, Sol→Astra allowed, manual pick respected, escalation stops
at top rung); dev-instance two-follow-up run.

## Phase 6: Measurement

`scripts/routing-report.mjs`: `turn_routes` ⨝ `usage_events` → per cell turns,
$/turn, escalations, overrides, goals met.
The Usage page's **Router** card shows the same per tier, turn by turn, for
the page's window ([usage.md](../usage.md#router-cost)).

## Final checks

`npm run precheck`; bindings regenerated; `check:tauri-bridge`; docs
(`docs/routing.md` new, `providers.md`, `data.md`, `agent-tools.md`,
`GLOSSARY.md` terms Auto tier / Route, an ADR for "route at launch, re-route only
at break-even; speed breaks ties outside Heavy/Frontier"); `pricing.rs` ↔ TS
`MODEL_PRICING` agree.

## Risks

- Benchmarks: 1–2 runs per cell on a toy repo; Phase 6 replaces them.
- Composer is unpriced (Cursor billing unknown); Cursor chats never re-route.
- OpenCode hung with 10 concurrent `opencode run` calls through its shared
  server; Argmax uses the same server. More V4.1 Flash routing may need a
  concurrency cap.
- Privacy: prompts leave the machine only in Auto chats.

## Latency (2026-09-27 rerun)

Economy weighs latency as much as cost. Median seconds for question / rename /
debug / implement through the real CLIs, 2 runs each: Opus low 48.8, Opus
medium 57.9, Grok low 72.9, Composer 74.3, V4.1 Flash high 86.7 (low 88.2),
Luna medium 90.9, Grok medium 99.0, Sol medium 156.4. Sol was dropped from the
Standard review cell for being 2.7x slower than Opus medium at a lower score.

In-app rerun (scratch Argmax, 4-turn chats: launch + 3 follow-ups, 2 chats each,
median total): Composer 42 s, Opus medium 58 s, Grok low 89 s, V4.1 Flash high
89 s. Cursor's warm ACP pool removes its ~5.5 s start from every follow-up, so the
cold-CLI benchmark had overstated Composer's latency. The Economy cheap cells for
mechanical, research and review moved from V4.1 Flash to Composer.

Review quality check (2026-09-27): on 1 review with 5 planted bugs and 3 multi-file
repo questions run in-app, Opus low, Composer, Cursor Grok 4.7 medium and Cursor
Gemini 3.8 Flash medium all scored full marks (the tasks were too easy to separate
them); Grok and Gemini took 2.5-4.5x longer. CursorBench 4.0 separates them: Opus low
43.7% ($1.17/task), Grok 4.7 medium 41.6% ($3.49), Gemini 3.8 Flash medium 37.3%
($4.06), Composer 27.7% ($0.68), Sonnet 5 low/medium 24.1%/28.0%. The cheap review
cell moved to Opus low; research stays on Composer.

## Matched implementation check (2026-09-27)

Keep the current Balance grid. Composer is promising for bounded implementation,
but this sample does not establish which Standard coding prompts can safely move.

Three small JavaScript tasks ran through an isolated Argmax instance on both
Composer 2.5 and Opus 5.5 medium. Each had an identical initial prompt and one
standardized follow-up, with model order alternated. Acceptance tests were
written before the runs, kept outside the fixture repositories, and checked
after each turn. The follow-up checks also reran the initial requirements.
All twelve stages passed.

| Task, including follow-up | Composer | Opus medium |
|---|---:|---:|
| Incremental event updates | 35.9 s | 54.0 s |
| Filtered metric aggregation | 42.7 s | 54.0 s |
| Bounded queue and cancellation | 42.9 s | 35.2 s |
| Total | 121.6 s | 143.2 s |

Composer used 15.1% less elapsed time overall and won two of three tasks.
Opus's three session totals summed to $0.727. Cursor supplied no billing data,
so the run establishes no dollar saving. Three small deterministic tasks also
cannot establish production quality or performance on larger repositories.
Four pilot turns that inherited Argmax's repository instructions were excluded.

Local evidence, including prompts, acceptance tests, transcripts, and diffs:
`.verify/runs/router-balance-eval-20260927T1828Z/clean-summary.json`.
