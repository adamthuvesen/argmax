# Workspaces, Review, Files, Git

Rust manages workspace lifecycle, file operations, and git integration under `src-tauri/src/`.

## Workspaces

[src-tauri/src/workspaces](../src-tauri/src/workspaces) handles workspace creation, status polling, pinning, archiving, and IDE launching.

### Lifecycle & Watchers
- **Filesystem watchers:** Watchers are keyed by canonical checkout path so multiple sessions sharing a checkout share one watch. Linked worktrees also watch their external Git metadata directory, so branch and index changes update the card and composer even when no working files change. Events are debounced at 200 ms with a 1-second max interval. Changes inside `.git/objects`, `.git/lfs`, `.git/fsmonitor--daemon`, and `*.lock` are ignored.
- **Workspace modes:** The launcher offers two modes (stored in `localStorage.argmax.workspaceMode`):
  - `current`: Shared checkout (`create_current`).
  - `worktree`: Isolated worktree (`create_isolated`), branched as `argmax/<word>-<8-hex-id>`, for example `argmax/cedar-a3f92c18`, unless a [branch name template](#branch-name-templates) is set. The name is generated locally without a model call. The directory uses the same name with `/` replaced by `-`. Branch and directory names stay stable while the descriptive chat title updates in the background. Existing worktrees keep their names.
  **The launcher's branch pick** changes nothing on disk. It is held in the launcher and sent with the launch, captured when the prompt is sent, so Project check's dialog, a background send and an Undo each launch with the branch that was picked for them. The picker marks a branch another worktree has checked out (`projects:list-checkouts`), and a pick belongs to the project it was made in. What the launch does with it:
  - `worktree` mode: `create_isolated` with the picked branch as `baseRef`. The project root is not touched.
  - `current` mode, branch checked out in a worktree or the project root: `workspaces:create-alongside` attaches a new chat to that checkout. It takes the same shared-row shape as a multitask ([Lifecycle](#lifecycle--watchers) covers archive), so the owning chat's archive takes the new row with it. The host re-validates the path against `git worktree list`, refuses it when the checkout is now on another branch (`CHECKOUT_BRANCH_CHANGED`, naming both branches), and refuses a checkout under archive recovery storage or whose owner is mid-archive or failed to archive. It holds an admission on the owner from before the first check until the row exists, so an archive that starts meanwhile either refuses the launch or finds the row and archives it too.
  - `current` mode, branch no checkout has: the project root checks the branch out at launch, not at the pick. Git still refuses if a worktree gained the branch in between.

  A picked linked checkout is where the chat runs, but Files, Changes, the launcher's terminal and `@` file suggestions still show the project's own checkout. The branch chip says so in its tooltip. Dropped files' relative paths follow the pick.
  Agent `session_launch` can also attach to an existing checkout (`path`) or fork an isolated worktree from a named `branch`. See [agent-tools.md](agent-tools.md).
- **Worktree location:** New projects default to `~/.argmax/worktrees/<project-id>/`. A one-time upgrade on database open switches project settings still pointing to the old `<repo>/.argmax/worktrees` default to this location for future launches. Custom locations and existing workspace paths stay unchanged. Settings → Projects accepts an absolute directory inside or outside the repo, including a return to the old location after upgrading. Creation resolves that directory and refuses an existing destination, including a symlink. Scratch profiles using `ARGMAX_DATA_DIR` keep worktrees under `<ARGMAX_DATA_DIR>/local-state/worktrees/<project-id>/`.
- **Worktree setup:** `create_isolated` returns as soon as the checkout exists. `git worktree add` runs with hooks disabled, then a background task replays the repository's `post-checkout` hook with `git hook run` (git 2.36+, only when the hook exists) and runs the project's configured setup command, each through `CheckService` as a check row in the new worktree. Check children get the login-shell `PATH`, like git's do. Failures are recorded on the check rows and never fail the workspace, and the agent's first turn may start while they run.
- **Archiving:**
  - Successful archives leave the active list and appear in a collapsed Archived section at the bottom of the sidebar in either grouping. The chats start hidden on each app launch. Expanding the section lets the user read archived transcripts, but the composer cannot send to an archived workspace. Recovery access for isolated checkout files lives in Settings, while notifications are reserved for failures or changes that need attention.
  - Settings → Appearance → Layout → Show archived chats hides or shows the entire Archived section. It is on by default, with the section collapsed.
  - Shared checkouts mark `archived` immediately and drain child processes in the background.
  - Isolated worktrees mark `archiving`, cancel child processes, expire pending approvals, evict warm Cursor ACP instances, and use `git worktree move` to retain the complete checkout under `local-state/workspace-archive/<workspace-id>`. The moved checkout stays registered with Git, so tracked, untracked, and ignored files remain available. Settings → Advanced → Diagnostics → Archived workspaces opens the recovery root.
  - Dirty worktrees return to `kept` unless `force: true` is passed. An `archive-failed` retry never implies force. The renderer confirms against the current dirty state before retrying with force.
  - A worktree can carry more than one workspace row — a multitask dispatched from a chat inside it shares that checkout ([multitask.md](multitask.md)), and `session_launch` with `path` can share one the same way. Only the isolated row owns the tree, so archiving it archives every co-located row first, before the move; otherwise they would point at nothing, never reclassify (both reconcile branches skip shared rows), and keep a watcher and an agent alive over the archive location. If one of them still has a turn in flight the archive is refused, naming that workspace, unless `force: true` is passed. `session move --path` refuses to create this shape in the first place.
  - Archive recovery expires after 48 hours (`ARCHIVE_RECOVERY_EXPIRY`); with the daily sweep a checkout is gone 48 to 72 hours after archiving. A daily background sweep, first run 30 seconds after launch, removes a recovery checkout once its workspace row has been `archived` that long (by the row's `updated_at`), or once a directory no row owns is that old by the later of its own and its `.git` file's mtime (a move keeps the directory's mtime, but `git worktree move` rewrites `.git`); `archiving`, `archive-failed`, `kept`, and live rows are never touched. Removal runs `git worktree remove --force` in the source repository, falling back to deleting the directory and `git worktree prune`, so Git keeps no registration for a vanished checkout. The branch and its commits survive; uncommitted and ignored files do not. Repeating an archive after the row reaches `archived` returns the same recovery path. Startup recovery recognizes a checkout already moved into its deterministic recovery path and completes the interrupted archive without moving or deleting it again.
  - Archiving is also how a workspace is disposed of automatically. A project's `merge_cleanup` (Settings → Projects) has the gh poller archive each of its *isolated* workspaces once the PR on that workspace's branch merges, never forced. `remove-checkout` deletes the checkout instead of retaining it, and the chat stays in its sidebar section, read-only — see [gh.md](gh.md#merge-cleanup).
  - An agent can ask for the same thing from inside: the `workspace_archive` MCP tool archives the caller's own workspace once its turn settles. Babysitting a PR does not imply archiving its chat. An explicit archive request can use this tool without removing the worktree during the agent's turn. See [agent-tools.md](agent-tools.md).
  - Stopping a chat within 10 seconds of launch is an undo of a mistaken start: the pane returns to the composer, and the workspace is force-archived so no cancelled row stays in the sidebar. Docked multitasks and details popups are excluded. See [earlyStop.ts](../src/renderer/lib/earlyStop.ts).

### Branch name templates

A **branch template** names the branch of each new isolated worktree. A project can set its own (Settings → Projects → Branch names), the app can set a default for every project, and with neither set the built-in `argmax/{word}-{id}` applies. Order of precedence: project, then app, then built-in. The app value lives in `ui_state` (`workspace.branch_template`) and the project value in `projects.branch_template`, because a launch reads both from Rust on every path, including agent launches.

| Placeholder | Value |
| --- | --- |
| `{slug}` | The task label's words, lowercase ASCII, joined with `-`, at most 40 characters, cut at a word boundary. A word with any non-ASCII letter is skipped whole rather than kept as a fragment ("ändring" would become "ndring"). A label with no usable word (only emoji, or only such words) becomes `{word}`. |
| `{type}` | Always `feat`. Nothing classifies the work: that would put a model call on chat startup. |
| `{word}` | A random word from the worktree word list. |
| `{id}` | Eight hex characters, unique per launch. |
| `{date}` | The UTC day, `YYYYMMDD`. |

Rust validates a template when it is saved ([branch_names.rs](../src-tauri/src/workspaces/branch_names.rs)): at most 100 characters, only the placeholders above, balanced braces, and a render with worst-case values must be a valid Git branch name. The rules match `git check-ref-format --branch` (including its refusal of `HEAD`), and a test checks them against the installed `git`. A rejected save keeps the previous value and returns the reason, which the form shows beside the field. A stored template that renders to an invalid name for some label (`a.{slug}` with the label "lock") falls back to the built-in one and logs a warning, so a launch never fails on it.

A template with no unique part (`adam/{type}-{slug}`) collides when two chats share a label, and two launches can pick the same name at the same moment. `create_isolated` therefore **claims** a name instead of probing for one, and only ever removes what it created itself:

1. `create_dir` makes the worktree directory and fails if anything is already there. The directory is the branch with `/` replaced by `-`, so `a/b-c` and `a-b/c` share one and the second launch loses.
2. `git branch` creates the branch under git's own ref lock and fails if the name is taken, or if a parent or child ref blocks it. Of two launches racing for a name, exactly one succeeds.
3. `git worktree add` checks the branch it owns out into the directory it owns.

Steps 2 and 3 run as one group under a **worktree registry lock**, and so does every other Argmax call that writes the repository's `.git/worktrees/` registry: a failed launch's cleanup, archive's `worktree move`, `worktree repair` during archive recovery, and the expiry sweep's `worktree remove` and `prune`. Git does not lock that registry against itself, so two overlapping `git worktree add` calls could fail with `failed to read .git/worktrees/<name>/commondir`. The lock is one per repository, keyed by the canonical git common dir (every linked checkout and every path spelling shares it), and is a leaf: nothing else is acquired while it is held, and it is released before the row, the watcher and the background hook replay. Another process running git on the same repository is not covered; there the failing launch reports the error and removes only what it created.

A launch that loses step 1 or 2 deletes nothing but its own empty directory and tries the next name: `-2`, `-3`, … `-31`, then the name plus the launch's random `{id}`, then the built-in `argmax/{word}-{id}` name. A parent/child conflict (an existing branch `adam/fix` forbids every `adam/fix/…`, so no suffix on that prefix can work) skips straight to the built-in name; an existing child (`adam/fix/old` blocks `adam/fix`) still takes the next suffix, because `adam/fix-2` is a different ref. If even that fails the launch ends with an error that names the last conflict. A failure after the claim (disk full) removes the directory and the branch it created, and the branch only while it still points at the commit it was created at. No code path removes a worktree or branch this launch did not create. Only new branches change. Existing branches and worktree directories keep their names, and the name still never follows the chat's later auto-title.

### Session Moves

`$ARGMAX_BIN session move (--project <name-or-path> | --path <checkout>) --prompt <what-to-do-there>` schedules an explicit handoff from inside an active agent turn. When the turn settles, `WorkspaceService` creates a destination workspace and copies the timeline into a fresh session. The source workspace is never retargeted: a workspace's `path` is write-once, so landing somewhere new always means a new row.

Exactly one destination is required. `--project` moves to another project — a registered name, or the absolute path of a repository Argmax has never opened, which is registered on first use ([agent-tools.md](agent-tools.md)). `--path` moves to another checkout of the *same* project — any directory `git worktree list` reports for its repository, including the main one. That is the supported answer to "this work belongs in a different worktree"; running `cd` inside a tool call only moves the agent's shell, leaving the workspace, its diff, and its commit and pull-request actions pointed at the checkout the session started in, and the next turn relaunches back there.

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

## Forking at a finished turn

The Fork action under a finished turn forks the chat at that turn, in the same checkout. A second action forks it into an isolated checkout. The new chat opens with the visible history up to the end of that turn and no provider conversation: its first message starts one, with the provider chosen in the composer then. The source chat is never modified. Provider mechanics, the exact-versus-fresh rule, and why files are not rewound are in [providers.md](providers.md#native-continuity-and-forks).

- `shared` reuses the source's checkout and workspace path, as a shared row, so archiving the fork never touches the source's worktree.
- `isolated` creates a worktree on a new branch from the source's current `HEAD`, then applies the source's current uncommitted and untracked changes. It is the current files, never the files at the turn. If the changes cannot be copied the new worktree is archived and the fork fails.
- Only git checkouts fork isolated.
- `session_forks` records source, child, boundary message, last copied event, workspace mode and native plan. A fork can be made from a chat that is itself a fork. A fork of a chat that has not launched yet (an untouched fork or a moved copy) always starts fresh from the copied history: the id it holds is borrowed. A fork that has launched owns its conversation and can be forked like any chat.

### Bringing findings back

A fork chat shows a **Forked chat** card above the composer with **Open source** and **Bring findings back**. The second opens a preview: the source's name, the message the fork started from, how many visible messages the fork added since the fork or its last merge, and the exact text the source would receive. Confirming sends that text as the source's next message, attributed to the fork. A source that is mid-turn queues it through the ordinary follow-up queue; it is never steered into the running turn.

- **No git merge, no file restore.** It moves context, not changes.
- **Range.** A merge covers the fork's visible messages (the same eligibility as a provider handoff) in the earliest range no live claim covers, up to the position the preview showed. Positions are visible messages, never trace rows, which are rewritten after the fact, so a trace import is not a finding and cannot move the cursor. At most 40 messages and 24k characters go; older ones drop and the text points at `session_read` on the fork.
- **Idempotent.** `fork_merges` claims `(fork, through event)` under a unique key before anything is sent, under the writer lock, so a repeated or concurrent click claims nothing. The footer line `Argmax fork merge <id>` is the claim's marker. The marker id is stored apart from the row id, so a claim copied onto a moved fork still finds its queued message.
- **Gaps.** The next range is the first hole in the live claims, not "after the newest". Withdrawing an older queued merge while a newer one is queued offers the older range again, before the newer work.
- **Delivery.** A send the source refuses releases its claim, unless the message was stored before the error, in which case the range stays merged. A queued message keeps its claim as `sending`. A claim whose send is running in this process is never touched. Any other `sending` claim is settled the next time a merge reads the fork: confirmed once the marker is in a source message, left alone while the message waits in the queue, and withdrawn when it is nowhere (the queued message was deleted, or the app died between claim and send). The preview itself writes nothing.
- **A moved fork** keeps its lineage and claims (copied onto the destination), so merge-back still works from where it landed. If the source chat was deleted the fork keeps its history and has nothing to bring findings to.
- **From inside the fork.** The fork's own agent calls `session_message` with `forkFindings: true` and the source's id. `message` becomes the note ahead of the findings, the call is allowed mid-turn, and it queues rather than steers. See [agent-tools.md](agent-tools.md).

## Scratch Workspaces

`workspaces:create-scratch` initializes temporary workspaces in `local-state/side-chats/` with an empty git repository to support providers that require a git root. The launcher selects this path through Chat on the mode chip (Tab cycles Auto / Chat), which attaches no project.

`workspaces.kind` supports three kinds (migration v15):
- `git`: Standard repo checkouts (shared or isolated).
- `scratch`: User-facing side chats under the hidden `scratch-side-chats` project ID.
- `popup`: Ephemeral sessions used by the "More details" popup. Closing the popup terminates the session and deletes the temporary directory.

## Sidebar Priority Section

Repository sessions and repo-less sessions use the same Priority rules.

Workspaces holding at least one live **reason**, and workspaces with a live turn, share the Priority section beneath Pinned. A reason is one claim on the reader with its own answer to "what makes this go away", which is what keeps the section from being a feed of everything that finished recently.

| Reason | Raised by | Cleared by |
| --- | --- | --- |
| `approval-needed` | a pending approval | the decision |
| `question-asked` | an unanswered `AskUserQuestion` (see [chat-cards.md](chat-cards.md)) | answering it |
| `blocked` | session `blocked` / `waiting` | 30 minutes of silence |
| `failed` | session `failed` | 30 minutes of silence |
| `ci-red` | the attributed PR's check rollup at `failure` ([gh.md](gh.md)) | checks going green, or the PR closing |
| `review-ready` | a completed turn **whose reply is still unread** | opening the chat, or 30 minutes of silence |
| `pr-open` | the attributed PR at `OPEN` | the PR merging or closing |

- Calculated client-side in [src/renderer/lib/priority.ts](../src/renderer/lib/priority.ts). Only the reasons a clock can resolve carry `PRIORITY_IDLE_MS` (30 minutes from the last message); an approval, a question, a red check and an open PR are all still true half an hour later, so they wait for the event that ends them. A row leaves once *every* reason holding it has lapsed.
- Reading is asymmetric: opening a chat resolves `review-ready` and nothing else. Unread state is this device's own (`localStorage`, see [sessionUnread.ts](../src/renderer/lib/sessionUnread.ts)), so the phone and the desktop disagree about what has been read.
- Default order: working rows first, then by reason strength (the table above), then by last message descending.
- Drag Priority chats to set their order in either sidebar view. The order persists across restarts in `localStorage.argmax.sidebar.workspaceOrder`, under `priority`, like Pinned ordering. New entries follow the saved order and use the default order among themselves. The row's accessible title names its strongest reason.
- Pinned status takes precedence over Priority.
- Right-click "Done" (`workspaces:set-priority-dismissed`) clears every reason that was already true, and nothing that happens afterwards: a PR going red after a dismissal brings the row back, because `ci-red` is newer than the dismissal. Each reason carries its own `since` for that comparison — a session reason uses `attention_changed_at`, a PR reason the poller's `pr_activity_at`. Manual adds (`workspaces:set-priority-added`) persist until cleared. A row that is only listed because its turn is running has no "Done" — it leaves when the turn ends — and the header's Clear skips it.
- The "Priority section in sidebar" setting hides the whole section, running rows included; they fall back to their date bucket or project group.

## Snooze Shelf

Right-click a chat → **Snooze for 1 hour**, **Snooze until tomorrow** (9:00 local), or **Snooze for a week**. The row leaves its section (Priority, date bucket, project group, Chat) and goes to a **Snoozed** shelf above Archived. The shelf is collapsed on every launch. Right-click a shelved row → **Unsnooze** returns it at once, and a snooze that reaches its time returns it by itself.

A snooze is display metadata. `workspaces.snoozed_until` (RFC 3339, millisecond UTC, stored by `workspaces:set-snoozed-until`) is the only thing written. It never changes the workspace state, the session, attention, checks, or what the gh poller does: a PR that merges still settles the workspace, and merge cleanup still runs. Rust accepts only a future instant at most 366 days out, and `null` clears it.

Shelf membership is derived in the renderer ([snooze.ts](../src/renderer/lib/snooze.ts)) from the clock, so there is no backend timer and no poll. The sidebar arms one `setTimeout` for the earliest active expiry and re-derives when it fires. A snoozed row stays in its normal section while a session on it has a pending approval or an unanswered question (`approval-needed`, `question-asked`), because hiding what an agent is blocked on would stall it unseen. A pinned row stays in Pinned. Selecting a shelved chat opens the shelf. The iPhone app decodes `snoozedUntil` but does not shelve rows yet.

## Arcs

Arcs sit above every other sidebar section — a body of work spanning several projects doesn't nest under any one of them. The section header carries "New arc"; each row is an arc's name plus its state as text when it isn't `active` (`paused`, `done`), never color alone. Active and paused arcs sort ahead of done ones, most recently touched first. Clicking a row opens the standalone Arc page, wired through `showArcPage`/`selectedArcId` in [overlays.ts](../src/renderer/state/overlays.ts) the same way Settings and Schedule take over the sidebar column.

A sidebar chat row whose session carries `arcId` shows a small marker (title and accessible name `Part of arc <name>`) next to its subtitle, the same slot `launched by …` uses — a member reads as part of a larger body of work rather than a stray chat, while staying in its own project's section.

See `docs/arcs.md` for the full data model (coordinator chat, member chats, `BRIEF.md`/`NOTES.md`, launch caps).

## Custom Row Icons

Right-click → "Edit Icon" saves `workspaces.icon` and `workspaces.icon_color` via `workspaces:set-icon`. When a custom icon is active, status indicators move to a corner badge.

A chat that produced a response while it was not the open row shows an unread mark: an accent-colored dot (`--accent`) in the leading-glyph cell, replacing the custom icon or status marker. Opening the chat clears it and puts the icon back. A turn in flight keeps the working nest instead; the unread dot waits until that turn ends. Stamps live in `localStorage.argmax.sidebar.viewedAt` so existing history does not light up on first sight.

An attributed pull request replaces the default status marker with a GitHub PR glyph: green while open, violet once merged. Isolated workspaces resolve PRs by branch. Shared checkouts require session evidence and retain their recorded branch context after completion, so later checkout changes cannot assign another session's PR to an old chat. See [gh.md](gh.md) for attribution and legacy-cache behavior.

## Review

The review panel can show two views stacked vertically. Right-click a view tab and choose **Split below**, or drag a tab onto the upper or lower half of the panel. Drag the divider to resize the views, or focus it and use the arrow keys. Each view appears once. Selecting a tab already shown in the other half swaps the views. Actions from the chat use the half where the requested view is already visible. Closing either half expands the remaining view.

The dock's width is a third of the pane (floored at its 360px minimum, capped at 560px) until the user drags its inner edge, which pins a pixel width in `argmax.session.rightPanel.pinnedWidth` and holds it from then on. Opening a subagent, Changes, Files, Browser or the Terminal all land on that one width — the dock is one column whichever view is in it.

Resizing temporarily hides native browser pages so they cannot swallow the drag's mouse events. Releasing the mouse or moving focus out of the window ends the drag and restores the cursor.

The session review panel remembers its visibility, view arrangement, and divider position per session in localStorage. Returning to a chat or restarting the app restores them. Closing the whole sidebar preserves the arrangement for its next open. Full-screen review surfaces keep their explicit initial visibility and a single view.

Layouts live in `argmax.reviewPanel.layout.<sessionId>`. The Files view's open tabs and active tab are kept per session in `argmax.reviewPanel.files.<sessionId>`: returning to a chat reopens them and reloads a clean active file from disk, and closing the last tab clears the entry. The launcher uses one shared `argmax.reviewPanel.layout.launcher` preference across projects. New chat starts with the panel closed, even when a chat in the shared checkout shows its terminal. Opening the launcher panel explicitly restores its layout. Existing single-mode session preferences remain the fallback until a layout is saved.

Unsaved Files edits stay in memory when switching chats or projects, scoped to the pane and source checkout. Returning restores the draft and checks the disk version without replacing the edited text. Saving still uses the draft's original disk timestamp to detect external changes. Draft contents do not survive an app restart.

[src-tauri/src/review/git_review.rs](../src-tauri/src/review/git_review.rs) provides diff calculations and file lists.

### Comparison Scopes

| Scope | `ReviewComparison` | Git Range |
|---|---|---|
| All on branch (default) | `branch` | `merge-base(base_ref, HEAD)` → working tree + untracked |
| Committed | `committed` | `merge-base(base_ref, HEAD)..HEAD` |
| Uncommitted | `workingTree` | `HEAD` → working tree + untracked |
| Last turn | `branch` (client-filtered) | File-writing tool calls in the most recent turn |

Last turn keeps the selected diff within its filtered file list. When the selected file drops out, Changes selects the first remaining file or clears the detail view if the list is empty.

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

That revision is a fingerprint of HEAD, the index and the whole worktree, and it
costs more to compute than the diff it guards, so only the Uncommitted
comparison pays for it. The Branch and Committed diffs describe history nobody
can act on from here, so they carry a revision of their own payload instead,
which every mutation refuses. Opening a file in those scopes is roughly seven
times cheaper for it.

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
escape hatch for a clean continuation. Fork at a turn copies the history up to
that turn, and still does not rewind files ([above](#forking-at-a-finished-turn)). Settings → Agents → Conversation turns
the action off.

### Diff Notes

To add a diff note, click the line-number gutter or drag it across multiple lines within a hunk. The selected lines highlight as you drag, and releasing opens the comment form below the range. Dragging upward works too. Escape cancels a selection or an open form. Expand omitted context first to select across a gap.

The composer chip and submitted note retain the range. Quoted ranges include diff markers so removed and added code remain distinguishable, with both endpoint sides recorded when the range crosses between them.

### Diff Context

Diffs carry git's default three lines of context. `parseUnifiedDiff` ([src/renderer/lib/diff.ts](../src/renderer/lib/diff.ts)) turns each between-hunk gap into an `omitted` block, which `DiffBlocks` renders as an "N unmodified lines" button. Clicking it re-requests the file with `contextLines` on `review:load-diff`, which becomes `git diff -U<n>`, climbing `DIFF_CONTEXT_STEPS` (25, then the whole file) until every gap is closed.

Context is per open file and resets when a different file is selected. Only a single-file request honors `contextLines`; the whole-workspace diff and the additions/deletions counts stay on git's default. `MAX_DIFF_CONTEXT_LINES` in [validation.rs](../src-tauri/src/application/validation.rs) rejects anything larger, and the renderer's diff cache is keyed by path *and* context so a wider request is never served the narrower cached diff.

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

### PR Cleanup

After a PR merges, Argmax does the git cleanup itself, with no model turn, for every provider. One function, `cleanup_merged_pr` in [pr_cleanup.rs](../src-tauri/src/git/pr_cleanup.rs), serves the `pr_cleanup` agent tool, the `prs:cleanup` IPC command (the **Clean up** action on a merged PR row in the workspace card), and a PR watch with `cleanupOnMerge` ([gh.md](gh.md#pr-watch)).

Cleanup never archives, hides, or deletes the chat. The chat's checkout stays. The report says what was kept. With `merge_cleanup = remove-checkout`, the merge hook deletes the checkout first and then runs this cleanup, so step 4 finds no worktree on the branch ([gh.md](gh.md#merge-cleanup)).

1. Read the PR with `gh pr view`. Refuse with `PR_NOT_MERGED` unless it is merged. Record `headRefOid` as the merged head and `mergeCommit.oid` as the merge commit.
2. Remote branch. Skip it when the head repository's owner is not `origin`'s owner (a fork PR). Otherwise check `git ls-remote --heads origin refs/heads/<branch>`. GitHub may have deleted it already. If it is there, delete it with `git push --force-with-lease=refs/heads/<branch>:<merged head> origin --delete refs/heads/<branch>`. A `stale info` rejection means the branch moved past the merged head, so it stays and the report names the divergence.
3. Base. Find the worktree that has the base branch checked out. Skip when no worktree has it, when a turn is running there, or when it has uncommitted tracked changes. Otherwise take that checkout's write lock and run `git pull --ff-only origin <base>`. The report says when the merge commit is still not in it.
4. Local branch. Keep it when any worktree has it checked out (normally the chat's own worktree) or when its tip is not the merged head, including when it has later commits. Otherwise delete it with `git update-ref -d refs/heads/<branch> <merged head>`, which refuses if the tip moves in between.
5. `git remote prune origin`.

Worktree paths compare through `comparable_worktree_path`. A step that fails is reported in its line. Only a refusal returns an error. A report reads:

```
PR #72 merged as abc1234 (head def5678)
Remote: origin/fix-parser deleted
Base: main fast-forwarded in /path/to/repo
Local: fix-parser kept (checked out by this chat's worktree)
Chat: kept, checkout /path/to/worktree kept
```
