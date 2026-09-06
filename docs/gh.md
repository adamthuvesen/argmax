# GitHub CI Feedback

GitHub PR and check status is managed in Rust under [src-tauri/src/gh](../src-tauri/src/gh).

- [service.rs](../src-tauri/src/gh/service.rs): Runs `gh pr view <workspace.branch> --json …` and caches the result in SQLite. The row records the session that observed the PR and the PR's own head branch (`head_ref_name`).
- [poller.rs](../src-tauri/src/gh/poller.rs): Polls running sessions, sessions that completed in the last two minutes, and sessions with an open PR. Its transition ledger includes the PR lifecycle state, so an `OPEN` to `MERGED` change emits `dashboard:delta` even when the head SHA and checks are unchanged. It also triggers desktop notifications on check failures, can launch automated follow-up sessions on failure using project defaults, and archives a workspace whose PR has merged when its project asks for it.
- [src-tauri/src/util/gh_runner.rs](../src-tauri/src/util/gh_runner.rs): Subprocess runner interface for mocking in tests.

## The Check-Failure Follow-Up

One red commit gets one follow-up per *workspace*, not per session. Every session in a checkout resolves the same branch's PR, and the follow-up the poller launches is itself a session in that checkout — keyed per session, a single failure fires once per observer and doubles the observers on every tick. The guard is the in-memory ledger keyed `workspace:pr:head_sha` plus its persisted twin, `check_failure_launched_in_workspace`, which survives a restart mid-failure.

The launch also waits for the checkout to be free: while any session in the workspace is still running, the follow-up is deferred rather than dropped, because a second agent would edit the same tree the running one is mid-turn in and the sidebar resolves only one session per workspace. A still-failing PR is therefore re-evaluated on every tick, not only on the tick its state changed — a check that stays red offers no second transition to hang the retry on. Only a genuine state change publishes a `dashboard:delta`.

## Archive On Merge

Settings → Projects carries a per-project opt-in, `projects.archive_on_merge` (off by default, saved through `projects:update-settings`). With it on, the tick that sees the workspace's PR reach `MERGED` archives that workspace: the worktree goes, the local branch goes, the sidebar row goes. Without it a merged PR only repaints the marker, which is how eighteen finished worktrees came to sit on disk holding 29 GB.

The guards mirror the check-failure follow-up. The workspace is resolved at fire time, a ledger entry keyed `merged:workspace:pr` means one merge archives once however many sessions in the checkout observed it, and a busy workspace *defers* rather than drops — archiving cancels the agent's processes and removes the tree it is mid-turn in. A merged PR stays merged, so the hook cannot wait for a second transition; it is re-evaluated on every tick the session is still polled and deduped by the ledger instead. No persisted twin is needed: an archived workspace leaves the poll set on its own, and a restart mid-archive re-runs a no-op.

It acts on merges the poller sees, not on history: a workspace whose PR was already recorded as `MERGED` before the setting went on is out of the poll set entirely, so turning the setting on does not sweep up what has already piled up. Those are archived by hand.

The archive is never forced. A worktree with uncommitted changes returns to `kept`, and the poller logs that it did — work that outlived the PR is not ours to delete. See [workspaces.md](workspaces.md).

Isolated workspaces only. Archiving a shared checkout deletes nothing, so applying this there would not be cleanup — it would close a chat in a tree the user is still working in. The opt-in query excludes them ([projects.rs](../src-tauri/src/persistence/projects.rs)).

A pull request belongs to its head branch, not to whichever session happened to be mid-turn when the poller looked. Sidebar markers therefore attach by branch: a workspace shows the latest PR in its project whose `head_ref_name` matches the workspace's current branch. Isolated worktrees each have their own branch, so the creating session is the one that shows the icon. Shared checkouts on the same branch share it. Rows recorded before the branch was stored still attach to the observing workspace so a merged PR does not lose its marker.

Creating or viewing a PR from a session refreshes that session's cache and publishes the workspace immediately, so the sidebar does not wait for the next poller tick.

IPC channels:
- `prs:list-for-session`
- `prs:refresh`
- `git:view-or-create-pr`

The PR cache also retains GitHub's `createdAt` and `mergedAt` timestamps. Workspace summaries expose them as `prCreatedAt` and `prMergedAt` alongside the branch-matched PR number and state. The optional Appearance celebration uses those source timestamps to distinguish a new milestone from an old PR discovered after a delayed refresh. It defaults off and does not run on ordinary turn completion.
