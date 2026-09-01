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

### Session Moves

`$ARGMAX_BIN session move --project <name-or-path>` schedules an explicit cross-project handoff from inside an active agent turn. When the turn settles, `WorkspaceService` creates a destination workspace, copies the timeline into a fresh session, and leaves the provider conversation id empty. The source workspace is never retargeted.

The destination uses the shared checkout by default. `--worktree` creates an isolated workspace and runs its setup command. The source archives after a successful copy unless `--keep-source` was passed. Archive never uses `force`, so an isolated source with uncommitted changes returns to `kept`.

`session.moved` marks the handoff in both timelines. The renderer follows the destination only when the source session is still selected.

## Scratch Workspaces

`workspaces:create-scratch` initializes temporary workspaces in `local-state/side-chats/` with an empty git repository to support providers that require a git root. The launcher selects this path through Chat on the Auto / Plan / Chat mode chip (Tab), which attaches no project.

`workspaces.kind` supports three kinds (migration v15):
- `git`: Standard repo checkouts (shared or isolated).
- `scratch`: User-facing side chats under the hidden `scratch-side-chats` project ID.
- `popup`: Ephemeral sessions used by the "More details" popup. Closing the popup terminates the session and deletes the temporary directory.

## Sidebar Priority Section

Workspaces with active attention (`approval-needed`, `blocked`, `failed`, or `review-ready`) and workspaces with a live turn share the Priority section beneath Pinned.

- Calculated client-side in [src/renderer/lib/priority.ts](../src/renderer/lib/priority.ts). Entries remain while working and for 30 minutes after the last message (`PRIORITY_IDLE_MS`).
- Order: working rows first (sorted by last message descending), followed by non-working rows (attention and manual adds) sorted by last message in descending order.
- Pinned status takes precedence over Priority.
- Right-click "Done" (`workspaces:set-priority-dismissed`) clears a priority item until new attention arrives. Manual adds (`workspaces:set-priority-added`) persist until cleared. A row that is only listed because its turn is running has no "Done" — it leaves when the turn ends — and the header's Clear skips it.
- The "Priority section in sidebar" setting hides the whole section, running rows included; they fall back to their date bucket or project group.

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

### Diff Context

Diffs carry git's default three lines of context. `parseUnifiedDiff` ([src/renderer/lib/diff.ts](../src/renderer/lib/diff.ts)) turns each between-hunk gap into an `omitted` block, which `DiffBlocks` renders as an "N unmodified lines" button. Clicking it re-requests the file with `contextLines` on `review:load-diff`, which becomes `git diff -U<n>`, climbing `DIFF_CONTEXT_STEPS` (25, then the whole file) until every gap is closed.

Context is per open file and resets when a different file is selected. Only a single-file request honors `contextLines`; the whole-workspace diff and the additions/deletions counts stay on git's default. `MAX_DIFF_CONTEXT_LINES` in [validation.rs](../src-tauri/src/ipc/validation.rs) rejects anything larger, and the renderer's diff cache is keyed by path *and* context so a wider request is never served the narrower cached diff.

Each per-file diff is capped at 1 MiB (`PER_FILE_DIFF_CAP_BYTES`). A capped diff loses whole trailing hunks, so the parser emits a `truncated` block for the marker `cap_diff` appends, `DiffBlocks` shows it as a warning row, and the expand buttons stop offering an action that would only drop more.

## Files

[src-tauri/src/files/workspace_files.rs](../src-tauri/src/files/workspace_files.rs) handles directory trees, file previews, mtime-checked writes, and content grep. Paths are verified through [workspace_paths.rs](../src-tauri/src/util/workspace_paths.rs) to prevent path traversal.

Tree icons use `@react-symbols/icons` with folder icons styled using `var(--accent)`.

The Files view is laid out as a sidebar plus an editor. [WorkspaceTree.tsx](../src/renderer/components/WorkspaceTree.tsx) virtualizes 24px rows and, given a `toolbar`, renders a titleless action strip above them holding collapse-all and refresh (`refreshList`, which re-lists the source — the automatic re-fetch only keys off the changed-files signature, so it misses files git never saw). The strip carries no label: the panel already names the source, and at rest its only job is keeping the first row off the review toolbar's edge. Rows carry a `--tree-depth` custom property that CSS turns into indent guides, and the folders enclosing the top visible row pin above the scroll window, sliding out as their subtree scrolls past.

The tree column sits on `--review-sidebar`, which steps *under* the preview surface in light and *above* it in dark — `--panel-sunken` is the darkest surface in the app, so a dark column set from it reads as a hole rather than a sidebar. Its width is a share of the panel (`LEFT_COL_AUTO_RATIO`, clamped) until the user drags the divider, which pins a pixel width in `argmax.reviewPanel.leftColumnWidth`. Past `PANEL_WIDE_BREAKPOINT` the panel sets `data-wide`, which labels the Changes/Files tabs. A status bar under both columns carries the open path, save state, language, line count, and the caret position the editor reports up through `onCursorChange`.

## Git

[src-tauri/src/git](../src-tauri/src/git) executes git commands via direct argv arguments for branching, commits, pushing, and pull request actions.
