# Agent Tools

Every session Argmax launches gets one MCP server, `argmax`, whose tools reach
the sessions around it: list them, launch new ones, watch them, read what they
did, message them, stop them, and move this session to another project. The
tools are the same across providers, and they run on the same wire protocol the
`argmax session …` CLI has always used — one protocol, two faces.

## The tools

Namespace `argmax`; Claude, Codex, and Cursor show them as
`mcp__argmax__<tool>`.

### Sessions

| Tool | Arguments | Returns |
|---|---|---|
| `session_list` | `project?`, `all?`, `query?` | `{sessions: [{sessionId, projectId, projectName, taskLabel, provider, state, attention, lastActivityAt, launchedBySessionId?, unreadable?, matched?}], truncated}` — newest activity first, the caller excluded, capped at 40 rows. `unreadable` marks a session the caller may not read. With `query`, only readable sessions are kept: task-label hits first (`matched.source` `title`), then conversation hits (`content`, with `itemId` and a plain `snippet`) |
| `session_launch` | `prompt`, `project?`, `path?`, `branch?`, `provider?`, `model?`, `worktree?`, `taskLabel?`, `reasoning?`, `permissionMode?`, `checkInMinutes?`, `clientRequestId?` | `{sessionId, workspaceId, projectId, projectName, path, branch, permissionMode, permissionModeRequested?, replayed?, projectCheck?}`. `permissionMode` is the mode the session runs under; `permissionModeRequested` appears only when the caller asked for a looser one than it may hand out. `replayed: true` marks a retry that was answered from the first launch's receipt. `projectId`, `projectName`, and `path` are the checkout the session started in. `projectCheck` (`decision` of `suggest` or `switch`, `suggestedProjectId`, `suggestedProjectName`, `reasons`) is present when project check had an opinion; a `switch` means those checkout fields are the suggested project, not the one the caller passed. `checkInMinutes` (1 to 1440, else `CHECK_IN_OUT_OF_RANGE`) schedules a `same_session` wake for the caller, routine id `check-in:<sessionId>`, that Argmax deletes when the launched session's completion notice is built, so it fires only while the session is still running. |
| `session_message` | `session`, `message`, `forkFindings?` | `{sessionId, queued}` — `queued` is true when the target was mid-turn and could not be steered. With `forkFindings`, from a chat forked from `session`: sends that chat the fork's new findings with `message` as the note, queued rather than steered, and only the work no earlier call carried (`FORK_NOTHING_NEW` when there is none) |
| `session_status` | `session` | `{sessionId, taskLabel, provider, modelId, state, attention, turnAgeSeconds?, lastActivityAt, lastAssistantText?, unreadInbox, launchedBySessionId?, launchDepth}` |
| `session_read` | `session`, `cursor?`, `maxChars?`, `itemId?`, `offset?` | `{sessionId, entries: [{id, at, kind, text, clipped?}], nextCursor, truncated}`, or with `itemId`, `{sessionId, item: {id, at, kind, text, offset, nextOffset?, totalBytes}, truncated}` |
| `session_stop` | `session` | `{sessionId, state}` |
| `session_rename` | `taskLabel` | `{sessionId, workspaceId, taskLabel, previousTaskLabel}` — renames this session's sidebar row only |
| `inbox_read` | — | `{messages: [{fromSessionId?, fromLabel?, kind, body, createdAt}]}` |
| `session_wait` | `sessions?`, `timeoutS?` | `{timedOut, sessions: [{sessionId, taskLabel, state}], messages: […]}` |
| `session_move` | `project?` \| `path?`, `prompt`, `worktree?`, `keepSource?` | `{scheduled, sourceSessionId, projectId, projectName, path?}` |
| `workspace_archive` | — | `{scheduled, sessionId, workspaceId}` |
| `goal_set` | `condition`, `maxTurns?` | `{goalId, condition, maxTurns}` — sets this session's goal; the turn that set it counts as the goal's first turn |
| `goal_clear` | — | `{cleared}` |
| `checks_run` | `session?`, `command?`, `timeoutMs?` | `{sessionId, workspaceId, passed, checks: [{command, status, exitCode?, summary}]}` |
| `workspace_status` | `session?` | Checkout, branch, PR, dirty-state, shared-checkout, and archive metadata |
| `workspace_diff` | `session?`, `filePath?`, `comparison?`, `maxChars?` | Bounded changed-file list and diff text with `truncated` |
| `learnings_add` | `kind`, `summary`, `project?` | The stored project learning |
| `learnings_search` | `query?`, `project?`, `limit?` | Ranked project learnings with `truncated` |
| `sources_list` | `offset?`, `limit?`, `linked_repo?`, `path?` | Registered source metadata with `nextOffset` and `truncated`, the project's enabled `linkedRepos`, or with `linked_repo` one directory of a linked repository |
| `sources_read` | `id?`, `linked_repo?`, `path?`, `maxChars?` | Live file or URL text, actual read location and title, read time, warning, and `truncated`; with `linked_repo` and `path`, a file from a linked repository |
| `sources_add` | `title`, `location`, `guidance` | The registered source and whether it was newly added |
| `terminal_spawn` | `session?`, `command?` | `{terminalId, sessionId, workspaceId, path, command?}` |
| `terminal_read` | `terminalId?`, `session?`, `maxChars?` | A terminal tail, or the terminals known for a workspace |
| `terminal_write` | `terminalId`, `text`, `submit?` | `{terminalId, bytes}` |
| `terminal_close` | `terminalId` | `{terminalId, wasRunning, exitCode?}` |
| `project_list` | — | Every registered project, including projects with no open session |
| `schedule_followup` | `prompt`, `inSeconds?` or `at?`, `name?` | A one-shot scheduled wake for this session |
| `schedule_list` | `project?` | `{projectId, schedules: [{scheduleId, name, prompt, enabled, cronExpr?, runOnceAt?, runTarget, createdBy, sessionId?, nextRunAt?, lastRunAt?, lastError?}], truncated}` |
| `schedule_cancel` | `scheduleId`, `disable?` | `{scheduleId, name, deleted}` |
| `schedule_resume` | `scheduleId` | `{scheduleId, name, nextRunAt?}` |
| `pr_watch` | `pr?`, `cleanupOnMerge?` | `{projectId, prNumber, url?, headSha?, watching}` — wakes this session about the PR until it merges or closes |
| `pr_unwatch` | `pr?` | `{removed}` |
| `pr_cleanup` | `pr?` | `{prNumber, branch, baseBranch, mergedHead, mergeCommit, remote, base, local, checkoutPath, text}`; each step is `{outcome, detail}`. Git cleanup after a merge. Never archives the chat. |
| `arc_status` | — | The caller's Arc: `{arcId, name, state, dir, brief, briefTruncated, coordinatorSessionId?, callerIsCoordinator, members: [{sessionId, taskLabel, projectName, state, prNumber?, prState?}], truncated, launchesLast24h, limits: {maxActiveMembers, maxLaunchesPerDay}, now, notesBytes?, notesApproxTokens?, notesOversized, logBytes?}`. `now` is the local clock; `notesOversized` is true above 24 KB of `NOTES.md`. `NOT_IN_ARC` if the caller is not attached to one. |

A goal makes this session keep working until a separate evaluator judges the
condition met. Set one when the user describes work with a verifiable end
state rather than a single edit. See [goals.md](goals.md).

`attention` is the persisted answer to whether a person should look at a
session. Its values are `normal`, `blocked`, `failed`, `review-ready`,
`question-asked`, and `approval-needed`. It is included in both session reads
so a launcher can check one child without listing every session.

`session_launch.reasoning` accepts `low`, `medium`, `high`, `xhigh`, `max`, or
`ultra`. `permissionMode` accepts `auto-approve`, `ask-each-time`, or
`provider-defaults`. Omitted values inherit from the caller. `model: "auto"`
(or `auto:cost` for Speed, `auto:economy` for Cost,
`auto:balanced`, `auto:intelligence`) lets the router pick
provider, model and effort from the prompt; it needs a saved Jev key, and an
explicit `reasoning` still wins. A caller on Auto that omits both `model` and
`provider` inherits its Auto tier rather than the model its last turn ran on.
See [routing.md](routing.md).

**A launch never gets a looser permission mode than its caller.** From strictest
to loosest the modes are `ask-each-time`, `provider-defaults`, `auto-approve`.
A request at or below the caller's own mode is honoured. A request above it is
replaced by the caller's mode, and the reply says so: `permissionMode` is what
the session runs under, and `permissionModeRequested` is what was asked for. An
`ask-each-time` caller therefore launches only `ask-each-time` sessions, a
`provider-defaults` caller launches `provider-defaults` or `ask-each-time`, and
an `auto-approve` caller may launch any. The caller's mode is read from its
session row. The ceiling is `child_permission_mode` in
[session_launch.rs](../src-tauri/src/application/session_launch.rs). It does not
ban any provider: a provider that cannot answer approvals is still refused by
`ensure_permission_mode_supported` when the launch asks for `ask-each-time`.

