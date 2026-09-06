# GitHub CI Feedback

GitHub PR and check status is managed in Rust under [src-tauri/src/gh](../src-tauri/src/gh).

- [service.rs](../src-tauri/src/gh/service.rs): Runs `gh pr view <workspace.branch> --json …` and caches the result in SQLite. The row records the session that observed the PR and the PR's own head branch (`head_ref_name`).
- [poller.rs](../src-tauri/src/gh/poller.rs): Polls running sessions, sessions that completed in the last two minutes, and sessions with an open PR. Its transition ledger includes the PR lifecycle state, so an `OPEN` to `MERGED` change emits `dashboard:delta` even when the head SHA and checks are unchanged. It also triggers desktop notifications on check failures and can launch automated follow-up sessions on failure using project defaults.
- [src-tauri/src/util/gh_runner.rs](../src-tauri/src/util/gh_runner.rs): Subprocess runner interface for mocking in tests.

## The Check-Failure Follow-Up

One red commit gets one follow-up per *workspace*, not per session. Every session in a checkout resolves the same branch's PR, and the follow-up the poller launches is itself a session in that checkout — keyed per session, a single failure fires once per observer and doubles the observers on every tick. The guard is the in-memory ledger keyed `workspace:pr:head_sha` plus its persisted twin, `check_failure_launched_in_workspace`, which survives a restart mid-failure.

The launch also waits for the checkout to be free: while any session in the workspace is still running, the follow-up is deferred rather than dropped, because a second agent would edit the same tree the running one is mid-turn in and the sidebar resolves only one session per workspace. A still-failing PR is therefore re-evaluated on every tick, not only on the tick its state changed — a check that stays red offers no second transition to hang the retry on. Only a genuine state change publishes a `dashboard:delta`.

A pull request belongs to its head branch, not to whichever session happened to be mid-turn when the poller looked. Sidebar markers therefore attach by branch: a workspace shows the latest PR in its project whose `head_ref_name` matches the workspace's current branch. Isolated worktrees each have their own branch, so the creating session is the one that shows the icon. Shared checkouts on the same branch share it. Rows recorded before the branch was stored still attach to the observing workspace so a merged PR does not lose its marker.

Creating or viewing a PR from a session refreshes that session's cache and publishes the workspace immediately, so the sidebar does not wait for the next poller tick.

IPC channels:
- `prs:list-for-session`
- `prs:refresh`
- `git:view-or-create-pr`

The PR cache also retains GitHub's `createdAt` and `mergedAt` timestamps. Workspace summaries expose them as `prCreatedAt` and `prMergedAt` alongside the branch-matched PR number and state. The optional Appearance celebration uses those source timestamps to distinguish a new milestone from an old PR discovered after a delayed refresh. It defaults off and does not run on ordinary turn completion.
