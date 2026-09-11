# Workspaces, Review, Files, Git

Rust manages workspace lifecycle, file operations, and git integration under `src-tauri/src/`.

## Workspaces

[src-tauri/src/workspaces](../src-tauri/src/workspaces) handles workspace creation, status polling, pinning, archiving, and IDE launching.

### Lifecycle & Watchers
- **Filesystem watchers:** Watchers are keyed by canonical checkout path so multiple sessions sharing a checkout share one watch. Linked worktrees also watch their external Git metadata directory, so branch and index changes update the card and composer even when no working files change. Events are debounced at 200 ms with a 1-second max interval. Changes inside `.git/objects`, `.git/lfs`, `.git/fsmonitor--daemon`, and `*.lock` are ignored.
- **Workspace modes:** The launcher offers two modes (stored in `localStorage.argmax.workspaceMode`):
  - `current`: Shared checkout (`create_current`).
  - `worktree`: Isolated worktree (`create_isolated`), branched as `argmax/<slug>-<short-id>`.
  Agent `session_launch` can also attach to an existing checkout (`path`) or fork an isolated worktree from a named `branch`. See [agent-tools.md](agent-tools.md).
- **Setup commands:** For isolated worktrees, the project's configured setup command runs via `CheckService` after creation. Failures are recorded as check rows and do not block workspace creation.
- **Archiving:**
  - Successful archives quietly leave the active list. Recovery access lives in Settings, while notifications are reserved for failures or changes that need attention.
  - Shared checkouts mark `archived` immediately and drain child processes in the background.
  - Isolated worktrees mark `archiving`, cancel child processes, expire pending approvals, evict warm Cursor ACP instances, and use `git worktree move` to retain the complete checkout under `local-state/workspace-archive/<workspace-id>`. The moved checkout stays registered with Git, so tracked, untracked, and ignored files remain available. Settings → Advanced → Diagnostics → Archived workspaces opens the recovery root.
  - Dirty worktrees return to `kept` unless `force: true` is passed. An `archive-failed` retry never implies force. The renderer confirms against the current dirty state before retrying with force.
  - A worktree can carry more than one workspace row — a multitask dispatched from a chat inside it shares that checkout ([multitask.md](multitask.md)), and `session_launch` with `path` can share one the same way. Only the isolated row owns the tree, so archiving it archives every co-located row first, before the move; otherwise they would point at nothing, never reclassify (both reconcile branches skip shared rows), and keep a watcher and an agent alive over the archive location. If one of them still has a turn in flight the archive is refused, naming that workspace, unless `force: true` is passed. `session move --path` refuses to create this shape in the first place.
  - Archive recovery has no automatic expiry. Repeating an archive after the row reaches `archived` returns the same recovery path. Startup recovery recognizes a checkout already moved into its deterministic recovery path and completes the interrupted archive without moving or deleting it again.
  - Archiving is also how a workspace is disposed of automatically. A project with `archive_on_merge` on (Settings → Projects) has each of its *isolated* workspaces archived by the gh poller once the PR on that workspace's branch merges, never forced — see [gh.md](gh.md).
  - An agent can ask for the same thing from inside: the `workspace_archive` MCP tool archives the caller's own workspace once its turn settles, which is how `ship`'s babysit mode disposes of a worktree it is standing in without pulling the floor out from under itself — see [agent-tools.md](agent-tools.md).
  - Stopping a chat within 10 seconds of launch is an undo of a mistaken start: the pane returns to the composer, and the workspace is force-archived so no cancelled row stays in the sidebar. Docked multitasks and details popups are excluded. See [earlyStop.ts](../src/renderer/lib/earlyStop.ts).

### Session Moves

`$ARGMAX_BIN session move (--project <name-or-path> | --path <checkout>) --prompt <what-to-do-there>` schedules an explicit handoff from inside an active agent turn. When the turn settles, `WorkspaceService` creates a destination workspace and copies the timeline into a fresh session. The source workspace is never retargeted: a workspace's `path` is write-once, so landing somewhere new always means a new row.

Exactly one destination is required. `--project` moves to another registered project. `--path` moves to another checkout of the *same* project — any directory `git worktree list` reports for its repository, including the main one. That is the supported answer to "this work belongs in a different worktree"; running `cd` inside a tool call only moves the agent's shell, leaving the workspace, its diff, and its commit and pull-request actions pointed at the checkout the session started in, and the next turn relaunches back there.

Every provider's launch instructions and the MCP server instructions require
`session_move` with `path` and a continuation `prompt` when continuing in another
checkout. The agent then ends its turn so the handoff can run. Command `workdir`
and `git -C` overrides also leave the chat's checkout unchanged. Branch switches
within the same checkout use Git normally and flow through the status watcher.

