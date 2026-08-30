# GitHub CI Feedback

GitHub PR and check status is managed in Rust under [src-tauri/src/gh](../src-tauri/src/gh).

- [service.rs](../src-tauri/src/gh/service.rs): Executes `gh pr view --json ...` and caches PR status by session in SQLite.
- [poller.rs](../src-tauri/src/gh/poller.rs): Polls PR state for active and open PR sessions, emits `dashboard:delta` on status changes, triggers desktop notifications on check failures, and optionally launches automated follow-up sessions on failure using project defaults.
- [src-tauri/src/util/gh_runner.rs](../src-tauri/src/util/gh_runner.rs): Subprocess runner interface for mocking in tests.

IPC channels:
- `prs:list-for-session`
- `prs:refresh`
