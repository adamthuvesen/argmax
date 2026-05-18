# Workspaces & review

Every task runs in its own git worktree. The renderer drives this via `window.argmax.workspaces.*` and `window.argmax.review.*`; main owns the disk.

## Creation

[src/main/workspaces/workspaceOrchestration.ts](../../src/main/workspaces/workspaceOrchestration.ts) — `WorkspaceService`.

Two flavors:

| Method | Behavior |
|---|---|
| `createIsolatedWorkspace({ projectId, taskLabel, baseRef? })` | New branch + new worktree directory under `project.settings.worktreeLocation`. Default base is `defaultBranch`, else `currentBranch`. |
| `createCurrentWorkspaceSession({ projectId, taskLabel })` | Shared workspace pointing at the repo's existing checkout — for in-place work without a new worktree. |

**Safety rails:**

- `baseRef` is rejected if it starts with `-` (prevents flag injection into `git`).
- The worktree directory is resolved through `realpath` and validated to stay inside `project.settings.worktreeLocation`. Any path that resolves outside is refused.
- All git shell-outs go through [src/main/git/exec.ts](../../src/main/git/exec.ts) (`runGitText` / `runGitBuffer`). Timeout, maxBuffer, and stderr-surfacing are enforced there; never bypass it.

## Status & watching

`WorkspaceService` keeps a per-workspace `fs.watch` handle on the worktree root. Bursts (e.g. `npm install`) are coalesced through a trailing-edge debouncer (`WATCH_DEBOUNCE_MS = 200`). When a debounce window settles, the service:

1. Refreshes `dirty` and `changed_files` via `git status --porcelain=v1`.
2. Updates `last_activity_at`.
3. Publishes a `dashboard:delta` carrying the updated `WorkspaceSummary`.

This is what makes the sidebar's change-count badge react to background tasks. The renderer's `workspaces.status()` call on `visibilitychange` is the backstop — fs.watch fires for in-process edits, the visibility-refresh covers edits that landed while the window was hidden. There is no recurring renderer poll.

## Lifecycle states

`WorkspaceState`: `created | running | waiting | blocked | complete | failed | cancelled | kept | archived`.

- `kept` is sticky — the user marked it for retention; subsequent runs won't auto-clean. `archiveWorkspace` also re-routes dirty worktrees into `kept` so user work never gets nuked silently.
- `archived` runs `git worktree remove` for isolated workspaces (after cancelling in-flight checks via the optional `cancelChecks` hook and re-checking porcelain to close the TOCTOU window) and keeps the row for history. Shared workspaces just close the watcher and mark the row archived — there's no worktree to remove.

## Review

[src/main/review/gitReviewService.ts](../../src/main/review/gitReviewService.ts) — read-only diff surface.

| Method | Returns |
|---|---|
| `listChangedFiles(workspaceId)` | `ChangedFileSummary[]` — `git status --porcelain=v1 -z`, then per-file `git diff HEAD -- <path>` (untracked files get a synthesized diff) fanned out at `DIFF_FANOUT_LIMIT = 8` |
| `loadDiff(workspaceId, filePath?)` | `WorkspaceDiff` — concatenated per-file diffs; all-files when `filePath` is omitted. Per-file content capped at `PER_FILE_DIFF_CAP_BYTES` (1 MiB) with a `[diff truncated …]` marker |

The renderer's review panel renders these in `ReviewPanel.tsx` with `DiffBlocks.tsx`.

## Checkpoints

[src/main/review/checkpointService.ts](../../src/main/review/checkpointService.ts) creates an in-place "save point" without touching the user's git history:

1. In parallel: `branch --show-current`, `rev-parse HEAD`, and build the patch via a temporary `GIT_INDEX_FILE` (`read-tree HEAD` → `add -A -- .` → `diff --binary --cached HEAD`) so untracked files are captured alongside tracked changes without touching the real index.
2. Write the patch to `${dataDirectory}/checkpoints/<id>.patch`.
3. Persist a `Checkpoint` row pointing at the patch and the captured git ref.

Checkpoints are deliberately one-way today — restoring a patch isn't surfaced in the UI yet. The pattern leaves room for a future "snap back" affordance.

## Git actions

[src/main/git/gitOpsService.ts](../../src/main/git/gitOpsService.ts) — `GitOpsService` owns the mutating branch actions behind the renderer's git dropdown:

| Method | Behavior |
|---|---|
| `commitAll(input)` | Stages selected files with `git add -- <paths>` or everything with `git add -A`, commits with the supplied message, then returns the new commit SHA + branch. |
| `push(input)` | Runs `git push`; on the first missing-upstream push, retries with `git push -u origin <branch>`. |
| `createBranch(input)` | Creates and checks out a new branch in the workspace. |
| `viewOrCreatePr(input)` | Opens the latest cached PR for the session when known, otherwise runs `gh pr create --fill` and refreshes the PR cache. |

Branch-name validation lives in the IPC schema, and git calls still use argv arrays plus `--` separators where git supports them. Keep new branch/PR actions here unless they grow their own lifecycle or background poller.

## File preview & inline editor

[src/main/files/workspaceFilesService.ts](../../src/main/files/workspaceFilesService.ts) — the file tree the renderer uses in the composer (`@path` references), the review panel (browse-files), and the inline CodeMirror editor.

- `listFiles(workspaceId)` returns the workspace file list, virtualized in the renderer (`SessionConversation` uses `@leeoniya/ufuzzy` for picker filtering).
- `readFile(workspaceId, filePath)` returns either `{ kind: "text", content, size }` or `{ kind: "skipped", reason: "binary" | "too-large" | "not-a-file", size? }`. The renderer surfaces the skip reason rather than trying to render binary blobs.
- `statFile(workspaceId, filePath)` returns `{ mtimeMs, size }` — used by the editor to detect upstream writes between read and save.
- `writeFile(workspaceId, filePath, content, expectedMtimeMs)` is mtime-checked: if the on-disk `mtimeMs` no longer matches `expectedMtimeMs`, the call returns `{ ok: false, reason: "stale", currentMtimeMs, size }` so the renderer can surface a "their changes vs yours" prompt instead of clobbering.

Each method has a `…ForProject` sibling (`listFilesForProject`, `readFileForProject`, `statFileForProject`, `writeFileForProject`) that resolves against `project.repoPath` instead of a workspace path — the renderer uses these for the project-level review-files surface and the shared-workspace flow.

Path resolution is validated through `workspacePaths` ([src/main/util/workspacePaths.ts](../../src/main/util/workspacePaths.ts)) to refuse escapes outside the worktree (and outside the repo root for the project variant).

## When to add a method here vs a new file

Route git work by ownership:

- Read-only diff/status surfaces belong in **`GitReviewService`**.
- Save-point patch creation belongs in **`CheckpointService`**.
- Mutating branch/commit/push/PR actions belong in **`GitOpsService`**.

All three should keep using the shared `runGitText` / `runGitBuffer` rails. Carve out a new service only when the feature owns its own lifecycle (a watcher, queue, external poller, or long-running process) — `WorkspaceService` is already that for worktrees.
