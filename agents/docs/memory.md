# Learnings

Project-scoped facts distilled from prior sessions. Surfaced two ways: prepended to new prompts in the same project (the "preamble"), and rendered in the Project Knowledge panel for human review.

This is Argmax's own learning system — unrelated to the user-level Engram MCP memory described in `~/dotfiles/agents/AGENTS.md`.

## Shape

`learnings` table (migration v9). One row =

| Field | Notes |
|---|---|
| `kind` | `pitfall` \| `convention` \| `command` |
| `summary` | Short human-readable fact, capped at 240 chars |
| `evidence_session_id` / `evidence_event_id` | Pointer to the timeline event that justified the row (deep-link target for a future UI) |
| `verified` | User-set boolean — promotes the row in the picker and prevents auto-cleanup |
| `hits` | Bumped each time the row is included in a preamble |
| `created_at` / `last_seen_at` | Recency for ranking |

An FTS5 sidecar (`learnings_fts`) mirrors `summary` for cheap project-scoped search.

## Extraction

[src/main/memory/learningExtractor.ts](../../src/main/memory/learningExtractor.ts) — `extractLearningCandidates(events)`.

v1 heuristic is intentionally conservative: any tool/command that produced an **error in `MIN_REPETITIONS` (2) or more events** becomes a single `pitfall` candidate with the **earliest matching event** as evidence. Capped at `MAX_CANDIDATES_PER_SESSION` (3).

> Synthesizing many low-signal "learnings" is worse than missing some — they pollute the preamble.

The extractor runs at session completion inside `ProviderSessionService` (`synthesizeLearnings`). Candidates write to `learnings` via `insertLearning` — a plain insert per candidate; there is no summary-level dedupe in persistence today.

The `convention` and `command` kinds exist in the schema for future heuristics; v1 only emits `pitfall`.

## Injection

[src/main/memory/learningInjector.ts](../../src/main/memory/learningInjector.ts) — `composeLearningPreamble(deps, projectId, originalPrompt)`.

- Pulls `TOP_K` (5) learnings for the project via `listLearnings(projectId, TOP_K)`, ordered by `verified DESC, hits DESC, last_seen_at DESC`.
- Builds a bullet list under a fixed header (`"Project knowledge — facts captured from prior sessions in this project. Apply where relevant; ignore if not."`).
- Hard-caps the preamble at `MAX_PREAMBLE_CHARS` (2000 — roughly 500 tokens). Bullets that would push past the cap are dropped, not truncated.
- Returns `{ augmentedPrompt, injectedIds }`. The session service uses `injectedIds` to bump `hits` post-launch.

If the project has no learnings, the original prompt is returned unchanged — no empty header, no signal that the system is "on."

## UI

`ProjectKnowledgePanel.tsx` lists learnings per project and exposes:

- Edit summary (`learnings.update({ id, summary })`).
- Verify / unverify (`learnings.update({ id, verified })`).
- Delete (`learnings.delete(id)`).

These are plain IPC channels — see [ipc.md](ipc.md). No bulk operations; the panel is for curation, not data engineering.

## Why so conservative

The risk profile is asymmetric. A bad learning is silent — it shapes every future prompt in that project until someone notices and deletes it. A missed learning costs nothing (the agent re-discovers the pitfall and the next extraction catches it).

When extending heuristics, bias toward **higher MIN_REPETITIONS** and **smaller MAX_CANDIDATES_PER_SESSION** over wider matching. The `verified` flag is the user's escape hatch for promoting a noisy-but-real learning past the heuristic.
