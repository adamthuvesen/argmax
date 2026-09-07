# GitHub CI Feedback

GitHub PR and check status is managed in Rust under [src-tauri/src/gh](../src-tauri/src/gh).

- [service.rs](../src-tauri/src/gh/service.rs): Resolves PRs from session branch context and explicit PR references, then caches the result in SQLite. GitHub state synchronizes across every cached row for the same project and PR number. Session attribution is recorded separately from that state.
- [poller.rs](../src-tauri/src/gh/poller.rs): Polls running sessions, sessions that completed in the last two minutes, and sessions with an open PR. Its transition ledger includes the PR lifecycle state, so an `OPEN` to `MERGED` change emits `dashboard:delta` even when the head SHA and checks are unchanged. It also triggers desktop notifications on check failures, can launch automated follow-up sessions on failure using project defaults, and archives a workspace whose PR has merged when its project asks for it.
- [src-tauri/src/util/gh_runner.rs](../src-tauri/src/util/gh_runner.rs): Subprocess runner interface for mocking in tests.

## The Check-Failure Follow-Up

One red commit gets one follow-up per *workspace*, not per session. Every session in a checkout resolves the same branch's PR, and the follow-up the poller launches is itself a session in that checkout — keyed per session, a single failure fires once per observer and doubles the observers on every tick. The guard is the in-memory ledger keyed `workspace:pr:head_sha` plus its persisted twin, `check_failure_launched_in_workspace`, which survives a restart mid-failure.

The launch also waits for the checkout to be free: while any session in the workspace is still running, the follow-up is deferred rather than dropped, because a second agent would edit the same tree the running one is mid-turn in and the sidebar resolves only one session per workspace. A still-failing PR is therefore re-evaluated on every tick, not only on the tick its state changed — a check that stays red offers no second transition to hang the retry on. Only a genuine state change publishes a `dashboard:delta`.

## Archive On Merge

Settings → Projects carries a per-project opt-in, `projects.archive_on_merge` (off by default, saved through `projects:update-settings`). With it on, the tick that sees the workspace's PR reach `MERGED` archives that workspace. Its checkout and branch are retained in the archive location and the sidebar row is hidden. This preserves local files but does not reclaim their disk space. Without it a merged PR only repaints the marker.

The workspace is resolved at fire time. A ledger entry keyed `merged:workspace:pr` means one merge archives once however many sessions in the checkout observed it. A busy workspace defers because archive drains its processes before moving the checkout. A merged PR stays merged, so the hook is re-evaluated on every tick while the session is still polled and deduped by the ledger. An archived workspace leaves the poll set on its own. Startup recovery validates a retained checkout and repairs Git registration after an interrupted move.

It acts on merges the poller sees, not on history: a workspace whose PR was already recorded as `MERGED` before the setting went on is out of the poll set entirely, so turning the setting on does not sweep up what has already piled up. Those are archived by hand.

The archive is never forced. A worktree with uncommitted changes returns to `kept`, and the poller logs that it did — work that outlived the PR is not ours to delete. See [workspaces.md](workspaces.md).

Isolated workspaces only. Archiving a shared checkout deletes nothing, so applying this there would not be cleanup — it would close a chat in a tree the user is still working in. The opt-in query excludes them ([projects.rs](../src-tauri/src/persistence/projects.rs)).

## PR Attribution

Isolated workspaces show the latest PR on their branch within the same project. Shared checkouts show only PRs attributed to their own session. Moving a shared checkout onto another branch cannot assign that branch's PR to an old session.

New sessions record their starting branch and the last branch observed while active. Shared-checkout discovery uses that saved branch after the session finishes. A new inferred association must match the saved branch. For a completed session, GitHub's PR creation time must be known and no later than completion. An association observed while active survives a later checkout change.

A PR reference in the session's command output, or its explicit view/create action, establishes explicit attribution. This also covers a PR opened from another checkout. Refreshing an already cached PR by number preserves its attribution instead of treating the refresh as new evidence.

Migration v37 leaves existing associations marked as legacy. Shared-checkout markers with only legacy evidence are hidden until an explicit reference confirms them. Historical branches cannot be reconstructed reliably from the checkout's current HEAD. Isolated workspaces retain branch lookup and their legacy session fallback.

Every observation synchronizes GitHub-owned fields across existing rows for the same project and PR number. A late OPEN response cannot overwrite MERGED. Notification bookkeeping remains per session and resets when the head commit changes. Dashboard publication includes affected observers and isolated workspaces on the PR branch, so a merge repaints their markers together.

The poller rechecks attributed open PRs by number after the checkout leaves their branch. Explicit PR observations and view/create actions refresh immediately and publish the affected workspace summaries.

IPC channels:
- `prs:list-for-session`
- `prs:refresh`
- `git:view-or-create-pr`

The PR cache also retains GitHub's `createdAt` and `mergedAt` timestamps. Workspace summaries expose them as `prCreatedAt` and `prMergedAt` alongside the attributed PR number and state. The optional Appearance celebration uses those source timestamps to distinguish a new milestone from an old PR discovered after a delayed refresh. It defaults off and does not run on ordinary turn completion.
