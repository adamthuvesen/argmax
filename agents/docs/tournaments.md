# Tournaments

Run the same task across N agents in parallel worktrees, score them with deterministic criteria, keep the winner with one click. MVP shipped via OpenSpec change [`add-tournament-mode`](../../openspec/changes/add-tournament-mode/).

## Lifecycle

```
pending → running → judging → awaiting-decision → decided
                                                ↘ cancelled (any state)
```

A `tournament` row owns N `tournament_contestants`; each contestant points at exactly one `session` running in its own isolated worktree. The orchestrator never modifies the session schema beyond setting `tournament_id` + `contestant_index` on contestant sessions.

## Files

- [src/main/tournaments/tournamentService.ts](../../src/main/tournaments/tournamentService.ts) — orchestrator: launch, poll-for-quorum, run judge, keep winner
- [src/main/judges/criterionRunners.ts](../../src/main/judges/criterionRunners.ts) — per-criterion deterministic runners
- [src/main/judges/scoreAggregator.ts](../../src/main/judges/scoreAggregator.ts) — pool-normalize + apply weights → verdict
- [src/main/persistence/tournamentsRepository.ts](../../src/main/persistence/tournamentsRepository.ts) — CRUD + leaderboard read
- [src/main/persistence/scoringPoliciesRepository.ts](../../src/main/persistence/scoringPoliciesRepository.ts) — CRUD + built-in protection
- [src/renderer/components/TournamentPanel.tsx](../../src/renderer/components/TournamentPanel.tsx) — launch form + leaderboard

## Scoring policies

A policy is `{ criteria: [{ id, weight, threshold? }], autoKeepRule, tiesThreshold }`. Three built-ins ship at user scope (seeded by migration v17, marked `is_built_in` so they cannot be deleted):

| Preset | Use when |
|---|---|
| `correctness-first` | Tests, lint, typecheck as hard gates; rank rest by diff size + wall-clock |
| `smallest-diff` | Correctness gated; smallest diff wins |
| `cheapest-green` | Correctness gated; cheapest contestant wins |

The policy is **snapshotted** onto the tournament row at launch (`tournaments.policy_snapshot_json`). Editing a policy after launch never changes a past tournament's verdict.

## Criteria (MVP)

| Id | Implemented | Source |
|---|---|---|
| `tests-pass` | Yes — runs project's check commands; 1.0 if all pass | [criterionRunners.ts](../../src/main/judges/criterionRunners.ts) |
| `diff-size-lines` | Yes — `git diff --shortstat baseRef...HEAD` | same |
| `cost-usd` | Yes — `session.cost_usd` from usage events | same |
| `lint-clean` | **Stub** — returns inconclusive; aggregator drops it | future work |
| `typecheck-clean` | **Stub** — returns inconclusive | future work |
| `files-touched` | **Stub** — returns inconclusive | future work |
| `wall-clock-seconds` | **Stub** — returns inconclusive | future work |

The aggregator drops inconclusive scores from both numerator and denominator, so a partial-criteria MVP still produces meaningful totals.

## Aggregator semantics

- **Smaller-is-better** criteria (`diff-size-lines`, `files-touched`, `wall-clock-seconds`, `cost-usd`): pool minimum is normalized to 1.0; others scale as `min/value`. Raw 0 is treated as ideal (1.0).
- **Larger-is-better** criteria (e.g. boolean `tests-pass`): identity for {0, 1}; otherwise `value/poolMax`.
- **Hard gates** (`threshold` set): violators are added to `verdict.disqualified` and excluded from winner ranking. Inconclusive scores never trip a gate.
- **Ties**: when top two totals are within `policy.tiesThreshold`, `verdict.winner` is `null` and `verdict.ties` lists the tied contestants. The UI declines to surface a winner prompt.

## Auto-keep semantics (MVP)

The auto-keep rule is computed (`min_total`, `min_margin`) but the MVP UI does **not** auto-archive losers. The user must click "Keep" on a row to:

1. Mark the chosen contestant's worktree as `kept` (existing per-session keep path)
2. Archive every other contestant's worktree (existing per-session archive path; cancels in-flight checks first)
3. Persist `tournaments.decision_json` with `source: "manual"` and `overrodeWinner` if the user picked someone other than the verdict's winner

A future change can add a "fully autonomous" per-project setting that fires keep + archive without confirmation when the auto-keep rule passes.

## IPC surface

| Channel | Schema | Returns |
|---|---|---|
| `tournament:launch` | `tournamentLaunchInputSchema` | `Tournament` |
| `tournament:list` | `{ projectId }` | `Tournament[]` |
| `tournament:get` | `{ tournamentId }` | `TournamentLeaderboard` (also runs judge if quorum reached) |
| `tournament:keep` | `{ tournamentId, contestantIndex, reason? }` | `TournamentLeaderboard` |
| `scoring:listPolicies` | `void` | `ScoringPolicy[]` |

Polling-based for MVP: the `TournamentPanel` calls `tournament:get` every 2 seconds while a tournament is open. The judge runs synchronously on the IPC thread when `tournament:get` detects all contestants have reached a terminal state. A future change can swap to a `tournament:delta` push channel mirroring `dashboard:delta`.

## Wiring the panel into the UI

The `TournamentPanel` component is standalone but not yet mounted in App navigation. To enable in your local build, drop it into [SettingsPanel.tsx](../../src/renderer/components/SettingsPanel.tsx) as a new `<section>` (gate behind a feature-flag preference if you want it off by default), or add a top-level route in [App.tsx](../../src/renderer/App.tsx). Pass `project={currentProject}` and reuse `cols`/`rows` from the existing launcher.

## What's deferred

Out of scope for MVP, planned for follow-up changes:

- `ScoringPolicyEditor` UI — custom policies via Settings
- `tournament:delta` push channel — replaces 2s polling
- Per-criterion timeouts + outside-quorum handling
- Re-judge against a different policy without re-running runners
- Auto-keep / fully-autonomous mode
- LLM-as-judge for subjective criteria
- ReviewPanel integration so leaderboard ordering shows up in the existing comparison view

See the OpenSpec change's [design.md](../../openspec/changes/add-tournament-mode/design.md) for the full long-term shape.
