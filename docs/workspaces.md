# Workspaces, Review, Files, Git

Rust manages workspace lifecycle, file operations, and Git under `src-tauri/src/`. See [GLOSSARY.md](../GLOSSARY.md) for the terms.

## Projects and folders

A project has a name and local folders. The primary folder must be a Git repository. Additional folders can hold code or documentation without Git, and one directory can belong to several projects.

Each workspace records its project folder and actual checkout. Repository settings, checks, and cleanup follow that recorded folder, so changing the primary affects only future chats. An isolated chat uses its worktree for its working repository and the existing checkouts for additional folders. Argmax does not create a worktree in every project folder.

Folder membership does not promise identical filesystem permissions across providers. Arcs are separate ([arcs.md](arcs.md)).

### Project overview

Creating a project starts a background overview generation from bounded samples of its folders. It describes purpose and folder roles. It does not run repository instructions or infer unsupported relationships.

Refresh produces a separate draft, and an unapplied draft never enters agent context. Manual edits made during generation win, and concurrent edits in another window produce a conflict. Results from an outdated folder configuration are rejected. A restart does not repeat provider calls.

Each new turn receives the saved overview as descriptive context to verify against current files.

## Workspaces

[src-tauri/src/workspaces](../src-tauri/src/workspaces) owns creation, status, pinning, archiving, and IDE launching.

**A workspace's `path` is write-once.** Landing somewhere new always means a new row.

### Lifecycle & Watchers

**Watchers** are keyed by canonical checkout path, so sessions sharing a checkout share one watch. Linked worktrees also watch their external Git metadata directory, so branch and index changes update the UI when no working file changes.

**Modes.** `current` is a shared checkout (`create_current`). `worktree` is an isolated worktree (`create_isolated`). Branch and directory names stay stable while the chat title updates in the background.

**The launcher's branch pick** changes nothing on disk. It is captured when the prompt is sent, so Project check's dialog, a background send, and an Undo each launch with the right branch.

- `worktree` mode uses the pick as `baseRef`, and the project root is not touched.
- `current` mode, on a branch a checkout already has: `workspaces:create-alongside` attaches a new chat as a shared row. The host re-validates the path, and refuses a checkout that changed branch or whose owner is archiving. It holds an admission on the owner until the row exists, so a concurrent archive either refuses the launch or archives the row too.
- `current` mode, on a branch no checkout has: the project root checks it out at launch.

A picked linked checkout is where the chat runs, but Files, Changes, and the launcher's terminal still show the project's own checkout. The branch chip's tooltip says so.

**Location.** New projects default to `~/.argmax/worktrees/<project-id>/`. Settings accepts any absolute directory. Creation refuses an existing destination, including a symlink. Scratch profiles keep worktrees under `ARGMAX_DATA_DIR`.

**Setup.** `create_isolated` returns as soon as the checkout exists. `git worktree add` runs with hooks disabled. A background task then replays `post-checkout` and runs the configured setup command as check rows. Failures never fail the workspace, and the first turn may start while they run.

**Archiving.**

- Shared checkouts mark `archived` immediately and drain processes in the background.
- Isolated worktrees mark `archiving`, cancel processes, and `git worktree move` the checkout under `local-state/workspace-archive/<workspace-id>`. It stays registered with Git, so all files remain available.
- Dirty worktrees return to `kept` unless `force: true`. An `archive-failed` retry never implies force.
- A worktree can carry several rows, because a multitask or a `session_launch` with `path` shares it. Only the isolated row owns the tree, so archiving it archives every co-located row first. Otherwise they would point at nothing and keep a watcher alive. A co-located turn in flight refuses the archive unless forced.
- A daily sweep removes a recovery checkout after `ARCHIVE_RECOVERY_EXPIRY`. `archiving`, `archive-failed`, `kept`, and live rows are never touched. The branch and its commits survive, and uncommitted files do not.
- Startup recovery recognizes a checkout already moved to its deterministic path and completes the interrupted archive.
- The composer cannot send to an archived workspace.

