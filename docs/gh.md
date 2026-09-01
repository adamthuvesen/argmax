# GitHub CI Feedback

GitHub PR and check status is managed in Rust under [src-tauri/src/gh](../src-tauri/src/gh).

- [service.rs](../src-tauri/src/gh/service.rs): Runs `gh pr view <workspace.branch> --json …` and caches the result in SQLite. The row records the session that observed the PR and the PR's own head branch (`head_ref_name`).
- [poller.rs](../src-tauri/src/gh/poller.rs): Polls running sessions, sessions that completed in the last two minutes, and sessions with an open PR. Emits `dashboard:delta` on status changes, triggers desktop notifications on check failures, and optionally launches automated follow-up sessions on failure using project defaults.
- [src-tauri/src/util/gh_runner.rs](../src-tauri/src/util/gh_runner.rs): Subprocess runner interface for mocking in tests.

A pull request belongs to its head branch, not to whichever session happened to be mid-turn when the poller looked. Sidebar markers therefore attach by branch: a workspace shows the latest PR in its project whose `head_ref_name` matches the workspace's current branch. Isolated worktrees each have their own branch, so the creating session is the one that shows the icon. Shared checkouts on the same branch share it. Rows recorded before the branch was stored still attach to the observing workspace so a merged PR does not lose its marker.

Creating or viewing a PR from a session refreshes that session's cache and publishes the workspace immediately, so the sidebar does not wait for the next poller tick.

IPC channels:
- `prs:list-for-session`
- `prs:refresh`
- `git:view-or-create-pr`
