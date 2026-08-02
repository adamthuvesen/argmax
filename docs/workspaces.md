# Workspaces, Review, Files, Git

Rust owns workspace lifecycle and git operations.

## Workspaces

[src-tauri/src/workspaces](../src-tauri/src/workspaces) creates isolated/current workspaces, refreshes status, pins, archives, keeps, and opens IDEs. Watchers debounce filesystem changes and publish updated workspace deltas.

The launcher composer exposes this choice per launch via the "Worktree" toggle (off by default → current checkout), persisted to `localStorage` (`argmax.workspaceMode`). `worktree` calls `create_isolated` (forking `argmax/<slug>` from the live branch); `current` calls `create_current` (shared checkout). See [src/renderer/lib/workspaceMode.ts](../src/renderer/lib/workspaceMode.ts).

## Sidebar Priority section

The sidebar floats attention-worthy workspaces (session `attention` of `approval-needed`, `blocked`, `failed`, or `review-ready`; `archived`/`kept` excluded) into a Priority section above the pinned/date/project groups, sorted by severity then oldest-waiting. The selector is pure and client-side: [src/renderer/lib/priority.ts](../src/renderer/lib/priority.ts) joins `snapshot.sessions` attention onto workspaces, so it updates via normal `dashboard:delta` merges.

Right-click → "Mark as done" calls `workspaces:set-priority-dismissed`, stamping `workspaces.priority_dismissed_at`. A dismissal only suppresses the row while it is newer than the session's `attention_changed_at` (stamped in `update_session_state` whenever the attention value changes), so fresh attention re-promotes the workspace without any server-side clearing. The section is toggleable in Settings → General (`argmax.sidebar.priority.visible`, default on).

## Review

Changed files are listed and diffs are loaded for workspace or project targets
through one command surface in
[src-tauri/src/review/git_review.rs](../src-tauri/src/review/git_review.rs).

## Files

[src-tauri/src/files/workspace_files.rs](../src-tauri/src/files/workspace_files.rs) powers file tree, preview, mtime-checked writes, stats, and content grep. Every path resolves through [workspace_paths.rs](../src-tauri/src/util/workspace_paths.rs) to prevent traversal outside the workspace/project root.

## Git

[src-tauri/src/git](../src-tauri/src/git) exposes argv-only git execution plus commit, push, branch creation, and PR view/create actions. Do not shell-interpolate user-controlled git args.