### Retrying a launch

`session_launch` takes an optional `clientRequestId`: 1 to 128 printable
characters the caller chooses, scoped to the calling session. It makes the call
safe to repeat after a timeout or a lost reply.

- **Receipt first.** The receipt row ([data.md](data.md), `launch_receipts`) is
  written before the budget lock, the router, project check, the worktree or
  the provider. It holds the canonical request (a SHA-256 of the action without
  the key and before any Arc preamble is added) and the session id the launch
  will use. The session id is chosen up front, and the checkout is written onto
  the receipt before the provider starts.
- **Same key, same arguments** replays the first launch's reply with
  `replayed: true`: same session, workspace and checkout, and no second
  provider process. **Same key, other arguments** is `LAUNCH_REQUEST_ID_MISMATCH`.
- **Two copies in flight together** start one session. The second waits up to
  30 seconds for the first to settle, then answers `LAUNCH_IN_PROGRESS` with
  the session id. The claim is one SQLite write, so the budget lock, which is
  per process and comes later, is not what prevents the duplicate.
- **`pending`** is a launch in flight. **`completed`** replays. **`failed`**
  means the launch was refused or failed before its session row was written. No
  provider started. The router and project check may already have run. The same
  key may be tried again and takes a new session id. **`uncertain`** means the
  launch stopped after its session row was written (the app quit, the call was
  dropped, the receipt could not be settled, or a step after the launch
  failed). The provider may be running. The key is never launched again: a retry
  gets `LAUNCH_OUTCOME_UNCERTAIN` naming the session and workspace, and the
  caller checks it with `session_status`.
- **Restart.** At boot a `pending` receipt becomes `failed` if its session was
  never written (the provider starts only after that row commits) and
  `uncertain` if it was. An `uncertain` receipt's session also gets the lineage
  the interrupted launch never recorded (`launched_by_session_id`, depth, kind
  `agent`), so the launcher can still read, wait on and count it, in any
  project, without a second launch.
- **The cap.** An `uncertain` launch whose session exists but has no lineage
  yet holds one of the caller's slots until it does. A receipt with no session
  holds none, and a call waiting on the budget lock does not count against the
  call that holds it.

`project` accepts a repository Argmax has never opened. A name or id must
already be registered, but an absolute path is taken at face value: the
repository at it is added as a project — the same row the folder picker would
create, named after the folder, with the same default settings — and the
session launches there. So an agent told "start a chat in ~/dev/thing" does not
first need the user to add that folder by hand. A path inside a registered
project resolves to that project instead of adding it twice, and a path that is
a *linked worktree* is refused with `PROJECT_IS_CHECKOUT`: a worktree is a
checkout of a project, not a project, so the error names the project to pass as
`project` with the worktree as `path`. A path that is not a git repository at
all is refused with `PROJECT_NOT_GIT`. `session_move` resolves its `project` the
same way.