Merge cleanup disposes of workspaces automatically ([gh.md](gh.md#merge-cleanup)). `workspace_archive` lets an agent ask from inside ([agent-tools.md](agent-tools.md#moving-and-archiving)). Early stop force-archives a mistaken start ([earlyStop.ts](../src/renderer/lib/earlyStop.ts)).

### Branch name templates

A branch template names the branch of each new isolated worktree. Precedence runs project, then app, then the built-in `argmax/{word}-{id}`. Both values are read from Rust, because every launch path needs them, including agent launches. [branch_names.rs](../src-tauri/crates/argmax-contracts/src/branch_names.rs) owns the placeholders and the validation, and a test checks the rules against the installed `git`.

- `{type}` is always `feat`, because classifying the work would put a model call on chat startup.
- A stored template that renders an invalid name for some label falls back to the built-in one and logs a warning, so a launch never fails on it.

A template with no unique part collides, and two launches can race. `create_isolated` therefore **claims** a name instead of probing for one, and removes only what it created:

1. `create_dir` fails if anything is there.
2. `git branch` fails under git's own ref lock if the name is taken.
3. `git worktree add` checks out the branch it owns into the directory it owns.

A loser tries the next name. A parent or child ref conflict can make every suffix fail, so it skips to the built-in name.

Steps 2 and 3 run under a **worktree registry lock** (`lock_worktree_registry`), and so does every Argmax call that writes `.git/worktrees/`. Git does not lock that registry against itself, so overlapping `git worktree add` calls could fail with `failed to read .git/worktrees/<name>/commondir`. The lock is per repository, keyed by the canonical common dir, and is a leaf: nothing else is acquired while it is held. Another process running git is not covered.

### Session Moves

An agent moves a chat with `session_move` or `argmax session move` ([agent-tools.md](agent-tools.md#moving-and-archiving)). When the turn settles, `WorkspaceService` creates a destination workspace and copies the timeline into a fresh session.

- A `path` destination is validated against `git worktree list`, so an arbitrary directory is refused. It is always recorded as shared, because Argmax did not create that worktree and archiving must never delete it. A detached HEAD is refused.
- A `project` destination uses that project's shared checkout by default.
- The source archives after a successful copy unless `keepSource`. The archive is never forced.
- A cross-project move leaves the provider conversation id empty. A `path` move carries it where supported ([providers.md](providers.md#session-moves-and-the-provider-conversation)).
- The renderer follows the destination only when the source is still selected.

## Forking at a finished turn

A fork opens with the visible history up to that turn and no provider conversation. Its first message starts one, with the provider chosen then. The source is never modified. Provider mechanics, and why files are not rewound, are in [providers.md](providers.md#native-continuity-and-forks).

- `shared` reuses the source's checkout as a shared row, so archiving the fork never touches the source's worktree.
- `isolated` creates a worktree on a new branch from the source's current `HEAD`, and applies its current uncommitted changes. It is the current files, never the files at the turn.
- A fork of a chat that has not launched always starts fresh, because the id it holds is borrowed.

### Bringing findings back

A fork chat's **Bring findings back** sends a previewed text as the source's next message, attributed to the fork. A source mid-turn queues it, and it is never steered. It moves context, not changes, so there is no git merge and no file restore.

- **Range.** A merge covers visible messages in the earliest range no live claim covers. Positions are visible messages, never trace rows, because traces are rewritten after the fact.
- **Idempotent.** `fork_merges` claims `(fork, through event)` under a unique key before anything is sent, so a repeated click claims nothing.
- **Gaps.** The next range is the first hole in the live claims, not "after the newest". Withdrawing an older queued merge offers that range again.
- **Delivery.** A refused send releases its claim, unless the message was stored first. A `sending` claim is settled on the next read: confirmed once the marker is in a source message, and withdrawn when the message is nowhere. The preview writes nothing.
- **A moved fork** keeps its lineage and claims.
- **From inside the fork,** the agent calls `session_message` with `forkFindings: true`.

## Scratch workspaces

`workspaces:create-scratch` makes temporary workspaces with an empty git repository, because some providers require a git root. Chat on the launcher's mode chip selects this path and attaches no project. `workspaces.kind` is `git`, `scratch`, or `popup`, and a popup's directory goes away with the popup.

## Sidebar

**Group by** offers Projects, Date, and Status. Pins and manual order are a desktop preference in `localStorage` and do not reach the iPhone. Nested chats stay with their parent, and a working descendant places the whole tree in Working.

### Priority

Workspaces with a live **reason** or a live turn share the Priority section. A reason is one claim on the reader with its own answer to "what makes this go away", which keeps the section from being a feed of everything recent. [priority.ts](../src/renderer/lib/priority.ts) computes them on the client.

| Reason | Raised by | Cleared by |
|---|---|---|
| `approval-needed` | a pending approval | the decision |
| `question-asked` | an unanswered question | answering it |
| `blocked` | session `blocked` or `waiting` | resolution or dismissal |
| `failed` | session `failed` | resolution or dismissal |
| `ci-red` | the attributed PR at `failure` | green checks, or the PR closing |
| `review-ready` | a completed turn with an unread reply | reading it and leaving the chat |
| `pr-open` | the attributed PR at `OPEN` | the PR merging or closing |

- Reasons never expire with time.
- Opening a chat resolves `review-ready` and nothing else. Unread state is per device ([sessionUnread.ts](../src/renderer/lib/sessionUnread.ts)), so the phone and desktop disagree on purpose.
- "Done" clears every reason already true, and nothing that happens later. A PR going red after a dismissal brings the row back. Each reason carries its own `since` for that comparison.
- A row listed only for its running turn has no "Done".
- Clearing does not mark a chat read.

### Snooze shelf

A snooze is display metadata. `workspaces.snoozed_until` is the only thing written, so it never changes state, attention, checks, or what the gh poller does. A PR that merges still settles the workspace.

[snooze.ts](../src/renderer/lib/snooze.ts) derives shelf membership from the clock, so there is no backend timer and no poll. A snoozed row stays in its section while a session has a pending approval or question, because hiding what an agent is blocked on would stall it unseen. The iPhone decodes the field but does not shelve rows.

### Arcs and icons

Arcs sit above every other section, because a body of work across projects does not nest under one. State is shown as text, never color alone ([arcs.md](arcs.md)).

Unread stamps live in `localStorage`, so existing history does not light up on first sight. A turn in flight keeps the working nest, and the unread dot waits. A shared checkout needs session evidence for its PR glyph, so later checkout changes cannot assign another session's PR to an old chat ([gh.md](gh.md#session-prs)).

## Review

Changes groups the chat's checkout and the project's other enabled folders. Additional repositories show uncommitted changes in their shared checkout, including edits from other chats, and they are inspection only. Workspace and session state changes refresh the groups, with no recurring poll.

PR tracking covers only each project's original primary repository. Chats in other repositories get an explicit error.

**Layout.** The dock is one column whichever view is in it. A drag pins its width in `argmax.session.rightPanel.pinnedWidth`. The tab menu is the only way to split, because dragging only reorders. Only one file tab is visible at a time. Resizing hides native browser pages, so they cannot swallow the drag's mouse events. Layouts and open files are kept per session in `localStorage`.

Unsaved Files edits stay in memory across chat switches. Saving uses the draft's original disk timestamp to detect external changes. Drafts do not survive a restart.

### Branch changes

Changes always shows every difference from the base branch. The review API keeps other comparisons for callers that need an explicit range:

| `ReviewComparison` | Git range |
|---|---|
| `branch` | `merge-base(base_ref, HEAD)` → working tree + untracked |
| `committed` | `merge-base(base_ref, HEAD)..HEAD` |
| `workingTree` | `HEAD` → working tree + untracked |

Base ref resolution checks `workspace.base_ref`, then `origin/<default>`, then local `<default>`. [git_review.rs](../src-tauri/src/review/git_review.rs) owns diffs.

### Review actions

The `workingTree` comparison supports staging, unstaging, and reverting. The Changes sidebar uses `branch` and exposes none of them.

Every mutation carries the displayed revision. Rust checks HEAD, index, and working-tree state under the canonical checkout lock, and an obsolete revision fails with a refresh instruction. Another session in the checkout does not reserve the tree, because sharing is normal and the revision check catches a tree that moved on.

That revision costs more than the diff it guards, so only `workingTree` pays for it. `branch` and `committed` carry a revision of their own payload, which every mutation refuses.

Reverting saves a recovery checkpoint first.

### Revert to a turn

Every provider turn in a Git workspace is preceded by an automatic checkpoint, anchored to the user message it answers. That anchor puts **Revert** in the turn's footer, so there is no checkpoint panel. A failed capture never blocks the turn, and the footer says none was saved.

Reverting binds the restore to the current HEAD, branch, index, and worktree. Restoring is the one action that requires idle sessions on the checkout, because it overwrites files another agent may be editing. It saves a recovery checkpoint and journals the operation, so it is undoable and interrupted restores recover. Unresolved merges and submodules are unsupported.

**Revert restores files, not the conversation.** No provider CLI can resume from an earlier message, so rewinding the transcript would promise what the backend cannot keep. Fork is the way to a clean continuation.

### Diff context

Each gap between hunks is an `omitted` block ([diff.ts](../src/renderer/lib/diff.ts)). Clicking it re-requests the file with `contextLines`. The diff cache is keyed by path and context, so a wider request never gets the narrower diff.

Per-file diffs are capped at `PER_FILE_DIFF_CAP_BYTES`. A capped diff loses trailing hunks, so the expand buttons stop offering an action that would only drop more.

## Files

[workspace_files.rs](../src-tauri/src/files/workspace_files.rs) owns trees, previews, mtime-checked writes, and grep. Paths go through [workspace_paths.rs](../src-tauri/src/util/workspace_paths.rs), which prevents traversal.

[ImageFilePreview.tsx](../src/renderer/components/ImageFilePreview.tsx) fetches over `argmax-asset://`, because the text read reports images as binary. Widen the extension list in [workspace_assets/protocol.rs](../src-tauri/src/workspace_assets/protocol.rs) and its copy in [FilePreview.tsx](../src/renderer/components/FilePreview.tsx) together, or the panel offers a file the handler refuses.

## Git

[src-tauri/src/git](../src-tauri/src/git) runs Git for checkouts, review, checkpoints, and PR cleanup. Agents own commits, pushes, and PR creation. Git writes from Argmax serialize per canonical checkout.

### PR Cleanup

After a PR merges, Argmax does the git cleanup itself, with no model turn. `cleanup_merged_pr` in [pr_cleanup.rs](../src-tauri/src/git/pr_cleanup.rs) serves the `pr_cleanup` tool, the `prs:cleanup` IPC command, and a watch with `cleanupOnMerge`.

Cleanup never archives, hides, or deletes the chat. A step that fails is reported in its line, and only a refusal returns an error. The guards:

- **Remote branch:** deleted only while it still points at the merged head (`--force-with-lease`). A fork PR is skipped.
- **Base:** fast-forwarded only when its checkout has no running turn and no uncommitted tracked changes.
- **Local branch:** deleted only when no worktree holds it and its tip is the merged head (`git update-ref -d` with the old value).

The tool also removes the chat's own worktree when the turn ends. Removal stops every process in the checkout, including the caller, so it is an after-turn action in `session_after_turn`, and boot recovery keeps the promise. `remove_merged_checkout` stops Argmax's processes and any other process whose working directory is inside (matched with `lsof`).

The checkout stays when it is shared, is dirty, or has a HEAD the merged PR does not contain. The IPC command and a watch's `cleanupOnMerge` keep it, because the merged notice starts a turn in it.
