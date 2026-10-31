# Agent Tools

Every session Argmax launches gets one MCP server, `argmax`, whose tools reach the sessions around it. The tools are the same across providers. They run on the same wire protocol as the `argmax session …` CLI: one protocol, two faces.

## The tools

Claude, Codex, and Cursor show tools as `mcp__argmax__<tool>`. Arguments, descriptions, and bounds live on the `#[tool]` definitions. An agent reads them from the MCP schema, so this doc does not copy them.

| Group | Tools | Definitions |
|---|---|---|
| Sessions | `session_list`, `session_launch`, `session_message`, `session_status`, `session_read`, `session_stop`, `session_rename`, `session_wait`, `session_move`, `inbox_read` | [session_tools.rs](../src-tauri/src/mcp/session_tools.rs) |
| Workspace and checks | `workspace_status`, `workspace_diff`, `workspace_archive`, `checks_run` | same |
| Goals | `goal_set`, `goal_clear` ([goals.md](goals.md)) | same |
| Project knowledge | `learnings_add`, `learnings_search`, `sources_list`, `sources_read`, `sources_add`, `project_list` | same |
| Terminals | `terminal_spawn`, `terminal_read`, `terminal_write`, `terminal_close` | same |
| Scheduling | `schedule_followup`, `schedule_list`, `schedule_cancel`, `schedule_resume` | same |
| PRs | `pr_watch`, `pr_unwatch`, `pr_cleanup` | same |
| Arcs | `arc_status` | same |
| Browser | `browser_*` | [browser_tools.rs](../src-tauri/src/mcp/browser_tools.rs) |
| Visualizations | `visualization_preview`, `visualization_publish` | [visualization_tools.rs](../src-tauri/src/mcp/visualization_tools.rs) |

Tool arguments are snake_case on the wire, and results are camelCase. `session_read` and `session_list` refuse an argument they do not know, so a misspelled `itemId` is an error and not a quiet page read.

`attention` answers whether a person should look at a session. It is on both session reads, so a launcher can check one child without listing every session.

## Launching

**A launch never gets a looser permission mode than its caller.** The modes run `ask-each-time`, `provider-defaults`, `auto-approve`, strictest first. A request above the caller's mode is replaced by it, and the reply says so through `permissionModeRequested`. The ceiling is `child_permission_mode` in [session_launch.rs](../src-tauri/src/application/session_launch.rs). A provider that cannot answer approvals is refused separately by `ensure_permission_mode_supported`.

**`project` accepts a repository Argmax has never opened.** A name or id must already be registered, but an absolute path is taken at face value and registered. An agent told "start a chat in ~/dev/thing" therefore needs no setup from the user. A path inside a registered project resolves to it. A linked worktree is refused with `PROJECT_IS_CHECKOUT`, because a worktree is a checkout of a project, not a project.

**A launch can target a checkout.** `path` is an existing working tree of the target project. `worktree` creates a new isolated one, and the two are mutually exclusive. `branch` is the ref to work from. Launch never switches another checkout's branch.

