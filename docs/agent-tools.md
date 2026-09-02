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
| `session_list` | `project?`, `all?` | `{sessions: [{sessionId, projectId, projectName, taskLabel, provider, state, lastActivityAt, launchedBySessionId?}], truncated}` — newest activity first, the caller excluded, capped at 40 rows |
| `session_launch` | `prompt`, `project?`, `provider?`, `model?`, `worktree?`, `taskLabel?` | `{sessionId, workspaceId, projectId, projectName}` |
| `session_message` | `session`, `message` | `{sessionId, queued}` — `queued` is true when the target was mid-turn |
| `session_status` | `session` | `{sessionId, taskLabel, provider, modelId, state, turnAgeSeconds?, lastActivityAt, lastAssistantText?, unreadInbox, launchedBySessionId?, launchDepth}` |
| `session_read` | `session`, `cursor?`, `maxChars?` | `{sessionId, entries: [{at, kind, text}], nextCursor, truncated}` |
| `session_stop` | `session` | `{sessionId, state}` |
| `inbox_read` | — | `{messages: [{fromSessionId?, fromLabel?, kind, body, createdAt}]}` |
| `session_wait` | `sessions?`, `timeoutS?` | `{timedOut, sessions: [{sessionId, taskLabel, state}], messages: […]}` |
| `session_move` | `project`, `worktree?`, `keepSource?` | `{scheduled, sourceSessionId, projectId, projectName}` |

### Browser

The same server carries Argmax's browser. A page an agent opens is a real tab
in the user's window, shown in that session's own pane — browsing is visible
work, not a hidden side channel.

| Tool | Arguments | Returns |
|---|---|---|
| `browser_open` | `url` | `{tabId, opened}` |
| `browser_navigate` | `url`, `tab?` | `{tabId}` |
| `browser_back` / `browser_reload` | `tab?` | `{tabId}` |
| `browser_tabs` | — | `{tabs: [{tabId, ownerSessionId, url, title, loading}]}`, this session's only |
| `browser_close` | `tab` | `{tabId, closed}` |
| `browser_snapshot` | `tab?`, `interactive_only?` | `{tabId, url, title, tree, truncated}` |
| `browser_find` | `query`, `tab?` | `{tabId, matches: [{ref, role, name, value}]}` |
| `browser_get_text` | `tab?`, `max_chars?` | `{tabId, url, title, text, truncated}` |
| `browser_click` / `browser_hover` | `ref`, `tab?` | `{tabId, url, detail}` |
| `browser_type` | `ref`, `text`, `submit?`, `tab?` | `{tabId, url, detail}` |
| `browser_select` | `ref`, `value`, `tab?` | `{tabId, url, detail}` |
| `browser_press_key` | `key`, `modifiers?`, `tab?` | `{tabId, url, detail}` |
| `browser_scroll` | `direction`, `amount?`, `ref?`, `tab?` | `{tabId, url, detail}` |
| `browser_wait_for` | `text?`, `ref?`, `url_includes?`, `timeout_s?`, `tab?` | `{tabId, url, detail}` |
| `browser_screenshot` | `tab?`, `ref?` | an image content block, plus `{width, height, bytes}` |
| `browser_evaluate` | `expression`, `tab?` | `{tabId, result}` |
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

**Screenshots cost more than snapshots.** A snapshot is text — a few kilobytes
of roles, names and refs, and the only thing that hands out refs. A screenshot
is a PNG that has to survive base64 through the provider's JSON stream, so it
is rasterised at 720 CSS pixels wide and dropped entirely (text and dimensions
only) past 900 KB of base64, which is what keeps it under the normalizer's
1 MB per-line cap. Reach for it when the question is visual and for nothing
else; the tool description says so.

**Dialogs.** A page's `alert` / `confirm` / `prompt` is synchronous: it must
return before the page's next statement runs, and it cannot wait for an answer
from an agent in another process. So on a tab a session opened, the three are
captured and answered on the spot — with whatever `browser_handle_dialog`
armed, otherwise dismissively (`confirm` → false, `prompt` → null) — and the
record shows up for 30 seconds as a `dialog:` header line in the snapshot:

```
url: https://example.com/
title: Example
dialog: confirm "Delete this?" pending (auto-dismissed with false)
```

`browser_handle_dialog` arms the answer for the *next* dialog on that tab and
acknowledges the one that just fired, so the way through is: see the header
line, arm the answer, repeat the action. Tabs the user opened are untouched and
keep the engine's native dialogs — silently answering a person's confirm box
would misreport what they clicked.

`project` takes a registered project's name or its absolute repo path, and
defaults to the caller's own project. `provider` and `model` default to the
caller's own: an agent that names neither launches a peer of itself. A named
model is passed to the CLI as-is and stands in as its own sidebar label — Rust
has no model-label catalog, that lives in
[providerModels.ts](../src/shared/providerModels.ts).

A move is scheduled rather than immediate: it runs once the calling turn
settles, since the agent asking for it is mid-turn.

## Observing another session

`session_read` returns the *normalized* timeline, not provider JSON. Every
provider's output is translated into `events` rows on the way in
([data.md](data.md)), so a read is the same query the chat pane makes
(`session:events-since`) with each row flattened to one line: `user` prompts,
`assistant` answers, `tool` calls as name plus one argument, `tool-result` as
`ok` or `error: …`, and `state` for a session ending. Rows the chat hides —
streaming deltas, subagent traces, lifecycle bookkeeping — are dropped here
too.

