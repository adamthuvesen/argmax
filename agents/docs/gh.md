# GitHub CI feedback loop

When a session opens a PR, Argmax polls the PR's check status and — on a transition into `failure` — fires a notification and launches a follow-up provider session pre-loaded with the failure context. End-to-end agentic CI recovery.

## Moving parts

| Component | File | Role |
|---|---|---|
| `GhService` | [src/main/gh/ghService.ts](../../src/main/gh/ghService.ts) | Thin `gh` CLI wrapper — resolves the project remote, queries PRs for a session, returns rolled-up check state |
| `GhPoller` | [src/main/gh/ghPoller.ts](../../src/main/gh/ghPoller.ts) | Periodic ticker (60 s default); fires `launchFollowUp` on `failure` transitions |
| `projects.repo_remote_owner` / `repo_remote_name` | migration v12 | Per-project cache of `gh repo view --json owner,name` so polling doesn't re-resolve |
| `gh_pr` table | migration v12 | One row per `(session_id, pr_number)` holding `head_sha`, `last_seen_check_state`, `updated_at` |

## Project remote

`gh repo view --json owner,name` runs once per project during registration / refresh. Owner + name are persisted on `projects` so every PR refresh for any session in that project can skip the lookup. Re-resolve happens when the user explicitly refreshes the project; we don't try to detect remote changes mid-session.

## Refresh

`GhService.refresh(sessionId)` runs the user-equivalent of:

1. `gh pr list --search "head:<branch>" --json …` to find the PR(s) opened from the session's worktree branch.
2. `gh pr checks <number> --json …` for each PR to get the roll-up state.
3. Upsert into `gh_pr` keyed on `(session_id, pr_number)`.

The renderer's `prs.listForSession({ sessionId })` and `prs.refresh({ sessionId })` are the IPC entry points — see [ipc.md](ipc.md). Refresh is also reachable via the `Refresh PRs` button in the session header.

`GhCheckState` union: `"unknown" | "pending" | "success" | "failure" | "neutral" | "cancelled" | "skipped"`. The state is computed from `gh pr checks` — any `failure` → `failure`; any `pending` → `pending`; etc.

## Poller

`GhPoller.start()` registers a 60-second `setInterval` (`.unref()`'d) that:

1. `database.listRunningSessionIds()` — only sessions still in `running` are polled.
2. For each, calls `ghService.refresh(sessionId)`.
3. Tails the result and looks at the **most recent** PR (sorted by `pr_number`).
4. If `last_seen_check_state` transitions into `failure` for a **new `headSha`**, fires `launchFollowUp(context)`.

**Re-entrancy guard.** If a tick is still running (slow `gh` call), the next interval no-ops. Pile-up under bad network conditions would be worse than missing one tick.

**Failure dedup** is keyed on `(sessionId, prNumber, headSha)`. A new commit (new `head_sha`) earns a fresh follow-up; the same failed commit polled over and over does not. This matters when CI takes minutes to settle — the user shouldn't get five duplicate "checks failed" notifications.

## Follow-up launch

`main.ts` wires `launchFollowUp` to `ProviderSessionService.launch` with:

- The workspace's project's `default_provider` and `PROVIDER_MODEL_DEFAULTS[provider]` (so the user's configured model is used, not whatever ran originally).
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
