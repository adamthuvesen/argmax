# GitHub CI Feedback

GitHub PR/check state is handled by Rust under [src-tauri/src/gh](../src-tauri/src/gh).

- [service.rs](../src-tauri/src/gh/service.rs) wraps `gh pr view --json ...` and caches PR rows by session.
- [poller.rs](../src-tauri/src/gh/poller.rs) polls running sessions, publishes `dashboard:delta` on status transitions, notifies on failures, and launches a follow-up provider session when checks fail. The follow-up uses the project's default provider and model (Settings → Projects); a project whose `defaultModelId` is still `''` falls back to the built-in per-provider default in `provider_defaults` ([lib.rs](../src-tauri/src/lib.rs)).
- [src-tauri/src/util/gh_runner.rs](../src-tauri/src/util/gh_runner.rs) is the shellout seam for tests.

Renderer IPC uses `prs:list-for-session` and `prs:refresh`.
