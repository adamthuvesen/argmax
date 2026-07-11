# Workspaces, Review, Files, Git

Rust owns workspace lifecycle and git operations.

## Workspaces

[src-tauri/src/workspaces](../src-tauri/src/workspaces) creates isolated/current workspaces, refreshes status, pins, archives, keeps, and opens IDEs. Watchers debounce filesystem changes and publish updated workspace deltas.

The launcher composer exposes this choice per launch via the "Worktree" toggle (off by default → current checkout), persisted to `localStorage` (`argmax.workspaceMode`). `worktree` calls `create_isolated` (forking `argmax/<slug>` from the live branch); `current` calls `create_current` (shared checkout). See [src/renderer/lib/workspaceMode.ts](../src/renderer/lib/workspaceMode.ts).

## Review

Changed files are listed and diffs are loaded for workspace or project targets
through one command surface in
[src-tauri/src/review/git_review.rs](../src-tauri/src/review/git_review.rs).

## Files

[src-tauri/src/files/workspace_files.rs](../src-tauri/src/files/workspace_files.rs) powers file tree, preview, mtime-checked writes, stats, and content grep. Every path resolves through [workspace_paths.rs](../src-tauri/src/util/workspace_paths.rs) to prevent traversal outside the workspace/project root.

## Git

[src-tauri/src/git](../src-tauri/src/git) exposes argv-only git execution plus commit, push, branch creation, and PR view/create actions. Do not shell-interpolate user-controlled git args.
