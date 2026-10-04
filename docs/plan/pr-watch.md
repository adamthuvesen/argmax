# PR Watch and PR Cleanup

## Problem

The `ship --babysit` skill tells every agent to poll GitHub itself on a 30 second
loop. Across about 750 Argmax sessions that produced about 800 `sleep` calls,
about 330 `until`/`while` loops, 81 Bash timeouts, and repeated harness blocks on
long `sleep`. Each provider polls in its own way, and Grok needs a bundled
script. After the merge the user types "merged, let's clean up" (about 46 times),
and the agent spends a turn on deterministic git work.

Argmax already polls every session's PR in Rust (`gh/poller.rs`) and can wake
any provider's session with `send_system_notice`. The agent should not poll.

## Outcome

1. An agent calls `pr_watch` once and ends its turn. Argmax polls that PR and
   wakes the session with one notice when there is something to act on.
2. After the merge, `pr_cleanup` (agent tool and a button on the merged PR row)
   runs the cleanup in Rust and returns a report. A watch can run it
   automatically on merge.
3. The behavior is the same for Claude Code, Codex, Cursor Agent, OpenCode,
   and Grok, because both paths go through the session control socket and the
   inbox.

## Terms

- **PR watch:** a persisted request from one session to be woken about one PR
  until it merges, closes, or is unwatched. Add it to `CONTEXT.md`.
- **Watch notice:** the `send_system_notice` message a PR watch sends.
- **PR cleanup:** the post-merge git work below. It never removes the chat's
  checkout unless the caller asks to archive the chat.

## PR Watch

### Tool