A read with no cursor starts at the beginning of the transcript and pages
forward from `nextCursor` — unlike the chat pane's cursorless read of the same
rows, which wants the newest page because it scrolls up.

A page is capped at 500 rows and in bytes (16 KB by default, 40 KB at most),
and each entry is capped at 2 000 characters, so one enormous tool result
cannot spend the whole budget. A page either cap cut short comes back with
`truncated: true`; read again from `nextCursor` for the rest.

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
into the recipient as an ordinary turn through the existing queue-until-idle
path — an idle session starts a turn on it, a working one gets it when its turn
ends. But a session that is mid-turn cannot see a turn that has not started
yet, and no provider CLI surfaces a server push into a running model. The row
is what closes that gap: `inbox_read` hands over what is not yet delivered and
marks it collected, and `session_wait` wakes on the insert.

Two caps keep a hand-over inside the reply ceiling, since a row is marked
collected by the same call that carries it and a reply the client refuses would
take the messages with it: a stored body is capped at 16 KB with a
`(truncated)` marker, and one read hands over at most 50 messages and 48 KB of
body. What does not fit stays undelivered and comes back on the next read.

A message that reached its recipient as a turn is marked delivered, so it is
not handed over twice. One that queued behind a running turn stays collectable
until either the queue drains or the recipient reads its inbox.

## Completion notices

When a session that was launched by another one ends a turn — complete, failed,
or cancelled — Argmax writes one `completion` message to the launching session:

```
Session <id> (<label>) finished with state <state>. Final answer:
<the session's last assistant message, capped at 4 KB>
```

It is delivered like any other message, so an idle launcher **wakes up on a new
turn** carrying its child's answer, the way Claude Code's Agent Teams
idle-notification works. A notice that queued behind the launcher's running
turn is not delivered, and stays collectable from its inbox.

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

Agents may launch, message, and coordinate other sessions **on their own
initiative** when the task needs it. The tool descriptions say so, and they say
what a launch actually is: a top-level session in the user's sidebar, visible,
spending real tokens, outliving the turn that started it — not a subagent. An
agent that wants a subagent already has its provider's own.

Two caps keep a chain finite, enforced in the socket handler where every caller
passes through:

- **Depth ≤ 2.** A session the user started is depth 0. It may launch (depth 1),
  and that session may launch (depth 2). A launch from depth 2 is refused with
  `LAUNCH_DEPTH_EXCEEDED`.
- **Ten launches per session**, refused with `LAUNCH_LIMIT_REACHED`.

A session cannot message itself (`MESSAGE_SELF`) or stop its own turn
(`STOP_SELF`). Lineage lives on the session row as `launched_by_session_id` and
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
| Cursor (composer, ACP) | `mcpServers` in `session/new` / `session/load` | no |
| OpenCode | `OPENCODE_CONFIG_CONTENT` (inline JSON, merged over the user's config) | no |
| Cursor (other models, PTY) | `<workspace>/.cursor/mcp.json`, merged over the user's own | yes, restored at exit |
| Grok Build | `<workspace>/.grok/config.toml` plus a folder-trust grant | yes, removed at exit |

Every provider now carries the same one-line instruction; the long
shell-command preamble is gone. The `argmax session …` CLI it described is not
— it is still the way to reach a session from a terminal, and
[session_control.rs](../src-tauri/src/session_control.rs) dispatches it from
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

## The wire underneath

[session_control.rs](../src-tauri/src/session_control.rs) holds the whole
protocol: a `SessionControlRequest` with a token and one `SessionControlAction`,
answered by a `SessionControlResponse` whose result is flattened
(`{"version":1,"launched":{…}}`, `{"version":1,"listed":{…}}`, or
`{"version":1,"error":{"code","message"}}`).
Each action carries exactly the fields it uses, so a nonsense combination — a
project selector on a message, a prompt on a move — cannot be encoded.

The browser tools ride the same socket with one action of their own,
`Browser(BrowserRequest)`, answered by `Browsed(BrowserOutcome)`. The MCP
process has no `AppHandle` and cannot touch a webview, so
[browser_bridge.rs](../src-tauri/src/mcp/browser_bridge.rs) holds both ends: the
request the tool builds, and the app-side handler that resolves the caller's
session from its token, checks tab ownership, and calls
`browser::automation` with the real handle. A screenshot's PNG rides beside the
JSON rather than inside it, so the base64 becomes an MCP image block without
also landing in the text the model reads; the browser reply gets a 4 MB ceiling
where every other action gets 64 KB.

Creating, navigating and destroying a webview are AppKit calls, so the handler
hops them to the main thread with `run_on_main_thread`. Reads do not need it:
WebKit's own `evaluateJavaScript:` and `takeSnapshot` callbacks already do.

The CLI and the MCP tools both build a `SessionControlAction` and hand it to
`send_session_control`; the socket handler matches on the same enum. Adding a
tool means adding a variant, not a second protocol.

Credentials are per session and revocable: `SessionLaunchRegistry::revoke`
drops a gone session's token, and every tool then fails with `AUTH_FAILED`.

## What the user sees

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
The caps, the socket actions, the inbox, and the completion notice all have
tests in
[src-tauri/tests/session_control.rs](../src-tauri/tests/session_control.rs).

`pgrep -f "argmax mcp"` must come back empty once the app is gone. The ACP pool
runs its server in its own process group and signals the group on teardown,
because an MCP server started by `cursor-agent` is a grandchild that a signal
aimed at the server alone would leave running.