`session_launch` can target a checkout as well as a project. `path` is an
existing working tree of the target project, any directory `git worktree list`
reports, including the main one. The new session shares that checkout. `worktree`
creates a new isolated worktree instead. The two are mutually exclusive.
`branch` is the git ref to work from: with `worktree`, the isolated worktree
forks from that ref instead of the project's current branch; with `path`, the
named checkout must already be on that branch. Launch never switches another
checkout's branch. The result includes the path and branch the session landed
on. Project check runs on this launch the same way it does from the launcher
([routing.md](routing.md#project-check)). A switch starts the session in the
other project, drops `branch`, and keeps `path` only when that checkout belongs
to the project it switched to. The result's checkout fields are where it
started, and `projectCheck` says when another project was suggested or chosen.

### Arcs

An Arc's coordinator and members are ordinary sessions — `session_launch`,
`session_wait`, and every other tool above work on them exactly as they do
anywhere else. `arc_status` is the one addition: it answers "what Arc am I
in, and who else is in it" for the caller's own session, since none of the
tools above take an Arc id. Creating an Arc, editing its brief, and launching
its coordinator are desktop actions (`arc:*` IPC, see
[ipc.md](ipc.md#arcs)), not agent tools.

**Inheritance.** A session launched with `session_launch` whose caller
carries an `arc_id` inherits it, and its prompt gets a member preamble
prepended: read `BRIEF.md`/`NOTES.md` in the Arc's folder first, do not write
there, and end the final answer with a "Learnings for the arc" section so the
coordinator can fold it into `NOTES.md`. A `/multitask` dispatched from an
Arc session inherits the same way. Inheritance has no depth limit of its own
— a member's own launches carry the Arc forward exactly like the coordinator's
do — but `LAUNCH_DEPTH_EXCEEDED` still applies at two levels below the user,
same as any other chain.

**`session_move`** always mints a new session row for the destination, so a
moved Arc member's `arc_id` is carried across explicitly, and if the session
that moved was the Arc's current coordinator, the Arc's
`coordinatorSessionId` is repointed at the new row in the same transaction;
`fork_session` carries neither, so a fork of an Arc member starts outside the
Arc rather than silently becoming (or duplicating) its coordinator.

**Caps**, checked wherever `session_launch` already checks `LAUNCH_LIMIT_REACHED`
and `LAUNCH_DEPTH_EXCEEDED`:

- `ARC_DONE` — the Arc is done. A person has to reopen it (set it active or
  paused) before it takes another launch.
- `ARC_CAPACITY_REACHED` — 8 of the Arc's sessions are already active
  (not `complete`, `failed`, or `cancelled`), the coordinator excluded. Wait
  for one to finish.
- `ARC_LAUNCH_BUDGET_REACHED` — the Arc has launched 40 sessions in the last
  rolling 24 hours, coordinator launches included. Wait for the window to
  roll forward.
- The Arc's *current* coordinator (the caller's own id matches
  `coordinatorSessionId`) is exempt from the ordinary twenty-launches-per-session
  cap — it plans and delegates for the whole Arc, so its own lifetime count
  must not run out after twenty pieces of work. Every other session, coordinator
  or not, still counts against it. A relaunched coordinator's old session
  keeps its own count; the exemption follows whichever session currently
  holds the pointer.

A coordinator's own prompt is the [coordinator preamble](../src-tauri/src/arcs/preamble.rs)
`arc:launch-coordinator` starts it with, not something `session_launch`
prepends — it tells the agent to plan and delegate rather than implement, to
read `NOTES.md` before planning (a non-empty one means a previous coordinator
may already have worked on this Arc), that completion notices arrive only one
hop (so it must not `session_wait` on a grandchild), and to use
`schedule_followup` to check back on longer work instead of blocking.
"Plans and delegates, never codes" is that prompt contract, not a permission:
the coordinator is an ordinary, disposable session with no special
restrictions of its own.

### Workspaces and checks

`checks_run` runs one named command or the target project's configured check
commands. Configured commands run in order and stop at the first failure. The
optional `session` addresses a peer's workspace. The checks service applies
the same destructive-command guard as the Checks panel. One wall-clock timeout
covers the whole sequence. It defaults to five minutes and is capped at 30
minutes; the control socket remains open for that budget plus cleanup slack.

`workspace_status` reports information held by Argmax rather than Git:
whether the checkout is shared, its base ref, tracked pull request and check
state, and whether the workspace can be archived. `workspace_diff` uses the
same review service as the Changes panel. It defaults to the working tree,
accepts `branch` and `committed` comparisons, and can narrow the result to one
relative path. Diff text defaults to 16,000 characters and is capped at
40,000. The changed-file list is capped at 100. `truncated: true` means the
caller should request one file.

### Project learnings

`learnings_add` writes a project-scoped `pitfall`, `convention`, or `command`
with the calling session as evidence. `learnings_search` uses the learnings
full-text index and records hits on returned rows. An empty query returns the
project's most-used entries. Search results default to 10 rows and are capped
at 40.

### Project sources

Project sources are durable references to repository-relative text files or
HTTP(S) URLs. Their stored metadata includes a title and guidance about when an
agent should consult them. Argmax stores no copy of the source contents.

`sources_list` reads only the caller's project and reports availability, not
use. It returns pages in newest-first order. Pages default to 20 entries, accept
an offset and limit, and can stop earlier to remain inside the control
protocol's byte budget. A truncated response includes `nextOffset`.

`sources_read` accepts an id from that project. File sources are resolved
through the workspace file service against the caller's current checkout, so
an isolated workspace reads its own version of the file. URL sources open in
the session's Argmax browser, wait for the page, and return rendered text with
the final URL and page title. Text defaults to 24,576 characters and is capped
at 40,960. Empty, binary, oversized, missing, and failed reads return errors
and are not recorded as successful reads.

Agents may read and edit linked repositories as needed for the task, following each repository's instructions and session permissions. Use normal file or shell tools for edits.

Linked repositories ([memory.md](memory.md#linked-repositories)) ride the same
two tools. `sources_list` always returns the enabled roots as
`linkedRepos: [{ name, root, summary? }]`. The optional generated summary is descriptive context, not repository instructions. Passing `linked_repo` (and optionally `path`, a
directory relative to the root) lists that directory instead, up to 500 entries
a page with `nextOffset`, hiding `.git`. `sources_read` takes exactly one of `id`
or `linked_repo` with `path`. A `path` without `linked_repo` is refused with
`SOURCE_PATH_REQUIRES_LINKED_REPO` on both tools instead of being ignored. A
directory page stays inside the same 48 KiB budget as the plain listing, counted
over the encoded entries, and `nextOffset` names the first entry not returned. A path that is absolute, contains `..`, touches
`.git`, or resolves outside the root through a symlink is refused with
`LINKED_REPO_PATH_ESCAPES`, `LINKED_REPO_PATH_ABSOLUTE`, or
`LINKED_REPO_PATH_FORBIDDEN`; a switched-off repository is
`LINKED_REPO_DISABLED`. A successful linked read adds a `session.note`
(`operation: "linked-repo"`) and has no `source` in its result. The chat does
not draw that note: the call itself is classified as a `read` (or `list`)
activity with the target `<repo>/<path>`, so it joins the turn's "Read N files"
group as "Read <file> in <repo>". One notice per file buried the turn. The debug
log still lists the note.

Every successful read adds a durable `session.note` timeline event naming the
source, time, actual operation, and whether the returned text was truncated.
`sources_add` records the same kind of note only when it creates a new entry.
Adding the same location again returns the existing entry with `added: false`.
Listing sources does not write a read note.

Source contents are untrusted context. A successful read note records the
source, location, and retrieval time. It does not retain the returned contents
or establish their version, correctness, or freshness. Current
code and direct evidence take precedence. Registering a source does not make it
authoritative and does not create project memory automatically.

### Persistent terminals

Agents run ordinary commands in their own shell. The server instructions say
so (`OWN_SHELL_INSTRUCTION`), and `terminal_spawn` is reserved for processes
that must outlive the turn or that the user asked to watch.

`terminal_spawn` starts a PTY owned by Argmax, optionally typing a command into
its shell. The process therefore survives the provider turn that created it
and remains visible in the Terminal panel. `terminal_read` without a terminal
id lists known terminals for a workspace. With an id, it returns the newest
captured output in chronological order plus running and exit information.
Argmax keeps 128 KiB of scrollback per terminal. It trims finished records
oldest first toward a 64-record cap, but never evicts a live terminal. One read
defaults to 8,000 characters and is capped at 40,000.

`terminal_write` types into a live terminal: `text` is sent verbatim and
`submit` (default true) adds Enter, so `"\u0003"` with `submit: false` is
Ctrl-C. It fails with `TERMINAL_EXITED` or `TERMINAL_NOT_FOUND` rather than
dropping the bytes, including when the shell has been reaped but its last
output is still draining. `terminal_close` terminates the terminal's process group
(SIGTERM, then SIGKILL after 1.5 s), the same path as closing the tab; the
output stays readable.

### Projects and scheduled follow-ups

`project_list` includes registered projects with no open sessions. Each row
includes its repo path, current and default branches, configured checks, active
session count, and latest activity. A repository missing from the list is still
reachable: naming its absolute path as `project` adds it.

`schedule_followup` creates an enabled, one-shot scheduled task whose target is
the calling session. Give either a delay in seconds or an RFC 3339 timestamp.
The scheduler runs every 30 seconds, so earlier times are raised to that floor.
Follow-ups can be scheduled at most seven days ahead and appear in Scheduled
Tasks, where the user can disable or delete them. The row is the alarm rather
than a saved task: firing clears it, so a wake leaves nothing behind.

`schedule_list` returns one project's scheduled tasks — the wakes chats set and
the recurring routines the user wrote — capped at 50 rows with `truncated`, and
each prompt capped at 500 characters. `sessionId` is the chat a same-chat task
fires into: equal to the caller's own id, the row is a wake it set for itself.
`createdBy` is `agent` for a wake and `user` for a task the person wrote or
edited, which is what tells an agent which rows are its own to remove.

`schedule_cancel` stops one from firing. It deletes by default and pauses with
`disable`, which leaves the row in Scheduled Tasks with its prompt and schedule
intact. A wake of the caller's own is meant to be deleted the moment it is
pointless — the PR merged, CI went green — since pausing it only parks a row
the user has to sweep by hand. `disable` is for the tasks they wrote. `schedule_resume` switches a paused one back on and recomputes its next
run from now, so a recurring task picks up at its next occurrence rather than
firing once for every run it slept through. Both are limited to tasks in the
caller's own project; anything else is refused with `SCHEDULE_OTHER_PROJECT`.

Together with `schedule_followup` that is the whole surface: an agent can
create a wake for itself, read a project's tasks, and switch any of them off,
on, or away. It cannot write a recurring routine or edit one's prompt,
schedule, or target — that stays in the Scheduled Tasks panel.

A wake arrives as a turn of its own. Because the floor is 30 seconds and the
tool is called mid-turn, its time usually passes while the calling turn is
still running; the scheduler then leaves the task due and wakes the chat on the
first tick after it settles, rather than queueing the prompt behind what the
user has typed. See [scheduled-tasks.md](scheduled-tasks.md).

### PR watches

`pr_watch` asks Argmax to wake this session about one pull request, so the
agent ends its turn instead of polling GitHub in a shell. `pr` defaults to the
session's primary PR. The gh poller then reads the PR on its 60 second tick
and sends one watch notice whenever there is something to act on: failing
checks, new reviews and comments, checks green on the head, or the PR merged or
closed. A merge or close ends the watch. See [gh.md](gh.md#pr-watch) for the
events, the notice text, and dedupe.

Calling `pr_watch` again for the same PR keeps the watch and its cursors and
updates the options. With `cleanupOnMerge`, the watch runs `pr_cleanup` when
the PR merges and puts its report in the merged notice. A PR number Argmax has not read yet is accepted, and the
poller views it by number on the next tick. Errors are `PR_NOT_FOUND` (no `pr`
and no primary PR), `PR_NOT_OPEN` (already merged or closed), and
`PROJECT_NOT_ALLOWED` (a side chat). `pr_unwatch` removes a watch and returns
whether there was one.

`pr_cleanup` does the git cleanup after a merge, with no shell steps. `pr`
defaults to the session's primary PR. It deletes the remote branch only while
it still points at the merged head, fast-forwards the base where it is checked
out, deletes the local branch only when nothing owns it, and prunes. It never
archives or hides the chat. Errors are `PR_NOT_MERGED`, `PR_NOT_FOUND`, and
`PROJECT_NOT_ALLOWED`. See [workspaces.md](workspaces.md#pr-cleanup).

A notice arrives through the inbox like any other system notice, so the
behavior is the same for every provider. The agent decides what to do. In
particular, Argmax reports checks green with the unresolved threads and
requested reviewers, and the agent applies the merge gate.

### Browser

The same server carries Argmax's browser. A page an agent opens is a real tab
in the user's window, shown in that session's own pane — browsing is visible
work, not a hidden side channel.

Cookie banners on agent tabs are dismissed automatically. A leftover prompt
may still be accepted without asking the user.

| Tool | Arguments | Returns |
|---|---|---|
| `browser_open` | `url` | `{tabId, opened}` |
| `browser_navigate` | `url`, `tab?` | `{tabId}` |
| `browser_back` / `browser_reload` | `tab?` | `{tabId}` |
| `browser_tabs` | — | `{tabs: [{tabId, ownerSessionId, url, title, loading, group}]}`, this session's only |
| `browser_activate` | `tab?` | `{tabId, active}` |
| `browser_duplicate` | `tab?`, `activate?` | `{tabId, opened}` |
| `browser_open_link` | `ref`, `tab?`, `activate?` | `{tabId, url, opened}` |
| `browser_group_tabs` | `tabs`, `group?` | `{tabs, group}` |
| `browser_close` | `tab` | `{tabId, closed}` |
| `browser_snapshot` | `tab?`, `interactive_only?` | `{tabId, url, title, state, tree, truncated}` |
| `browser_find` | `query`, `tab?` | `{tabId, matches: [{ref, role, name, value}]}` |
| `browser_get_text` | `tab?`, `max_chars?` | `{tabId, url, title, state, text, truncated}` |
| `browser_extract` | `tab?`, `max_chars?` | `{tabId, url, title, state, metadata, headings, sections, tables, links, items, fields, truncated}` |
| `browser_click` / `browser_hover` | `ref`, `tab?` | `{tabId, url, detail, textChars?, textCharsDelta?, listboxOpen?, urlChanged?}` |
| `browser_type` | `ref`, `text`, `submit?`, `tab?` | `{tabId, url, detail}` |
| `browser_select` | `ref`, `value`, `tab?` | `{tabId, url, detail}` |
| `browser_press_key` | `key`, `modifiers?`, `tab?` | `{tabId, url, detail}` |
| `browser_scroll` | `direction`, `amount?`, `ref?`, `tab?` | `{tabId, url, detail}` |
| `browser_drag` | `ref`, `to_ref?` \| `delta_x`/`delta_y`, `start_x?`, `start_y?`, `end_x?`, `end_y?`, `steps?`, `tab?` | `{tabId, url, detail}` |
| `browser_wait_for` | `text?`, `ref?`, `url_includes?`, `quiet_ms?`, `min_count?`, `timeout_s?`, `tab?` | `{tabId, url, detail, matched, state}` — a miss is `matched: false` with page state, not an error |
| `browser_screenshot` | `tab?`, `ref?` | an image content block, plus `{width, height, bytes, dropped, path}` |
| `browser_evaluate` | `expression`, `frame?`, `tab?` | `{tabId, result, frame?}` |
| `browser_console` | `tab?`, `limit?`, `clear?` | Captured console calls, uncaught errors, and unhandled rejections |
| `browser_network` | `tab?`, `limit?`, `clear?` | Captured fetch, XHR, and resource timing records |
| `browser_handle_dialog` | `accept`, `prompt_text?`, `tab?` | `{tabId, armed, answered}` |

**Ownership.** A session may only drive tabs it opened. A `tab` naming the
user's own tab, or another session's, is refused with `BROWSER_TAB_NOT_OWNED`;
an unknown id with `BROWSER_NOT_OPEN`. Naming no tab means the tab this session
touched most recently, which no other session can reach by construction — so
the default is always safe. `browser_tabs` lists only the caller's tabs.

**Refs.** `browser_snapshot` returns an aria tree whose interactive lines carry
`[ref=eN]` handles, and every write tool addresses one of those. A ref lives in
the page as a `data-argmax-ref` attribute, so it stays valid while its element
does and dies with the document: after a navigation, a reload, or a
single-page-app route change, take a fresh snapshot. A ref that no longer
resolves fails with a message that says exactly that.

**Iframes.** A page inside an `<iframe>`, cross-origin and sandboxed ones
included (a Claude artifact, an embedded deck or form), reads and drives like
the rest of the tab. The snapshot prints `- iframe "…" [frame=f3] url=…` and
splices that frame's tree under it, with refs like `f3e5`; every ref tool
routes them into the frame. `browser_find`, `browser_get_text`,
`browser_extract`, `browser_wait_for` (text and counts), `browser_console`,
and `browser_network` cover every frame. A key press follows focus into a
frame, and after a click or typing in one, keys go there. A scroll the page
cannot take moves its largest frame. `browser_evaluate` takes `frame: "f3"`.
A frame that cannot run script (a sandbox without `allow-scripts`) prints
`(content not readable)`. See [browser.md](browser.md#frames).

**Reading a page: three tools, cheapest first.** `browser_extract` is the one
to reach for when the question is *what does this page say*: it returns the
article's metadata, headings, sections, tables, unique links, repeating items,
and filled form fields as structured JSON, so comparing sources does not mean
parsing an accessibility tree. `browser_get_text` is the flat-prose fallback
when structure does not matter, and `browser_snapshot` is for *acting* — it is
the only one that hands out refs. All three include `state` (`captcha`,
`cookie`, `error`, `loading`, `ready`). Use extract's `items` for card/list
UIs and `fields` to see what a form currently holds.

**Tabs are for the human too.** `browser_activate` shows one of this session's
tabs in its pane and makes it the default for later calls. `browser_open_link`
opens a link ref beside the page it came from, and `browser_duplicate` forks a
tab at its current URL; both stay in the background unless `activate` is set,
and a background tab deliberately does *not* become the session's default —
queueing up links must not move the agent off the page it queued them from. A
new tab inherits the source tab's group. `browser_group_tabs` labels a set of
related tabs, and that label replaces the "agent" badge in the user's tab
strip, so grouping is something they can see rather than private bookkeeping.

**Dragging is stepped, not instant.** `browser_drag` presses at `ref` and
releases at `to_ref` (or `delta_x`/`delta_y` from where it started), moving in
`steps` increments so the page renders between moves — without that the drag
libraries that matter land the item back where it started. The gesture also
drives `<input type="range">` sliders, and the pointer is released on every exit
path, including a failure mid-gesture. See [browser.md](browser.md).

**Screenshots cost more than snapshots.** A snapshot is text — a few kilobytes
of roles, names and refs, and the only thing that hands out refs. A screenshot
is a PNG that has to survive base64 through the provider's JSON stream, so it is
rasterised narrow and dropped entirely (text and dimensions only) when it is
still too large. Reach for it when the question is visual and for nothing else;
the tool description says so.

**Dialogs.** On a tab a session opened, `alert` / `confirm` / `prompt` are
answered on the spot — with whatever `browser_handle_dialog` armed, otherwise
dismissively — and the record shows up for 30 seconds as a `dialog:` header line
in the snapshot:

```
url: https://example.com/
title: Example
dialog: confirm "Delete this?" pending (auto-dismissed with false)
```

`browser_handle_dialog` arms the answer for the *next* dialog on that tab and
acknowledges the one that just fired, so the way through is: see the header
line, arm the answer, repeat the action. Tabs the user opened are untouched.

**Console and network capture.** Agent-owned tabs install capture before page
scripts run. `browser_console` returns console calls, uncaught errors, and
unhandled promise rejections. `browser_network` returns fetch and XHR method,
status, duration, and error fields, plus resource timing rows. Each tab keeps
the newest 200 rows of each kind, and one call returns 50 by default. Set
`clear` before an interaction to isolate what that interaction caused. This is
page-level capture, not a debugger attachment: response bodies and request
headers are unavailable, a resource timing row may carry no status, and tabs the
user opened are not instrumented.

`project` takes a registered project's name, or any repository's absolute path
— an unregistered one is added on first use, as above — and defaults to the
caller's own project. `path` and `branch` pick a checkout of
that project as described above. `provider` and `model` default to the
caller's own: an agent that names neither launches a peer of itself. A named
model is passed to the CLI as-is and stands in as its own sidebar label — Rust
has no model-label catalog, that lives in
[providerModels.ts](../src/shared/providerModels.ts).

A move is scheduled rather than immediate: it runs once the calling turn
settles, since the agent asking for it is mid-turn.

`session_move` takes exactly one destination. `project` moves to another
project, registering the repository at that path if Argmax has never opened it;
`path` moves to another checkout of the project the chat is already in. `path` is the reason an agent should never reach for `cd` when the
work belongs in a different worktree: `cd` moves only that shell, so the
workspace card, its diff, and its commit and pull-request actions keep targeting
the checkout the session started in, and the next turn relaunches there — the
agent's work lands somewhere Argmax is not looking. The tool description says so
directly, because the alternative is one an agent reaches for by habit.

A move relocates work, so it does not stop at relocating the transcript: once
the destination workspace exists, its `prompt` starts the chat's first turn
there, in the destination checkout. That turn is composed like any follow-up
([follow_up.rs](../src-tauri/src/providers/follow_up.rs)) — the copied
transcript is Argmax's record, not context the destination CLI holds, so it
opens with the last few turns and the seam's own handoff note ("This chat moved
from *source* to *destination*. Work in the destination checkout at …"). Write
the prompt to stand on its own anyway, and call `session_move` as the last
action of a turn: anything done after it is not in the prompt already written.

The destination keeps the source's launch lineage — who launched this chat, at
what depth, and why — so a session that moves is still on its launcher's watch
list, still sends its completion notice, and still counts against the launch
caps. Without that, a moved chat would come back as a depth-0 orphan whose
unattended turn nobody is told about.

The continuation stops after three moves in one chat's history — the seams ride
along in the copied transcript, so the count is the whole chain. Two agents
that each conclude the work belongs in the other repo would otherwise bounce a
live turn between them unattended; past the cap the chat lands in the
destination and waits for a person, and says so in the timeline. A move whose
continuation cannot start records that on the destination too, where the
transcript now lives — the source is usually archived by then.

`workspace_archive` closes the caller's own workspace on the same schedule, and
for a sharper version of the same reason: archiving terminates every provider
process in the workspace, and the agent asking is one of them. Run inline the
call would kill its caller before it could report, so it is deferred and the
tool answers `{scheduled: true}`. One slot serves both — a chat cannot be
moving and archiving at once, and the refusal names whichever was scheduled
first (`MOVE_ALREADY_PENDING` / `ARCHIVE_ALREADY_PENDING`). While either is
pending, follow-ups into that chat are refused.

It exists because merged work leaves its checkout behind. An agent that lands a
pull request and was explicitly asked to archive its chat can hand the
disposal to Argmax instead of removing the directory it is standing in:
`git worktree remove` on your own working directory succeeds and then every
later command in the turn fails, and a worktree removed behind the app's back
leaves a sidebar row pointing at nothing. The archive is the app's own path:
checkout moved into the archive location with its files and branch retained,
then the row archived. Settings exposes the archived-workspace directory.

The archive is never forced. A workspace with uncommitted changes comes to rest
as **kept** instead ([GLOSSARY.md](../GLOSSARY.md)), so an agent should report the
archive as requested rather than done. An isolated checkout moves into recovery
storage, while a shared checkout stays in place because other sessions may
still use it. Nothing the archive does removes a worktree, which is why the
result no longer carries a `removesWorktree` flag that was only ever false.

Either promise survives a restart. `{scheduled: true}` is answered mid-turn and
the agent reports to the user on that answer, so the request is written to
`session_after_turn` ([data.md](data.md)) before the reply goes out. If Argmax
quits or crashes before the turn settles, the next launch picks the row up
after it has recovered orphaned sessions and repaired interrupted archives, and
runs the disposal then — the turn ended with the process, so there is nothing
left to wait for. It says so in the chat's timeline first, as a `session.note`
row ([chat-cards.md](chat-cards.md)). A promise with nothing left to do (the
session is gone, the workspace is already archived, or the move already
happened) is dropped instead of run again.

## Observing another session

`session_read` returns the *normalized* timeline, not provider JSON. Every
provider's output is translated into `events` rows on the way in
([data.md](data.md)), so a read is the same query the chat pane makes
(`session:events-since`) with each row flattened to one line: `user` prompts,
`assistant` answers, `tool` calls as name plus one argument, `tool-result` as
`ok` or `error: …`, `note` for what Argmax did to the chat itself, and `state`
for a session ending. Rows the chat hides —
streaming deltas, subagent traces, lifecycle bookkeeping — are dropped here
too.

A read with no cursor starts at the beginning of the transcript and pages
forward from `nextCursor` — unlike the chat pane's cursorless read of the same
rows, which wants the newest page because it scrolls up.

A page is capped at 500 rows and in bytes (16 KB by default, 40 KB at most),
and each entry is capped at 2 000 characters, so one enormous tool result
cannot spend the whole budget. A page either cap cut short comes back with
`truncated: true`; read again from `nextCursor` for the rest.

An entry the cap cut carries `clipped: true` and a stable `id` (the event id).
Pass that id as `itemId` to read the whole entry, and `nextOffset` as `offset`
to continue. The unit is bytes, everywhere: `maxChars` is a byte budget and
`offset`, `nextOffset`, and `totalBytes` are byte offsets into the entry's
UTF-8 text. A slice never ends inside a character, so `nextOffset` is always
a character boundary. An `offset` that is not one is refused (`OFFSET_INVALID`)
instead of served mangled. An item read shows what the page hides: a tool call's
whole input and a tool result's whole output. Rows the chat hides (subagent
traces, streaming deltas) have no readable id (`ITEM_NOT_FOUND`).

### Who may read whom

`session_read` and `session_status` take the caller, and refuse
(`READ_FORBIDDEN`) a session the caller may not read. An agent reads:

- its own project's sessions. A scratch Chat has no project to share, so each
  Chat is its own boundary;
- its launch lineage, up and down and across projects, so a parent still reads
  a child it launched into another project, and the child its launcher;
- a chat a person attached to one of its prompts. The composer writes a chat
  chip as `[title](argmax://chat/<session id>?v=1)` into the prompt, and a
  person's prompt in the caller's transcript that holds such a link is the
  grant. The grant is for that one session. The transcript is the durable
  authority, so there is no grant table to keep in step.

  What counts as the person's prompt is narrow, because an agent can put any
  text in a prompt it writes. A `user.message` grants only when it carries the
  positive person mark, the `events.prompt_author = 'person'` column
  ([persistence/authorship.rs](../src-tauri/src/persistence/authorship.rs)).
  Only fresh text from the person's own composer gets it: the backend writes it
  for `providers:launch` (the opening prompt), `providers:send-input`,
  `providers:steer-input`, and a prompt typed into Multitask, on the desktop
  webview and on the paired phone alike. Those four handlers in `crate::ipc`
  are the only code that can build the `PersonAttestation` token a person
  author needs, and a test lists the call sites. The marker is a column, never
  payload JSON, and no input type carries it, so a client, a tool argument, a
  transcript file or a synced provider event cannot supply it.

  Everything else is unattested and grants nothing: another session's message,
  a goal turn, a scheduled follow-up, a session move, a completion notice, an
  MCP `session_launch`, a routine or check-failure launch, a fork merge, a
  sync import, a legacy row, and a path nobody remembered to update. Missing
  the mark fails closed. A queued row keeps the author it was queued with
  through drain, Send now, steer, requeue and Multitask. A fork or a move copies
  each prompt's author and never changes it. A person's prompt that also carries
  an origin or a starter is refused (`PROMPT_AUTHOR_CONFLICT`). Text Argmax
  adds to a person's prompt from strings an agent can set (a typed Multitask's
  preamble names the parent chat's label and branch and the Arc's name and
  folder) has its square brackets turned into parentheses first, so only the
  person's own typed chip can form a link. The link has to
  be one the composer would draw as a chip, in the renderer's grammar
  (`composerContext.ts`, mirrored by `chat_reference_ids`): a bracketed title of
  1 to 120 characters, `argmax://chat/`, an id of up to 64 of `A-Za-z0-9_-`
  ending at `?` or `)`, and a `v` of exactly `1` or none. A bare URL, a longer
  or shorter id, or another version grants nothing.

  The mark stops text that an agent or another process wrote from becoming a
  cross-project read grant when Argmax itself routes that text: MCP and socket
  tools, routines, CI logs, sync files and provider output. It is not a
  boundary against an agent with shell access, which can already read the SQLite
  file or the bridge token. The same limit holds for every other local data
  path. The paired remote device counts as the person.

The app's own UI is not scoped: it browses every project. `session_list`
with `all` still lists other projects, marking the ones the caller cannot read.
`query` searches the conversation text of readable sessions only, in SQL, so
sessions the caller may not read cannot crowd out the ones it may. It keeps the
best line of each chat before it applies the limit, so one chat with a hundred
matches cannot fill the list. The list runs on a read connection, with the
caller's attached chats read by one query.

Tool arguments are snake_case (`item_id`, `max_chars`); results are camelCase
(`itemId`, `nextOffset`). `session_read` and `session_list` refuse an argument
they do not know, so a misspelled `itemId` is an error and not a quiet page read.
A tool row is `clipped` only when its line left something out: an argument other
than the one shown, a cut at the cap, or output the `-> ok` summary dropped.

`session_status` answers the cheaper question — is it still working, how long
has this turn been running, what did it last say, is anyone waiting on it — in
one row, without paging a transcript.

`session_stop` runs the same `SessionService::terminate` the user's Stop button
does: the provider process is disposed and the session goes to `cancelled`,
keeping its transcript and its workspace. A session cannot stop its own turn
(`STOP_SELF`).

## The inbox

`session_messages` ([data.md](data.md)) is a durable row per message: who sent
it, who it is for, its body, whether it is a plain `message` or a `completion`
notice, and when it was handed over.

Delivery and recording are separate on purpose. Every message is *also* sent
into the recipient through `ProviderSessionService::send_agent_message`: an idle
session starts a turn on it, a running Claude, Codex or OpenCode turn takes it as steering
(the same path as the composer's **Steer**, see [providers.md](providers.md)),
and every other working session gets it when its turn ends. Cursor and Grok
have no way to push input into a running model, and even a steerable
turn sometimes cannot take it: Codex is near or inside a compaction, Claude has
not picked up the turn's first message, or the recipient is blocked in
`session_wait`, which collects the message itself. The row
is what closes that gap: `inbox_read` hands over what is not yet delivered and
marks it collected, and `session_wait` wakes on the insert.

An automatic steer that fails differs from the composer's in one way. A person's
failed steer stays queued as unsent so they decide what to do with it; an
agent's message goes back to the ordinary queue and drains when the turn ends,
since nobody is there to retry it. A steer whose acknowledgement was lost stays
delivery-unknown and is never resent, the same as the composer's. Completion
notices, Arc PR notices, and PR watch notices (`send_system_notice`) use the
same delivery.

Two caps keep a hand-over bounded, since a row is marked collected by the same
call that carries it and a reply the client refuses would take the messages
with it: a stored body is capped at 16K characters with a `(truncated)` marker,
and one read hands over at most 50 messages and 48 KB of body. What does not fit
stays undelivered and comes back on the next read.

Neither cap is what keeps the reply readable. They count characters and rows
while the ceiling counts bytes — 16K four-byte scalars are 64 KB on their own —
and the hand-over always takes its first row whatever it costs, so no byte
budget can hold it under the 64 KB every other reply is read with. An inbox or
wait reply is therefore read under a 512 KB ceiling of its own, which is above
anything those caps can produce.

### The flag every tool result carries

The row closes the gap only if the recipient thinks to look in it, and an agent
deep in a turn has no reason to. None of the five CLIs will take a server push
mid-turn either. But there is one text channel that reaches a running model
without touching its turn: its own tool results. So every `argmax` reply — a
`session_list`, a `browser_click`, anything — carries a second content block
when mail is waiting:

```
2 messages from other sessions are waiting unread in your Argmax inbox. Call
inbox_read to collect them mid-turn, without ending your current turn.
```

The count is taken *after* the action runs, which is what makes it right on the
inbox tools too: a read the reply ceiling cut short reports what it left behind
instead of looking complete, and one that emptied the inbox says nothing at all.

This is the difference between a peer that answers and a queue the user watches
pile up, and it is bounded by exactly one thing: an agent that touches no
`argmax` tool for the rest of its turn is not reached, and gets the message the
old way when the turn ends. For Claude, Codex and OpenCode the flag is mostly a
fallback: their running turns are steered directly.

### Delivered once, whichever path wins

A message can now arrive two ways, so exactly one of them has to win. Every turn
that carries a message carries its row id with it (`MessageOrigin.message_id`),
and the row is closed the moment that turn actually starts: immediately for an
idle recipient, at the drain for one that was mid-turn.

Inbox reads and waits remove collected messages from the pending queue and
publish the updated queue immediately. Startup recovery also discards queued
copies whose inbox records already confirm delivery. Reading a result mid-turn
therefore removes its composer row without waiting for the turn to finish.
Enqueue also checks delivery while holding the database writer lock. If the
recipient collected the inbox row while the sender waited for the checkout
lock, the sender reports it delivered without creating a pending copy.

That id is what makes both directions safe. The queue checks the row before it
sends, so a message the recipient already collected through `inbox_read` is
dropped instead of delivered a second time — and the drain goes on to the
message behind it, since no turn will start to trigger the next drain. Closing
the row at the drain is the mirror image: without it, a message the agent has
just been handed as a turn comes back out of the next `inbox_read`, and the
unread flag fires on every tool result for the rest of the session.

A row stays open whenever no turn actually took it — a send that queues again
because a turn started under it, or one that fails and puts the message back on
the queue. Undelivered is the safe direction to be wrong in: the agent collects
it late rather than never.

**A failed turn parks its queue.** A non-zero exit marks the recipient's pending
queue `recovered` rather than delivering it ([`session_service.rs`](../src-tauri/src/providers/session_service.rs),
`handle_lifecycle_event` → `pause_queue_with_connection`), on the reasoning that
a broken provider should not be fed the follow-ups that piled up behind it. Only
a user stop or `/clear` deletes a queue. The row keeps it visible either way: the
entry is marked unsent, the row stays open, and the message is still there for
`inbox_read`, `session_wait`, and the unread flag.

Survivable is not the same as delivered. After a failed turn the message will
never arrive as a turn on its own — it waits until that session is working again
and touches an `argmax` tool. A sender that needs certainty should check
`session_status`, whose `unreadInbox` counts exactly these.

## Completion notices

When a session that was launched by another one ends a turn — complete, failed,
or cancelled — Argmax writes one `completion` message to the launching session:

```
Session <id> (<label>) finished with state <state> at <local time>. Final answer:
<the session's last assistant message>
```

The answer is capped at 4 KB of head. When it is longer and ends with a
"Learnings for the arc" heading past the cut, the notice keeps that section
too (itself capped at 2 KB) with a `(… middle truncated …)` marker between, so
the learnings an Arc member is asked to end with reach the coordinator. The
query behind it is `latest_agent_answer`, the unclamped sibling of the 4,000
character `latest_agent_message` every preview uses.

It is delivered like any other message, so an idle launcher **wakes up on a new
turn** carrying its child's answer, the way Claude Code's Agent Teams
idle-notification works. A notice that queued behind the launcher's running
turn is not delivered, and stays collectable from its inbox.

**Siblings that finish together wake the launcher once.** The row is written,
and a blocked `session_wait` is woken, the moment the turn ends. Only the
automatic wake waits: it is held for a 2 second window (`COMPLETION_BATCH_WINDOW`,
fixed from the first notice, per launcher). When the window closes, the wake
covers the notices the launcher has not already collected:

- none: no wake. `session_wait` or `inbox_read` already handed them over.
- one: the notice is delivered unchanged.
- several: one batch notice, `completion-batch:<launcher>:<first notice id>`,
  carries each result whole under its own `--- n/N ---` heading, with the finish
  time each child wrote. A batch holds at most 20 results (the launch cap); a
  larger pile is several batches. A result that would push the row past the
  16 KB inbox cap is replaced by a pointer line to `session_read` rather than
  cut. Every pointer is bounded (its label is capped at 80 characters and each
  result reserves 400 characters for it), so 20 results with the longest labels
  still fit one row with every session named. The batch row and the closing of
  the individual rows commit in one transaction. The individual rows stay in
  `session_messages` with their own body and time as the durable record, and the
  batch row is what the launcher still has to collect if its wake never lands.
  `session_wait` with explicit `sessions` is unaffected: it reports the named
  sessions' states and hands over the caller's inbox, which now holds the batch
  row with every result.

**A restart does not strand the launcher.** The window is in memory, so the
durable mark is `session_messages.wake_due_at` (v64): set when a completion row
or batch row is written, cleared once its wake has been attempted. At boot,
after orphan recovery, `recover_completion_wakes` rebuilds the wakes from the
rows that are still marked and unread. Individual rows go through a fresh window
so siblings still coalesce, and a batch row is delivered as it is. Delivery then
follows the ordinary rule: an idle launcher gets a turn, a running one queues
it. Not woken for: rows already collected, rows with a copy in the follow-up
journal (the composer shows them as paused or unsent, and the person or the queue
sends them), rows from before the mark existed, and a launcher whose workspace is
archiving or archived. A wake that crashed mid-attempt is repeated once, which
is safe because delivery marks the row delivered and the queue drops a copy the
launcher already collected.

**A turn the person started in the launched chat's own tab does not wake the
launcher at once.** The `user.message` that started the turn tells them apart:
one from another session carries `origin`, one from a Goal or the scheduler
carries `starter`, the session's first message is the launch prompt, and
anything else was typed by the person. Such a turn ending only bumps a
per-session digest; after 15 quiet minutes with no further turn, one notice
goes out as `Session <id> (<label>) answered the user directly <n> time(s)
since <time> and has been quiet for 15 minutes; latest answer at <time>:`. A
launcher-driven turn ending while a digest is pending cancels it and folds the
count into its own notice (`... (the user also had <n> direct exchange(s) with
it since <time>)`). The pending digest lives in memory, so a restart drops it;
the exchanges are still readable with `session_read`. On the first Arc, 36 of
93 notices were replies to the person in a member's tab, each one a full
coordinator turn.

Building a notice also deletes the launcher's `check-in:<session>` wake, if
`session_launch` scheduled one.

**The rule, and why it cannot ping-pong.** A session emits a notice on every
turn end *if and only if it has a launcher*. `launched_by_session_id` is a
strict tree rooted at the sessions a person or a routine started, and a launch
is capped at depth 2, so a notice climbs at most two hops and never comes back
down. That is also the answer to the obvious follow-up — does the turn a parent
takes purely to read a completion notify *its* launcher? It does, but only when
the parent was itself launched; a user-started session has no launcher and the
chain stops there.

The remaining guards are on the writing side: never notify yourself, skip a
launcher whose workspace is archiving or archived, and use a deterministic
message id (`completion:<session>:<turn end>`) so a retried turn end writes the
same row instead of a second notice.

## Waiting

`session_wait` blocks until one of two things happens: a watched session
reaches a settled state (`complete`, `failed`, `cancelled`), or a message
arrives for the caller. It returns the settled sessions with their states and
the messages, which it also marks collected. Nothing happening before the
timeout returns `{timedOut: true}`; call again to keep waiting. The default
timeout is 120 seconds and the ceiling is 600.

With no `sessions` the watch list is every session the caller has launched, so
the useful shape is `session_launch` → `session_wait` → `session_read`. A
watched session that is *already* settled returns at once rather than blocking,
as does an inbox that already holds something.

That form hands each finish over **once**. `sessions.wait_reported_at`
([data.md](data.md)) records when the launcher was last told, and a child is
reportable again only after a new turn moves its `last_activity_at` past that
mark — the mark is stamped by the same write that takes the inbox messages, so
a crash cannot mark a finish reported without also having handed it over.
Without it a parent that launched two children and collected the first got that
same child back the moment it asked about the second, forever, while the tool
description told it to call again to keep waiting. Naming ids in `sessions`
keeps the plain reading: the named settled sessions come back every time and
nothing is marked, which is how a launcher re-reads a finish it already
collected.

Underneath, the handler subscribes to the provider service's in-process session
state broadcast and to the inbox broadcast **before** its first database read,
so an edge landing between subscribing and reading is queued rather than lost.
A one-second re-read backs both up, for a state written outside the provider
service or a subscriber that fell behind a burst. Nothing holds a database
connection across an await, and the handler is fully async — a blocking wait
must not park a shared worker or the main thread
([performance.md](performance.md)).

`wait` is the one action whose client keeps the socket open longer than the
ordinary timeout: `client_read_timeout` gives it its own timeout plus 30
seconds of slack so a wait that runs the full duration still gets its reply.

## Policy

Keep bounded delegation in the current chat. Use the provider's native
subagents for research, review, or implementation whose result you will
integrate into the current turn. A native subagent only lives as long as the
turn that spawned it, so its result has to be collected before the answer: an
answer that reports the work as still running ends the turn and discards it
unread. The user-facing multitask flow is for work that should run alongside a
chat.

Use `session_launch` when either of these cases applies:

- The user explicitly asks for a separate session.
- The work needs its own independent, durable lifecycle that should remain
  visible and steerable after this turn, such as a separate repository
  investigation or a long-running build.

Do not launch a session merely for parallelism, fresh context, model choice, or
context relief. A launched session is a top-level sidebar session, not a
subagent. The launcher owns synthesis and verification. Keep delegation one
hop unless the brief explicitly requires further decomposition.

Two caps keep a chain finite, enforced in the socket handler where every caller
passes through:

- **Depth ≤ 2.** A session the user started is depth 0. It may launch (depth 1),
  and that session may launch (depth 2). A launch from depth 2 is refused with
  `LAUNCH_DEPTH_EXCEEDED`.
- **Twenty launches per session** (`MAX_LAUNCHES_PER_SESSION`), refused with `LAUNCH_LIMIT_REACHED`. A launch that stopped after its session was written but before the launch was recorded still holds a slot until the session carries its lineage (see retrying a launch).

A session cannot message itself (`MESSAGE_SELF`) or stop its own turn
(`STOP_SELF`). `session_rename` has no target argument — only the caller's own
sidebar label may change, the same scope as `goal_set` and `workspace_archive`.
To name a child at birth, pass `taskLabel` to `session_launch`. Lineage lives
on the session row as `launched_by_session_id` and
`launch_depth` ([data.md](data.md)), so both caps are counted from the database
rather than from anything the agent controls.

## How each provider gets the server

The server is `argmax mcp` — the same binary the app runs from, serving MCP over
stdio and forwarding each call to the running app over the session-control
socket. No sidecar, no second control plane. Wherever the spec is per-launch,
the per-session bearer token rides in the spec's own `env` rather than the
provider process's environment, so a warm shared process (Cursor's ACP pool)
can still hand each session its own credential.

| Provider | Mechanism | Leaves a file? |
|---|---|---|
| Claude | `--mcp-config '<inline json>'` | no |
| Codex | `-c mcp_servers.argmax.*` | no |
| Cursor (composer, ACP) | user MCPs from one home-scoped Cursor login; Cursor-approved project servers and `argmax` in `session/new` / `session/load` | no |
| OpenCode | `OPENCODE_CONFIG_CONTENT` (inline JSON, merged over the user's config) | no |
| Cursor (other models, PTY) | `<workspace>/.cursor/mcp.json`, merged over the user's own | yes, restored at exit |
| Grok Build | `<workspace>/.grok/config.toml` plus a folder-trust grant | yes, removed at exit |

Host policy — bounded in-chat delegation, cookie acceptance, not killing the
hosting Argmax process, and using `session_move` when continuing in another
checkout — lives on the `argmax` MCP server's `instructions` field. The user
prompt is the user's prompt. Native Codex and Claude transcript files of
sessions launched before that change still start with the old prefix; Argmax
does not rewrite those files. Claude import strips the prefix when titling a
session. New launches do not prepend it. The long shell-command preamble is
gone. The `argmax session …` CLI it described is not — it is still the way to
reach a session from a terminal, and
[cli.rs](../src-tauri/src/session_control/cli.rs) dispatches it from
exactly the same enum the tools do.

[mcp_injection.rs](../src-tauri/src/providers/mcp_injection.rs) is the one place
that knows which is which, and none of the six mechanisms displaces the user's
own servers: `--strict-mcp-config` is deliberately not passed to Claude,
OpenCode's inline config is merged over the global one, and a `.cursor/mcp.json`
the user keeps is parsed and rewritten with one key added. A file Argmax cannot
parse is left completely alone and the tools stay off for that launch, which
beats destroying a working config.

### The two that write a file

Cursor's one-shot path has no per-launch MCP flag and no config environment
variable — `CURSOR_CONFIG_DIR` moves the whole of `~/.cursor`, authentication
included — so the project-scoped `.cursor/mcp.json` the CLI already reads is the
only way in. Grok's `GROK_CONFIG` / `GROK_CONFIG_PATH` overlays are allowlisted
to soft settings and cannot spawn a command, so `.grok/config.toml` is the only
way in there.

A file written into a checkout is added to that checkout's `info/exclude`
first, so a launch never makes the user's own repository look dirty, and the
line is dropped again with the file. Only a `.grok/` or `.cursor/` the launch
itself created is excluded: a directory the user already keeps is theirs, and
hiding it from git for good would be a worse surprise than a transient
untracked file. A linked worktree keeps `info/` in the common git directory,
which is where the entry goes.

One checkout is one file, and
[ADR 0004](adr/0004-parallelism-comes-from-workspaces.md) makes several sessions
over one checkout the normal case, so neither file may hold anything one session
can overwrite for another. The two CLIs make that easy in different ways, and
the difference is measured, not assumed:

- **Grok** starts its MCP server with the environment its own process has, so
  the config carries no credential at all — the token reaches the server the
  same way it reaches every other Argmax child. Every session writes identical
  bytes and nothing can collide. (`grok mcp doctor` 1.0.13, with a server that
  dumps its environment, shows both variables arriving.)
- **Cursor** sanitises that environment: the same server reports
  `ENV_MISSING: ARGMAX_SESSION_LAUNCH_SOCKET is not set`. Its spec therefore
  carries the credential, which makes the entry per-session, so the entry is
  *named* per session — `argmax_<first 8 of the session id>`. Two sessions
  merge into one document instead of overwriting each other, and a session
  takes only its own entry when it leaves. Cursor reports the tool to the model
  without its namespace, so the suffix does not reach the tool name.

What is per-session either way is a share in the file's lifetime: it is
ref-counted, so the first session to finish leaves the file in place for the
second, and the last one out puts the checkout back exactly as it found it.

Cursor needs one flag as well as the file. An entry the CLI has not approved is
listed and then never started — the model reports the namespace as "not found"
while the file sits right there — so a launch passes `--approve-mcps`.

### Grok's folder trust

Grok gates repo-local MCP servers — and project hooks, and repo-local LSP
servers — on whether the folder is trusted, and a config Argmax writes is inert
until it is. The decision lives in one global file,
`$GROK_HOME/trusted_folders.toml` (`~/.grok/trusted_folders.toml` by default):

```toml
[folders."/Users/me/dev/thing"]
trusted = true
decided_at = 1788149659
```

A Grok launch records the workspace there exactly as Grok itself does when the
user answers its prompt, and gives it back when the launch ends
([grok_trust.rs](../src-tauri/src/providers/grok_trust.rs)). Grok matches the
canonicalised path, so that is what is written. Two entries are never touched:
one that was already there when Argmax first looked, because that is the user's
own decision, and one whose `decided_at` has changed underneath, because the
user trusted the folder themselves while Argmax held it. The grant is
ref-counted alongside the config file, and `GROK_FOLDER_TRUST=0` is deliberately
not used — it would ungate the repo's hooks too.

## What the surface costs

61 tools and ~54 KB of schema and server instructions, and a turn pays for all
of it whether or not it calls one — tool definitions render ahead of the system
prompt and the transcript, so they sit at the front of every cached prefix.

Claude launches therefore set
[`ENABLE_TOOL_SEARCH=true`](https://code.claude.com/docs/en/env-vars) in the
same inline `--settings` JSON that carries the background-task flag and the
inbox hook ([adapters.rs](../src-tauri/src/providers/adapters.rs)). Claude Code
then defers the schemas out of the prefix and gives the model a search tool to
pull back the ones it wants. Measured against 2.1.270 with a bare launch
carrying only this server, the prefix went from 46,305 tokens to 19,076 — the
server's own share from 12,573 tokens per turn to roughly 1,100.

Two costs come with it. The model pays a search round trip before its first
`argmax` tool call, and a tool it never thinks to search for is one it will not
find, so a rarely-wanted tool leans harder on its name and description than it
used to. Inline settings override the user's own `env` for this key, the same
way they already do for `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS`.

The other four providers have no equivalent flag and pay the full surface, so
the schemas themselves have to stay lean. Two thirds of those bytes are prose —
tool descriptions and parameter descriptions — and the rest is JSON Schema
structure, which only shrinks by removing a tool or a parameter. What that
buys is bounded: a description is the only place a tool's limits are stated, so
the cuts worth making are the ones that remove duplication rather than bounds.
Policy already carried by the `instructions` field, and parameters already
described in the schema, do not need restating in a tool description.

### Turning the browser tools off

Removing a tool is the lever trimming prose cannot match, and the browser tools
are the only group a user can do without and still have Argmax: 27 of the 61,
and about 35% of the bytes. Settings → Agents → Tools → **Browser tools** drops
them — 52,562 bytes to 34,242 (the serialized tool list plus the instructions,
with `pr_watch` and `pr_unwatch` adding 1,323 of each, measured before
`pr_cleanup`, which adds 793 bytes and lengthens `pr_watch` by about 180). At the 55-tool surface
that was measured at 12,573 prefix tokens per turn down to 7,665. The Browser
panel is untouched; what goes is an agent's ability to drive it.

The decision is the launch's. `SessionLaunchRegistry::issue` reads the setting
from [app_settings.rs](../src-tauri/src/persistence/app_settings.rs) and stamps
it into the launch's `SessionLaunchProcessConfig`, which puts
`ARGMAX_BROWSER_TOOLS=0` in the server spec's own `env` beside the credential —
so it reaches the server on every provider, including the two whose spec is a
workspace file. Reading it there rather than in the renderer is what makes a
chat an agent launched carry the same surface as a chat the user launched.

Two consequences follow from tool definitions sitting ahead of `system` and
`messages` in the cached prefix. A change to the tool list invalidates the whole
cache, so the setting is read per launch and never mid-conversation: a running
chat keeps the surface it started with and picks up the change on its next
turn. And the `instructions` blob has to move with the tools —
`agent_tools_instruction` takes the same flag and drops the browser clause, the
cookie grant, and the screenshot example, because an agent told it can open
pages when it cannot is worse off than one told nothing.

## The wire underneath

[protocol.rs](../src-tauri/src/session_control/protocol.rs) holds the whole
protocol: a `SessionControlRequest` with a token and one `SessionControlAction`,
answered by a `SessionControlResponse` whose result is flattened
(`{"version":1,"launched":{…}}`, `{"version":1,"listed":{…}}`, or
`{"version":1,"error":{"code","message"}}`).
Each action carries exactly the fields it uses, so a nonsense combination — a
project selector on a message, a model on a move — cannot be encoded.

The browser tools ride the same socket with one action of their own,
`Browser(BrowserRequest)`, answered by `Browsed(BrowserOutcome)`. The MCP
process has no `AppHandle` and cannot touch a webview, so
[browser_bridge.rs](../src-tauri/src/mcp/browser_bridge.rs) holds both ends: the
request the tool builds, and the app-side handler that resolves the caller's
session from its token, checks tab ownership, and calls
`browser::automation` with the real handle. A screenshot's PNG rides beside the
JSON rather than inside it, so the base64 becomes an MCP image block without
also landing in the text the model reads; the browser reply gets a 4 MB
ceiling, an inbox or wait reply 512 KB, and every other action 64 KB.

That image block reaches the model and stops there: no chat card draws it, and
the remote bridge strips those bytes out of the transcript. So the bridge also
writes the capture into the caller's attachment store and returns its `path`,
and a trailing text block tells the agent that the user cannot see the image
until the answer names that path in a Markdown image. `argmax-attachment://`
serves that directory on the desktop, the bridge serves it over HTTP, and the
phone fetches it through `BridgeClient`, so one path renders on all three. A
capture whose store write fails still returns the image block, with the reason
in `pathError`.

Creating, navigating and destroying a webview are AppKit calls, so the handler
hops them to the main thread with `run_on_main_thread`. Reads do not need it:
WebKit's own `evaluateJavaScript:` and `takeSnapshot` callbacks already do.

The CLI and the MCP tools both build a `SessionControlAction` and hand it to
`send_session_control`; the socket handler matches on the same enum. Adding a
tool means adding a variant, not a second protocol.

Credentials are per session and revocable: `SessionLaunchRegistry::revoke`
drops a gone session's token, and every tool then fails with `AUTH_FAILED`.

## What the user sees

A diagram in an answer is a fenced `mermaid` or `mmd` block, drawn as SVG
wider than the prose. That rule sits on the MCP server instructions next to
the Markdown-image rule, so every provider is told both channels.

A message from another session is not an ordinary prompt, and the chat says so:
the user bubble carries a "From `<label>`" header that opens the sending chat,
and the whole group is labelled "Message from another chat"
([chat-cards.md](chat-cards.md)). A launched session's sidebar row shows
"launched by `<label>`", and its actions menu offers "Open launching chat".

## Tool rows in the chat

The chat shows an MCP call like any other tool row. Cursor's ACP path needs
help: a call opens as a nameless `MCP: tool` placeholder and is identified only
by the *next* update, which carries
`rawInput: {providerIdentifier, toolName, args}`. The translation in
[cursor_acp.rs](../src-tauri/src/providers/cursor_acp.rs) therefore holds the
start line back until the name arrives, then emits one row named
`mcp__argmax__<tool>` — the same string Claude's own stream produces. Cursor
reports only `{"success": true}` as the raw output, so its row shows no result
body; the agent still receives the full tool result.

## Verifying

Rung 3 of [verification.md](verification.md): a scratch instance plus
`scripts/bridge.mjs chat` against a scratch repo, prompting the agent to use the
tools. The proof is tool rows for `session_list` / `session_launch` /
`session_message` with JSON results, and a new session in `dashboard:list` whose
`launchedBySessionId` names the caller. For the browser tools the proof is a
`mcp__argmax__browser_*` row per step, an answer that names something only the
real page could have said, and `browser:list-tabs` showing the tab owned by the
calling session. For the observation tools, prompt a parent to launch a child,
`session_wait` on it, then `session_read` it: the wait must return the child's
terminal state, the read must contain the child's answer, and
`session:events-since` for the parent must then show an origin-tagged
`user.message` — the completion notice — followed by a fresh assistant reply.
The caps, socket actions, inbox, completion notice, project tools, workspace
tools, and attention fields have tests in
[src-tauri/tests/integration/session_control.rs](../src-tauri/tests/integration/session_control.rs).
The shared MCP router test holds the common tool surface still. Terminal
scrollback and persistent reads are covered in
[src-tauri/src/terminal/service.rs](../src-tauri/src/terminal/service.rs).

`pgrep -f "argmax mcp"` must come back empty once the app is gone. The ACP pool
runs its server in its own process group and signals the group on teardown,
because an MCP server started by `cursor-agent` is a grandchild that a signal
aimed at the server alone would leave running.
