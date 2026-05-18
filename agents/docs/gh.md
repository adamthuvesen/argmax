# GitHub CI feedback loop

When a session opens a PR, Argmax polls the PR's check status and — on a transition into `failure` — fires a notification and launches a follow-up provider session pre-loaded with the failure context. End-to-end agentic CI recovery.

## Moving parts

| Component | File | Role |
|---|---|---|
| `GhService` | [src/main/gh/ghService.ts](../../src/main/gh/ghService.ts) | Thin `gh` CLI wrapper — resolves the project remote, queries PRs for a session, returns rolled-up check state |
| `GhPoller` | [src/main/gh/ghPoller.ts](../../src/main/gh/ghPoller.ts) | Periodic ticker (`GH_POLL_INTERVAL_MS`, 60 s default); fires `launchFollowUp` on `failure` transitions. Fans out per tick at `TICK_CONCURRENCY = 4` so one slow `gh` call doesn't head-of-line block other sessions |
| `projects.repo_remote_owner` / `repo_remote_name` | migration v12 | Per-project cache of `gh repo view --json owner,name` so polling doesn't re-resolve |
| `gh_pr` table | migration v12 (+ `pr_state`, `notified_at` in v19) | One row per `(session_id, pr_number)` holding `head_sha`, `last_seen_check_state`, `pr_state`, `notified_at`, `updated_at` |

## Project remote

`gh repo view --json owner,name` runs once per project during registration / refresh. Owner + name are persisted on `projects` so every PR refresh for any session in that project can skip the lookup. Re-resolve happens when the user explicitly refreshes the project; we don't try to detect remote changes mid-session.

## Refresh

`GhService.refresh(sessionId)` runs:

1. A single `gh pr view --json number,headRefOid,state,statusCheckRollup` from the workspace path. `gh` itself picks the PR matching the current branch; no `--search` is needed.
2. `collapseRollup` walks the `statusCheckRollup` array and reduces it to one `GhCheckState`: any `failure | failed | timed_out | action_required` → `failure`; any `cancelled` → `cancelled`; any `pending | in_progress | queued | waiting` → `pending`; otherwise `success` (or `skipped` when every entry is `skipped`/`neutral`); empty rollup → `unknown`.
3. Upsert into `gh_pr` keyed on `(session_id, pr_number)`. `pr_state` is normalized to `OPEN | CLOSED | MERGED | null`.

The renderer's `prs.listForSession({ sessionId })` and `prs.refresh({ sessionId })` are the IPC entry points — see [ipc.md](ipc.md). Refresh is also reachable via the `Refresh PRs` button in the session header.

`GhCheckState` union: `"unknown" | "pending" | "success" | "failure" | "neutral" | "cancelled" | "skipped"`.

Errors are classified by `ghErrorCategory` from stderr — `no-pr` and `unknown` stay silent (a session legitimately has no PR yet); `auth`, `rate-limit`, and `transient` log at warn level so a broken `gh` install doesn't look like "no PR".

## Poller

`GhPoller.start()` registers a 60-second `setInterval` (`.unref()`'d) that:

1. Builds the pollable set: union of `database.listRunningSessionIds()` and any session with an open `gh_pr` row (`pr_state` is `OPEN` or `NULL`). Sessions whose recorded PR is closed/merged drop out.
2. Fans out `ghService.refresh(sessionId)` in chunks of `TICK_CONCURRENCY = 4`.
3. Tails each result for the **most recent** PR (rows arrive sorted ASC by `pr_number`).
4. If the latest row's `lastSeenCheckState === "failure"` and the dedup key `${sessionId}:${prNumber}:${headSha}` is not in the in-memory `BoundedSet<string>(500)` and `notified_at` is empty, fires `notifications.notifyCheckFailure(...)` + `launchFollowUp(context)`, then stamps `notified_at` via `markGhPrNotified` so the dedup survives an app restart.

**Re-entrancy guard.** If a tick is still running (slow `gh` call), the next interval no-ops. Pile-up under bad network conditions would be worse than missing one tick.

**Failure dedup** has two layers: an in-memory `BoundedSet` (cap 500, rotates oldest out) short-circuits the common case without a DB write per tick, and `gh_pr.notified_at` persists the same `(sessionId, prNumber, headSha)` key across process restarts. A new commit (new `head_sha`) earns a fresh follow-up; the same failed commit polled over and over does not.

## Follow-up launch

`main.ts` wires `launchFollowUp` to `ProviderSessionService.launch` with:

- The workspace's project's `default_provider` and `PROVIDER_MODEL_DEFAULTS[provider]` — `modelLabel`, `modelId`, and (when defined) `reasoningEffort` are pulled from that registry so the user's configured fallback is used, not whatever ran originally.
- A pre-filled prompt:
  > `Checks on PR #<n> (commit <sha[0..12]>) are failing. Run \`gh pr checks <n>\` to see which checks failed, then investigate and fix.`
- Sensible `cols`/`rows` defaults (`120`/`36`).

The new session inherits the same worktree, so the agent can edit the failing code immediately. A notification fires through `NotificationService` so the user sees it even if the app isn't focused.

## Failure modes

| Symptom | Likely cause |
|---|---|
| Poller runs but nothing happens | `gh` not installed/authenticated. `GhService.refresh` catches errors silently per-session so one broken project doesn't kill polling. |
| Duplicate follow-up sessions | Multi-window or multiple poller instances. `main.ts` is the only place that constructs the poller; check that. |
| Follow-up launched against the wrong worktree | The session's `workspace_id` is the source of truth — see `GhPoller.tickSession`. |

## Adding a new check-state transition

Today the only trigger is `→ failure`. To add e.g. `→ success` notifications, extend `tickSession` with a second transition check; keep the `(sessionId, prNumber, headSha)` dedup key so users don't see the same success twice on retries.
