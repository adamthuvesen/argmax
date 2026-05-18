# Approvals & checks

Two related-but-separate flows: **approvals** (an agent wants permission to run a command) and **checks** (the user runs a shell command against a workspace and watches the result).

## Risk policy

[src/main/approvals/dangerousActionPolicy.ts](../../src/main/approvals/dangerousActionPolicy.ts) — `classifyCommandRisk(command)` returns `{ requiresApproval, riskLevel, reason }`.

**High risk** (always requires approval). Matching is case-insensitive and tolerates split flags so a steered model emitting `RM -R -F` or `rm --recursive --force` still trips. `git push --force-with-lease` is intentionally **not** high — it falls through to the medium `git push` matcher.

| Pattern | Reason |
|---|---|
| `rm -rf` / `rm -fr` / split `rm -r -f` / `rm --recursive --force` | Recursive forced removal |
| `… \| sh` / `\| bash` / `\| zsh` etc. | Pipe to shell interpreter |
| `eval $(…)` / `source $(…)` / `. $(…)` | Eval of command substitution |
| `$(rm \| sudo \| chmod \| chown \| dd \| mkfs \| curl \| wget …)` / backtick variant | Destructive command substitution |
| `find … -delete` | find -delete |
| `dd … if=…` | dd block copy |
| `mkfs.*` | Filesystem creation |
| `chmod … 777` / `666` / world-writable bit | World-writable chmod |
| `git reset --hard` / `git reset` | History rewrite |
| `git clean -f…` | Forced clean |
| `git push --force` / `-f` / `--mirror` (not `--force-with-lease`) | Force push |
| `git branch -d` / `-D` | Branch deletion |
| `git worktree remove` | Worktree removal |
| `gh pr create` / `gh pr merge` / `gh pr close` | GitHub PR mutation |
| `sudo` (anchored to command boundary) | Privilege escalation |

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

1. Provider event normalizer detects a permission-gate event (Claude `SDKPermissionDeniedMessage`, Codex `item/{commandExecution,fileChange}/requestApproval`) and emits an `approval.requested` timeline event with `command`, `cwd`, and the inferred risk level.
2. `ApprovalService.requestCommandApproval(input)` re-classifies the command, persists a row to `approvals` (status: `pending`), flips the session to `waiting / approval-needed`, and writes the matching `approval.requested` timeline event — all three writes share one SQLite transaction. A `dashboard:delta` carries the result.
3. The renderer shows the approval in `SessionPane.tsx`; the user clicks Approve or Reject.
4. `approvals:resolve` calls `resolveApproval` which updates the row, transitions the session back to `running` (approved) or `blocked` (rejected) only if it's still in `waiting`, and writes an `approval.resolved` timeline event — also one transaction.

**Dedup.** `findPendingApproval` matches the full `(sessionId, command, cwd, provider)` tuple so the same agent retrying a command doesn't enqueue two approval rows; the second call returns the existing pending row inside the same transaction.

## Auto-approve mode

When `permissionMode === "auto-approve"` (the default — Argmax is a trusted single-user desktop app), the adapter passes the provider's bypass flag — Claude's `--permission-mode bypassPermissions`, Codex's `--dangerously-bypass-approvals-and-sandbox`, Cursor's `--force --trust`. The provider then runs unsupervised inside the worktree and never emits permission gates, so no `approval.requested` rows are written for normal tool calls in this mode. Switch to `ask-each-time` for live demos or shared machines.

The risk classifier still gates check commands the user invokes from the UI (see below), and it would catch any approval event a provider chose to emit anyway.

## Checks

[src/main/checks/checkService.ts](../../src/main/checks/checkService.ts) — `CheckService.runWorkspaceCheck`.

Spawned with `shell: true, detached: true` so the entire process group can be signalled. Pre-spawn guards and rails:

| Rail | Default |
|---|---|
| Pre-spawn risk gate | `classifyCommandRisk(command)` — `high` is refused outright (`rm -rf`, pipe-to-shell, etc.); `medium` (npm install, git commit, git push) is allowed because legit CI scripts run those |
| Env filtering | `filterSensitiveEnv(process.env)` strips `*_KEY` / `*_TOKEN` / `*_SECRET` / `*_PASSWORD` / `*_CREDENTIALS` / `AWS_*` / `AZURE_*` / `GOOGLE_*` / `GCP_*` / `OPENAI_*` / `ANTHROPIC_*` / `DATABASE_URL` before `spawn` so a typo'd check can't exfiltrate credentials |
| Wall-clock cap | 5 minutes (`CHECK_DEFAULT_TIMEOUT_MS`) |
| Cancellation | `AbortSignal` from the caller; kills the process tree |
| Timeout behavior | Same — kills the tree, records the row as `cancelled` with `"[timed-out]"` prefix on the summary so a future `EventType` extension can promote it without a data migration |
| Streaming | `onOutput(chunk)` is forwarded; does not affect persisted summary |
| Output cap | Accumulated stdout+stderr capped at `OUTPUT_TAIL_BYTES = 64 KiB` (oldest chunks dropped); summary persists the last 8 non-empty lines |
| Per-workspace tracking | `Map<workspaceId, Set<ChildProcess>>` so `cancelWorkspaceChecks(workspaceId)` (invoked from `WorkspaceService.archiveWorkspace`) can kill all in-flight checks for that workspace in one shot |

**SIGKILL escalation.** Kills route through `scheduleSigkillEscalation` from [src/main/processControl.ts](../../src/main/processControl.ts) — send SIGTERM to the negative pgid, give the child a grace window, then SIGKILL if it's still alive. This applies to provider PTYs and terminal-panel PTYs too.

The renderer surfaces check runs through `ChangedFilesCard` (mounted inside `SessionPane`). Check status (`queued | running | passed | failed | cancelled`) is reflected by the status pill via the same `data-status` attribute selectors used elsewhere — see [styling.md](styling.md).

## When to add a new high-risk pattern

Only when the existing patterns miss a class of irreversible action. Each addition slows the agent down on a real command, so weigh the user-visible impact. If the new pattern overlaps an existing one, prefer extending the existing entry instead of adding a near-duplicate.
