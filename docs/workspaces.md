# Workspaces, Review, Files, Git

Rust manages workspace lifecycle, file operations, and git integration under `src-tauri/src/`.

## Workspaces

[src-tauri/src/workspaces](../src-tauri/src/workspaces) handles workspace creation, status polling, pinning, archiving, and IDE launching.

### Lifecycle & Watchers
- **Filesystem watchers:** Watchers are keyed by canonical checkout path so multiple sessions sharing a checkout share one watch. Events are debounced at 200 ms with a 1-second max interval. Changes inside `.git/objects`, `.git/lfs`, `.git/fsmonitor--daemon`, and `*.lock` are ignored.
- **Workspace modes:** The launcher offers two modes (stored in `localStorage.argmax.workspaceMode`):
  - `current`: Shared checkout (`create_current`).
  - `worktree`: Isolated worktree (`create_isolated`), branched as `argmax/<slug>-<short-id>`.
- **Setup commands:** For isolated worktrees, the project's configured setup command runs via `CheckService` after creation. Failures are recorded as check rows and do not block workspace creation.
- **Archiving:**
  - Shared checkouts mark `archived` immediately and drain child processes in the background.
  - Isolated worktrees mark `archiving`, cancel child processes, expire pending approvals, evict warm Cursor ACP instances, remove the git worktree, and persist `archived`. Dirty worktrees return to `kept` unless `force: true` is passed.

## Scratch Workspaces

`workspaces:create-scratch` initializes temporary workspaces in `local-state/side-chats/` with an empty git repository to support providers that require a git root.

`workspaces.kind` supports three kinds (migration v15):
- `git`: Standard repo checkouts (shared or isolated).
- `scratch`: User-facing side chats under the hidden `scratch-side-chats` project ID.
- `popup`: Ephemeral sessions used by the "More details" popup. Closing the popup terminates the session and deletes the temporary directory.

## Sidebar Priority Section

Workspaces with active attention (`approval-needed`, `blocked`, `failed`, or `review-ready`) appear in the Priority section beneath Pinned.

- Calculated client-side in [src/renderer/lib/priority.ts](../src/renderer/lib/priority.ts). Entries remain while working and for 30 minutes after the last message (`PRIORITY_IDLE_MS`).
- Pinned status takes precedence over Priority.
- Right-click "Done" (`workspaces:set-priority-dismissed`) clears a priority item until new attention arrives. Manual adds (`workspaces:set-priority-added`) persist until cleared.

## Custom Row Icons

Right-click → "Edit Icon" saves `workspaces.icon` and `workspaces.icon_color` via `workspaces:set-icon`. When a custom icon is active, status indicators move to a corner badge.

## Review

[src-tauri/src/review/git_review.rs](../src-tauri/src/review/git_review.rs) provides diff calculations and file lists.

### Comparison Scopes

| Scope | `ReviewComparison` | Git Range |
|---|---|---|
| All on branch (default) | `branch` | `merge-base(base_ref, HEAD)` → working tree + untracked |
| Committed | `committed` | `merge-base(base_ref, HEAD)..HEAD` |
| Uncommitted | `workingTree` | `HEAD` → working tree + untracked |
| Last turn | `branch` (client-filtered) | File-writing tool calls in the most recent turn |

Base ref resolution checks `workspace.base_ref`, then `origin/<default>`, then local `<default>`.

## Files

[src-tauri/src/files/workspace_files.rs](../src-tauri/src/files/workspace_files.rs) handles directory trees, file previews, mtime-checked writes, and content grep. Paths are verified through [workspace_paths.rs](../src-tauri/src/util/workspace_paths.rs) to prevent path traversal.

Tree icons use `@react-symbols/icons` with folder icons styled using `var(--accent)`.

## Git

[src-tauri/src/git](../src-tauri/src/git) executes git commands via direct argv arguments for branching, commits, pushing, and pull request actions.