A `--path` destination is validated against the project's own `git worktree list`, so an arbitrary directory is refused rather than attached. It is always recorded as a shared checkout (`shared_workspace = 1`): Argmax did not create that worktree, so archiving the workspace must never delete it. A detached HEAD is refused too — a workspace records the branch it sits on.

The prompt is required because a move relocates work in progress: it starts the destination chat's first turn there, so the chat carries on in the new checkout instead of waiting for a person. The destination keeps the source's launch lineage, so whoever dispatched the chat still hears when it finishes and the launch caps still count it. A chat that has arrived somewhere by moving more than three times stops continuing on its own and says so. See [agent-tools.md](agent-tools.md).

A `--project` destination uses that project's shared checkout by default; `--worktree` creates an isolated workspace and runs its setup command. The source archives after a successful copy unless `--keep-source` was passed. Archive never uses `force`, so an isolated source with uncommitted changes returns to `kept`.

A cross-project move always leaves the provider conversation id empty. A `--path` move carries it where the provider supports that, so the same work continues in the new worktree instead of starting cold — see [providers.md](providers.md#session-moves-and-the-provider-conversation).

`session.moved` marks the handoff in both timelines; its payload carries `checkoutMode` (`shared`, `worktree`, or `attached`) and `conversationCarried`. The renderer follows the destination only when the source session is still selected.

## Scratch Workspaces

`workspaces:create-scratch` initializes temporary workspaces in `local-state/side-chats/` with an empty git repository to support providers that require a git root. The launcher selects this path through Chat on the mode chip (Tab cycles Auto / Plan / Chat), which attaches no project.

`workspaces.kind` supports three kinds (migration v15):
- `git`: Standard repo checkouts (shared or isolated).
- `scratch`: User-facing side chats under the hidden `scratch-side-chats` project ID.
- `popup`: Ephemeral sessions used by the "More details" popup. Closing the popup terminates the session and deletes the temporary directory.

## Sidebar Priority Section

Workspaces holding at least one live **reason**, and workspaces with a live turn, share the Priority section beneath Pinned. A reason is one claim on the reader with its own answer to "what makes this go away", which is what keeps the section from being a feed of everything that finished recently.

| Reason | Raised by | Cleared by |
| --- | --- | --- |
| `approval-needed` | a pending approval | the decision |
| `question-asked` | an unanswered `AskUserQuestion` / `ExitPlanMode` (see [chat-cards.md](chat-cards.md)) | answering it |
| `blocked` | session `blocked` / `waiting` | 30 minutes of silence |
| `failed` | session `failed` | 30 minutes of silence |
| `ci-red` | the attributed PR's check rollup at `failure` ([gh.md](gh.md)) | checks going green, or the PR closing |
| `review-ready` | a completed turn **whose reply is still unread** | opening the chat, or 30 minutes of silence |
| `pr-open` | the attributed PR at `OPEN` | the PR merging or closing |

- Calculated client-side in [src/renderer/lib/priority.ts](../src/renderer/lib/priority.ts). Only the reasons a clock can resolve carry `PRIORITY_IDLE_MS` (30 minutes from the last message); an approval, a question, a red check and an open PR are all still true half an hour later, so they wait for the event that ends them. A row leaves once *every* reason holding it has lapsed.
- Reading is asymmetric: opening a chat resolves `review-ready` and nothing else. Unread state is this device's own (`localStorage`, see [sessionUnread.ts](../src/renderer/lib/sessionUnread.ts)), so the phone and the desktop disagree about what has been read.
- Order: working rows first, then by the strength of the strongest reason (the table above is that order), then by last message descending. The row's accessible title names that strongest reason.
- Pinned status takes precedence over Priority.
- Right-click "Done" (`workspaces:set-priority-dismissed`) clears every reason that was already true, and nothing that happens afterwards: a PR going red after a dismissal brings the row back, because `ci-red` is newer than the dismissal. Each reason carries its own `since` for that comparison — a session reason uses `attention_changed_at`, a PR reason the poller's `pr_activity_at`. Manual adds (`workspaces:set-priority-added`) persist until cleared. A row that is only listed because its turn is running has no "Done" — it leaves when the turn ends — and the header's Clear skips it.
- The "Priority section in sidebar" setting hides the whole section, running rows included; they fall back to their date bucket or project group.

## Custom Row Icons

Right-click → "Edit Icon" saves `workspaces.icon` and `workspaces.icon_color` via `workspaces:set-icon`. When a custom icon is active, status indicators move to a corner badge.

A chat that produced a response while it was not the open row shows an unread mark: an accent-colored dot (`--accent`) in the leading-glyph cell, replacing the custom icon or status marker. Opening the chat clears it and puts the icon back. A turn in flight keeps the working nest instead; the unread dot waits until that turn ends. Stamps live in `localStorage.argmax.sidebar.viewedAt` so existing history does not light up on first sight.

An attributed pull request replaces the default status marker with a GitHub PR glyph: green while open, violet once merged. Isolated workspaces resolve PRs by branch. Shared checkouts require session evidence and retain their recorded branch context after completion, so later checkout changes cannot assign another session's PR to an old chat. See [gh.md](gh.md) for attribution and legacy-cache behavior.

## Review

The review panel can show two views stacked vertically. Right-click a view tab and choose **Split below**, or drag a tab onto the upper or lower half of the panel. Drag the divider to resize the views, or focus it and use the arrow keys. Each view appears once. Selecting a tab already shown in the other half swaps the views. Actions from the chat use the half where the requested view is already visible. Closing either half expands the remaining view.

The session review panel remembers its visibility, view arrangement, and divider position per session in localStorage. Returning to a chat or restarting the app restores them. Closing the whole sidebar preserves the arrangement for its next open. Full-screen review surfaces keep their explicit initial visibility and a single view.

Layouts live in `argmax.reviewPanel.layout.<sessionId>`. The launcher uses one shared `argmax.reviewPanel.layout.launcher` preference across projects. Existing single-mode session preferences remain the fallback until a layout is saved.

[src-tauri/src/review/git_review.rs](../src-tauri/src/review/git_review.rs) provides diff calculations and file lists.

### Comparison Scopes

| Scope | `ReviewComparison` | Git Range |
|---|---|---|
| All on branch (default) | `branch` | `merge-base(base_ref, HEAD)` → working tree + untracked |
| Committed | `committed` | `merge-base(base_ref, HEAD)..HEAD` |
| Uncommitted | `workingTree` | `HEAD` → working tree + untracked |
| Last turn | `branch` (client-filtered) | File-writing tool calls in the most recent turn |

Base ref resolution checks `workspace.base_ref`, then `origin/<default>`, then local `<default>`.

### Review actions

The Uncommitted comparison offers file and hunk staging, unstaging, and reverting.
Every mutation carries the displayed revision. Rust reconstructs the patch and
checks HEAD, index, and working-tree state under the canonical checkout lock.
An obsolete revision fails with a refresh instruction. Another session working in
the same checkout does not reserve the tree: sharing a checkout is the normal
case, and the revision check is what catches an action taken against a tree that
has moved on. Untracked files can be staged as whole files. Their preview hunks
and rename hunks are not actionable. Files with both staged and unstaged edits
use whole-file index actions because their combined preview does not represent
one index patch.

Reverting restores unstaged changes and saves a recovery checkpoint first.
Untracked file deletion remains a Files action. **Commit staged** commits the
existing index, including partial staging. It requires a commit message.

### Revert to a turn

Every provider turn in a Git workspace is preceded by an automatic checkpoint,
recorded against the id of the user message it answers. That anchor is what puts
**Revert** in a finished turn's footer, beside Copy and Fork: the turn finds its
own checkpoint instead of the user picking from a list of identically named
rows. There is no checkpoint panel and nothing to name — checkpoints are
plumbing, and the turn is the thing you point at.

A capture that fails never blocks the turn. The turn runs and its footer says no
checkpoint was saved, so a checkout Argmax cannot snapshot still gets its work
done.

Each checkpoint pins the index and visible working tree as Git trees, including
non-ignored untracked files. Reverting previews the affected paths first and
binds the restore to the current HEAD, branch, index, and worktree. Restoring is
the one action that still requires idle sessions on the same checkout, because it
overwrites files another agent may be editing right now. It also requires
matching HEAD and branch, saves a recovery checkpoint, journals the operation,
and restores the index and files, so the revert is itself undoable. Interrupted
restores remain recoverable through that checkpoint. Unresolved merges and
submodules are unsupported.

**Revert restores files, not the conversation.** No provider CLI can resume from
an earlier message — each takes one opaque conversation id and continues from
its end — so rewinding the transcript would be a promise the backend cannot
keep. The conversation stays as the record of what was tried, and Fork is the
escape hatch for a clean continuation. Settings → Agents → Conversation turns
the action off.

### Diff Notes

To add a diff note, click the line-number gutter or drag it across multiple lines within a hunk. The selected lines highlight as you drag, and releasing opens the comment form below the range. Dragging upward works too. Escape cancels a selection or an open form. Expand omitted context first to select across a gap.

The composer chip and submitted note retain the range. Quoted ranges include diff markers so removed and added code remain distinguishable, with both endpoint sides recorded when the range crosses between them.

### Diff Context

Diffs carry git's default three lines of context. `parseUnifiedDiff` ([src/renderer/lib/diff.ts](../src/renderer/lib/diff.ts)) turns each between-hunk gap into an `omitted` block, which `DiffBlocks` renders as an "N unmodified lines" button. Clicking it re-requests the file with `contextLines` on `review:load-diff`, which becomes `git diff -U<n>`, climbing `DIFF_CONTEXT_STEPS` (25, then the whole file) until every gap is closed.

Context is per open file and resets when a different file is selected. Only a single-file request honors `contextLines`; the whole-workspace diff and the additions/deletions counts stay on git's default. `MAX_DIFF_CONTEXT_LINES` in [validation.rs](../src-tauri/src/ipc/validation.rs) rejects anything larger, and the renderer's diff cache is keyed by path *and* context so a wider request is never served the narrower cached diff.

Each per-file diff is capped at 1 MiB (`PER_FILE_DIFF_CAP_BYTES`). A capped diff loses whole trailing hunks, so the parser emits a `truncated` block for the marker `cap_diff` appends, `DiffBlocks` shows it as a warning row, and the expand buttons stop offering an action that would only drop more.

## Files

[src-tauri/src/files/workspace_files.rs](../src-tauri/src/files/workspace_files.rs) handles directory trees, file previews, mtime-checked writes, and content grep. Paths are verified through [workspace_paths.rs](../src-tauri/src/util/workspace_paths.rs) to prevent path traversal.

Tree icons use `@react-symbols/icons` with folder icons styled using `var(--accent)`.

The Files view is laid out as a sidebar plus an editor. [WorkspaceTree.tsx](../src/renderer/components/WorkspaceTree.tsx) virtualizes 24px rows and, given a `toolbar`, renders a titleless action strip above them holding collapse-all and refresh (`refreshList`, which re-lists the source — the automatic re-fetch only keys off the changed-files signature, so it misses files git never saw). The strip carries no label: the panel already names the source, and at rest its only job is keeping the first row off the review toolbar's edge. Rows carry a `--tree-depth` custom property that CSS turns into indent guides, and the folders enclosing the top visible row pin above the scroll window, sliding out as their subtree scrolls past.

The tree column sits on `--review-sidebar`, which steps *under* the preview surface in light and *above* it in dark — `--panel-sunken` is the darkest surface in the app, so a dark column set from it reads as a hole rather than a sidebar. Its width is a share of the panel (`LEFT_COL_AUTO_RATIO`, clamped) until the user drags the divider, which pins a pixel width in `argmax.reviewPanel.leftColumnWidth`. Past `PANEL_WIDE_BREAKPOINT` the panel sets `data-wide`, which labels the Changes/Files tabs. A status bar under both columns carries the open path, save state, language, line count, and the caret position the editor reports up through `onCursorChange`.

Images are the one file kind the text read can't carry: `workspace:read-file` reports every PNG as binary, and a 4 MB sprite sheet as too large, so the preview would only ever have a message to show. [ImageFilePreview.tsx](../src/renderer/components/ImageFilePreview.tsx) fetches the bytes over `argmax-asset://` instead ([workspace_assets/protocol.rs](../src-tauri/src/workspace_assets/protocol.rs), which serves whitelisted image extensions from inside a known project or workspace root). It fits to the pane without upscaling, and clicking swaps to 1:1 — the only way to read a sprite sheet in a column this narrow. Widen the extension list and the panel's own copy of it in [FilePreview.tsx](../src/renderer/components/FilePreview.tsx) together, or the panel offers a file the handler refuses. An SVG reads back as *text*, so it keeps the editor and gets the same rendered/source toggle markdown has. Over the mobile bridge, `workspaceAssetUrl` maps `argmax-asset://` to token-authenticated `/api/workspace-assets/...` HTTP endpoints so images render in remote browsers as well.

## Git

[src-tauri/src/git](../src-tauri/src/git) executes git commands via direct argv arguments for branching, commits, pushing, and pull request actions.

Selected-file commits build and commit through a temporary index, leaving unrelated staged entries in the checkout index alone. If the follow-up reset of that real index is blocked, the commit still returns its new SHA with an `indexCleanupWarning`; the commit dialog keeps the successful result visible and asks the user to repair the index rather than reporting a false failure. Git writes from Argmax serialize per canonical checkout, including separate IPC-created service instances that target a shared workspace.