Project check runs on this launch ([routing.md](routing.md#project-check)). `model: "auto"` routes it ([routing.md](routing.md)). `provider` and `model` default to the caller's own, so an agent that names neither launches a peer of itself. A named model is passed to the CLI as-is, because Rust has no model-label catalog.

### Retrying a launch

`clientRequestId` makes `session_launch` safe to repeat after a timeout or a lost reply.

- **Receipt first.** The `launch_receipts` row is written before the budget lock, the router, project check, the worktree, or the provider. It holds a hash of the canonical request and the session id the launch will use.
- **Same key, same arguments** replays the first reply with `replayed: true`. **Same key, other arguments** is `LAUNCH_REQUEST_ID_MISMATCH`.
- **Two copies in flight** start one session, because the claim is one SQLite write. The budget lock is per process and comes later, so it is not what prevents the duplicate.
- **`failed`** means the launch stopped before its session row was written. No provider started, so the same key may retry.
- **`uncertain`** means it stopped after that row. The provider may be running, so the key is never launched again. A retry gets `LAUNCH_OUTCOME_UNCERTAIN`, and the caller checks `session_status`.
- **Restart.** A `pending` receipt becomes `failed` if its session was never written, and `uncertain` if it was. An `uncertain` session also gets the lineage the launch never recorded, so the launcher can still read and wait on it.

## Moving and archiving

`session_move` and `workspace_archive` run when the calling turn settles, because the caller is mid-turn. Archiving terminates every provider process in the workspace, and run inline it would kill its caller before it could report. One slot serves both, and while either is pending, follow-ups into that chat are refused.

**Use `session_move`, never `cd`.** `cd` moves only that shell. The workspace card, its diff, and its PR actions keep targeting the original checkout, and the next turn relaunches there. The tool description says so, because agents reach for `cd` by habit. `project` moves to another project. `path` moves to another checkout of the same project.

A move relocates work, so its `prompt` starts the destination's first turn. That turn is composed like any follow-up ([follow_up.rs](../src-tauri/src/providers/follow_up.rs)), because the copied transcript is Argmax's record, not context the destination CLI holds. Call it as the last action of a turn, because later work is not in the prompt already written.

The destination keeps the source's launch lineage, so a moved chat still sends its completion notice and counts against the caps. Without that it would come back as a depth-0 orphan.

The continuation stops after three moves in one chat's history. Two agents that each conclude the work belongs in the other repo would otherwise bounce a live turn between them. Past the cap the chat waits for a person.

**`workspace_archive` exists because merged work leaves its checkout behind.** `git worktree remove` on your own working directory succeeds, and then every later command fails. The archive is never forced, so a dirty workspace comes to rest as **kept** ([GLOSSARY.md](../GLOSSARY.md)). An agent should report the archive as requested, not done.

**Either promise survives a restart.** The agent reports on `{scheduled: true}`, so the request is written to `session_after_turn` before the reply goes out. The next launch runs it after orphan recovery. A promise with nothing left to do is dropped.

## Arcs

An Arc's coordinator and members are ordinary sessions, and every tool works on them as usual. `arc_status` is the one addition, because no other tool takes an Arc id. Creating an Arc and launching its coordinator are desktop actions ([ipc.md](ipc.md#arcs)).

**Inheritance.** A session launched by a caller with an `arc_id` inherits it, and its prompt gets a member preamble. A `/multitask` inherits the same way. Inheritance has no depth limit of its own, but `LAUNCH_DEPTH_EXCEEDED` still applies.

**Moves and forks.** `session_move` carries `arc_id` across, and repoints `coordinatorSessionId` in the same transaction if needed. `fork_session` carries neither, so a fork cannot silently duplicate a coordinator.

**Caps** are `ARC_MAX_ACTIVE_MEMBERS` and `ARC_MAX_LAUNCHES_PER_DAY` in [arcs.rs](../src-tauri/crates/argmax-store/src/arcs.rs), refused as `ARC_CAPACITY_REACHED` and `ARC_LAUNCH_BUDGET_REACHED`. A done Arc refuses with `ARC_DONE`. The current coordinator is exempt from the per-session launch cap, because it delegates for the whole Arc. A relaunched coordinator's old session keeps its own count.

A coordinator's prompt is [preamble.rs](../src-tauri/src/arcs/preamble.rs). "Plans and delegates, never codes" is that prompt's contract, not a permission. The coordinator is an ordinary, disposable session.

## Workspaces and checks

`checks_run` applies the same destructive-command guard as the Checks panel. The control socket stays open for its timeout plus cleanup slack.

`workspace_status` reports what Argmax holds and Git does not. `workspace_diff` uses the same review service as the Changes panel.

## Project sources

Sources are durable references to text files or URLs, with guidance about when to consult them. Argmax stores no copy of the contents.

`sources_read` resolves a file against the caller's current checkout, so an isolated workspace reads its own version. A URL opens in the session's Argmax browser. A successful read adds a `session.note` that records the source and retrieval time, not the contents.

**Source contents are untrusted context.** A read note does not establish version, correctness, or freshness. Registering a source does not make it authoritative and does not create project memory.

**Additional project folders** ([memory.md](memory.md#linked-repositories)) use the same two tools. A linked path is refused when it is absolute, contains `..`, touches `.git`, or resolves outside the root through a symlink. A `path` without `linked_repo` is refused instead of ignored. A linked read's note is not drawn in the chat, because the call itself joins the turn's read group. One notice per file buried the turn.

## Persistent terminals

Agents run ordinary commands in their own shell (`OWN_SHELL_INSTRUCTION`). `terminal_spawn` is for processes that must outlive the turn or that the user asked to watch. The PTY is Argmax's, so it survives the turn and stays visible in the Terminal panel. See [terminal.md](terminal.md).

`terminal_write` fails with `TERMINAL_EXITED` or `TERMINAL_NOT_FOUND` rather than dropping bytes.

## Scheduled follow-ups

`schedule_followup` creates a one-shot task targeting the calling session. The row is the alarm, so firing clears it. See [scheduled-tasks.md](scheduled-tasks.md).

An agent can create a wake, read a project's tasks, and switch them off, on, or away. It cannot write a recurring routine or edit one, because that stays in the panel. `createdBy` tells an agent which rows are its own. A wake of its own should be deleted the moment it is pointless, because pausing it parks a row the user has to sweep.

The scheduler leaves a task due while the calling turn runs, and wakes the chat after it settles. It does not queue the prompt behind what the user typed.

## PR watches

`pr_watch` wakes the session about one PR, so the agent ends its turn instead of polling GitHub in a shell. Calling it again keeps the watch and its cursors. A PR number Argmax has not read yet is accepted. See [gh.md](gh.md#pr-watch).

`pr_cleanup` does the git cleanup after a merge, then removes the chat's own worktree when the turn ends. It never archives or hides the chat. See [workspaces.md](workspaces.md#pr-cleanup).

A notice arrives through the inbox, so behavior is the same for every provider. The agent applies the merge gate.

## Browser tools

A page an agent opens is a real tab in the user's window, because browsing is visible work. [browser.md](browser.md) covers the machinery. These contracts are what an agent relies on:

- **Ownership.** A session may drive only tabs it opened (`BROWSER_TAB_NOT_OWNED`). Naming no tab means the one this session touched most recently, which no other session can reach, so the default is always safe.
- **Refs.** `browser_snapshot` hands out `[ref=eN]` handles. A ref lives in the page as a `data-argmax-ref` attribute, so it dies with the document. After a navigation, take a fresh snapshot.
- **Reading, cheapest first.** `browser_extract` for what a page says, `browser_get_text` for flat prose, and `browser_snapshot` for acting. It is the only one that hands out refs. All three report `state`.
- **Screenshots cost more than snapshots.** A PNG has to survive base64 through the provider's JSON stream, so it is rasterised narrow and dropped when still too large. The image block reaches the model only, so the capture is also written to the attachment store and its `path` returned. The user sees it only when the answer names that path in a Markdown image.
- **Background tabs stay in the background.** A background tab does not become the session's default, because queueing links must not move the agent off its page. A group label replaces the "agent" badge, so grouping is visible to the user.
- **Dialogs** are answered on the spot, because they are synchronous. See [browser.md](browser.md#agent-automation).
- **Capture is page-level.** Response bodies and request headers are unavailable.

## Observing another session

`session_read` returns the normalized timeline, not provider JSON. It reads the same rows as the chat pane, flattened to one line each. Rows the chat hides are dropped too.

A read with no cursor starts at the beginning and pages forward, unlike the chat pane, which scrolls up from the newest. A page is capped in rows and bytes, and each entry is capped, so one enormous tool result cannot spend the budget. A clipped entry carries a stable `id`, which `itemId` reads whole.

The unit is bytes everywhere. A slice never ends inside a character, and an offset that is not a character boundary is refused (`OFFSET_INVALID`).

### Who may read whom

`session_read` and `session_status` refuse (`READ_FORBIDDEN`) a session the caller may not read. An agent reads:

- its own project's sessions. A scratch Chat has no project to share, so each Chat is its own boundary.
- its launch lineage, up, down, and across projects.
- a chat a person attached to one of its prompts. The composer writes `[title](argmax://chat/<session id>?v=1)` into the prompt, and a person's prompt in the caller's transcript that holds such a link is the grant. The transcript is the durable authority, so there is no grant table to keep in step.

What counts as the person's prompt is narrow, because an agent can put any text in a prompt it writes. A `user.message` grants only with the positive mark `events.prompt_author = 'person'` ([authorship.rs](../src-tauri/crates/argmax-store/src/authorship.rs)).

- Only `providers:launch`, `providers:send-input`, `providers:steer-input`, and a typed Multitask can build the `PersonAttestation` token, and a test lists the call sites.
- The marker is a column, and no input type carries it, so a client, a tool argument, a transcript file, or a synced event cannot supply it.
- Everything else is unattested and grants nothing. Missing the mark fails closed.
- A queued row keeps its author through drain and requeue. A fork or a move copies each prompt's author.
- A person's prompt that also carries an origin or starter is refused (`PROMPT_AUTHOR_CONFLICT`).
- Text Argmax adds to a person's prompt from agent-settable strings has its square brackets turned into parentheses, so only the person's own chip can form a link.
- The link must match the renderer's grammar (`composerContext.ts`, mirrored by `chat_reference_ids`).

The mark stops text an agent wrote from becoming a cross-project grant when Argmax itself routes that text. It is not a boundary against an agent with shell access, which can already read the SQLite file. The paired remote device counts as the person.

The app's own UI is not scoped. `query` in `session_list` searches readable sessions only, in SQL, so unreadable sessions cannot crowd out readable ones.

`session_stop` runs the same terminate path as the user's Stop button. A session cannot stop its own turn (`STOP_SELF`).

## The inbox

`session_messages` holds a durable row per message. Delivery and recording are separate on purpose. Every message is also sent through `send_agent_message`:

- An idle session starts a turn on it.
- A running Claude, Codex, or OpenCode turn takes it as steering ([providers.md](providers.md)).
- Every other working session gets it when its turn ends.

Cursor and Grok cannot take input into a running model, and even a steerable turn sometimes cannot. The row closes that gap: `inbox_read` hands over what is undelivered, and `session_wait` wakes on the insert.

An automatic steer that fails returns to the ordinary queue, because nobody is there to retry it. A steer with a lost acknowledgement stays delivery-unknown and is never resent.

A row is marked collected by the same call that carries it, so a reply the client refused would take the messages with it. That is why stored bodies and one read are capped. An inbox or wait reply is read under its own 512 KB ceiling (`MAX_INBOX_RESPONSE_BYTES`), which is above anything those caps can produce.

### The flag every tool result carries

None of the five CLIs takes a server push mid-turn, but a running model reads its own tool results. Every `argmax` reply therefore carries a second content block when mail is waiting. The count is taken after the action runs, so it is right on the inbox tools too.

An agent that touches no `argmax` tool for the rest of its turn is not reached. It gets the message when the turn ends.

### Delivered once, whichever path wins

A message can arrive two ways, so exactly one must win. Every turn that carries a message carries its row id (`MessageOrigin.message_id`), and the row closes when that turn actually starts.

The queue checks the row before it sends, so a message already collected is dropped, and the drain moves on to the next. Inbox reads remove collected messages from the pending queue immediately. Enqueue checks delivery under the writer lock.

A row stays open when no turn took it. Undelivered is the safe direction to be wrong in, because the agent collects it late rather than never.

**A failed turn parks its queue.** A non-zero exit marks the pending queue `recovered`, so a broken provider is not fed the follow-ups behind it. The message stays available to `inbox_read`, but it will not arrive as a turn on its own. A sender that needs certainty checks `unreadInbox` on `session_status`.

## Completion notices

When a launched session ends a turn, Argmax writes one `completion` message to its launcher. [completion_notices.rs](../src-tauri/src/providers/completion_notices.rs) owns the text. A long answer keeps its "Learnings for the arc" section, so those reach the coordinator.

It is delivered like any message, so an idle launcher wakes on a new turn.

**Siblings that finish together wake the launcher once.** The row is written at turn end, and only the automatic wake waits, for `COMPLETION_BATCH_WINDOW`. A batch row carries each result whole. A result that would exceed the inbox cap becomes a pointer to `session_read` rather than being cut. The batch row and the closing of individual rows commit in one transaction.

**A restart does not strand the launcher.** The window is in memory, so the durable mark is `session_messages.wake_due_at`. `recover_completion_wakes` rebuilds wakes at boot. A repeated wake is safe, because the queue drops a copy already collected.

**A turn the person started in the launched chat's own tab does not wake the launcher at once.** On the first Arc, 36 of 93 notices were replies to the person, each one a full coordinator turn. Such a turn only bumps a digest, sent after `USER_TURN_DIGEST_QUIET_SECS`. A restart drops the pending digest, and the exchanges stay readable.

**It cannot ping-pong.** A session emits a notice on turn end only if it has a launcher. `launched_by_session_id` is a strict tree, capped at depth 2, so a notice climbs at most two hops and never comes back down. A deterministic id (`completion:<session>:<turn end>`) keeps a retried turn end from writing twice.

Building a notice also deletes the launcher's `check-in:<session>` wake.

## Waiting

`session_wait` blocks until a watched session settles or a message arrives. With no `sessions`, the watch list is everything the caller launched, so the useful shape is `session_launch` → `session_wait` → `session_read`.

That form hands each finish over once. `sessions.wait_reported_at` is stamped by the same write that takes the inbox messages, so a crash cannot mark a finish reported without handing it over. Without it, a parent got the same child back forever. Naming ids re-reads a finish and marks nothing.

The handler subscribes to both broadcasts before its first database read, so an edge between subscribing and reading is queued, not lost. A one-second re-read backs both up. Nothing holds a connection across an await, and the handler is fully async, because a blocking wait must not park a shared worker ([performance.md](performance.md#main-thread)).

`client_read_timeout` keeps the socket open for the wait plus slack.

## Policy

Keep bounded delegation in the current chat. Use the provider's native subagents for work you will integrate into the current turn. A native subagent lives only as long as its turn, so an answer that reports it as still running discards it unread.

Use `session_launch` when the user explicitly asks for a separate session, or when the work needs its own durable lifecycle that stays visible and steerable after this turn. Do not launch merely for parallelism, fresh context, model choice, or context relief.

Two caps keep a chain finite, counted from the database, so nothing the agent controls can move them:

- **Depth ≤ 2.** A launch from depth 2 is refused with `LAUNCH_DEPTH_EXCEEDED`.
- **`MAX_LAUNCHES_PER_SESSION`**, refused with `LAUNCH_LIMIT_REACHED`. An `uncertain` launch with no lineage yet holds a slot.

A session cannot message itself (`MESSAGE_SELF`). `session_rename` has no target argument, the same scope as `goal_set` and `workspace_archive`.

## How each provider gets the server

The server is `argmax mcp`, the same binary as the app, forwarding each call over the session-control socket. No sidecar and no second control plane. Where the spec is per-launch, the bearer token rides in the spec's own `env`, so a warm shared process can give each session its own credential.

| Provider | Mechanism | Leaves a file? |
|---|---|---|
| Claude | `--mcp-config '<inline json>'` | no |
| Codex | `-c mcp_servers.argmax.*` | no |
| Cursor (composer, ACP) | `session/new` and `session/load` | no |
| OpenCode | `OPENCODE_CONFIG_CONTENT`, merged over the user's config | no |
| Cursor (other models, PTY) | `<workspace>/.cursor/mcp.json`, merged | yes, restored at exit |
| Grok Build | `<workspace>/.grok/config.toml` and a folder-trust grant | yes, removed at exit |

[mcp_injection.rs](../src-tauri/src/providers/mcp_injection.rs) is the one place that knows which is which. None of them displaces the user's own servers, so `--strict-mcp-config` is deliberately not passed. A file Argmax cannot parse is left alone and the tools stay off for that launch, which beats destroying a working config.

Host policy lives on the server's `instructions` field. The user prompt is the user's prompt. Claude import strips the old prefix from older transcripts when titling a session. The `argmax session …` CLI ([cli.rs](../src-tauri/src/session_control/cli.rs)) still reaches a session from a terminal.

### The two that write a file

Cursor's one-shot path has no per-launch MCP flag, and `CURSOR_CONFIG_DIR` moves authentication too. Grok's config overlays cannot spawn a command. A project-scoped file is the only way in for both.

A file written into a checkout goes into `info/exclude` first, so a launch never makes the repository look dirty. Only a directory the launch itself created is excluded, because hiding a directory the user keeps would be a worse surprise.

Several sessions over one checkout are the normal case ([ADR 0004](adr/0004-parallelism-comes-from-workspaces.md)), so neither file may hold anything one session can overwrite for another:

- **Grok** starts its server with its own environment, so the config carries no credential, and every session writes identical bytes.
- **Cursor** sanitises that environment, so its entry carries the credential and is named per session (`argmax_<first 8 of the session id>`). Sessions merge into one document.

The file's lifetime is ref-counted, so the last session out puts the checkout back as it found it. Cursor also needs `--approve-mcps`, because an unapproved entry is listed and never started.

### Grok's folder trust

Grok gates repo-local MCP servers on whether the folder is trusted, in `$GROK_HOME/trusted_folders.toml`. A launch records the workspace as Grok itself would, and gives it back at the end ([grok_trust.rs](../src-tauri/src/providers/grok_trust.rs)).

An entry already there is the user's own decision and is never touched, nor is one whose `decided_at` changed underneath. `GROK_FOLDER_TRUST=0` is deliberately not used, because it would ungate the repo's hooks too.

## What the surface costs

63 tools and ~54 KB of schema and instructions, and a turn pays for all of it, because tool definitions sit at the front of every cached prefix.

Claude launches set `ENABLE_TOOL_SEARCH=true` in the inline `--settings` ([adapters.rs](../src-tauri/src/providers/adapters.rs)). Claude Code defers the schemas and gives the model a search tool. Measured against 2.1.270, the server's share went from 12,573 tokens per turn to about 1,100. The cost is a search round trip, and a tool the model never searches for is one it will not find, so a rarely-wanted tool leans on its name and description.

The other four providers pay the full surface, so schemas must stay lean. A description is the only place a tool's limits are stated, so cut duplication, not bounds. Policy already in `instructions` needs no restating in a description.

### Turning the browser tools off

Settings → Agents → Tools → **Browser tools** drops 27 of the 63 tools and about 35% of the bytes. The Browser panel is untouched.

The decision is the launch's, so a chat an agent launched carries the same surface as one the user launched. `ARGMAX_BROWSER_TOOLS=0` rides in the server spec's `env`, so it reaches the server on every provider. A change to the tool list invalidates the whole cache, so it is read per launch and never mid-conversation.

`agent_tools_instruction` takes the same flag, because an agent told it can open pages when it cannot is worse off than one told nothing.

## The wire underneath

[protocol.rs](../src-tauri/src/session_control/protocol.rs) holds the whole protocol. Each `SessionControlAction` carries exactly the fields it uses, so a nonsense combination cannot be encoded. The CLI and the MCP tools both build an action, so adding a tool means adding a variant, not a second protocol.

Browser tools use one action, `Browser(BrowserRequest)`. The MCP process has no `AppHandle`, so [browser_bridge.rs](../src-tauri/src/mcp/browser_bridge.rs) holds both ends. A screenshot's PNG rides beside the JSON, so the base64 becomes an image block without landing in the text the model reads.

Reply ceilings are the `MAX_*_RESPONSE_BYTES` constants in [session_control/mod.rs](../src-tauri/src/session_control/mod.rs). Credentials are per session and revocable, and every tool then fails with `AUTH_FAILED`.

## Tool rows in the chat

A message from another session is marked in the chat ([chat-cards.md](chat-cards.md#user-messages)). A launched session's sidebar row names its launcher.

Cursor's ACP path needs help. A call opens as a nameless `MCP: tool` placeholder, and only the next update names it. [cursor_acp.rs](../src-tauri/src/providers/cursor_acp.rs) holds the start line back and emits one row named `mcp__argmax__<tool>`. Cursor reports only `{"success": true}`, so its row shows no result body, though the agent receives the full result.

## Verifying

Use the scratch rung of [verification.md](verification.md), with `scripts/bridge.mjs chat` against a scratch repo.

- Tool rows must show JSON results, and a launched session must appear in `dashboard:list` with `launchedBySessionId` naming the caller.
- Browser tools need an answer that names something only the real page could have said.
- For observation, prompt a parent to launch a child, wait, and read. `session:events-since` for the parent must show the completion notice followed by a fresh reply.

Caps, socket actions, inbox, and notices have tests in [session_control.rs](../src-tauri/tests/integration/session_control.rs).

`pgrep -f "argmax mcp"` must come back empty once the app is gone. The ACP pool signals its server's process group on teardown, because an MCP server started by `cursor-agent` is a grandchild.