`pr_watch` with `pr?` (number; default: the caller's primary session PR) and
`cleanupOnMerge?` (bool, default false). Archiving stays with the project's
existing `archive_on_merge` setting and the `workspace_archive` tool. Returns `{projectId, prNumber, url,
headSha, watching: true}`. Calling it again for the same session and PR updates
the options and keeps the cursors.

`pr_unwatch` with `pr?`. Returns `{removed: bool}`.

Errors: no PR resolvable (`PR_NOT_FOUND`), PR already merged or closed
(`PR_NOT_OPEN`), scratch project (`PROJECT_NOT_ALLOWED`).

### Persistence

Migration v62, table `pr_watches`:

| column | meaning |
|---|---|
| `id` | primary key |
| `session_id` | the session to wake |
| `project_id`, `pr_number` | the PR; unique with `session_id` |
| `cleanup_on_merge` | option |
| `head_sha` | head the cursors belong to |
| `seen_check_failures` | JSON list of `name@sha` already reported |
| `seen_feedback_ids` | JSON list of review, comment, and thread-comment ids already reported |
| `reported_ready_sha` | head for which "checks green" was reported |
| `last_pr_updated_at` | GitHub `updatedAt` at the last thread fetch |
| `created_at`, `updated_at` | |

On creation, seed `seen_feedback_ids` with every existing id. The agent reads
existing feedback itself when it starts babysitting, as the skill already says.

### Polling

- No second cadence. The existing 60 second tick is the only writer of
  `gh_pull_requests`, so the transition snapshot (`prior_pr_states`, taken at
  the top of `tick_once`) stays valid for Arc events and the follow-up. A
  second pass would write those rows between the snapshot and
  `detect_transition` and swallow Arc `merged` and `checks failing` events.
- A session with a watch is always due: it skips `open_pr_backoff` and the
  workspace-state filter, so a watch on an archived workspace still runs.
- After the fanout, the tick runs the watch step for each watched PR, from the
  same refreshed rows and the same snapshot:
  - `gh pr view <n> --json` adds `reviews,comments,reviewRequests,updatedAt,
    mergeCommit` to the existing fields. Keep each review's `commit.oid` so
    the agent can tell which head a bot reviewed.
  - `gh api graphql` for `reviewThreads` (id, isResolved, path, line, and the
    comments' id, author login and type, body, url), only when `updatedAt` or
    the head changed since the last fetch.
- Extend `RollupEntry` with `name`, `workflowName`, `detailsUrl`, so failing
  checks carry names and links. `collapse_rollup` stays as it is.
- On a rate-limit error category, skip that PR's watch step for the tick.

### Events

Each pass compares the fetch with the watch's cursors and sends at most one
notice that lists every new event, in this order:

1. **Merged** or **closed.** The watch is removed after the notice. For merged
   with `cleanupOnMerge`, run PR cleanup first and put its report in the notice.
2. **Head changed.** Reset `seen_check_failures` and `reported_ready_sha`.
   Not a wake by itself; the agent pushed it.
3. **Checks failing:** each failing check `name@sha` not yet reported, with its
   `detailsUrl`.
4. **New feedback:** each new review (author, state, first line), PR comment,
   and review-thread comment (author, `path:line`, first line, url). Mark bot
   authors (`[bot]` suffix or `__typename == "Bot"`).
5. **Checks green:** no failing or pending checks on the head, once per head.
   The notice lists unresolved review threads and pending reviews so the agent
   can apply the merge gate. Argmax does not decide the merge.

Notice id: `pr-watch:<watchId>:<headSha7>:<hash of event keys>`, so a restart
or a second tick cannot repeat it. Advance the cursors only after
`send_system_notice` stores the message: the message row and the cursor update
commit together, or a crash between them would drop events. Body is plain text under 4,000 characters;
long lists end with "and N more". First line:
`PR #<n> (<title>): <summary of event kinds>.` Last line: `<url>`.

### Overlap

- A PR with a watch suppresses the check-failure follow-up for that PR. The
  watching session owns the fix. Live Arc events are unchanged.
- The ordinary 60 second poller keeps running; the watch pass only adds
  cadence and events for watched PRs.

## PR Cleanup

One Rust service function, called by the `pr_cleanup` tool, the IPC command
`prs:cleanup`, and the watch on merge. Input: session and PR number.

Cleanup never archives or hides the chat. It keeps the chat's checkout, and a
branch that a worktree has checked out. The report says what was kept.

1. Refresh the PR. Refuse unless it is `MERGED`. Record `headRefOid` as the
   merged head and `mergeCommit.oid` as the merge commit.
2. Remote branch: skip when the head repository owner differs from `origin`'s
   owner (a fork PR). Otherwise check `git ls-remote --heads origin <branch>`;
   if it still exists (GitHub auto-delete may have removed it), delete it with
   `git push --force-with-lease=refs/heads/<branch>:<merged head> origin --delete <branch>`.
   A stale-info rejection keeps the branch and reports the divergence.
3. Base: find the worktree that has the base branch checked out (normally the
   project's main checkout). If it is clean and no session in it is running,
   `git pull --ff-only`. Otherwise skip and report why.
4. Local branch: delete it only if no worktree has it checked out, its tip
   equals the merged head, and it has no later commits. The chat's own isolated
   worktree normally has it checked out, so it stays.
5. `git remote prune origin`.

On merge, the watch runs cleanup in its pass, before the merged notice.
Archive on merge waits for that watch to end, so cleanup finishes before
archive-on-merge moves the checkout.

Take `checkout_write_lock` for every checkout it writes. Compare worktree paths
with `comparable_worktree_path`. Return a report:

```
PR #72 merged as abc1234 (head def5678)
Remote: origin/fix-parser deleted
Base: main fast-forwarded in /path/to/repo
Local: fix-parser kept (checked out by this chat's worktree)
Chat: kept, checkout /path/to/worktree kept
```

### UI

A single "Clean up" action on a merged PR row in `WorkspaceCard.tsx`. The
report shows as a toast.

## Skill change (dotfiles)

`ship/references/babysit.md` gets an Argmax path before the polling steps: in
Argmax, call `pr_watch` with `cleanupOnMerge: true` and end the turn; act on
each watch notice with the existing state machine; do not poll. The polling
steps stay for other environments.

## Phases

1. PR watch: migration, `pr_watch`/`pr_unwatch`, always-due watched sessions,
   the watch step, events (merged/closed, checks failing, new feedback, checks
   green), follow-up suppression, `RollupEntry` names, tests, docs
   (`agent-tools.md`, `gh.md`, `data.md`, `CONTEXT.md`), and an ADR.
2. PR cleanup: git helpers, service, `pr_cleanup` tool, `prs:cleanup` IPC,
   "Clean up" action on a merged PR row, `cleanupOnMerge`, tests, docs
   (`workspaces.md`, `gh.md`).
3. Skill update in dotfiles, landed the same day as phase 1.

Cut for now: a stall notice and an archive option on the watch.

## Checks

- `cargo test` for the poller watch pass (each event, dedupe across ticks and
  restart, archived workspace, rate limit, Arc events still fire for a watched
  PR), the tool handlers, and cleanup
  against a temp git repo with a bare remote (merged, diverged remote, dirty
  or busy base, branch checked out elsewhere, fork PR, branch already
  auto-deleted).
- `npm run precheck`, `npm run test:rust`, `npm run test:unit`,
  `npm run check:tauri-bridge`.
- Live: `verify-argmax` in an isolated dev instance on a throwaway PR.
