# Approvals & checks

Two related-but-separate flows: **approvals** (an agent wants permission to run a command) and **checks** (the user runs a shell command against a workspace and watches the result).

## Risk policy

[src/main/approvals/dangerousActionPolicy.ts](../../src/main/approvals/dangerousActionPolicy.ts) — `classifyCommandRisk(command)` returns `{ requiresApproval, riskLevel, reason }`.

**High risk** (always requires approval):

| Pattern | Reason |
|---|---|
| `rm -rf` / `rm -fr` / `rm -rf*` variants | Recursive forced removal |
| `git reset --hard` / `git reset` | History rewrite |
| `git clean -f…` | Forced clean |
| `git push --force` / `-f` / `--mirror` | Force push |
| `git branch -d` / `-D` | Branch deletion |
| `git worktree remove` | Worktree removal |
| `gh pr create` / `gh pr merge` | GitHub PR mutation |
| `sudo` | Privilege escalation |

**Medium risk** (requires approval; less destructive):

| Pattern | Reason |
|---|---|
| `git add`, `git commit`, `git merge`, `git rebase`, `git checkout`, `git push` | State / remote mutation |
| `chmod`, `chown` | Permission mutation |
| `npm/pnpm/yarn/bun install/add/remove` | Dependency mutation |

**Low risk** (no approval) — everything else.

The classifier is conservative and pattern-based. It does not parse subshells, `eval`, or compound commands; an agent that wants to bypass would have to actively obfuscate, which is a separate failure mode. Don't widen the patterns to handle pathological cases — the renderer's approval UI is the human-in-the-loop fallback.

## Approval flow

[src/main/approvals/approvalService.ts](../../src/main/approvals/approvalService.ts) — `ApprovalService`.

1. Provider event normalizer detects a permission-gate event (Claude `permission_request`, Codex equivalent) and emits an `approval.requested` timeline event with `command`, `cwd`, and the inferred risk level.
2. `ApprovalService.request(input)` persists a row to `approvals` (status: `pending`) and publishes a `dashboard:delta` carrying the new approval.
3. The renderer shows the approval in `SessionPane.tsx`; the user clicks Approve or Reject.
4. `approvals:resolve` updates the row and pushes an `approval.resolved` timeline event back through the running provider session so it can continue (or abort) its current tool call.

**Dedup.** `findPendingApproval` matches `(sessionId, command)` so the same agent retrying a command doesn't enqueue two approval rows; the second call returns the existing pending row.

## Auto-approve mode

When `permissionMode === "auto-approve"`, the adapter passes the provider's bypass flag (see [providers.md](providers.md#permission-modes)). Argmax does **not** intercept commands in this mode — the provider runs unsupervised inside the worktree. The risk classifier still emits `approval.requested` for the timeline, but the approval row is auto-resolved to `approved` so the chat stays consistent.

This is the default for trusted single-user local installs. Switch to `ask-each-time` for live demos or shared machines.

## Checks

[src/main/checks/checkService.ts](../../src/main/checks/checkService.ts) — `CheckService.runWorkspaceCheck`.

Spawns the command in the workspace's cwd with these rails:

| Rail | Default |
|---|---|
| Wall-clock cap | 5 minutes (`DEFAULT_TIMEOUT_MS`) |
| Cancellation | `AbortSignal` from the caller; kills the process tree |
| Timeout behavior | Same — kills the tree, records the row as `cancelled` with `"[timed-out]"` prefix on the summary so a future `EventType` extension can promote it without a data migration |
| Streaming | `onOutput(chunk)` is forwarded; does not affect persisted summary |
| Per-workspace tracking | `Map<workspaceId, Set<ChildProcess>>` so the workspace archive path can kill all in-flight checks for that workspace in one shot |

**SIGKILL escalation.** Kills route through `scheduleSigkillEscalation` from [src/main/processControl.ts](../../src/main/processControl.ts) — send SIGTERM, give the child a grace window, then SIGKILL if it's still alive. This applies to provider PTYs too.

The renderer surfaces check runs in the workspace status panel and the `ReviewPanel`. Check status (`queued | running | passed | failed | cancelled`) is reflected by the status pill via the same `data-status` attribute selectors used elsewhere — see [styling.md](styling.md).

## When to add a new high-risk pattern

Only when the existing patterns miss a class of irreversible action. Each addition slows the agent down on a real command, so weigh the user-visible impact. If the new pattern overlaps an existing one, prefer extending the existing entry instead of adding a near-duplicate.
