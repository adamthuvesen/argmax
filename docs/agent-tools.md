# Agent Tools

Every session Argmax launches gets one MCP server, `argmax`, whose tools reach
the sessions around it: list them, launch new ones, message them, and move this
session to another project. The tools are the same across providers, and they
are the same capabilities the `argmax session …` CLI has always had — one wire
protocol, two faces.

## The tools

Namespace `argmax`; Claude, Codex, and Cursor show them as
`mcp__argmax__<tool>`.

| Tool | Arguments | Returns |
|---|---|---|
| `session_list` | `project?`, `all?` | `{sessions: [{sessionId, projectId, projectName, taskLabel, provider, state, lastActivityAt, launchedBySessionId?}], truncated}` — newest activity first, the caller excluded, capped at 40 rows |
| `session_launch` | `prompt`, `project?`, `provider?`, `model?`, `worktree?`, `taskLabel?` | `{sessionId, workspaceId, projectId, projectName}` |
| `session_message` | `session`, `message` | `{sessionId, queued}` — `queued` is true when the target was mid-turn |
| `session_move` | `project`, `worktree?`, `keepSource?` | `{scheduled, sourceSessionId, projectId, projectName}` |

`project` takes a registered project's name or its absolute repo path, and
defaults to the caller's own project. `provider` and `model` default to the
caller's own: an agent that names neither launches a peer of itself. A named
model is passed to the CLI as-is and stands in as its own sidebar label — Rust
has no model-label catalog, that lives in
[providerModels.ts](../src/shared/providerModels.ts).

A move is scheduled rather than immediate: it runs once the calling turn
settles, since the agent asking for it is mid-turn.

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

A session cannot message itself (`MESSAGE_SELF`). Lineage lives on the session
row as `launched_by_session_id` and `launch_depth`
([data.md](data.md)), so both caps are counted from the database rather than
from anything the agent controls.

## How each provider gets the server

The server is `argmax mcp` — the same binary the app runs from, serving MCP over
stdio and forwarding each call to the running app over the session-control
socket. No sidecar, no second control plane. The per-session bearer token rides
in the server spec's own `env`, not the provider process's environment, so a
warm shared process (Cursor's ACP pool) can still hand each session its own
credential.

| Provider | Mechanism | Leaves a file? | Instruction |
|---|---|---|---|
| Claude | `--mcp-config '<inline json>'` | no | one line |
| Codex | `-c mcp_servers.argmax.*` | no | one line |
| Cursor (composer, ACP) | `mcpServers` in `session/new` / `session/load` | no | one line |
| OpenCode | `OPENCODE_CONFIG_CONTENT` (inline JSON, merged over the user's config) | no | one line |
| Cursor (other models, PTY) | none yet | — | shell commands |
| Grok Build | `<workspace>/.grok/config.toml` | yes, git-excluded and removed at exit | shell commands |

[mcp_injection.rs](../src-tauri/src/providers/mcp_injection.rs) is the one place
that knows which is which. `--strict-mcp-config` is deliberately not passed to
Claude, and OpenCode's inline config is merged over the global one, so a user's
own MCP servers stay loaded either way.

The two providers without a working injection path carry the long
shell-command instruction instead — the same capabilities spelled as
`"$ARGMAX_BIN" session launch|move|list|message`. Grok's folder-trust gate
refuses a config Argmax wrote, and Cursor's one-shot path has no per-launch
flag; closing both is Phase 5 of [the plan](plan/agent-tools.md).

A file written into a checkout is added to that checkout's `info/exclude`
first, so a launch never makes the user's own repository look dirty. A linked
worktree keeps `info/` in the common git directory, which is where the entry
goes.

## The wire underneath

[session_control.rs](../src-tauri/src/session_control.rs) holds the whole
protocol: a `SessionControlRequest` with a token and one `SessionControlAction`,
answered by a `SessionControlResponse` whose result is flattened
(`{"version":1,"launched":{…}}`, `{"version":1,"listed":{…}}`, or
`{"version":1,"error":{"code","message"}}`).
Each action carries exactly the fields it uses, so a nonsense combination — a
project selector on a message, a prompt on a move — cannot be encoded.

The CLI and the MCP tools both build a `SessionControlAction` and hand it to
`send_session_control`; the socket handler matches on the same enum. Adding a
tool means adding a variant, not a second protocol.

Credentials are per session and revocable: `SessionLaunchRegistry::revoke`
drops a gone session's token, and every tool then fails with `AUTH_FAILED`.

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
`launchedBySessionId` names the caller. The caps have their own test in
[src-tauri/tests/session_control.rs](../src-tauri/tests/session_control.rs).

`pgrep -f "argmax mcp"` must come back empty once the app is gone. The ACP pool
runs its server in its own process group and signals the group on teardown,
because an MCP server started by `cursor-agent` is a grandchild that a signal
aimed at the server alone would leave running.
