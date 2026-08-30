# Providers

Argmax launches Claude Code, Codex, Cursor Agent, and OpenCode through Rust services in [src-tauri/src/providers](../src-tauri/src/providers).

## Shape

- [adapters.rs](../src-tauri/src/providers/adapters.rs) builds argv/stdin for structured-json launches. Permission bypass flags stay centralized here.
- [environment.rs](../src-tauri/src/providers/environment.rs) builds provider PATH/env.
- [discovery.rs](../src-tauri/src/providers/discovery.rs) finds provider CLIs.
- [runtime.rs](../src-tauri/src/providers/runtime.rs) owns PTY/process launch.
- [session_service.rs](../src-tauri/src/providers/session_service.rs) owns launch, resume, send-input, resize, terminate, cancellation, orphan recovery, and follow-up queues.
- [follow_up.rs](../src-tauri/src/providers/follow_up.rs) builds the capped visible transcript used when resuming a completed session.
- [orphan_cleanup.rs](../src-tauri/src/providers/orphan_cleanup.rs) matches and terminates detached provider CLIs during startup recovery.
- [normalizer](../src-tauri/src/providers/normalizer) maps provider JSONL/stdout into timeline events.
- [flush_queue.rs](../src-tauri/src/providers/flush_queue.rs) micro-batches event writes and publishes `dashboard:delta` after commit. Complete JSONL lines flush immediately. A trailing fragment without a newline is debounced for about 16 ms after the last stdout chunk so interactive sessions that stay alive after answering still surface chat rows before Stop. A fragment that opens a JSON object but does not parse is held back instead because it is a protocol line split across PTY reads, not human-readable output. Claude's compaction summary is one roughly 22 KB line delivered as two dozen 1 KB reads, so flushing its fragments would write raw protocol JSON into the timeline.
- [pricing.rs](../src-tauri/src/providers/pricing.rs) mirrors renderer pricing defaults.
- [title.rs](../src-tauri/src/providers/title.rs) runs a best-effort, locked-down one-shot CLI call to replace the provisional first-line sidebar label with a short generated title.

Provider protocol output is persisted for debugging but must not render as chat. Visible chat is normalized timeline events.

Native permission gates are reported through `ProviderCapabilityReport.approvalSupport`. The current structured PTY runtime is observation-only for Claude and Codex, and unsupported for Cursor and OpenCode. Approval rows retain provider correlation data as opaque timeline payload fields. Resolution never silently changes a launch to bypass mode or claims to have answered a provider request that the runtime cannot address.

## MCP Configuration

Model Context Protocol (MCP) servers are configured and authenticated through
each provider's CLI or settings. Each agent loads that configuration when
Argmax launches it. Argmax does not discover or authenticate MCP servers.

- Claude Code servers are added with `claude mcp add <name> -- <command>`.
  Authentication is opened with `/mcp` inside Claude Code.
- Codex servers are added with `codex mcp add <name> -- <command>` or configured
  in `~/.codex/config.toml`.
- Cursor servers are configured under Settings > Tools & MCP or in
  `~/.cursor/mcp.json`.
- OpenCode servers are added with `opencode mcp add` or configured in
  `~/.config/opencode/opencode.json`.

An Argmax session gets exactly the MCP surface the same CLI gets in a terminal.
[environment.rs](../src-tauri/src/providers/environment.rs) hydrates the user's
login shell before spawning, so stdio servers that resolve secrets or run
through `uv`/`npx` start the same way they do interactively. The bypass flags in
[adapters.rs](../src-tauri/src/providers/adapters.rs) do not gate MCP, and
Claude's `--settings` override adds a settings layer rather than replacing the
user's MCP config.

The one real gap is Codex app connectors. Structured launches use `codex exec`,
which loads `mcp_servers` from `~/.codex/config.toml` but not the connector
plugins (Notion, Linear, Slack, Google Drive) that the ChatGPT desktop app
wires into its own `codex app-server` through a per-instance socket. Those
connectors are unavailable to every `codex exec` caller, terminal included, so
Argmax cannot recover them. A connector that also ships a remote endpoint can be
registered as an ordinary Codex server instead, for example
`codex mcp add --url https://mcp.notion.com/mcp notion` followed by
`codex mcp login notion`. Claude and Cursor expose their connector and plugin
servers to headless launches already, so both see Notion in Argmax.

Sessions run in the workspace's git worktree. Home-level MCP config is
unaffected, but a project-scoped `.mcp.json` or `.cursor/mcp.json` only reaches
the agent when it is tracked by git, since an untracked file never lands in the
worktree.

On startup, orphan recovery marks sessions left in `running`, `waiting`, or
`blocked` as failed and terminates any detached provider CLI whose argv still
references the Argmax session id or stored provider conversation id. Pending
approvals for those sessions are cancelled. Without that cleanup, an
unobserved provider process can keep working on the same resume id
while the user tries to continue the session again.

Follow-up launches still use the provider resume id when available, but the
prompt also includes a capped transcript of visible `user.message`,
`message.completed`, and `error` events from the same Argmax session. Hidden
child-agent rows (`parent_tool_use_id`, `traceImported`, Codex child-thread
messages) are excluded, matching what the chat surface shows. The timeline row
remains the raw user follow-up; only the provider launch prompt is
contextualized.

An idle follow-up can also switch provider. When `providers:send-input` carries
a `provider` that differs from the session's current one, `send_input` repoints
the session to the new provider + model, clears the provider-specific
`provider_conversation_id`, and relaunches fresh. Provider resume ids
do not translate, so the new agent rebuilds context from the same visible
transcript instead of using a native resume. Switching is gated to idle sessions:
the composer locks the picker to the session's provider while a turn is running.
A follow-up sent mid-turn queues and keeps the current provider. A switch
requires `model_label`/`model_id` for the new provider. A `session.provider-changed`
timeline marker records the handoff, carrying `from`, `provider`, and
`modelLabel` so the chat can render the seam. Every provider pair is allowed;
the transcript is the only context that crosses, which is what the composer's
confirmation dialog says before committing. See
[chat-cards.md](chat-cards.md#provider-handoff).

Claude structured launches use `--output-format stream-json`, `--verbose`,
`--include-partial-messages`, and `--brief` so answer/thinking deltas stream
live and Claude can send explicit user-facing messages through `SendUserMessage`.
A session created by `session:fork` (the turn footer's Fork button) carries a
one-shot `resume_fork` flag: its first resumed turn uses the provider's
fork-on-resume form — Claude adds `--fork-session`, Codex swaps `exec resume`
for `exec fork`, OpenCode adds `--fork` — so the CLI diverges into a new
session id instead of appending to the source conversation, and persisting
that new id clears the flag. Cursor sessions can't be forked: cursor-agent has
no fork-on-resume, so `FORK_CAPABLE_PROVIDERS` (providerModels.ts) and the
`fork_session` gate (orchestration.rs) both exclude it.
The normalizer unwraps `stream_event` rows, maps `SendUserMessage` tool calls to
`message.completed`, and maps a successful `result` row's `result` field to
`message.completed`. Context compaction becomes a
`session.compacting`/`session.compacted` pair and its replacement summary is
dropped. See [chat-cards.md](chat-cards.md#context-compaction).

A chunk whose lines were all deliberately dropped stays dropped: only a message
with no complete line is retried whole as raw text. Retrying a multi-line chunk
turned Claude's `system` hook/status/token rows back into raw protocol JSON in
the transcript.

Fast mode is an Argmax launch preference, not a persisted provider edit:
Claude receives it via `--settings {"fastMode":true|false}` and Codex receives
the priority service tier (`-c service_tier="priority"`) only when enabled.
Cursor has no fast-mode or reasoning-effort flag — it exposes both as distinct
model ids — so `cursor_model_for` in [adapters.rs](../src-tauri/src/providers/adapters.rs)
folds the chosen effort and fast mode into the launched `--model` (e.g.
`gpt-5.6-sol-xhigh`, `claude-opus-5-thinking-max-fast`). Effort variants exist
for GPT-5.6 Luna/Terra/Sol and Opus 5 Thinking (clamped to Max), plus Grok 4.6
and Gemini 3.7 Flash (clamped to High). Every Cursor model but Gemini 3.7 Flash
has a `-fast` variant; the picker mirrors this by only offering effort/Speed
where a variant exists.

Cursor's provider conversation id is the `session_id` from its `system/init`
JSON row; persist it so follow-ups can resume with `cursor-agent --resume`.

## Cursor Warm ACP Runtime

One-shot `cursor-agent agent -p` pays ~5.5 s of client-side startup before the
API turn begins — on the first turn and on every `--resume` follow-up. Eligible
Cursor launches instead run over the Agent Client Protocol on a warm
`cursor-agent acp` process, one per workspace, pooled in
[cursor_acp.rs](../src-tauri/src/providers/cursor_acp.rs) on top of the minimal
JSON-RPC client in [acp.rs](../src-tauri/src/providers/acp.rs). Measured:
session creation on a warm process ~1.2–1.4 s; a trivial follow-up turn
completes in ~2 s end to end versus ~10 s one-shot.

- **Eligibility**: `composer-2.5` only. Other Cursor models encode reasoning
  effort / fast serving in the one-shot `--model` id, and ACP's
  `session/set_model` accepts only the ids Cursor lists verbatim, so routing
  them would silently drop the chosen variant. Any ACP failure (spawn,
  handshake, load, model) logs a warning and falls back to the one-shot PTY
  path — behavior degrades to today's, never breaks.
- **Turn lifecycle**: ACP `session/update` notifications are translated into
  the same cursor stream-json lines the normalizer already parses
  (`system/init` with the ACP session id as the resume id, cumulative
  `assistant` text, `thinking` deltas, `tool_call` rows, `result/success`), so
  the flush queue, chat cards, and `complete_cursor_turn_after_result` are
  unchanged. Stop sends `session/cancel`; the warm process survives the turn.
  Follow-ups reuse the live session, or `session/load` it after an app restart
  (the replayed history is discarded — the timeline already has it).
- **Permissions**: `session/request_permission` is auto-answered with the
  allow option, matching the one-shot `--force --trust` semantics. ACP launches
  only occur in auto-approve mode (Cursor rejects ask-each-time at launch).
- **Trade-offs**: Cursor's ACP stream reports no token usage, so ACP turns
  record no usage/cost row. Composer runs Cursor's configured
  `composer-2.5[fast=true]` variant. Hosted-agent session-launch credentials
  are per-process env vars a shared warm process cannot carry, so ACP turns do
  not receive the `$ARGMAX_BIN` session-launch surface.
- **Lifecycle**: pool processes die with the app (`RunEvent::Exit` kills the
  pool; `kill_on_drop` is the backstop). Boot orphan recovery cannot match
  `cursor-agent acp` argv — it carries no session id — which is why the exit
  hook exists; a hard crash can still leak one until logout.

OpenCode structured launches use `opencode run --dir <workspace> --format json
--thinking` with the model in `provider/model` form (`-m opencode/big-pickle`).
`--dir` is mandatory: the session executes inside opencode's daemonized server,
whose own cwd is `/`, so the spawn's `current_dir` never reaches the tools —
without the flag every session runs at the filesystem root. The stream is
typed part envelopes: `text` and `reasoning` parts arrive whole (no token
streaming), a `tool_use` part carries input and output in one event and is
normalized to a `command.started`/`command.completed` pair, and each
`step_finish` reports token usage (per step, matching how the API bills). A
`step_finish` with `reason: "stop"` ends the turn as `session.completed`. Every
envelope carries the `sessionID` resume id; follow-ups resume with `run -s
<id>`. Auto-approve maps to `--auto`, and plan mode maps to the CLI's built-in
read-only `plan` agent (`--agent plan`). The catalog ships the OpenCode Zen
free-tier models (all priced at $0) plus 7 OpenCode Go (`opencode-go/*`)
models that are billed per-token and expose reasoning-effort variants via
`--variant` (low/high/max levels, model-dependent). OpenCode has no fast mode.

OpenCode keeps a process-global SQLite store at
`~/.local/share/opencode/opencode.db` (or `$XDG_DATA_HOME/opencode`). Two CLI
processes that share that file fail immediately with `database is locked`.
`providers:launch` returns as soon as the session row is persisted, and the
renderer then fires `workspaces:autotitle`, which would otherwise start a
second `opencode run` against the same file while the session is still
booting. Title generation and discovery probes (`--version`, `providers list`)
therefore point `XDG_DATA_HOME` / `XDG_STATE_HOME` at a throwaway directory
and copy `auth.json` and `mcp-auth.json` into it. Session launches keep the
real store so `run -s` resume works. A second Argmax OpenCode session, or an
OpenCode TUI already using that file, can still hit the same lock.

## Subagent Activity

Subagent panes use normal timeline events. The parent chat stays clean by hiding
child rows, while [AgentActivityPane.tsx](../src/renderer/components/AgentActivityPane.tsx)
projects those rows for the clicked parent tool.

Claude is the simplest case: its stream tags child messages and tool calls with
`parent_tool_use_id`, and the normalizer persists those rows. Codex and Cursor
need a pane-scoped trace import because their CLIs can write child-agent detail
outside the parent stream. `session:agent-events` calls
[subagent_trace.rs](../src-tauri/src/providers/subagent_trace.rs) before reading
rows back.

Codex links children from `spawn_agent` / `wait` `receiver_thread_ids`, then
looks for matching JSONL under `~/.codex/sessions/YYYY/MM/DD` around the parent
launch date and under `~/.codex/archived_sessions`. A candidate file must carry
matching `session_meta` before it is imported. Visible reasoning summaries map
to thinking deltas, function calls map to command rows, and assistant messages
map to normal completed messages.

Cursor links children from `taskToolCall` agent ids when they exist. If Cursor
does not emit an id in the parent row, the importer falls back to a
workspace-scoped prompt match under
`~/.cursor/projects/*/agent-transcripts/<agentId>/`. Cursor transcripts can
arrive late, often only after the task completes, so the pane keeps polling
while the parent tool is running. Text blocks become messages, `tool_use` blocks
become command rows, and tool outputs not yet in the transcript get a synthetic
`traceNoOutput` completion that is upgraded in place once the real result is
appended.

Imported rows are inserted only if absent and carry `traceImported: true`,
`providerChildSessionId`, `traceSource`, `traceSequence`, and the spawning
`parent_tool_use_id`. Trace import is best-effort: unreadable, missing, or
malformed files are skipped, and the pane falls back to safe launch metadata.
Provider-private async launch receipts are filtered out before the renderer
shows a subagent result.

## Agent-Launched Sessions

A hosted agent can launch a separate top-level Argmax session when the user
explicitly asks for one. This is different from a provider subagent. The new
session gets its own workspace and session rows, and the existing delta
publishers make it appear in the sidebar immediately.

Real provider launches receive a short hidden instruction plus three private
environment variables. The instruction teaches this command:

```bash
"$ARGMAX_BIN" session launch --project <registered-name-or-repo-path> --prompt '<task>'
```

`--project` is optional and only resolves registered projects by exact id,
exact repo path, or case-insensitive exact name. Omitting it uses the parent
session's project. The default creates a new workspace row for the registered
project's current checkout. `--worktree` creates an isolated worktree from the
project's current branch. `--prompt-stdin` is available for long or multiline
prompts.

The child session inherits the parent launch's provider, model, reasoning
effort, fast mode, permission mode, and agent mode. The request goes through
`WorkspaceService` and `ProviderSessionService`, so it never writes SQLite
directly or invents a second lifecycle path.

[session_control.rs](../src-tauri/src/session_control.rs) owns the private Unix
socket, in-memory per-session bearer credentials, bounded versioned protocol,
CLI client, and project resolution. The socket lives under a mode-0700 temp
directory and is mode 0600. Credentials are only injected into real hosted
provider processes. Title generation and other helper subprocesses do not
receive them.

Session titles are not exposed by Claude/Codex/Cursor protocol streams. New
sessions first show the renderer's `titleFromPrompt` label, then the renderer
fires `workspaces:autotitle` after `providers:launch` succeeds. The generated
title only overwrites while the workspace label is still marked auto, so manual
renames win over late title results.

## Launch defaults

The launcher pre-fills from Settings → Agents → Default model, stored in
`localStorage` (`argmax.launch.model`) for the whole app, not per project.
Per-project default agent (Settings → Projects) is separate: Argmax uses it
when it starts a session on its own, such as a PR check-failure follow-up.

With no stored preference, the factory pick is the highest-priority *usable*
provider (installed, and not known-unauthenticated):

1. Claude → Opus 5
2. Codex → GPT-5.6 Sol
3. Cursor → Grok 4.6
4. OpenCode → GLM-5.3-Flash (OpenCode Go)
5. otherwise Big Pickle

A stored pick that is still launchable is never replaced. Steering only runs
when the stored or factory pick's CLI is missing or logged out.

## Adding A Provider

Add the adapter, discovery metadata, normalizer mapping and fixtures, model defaults/pricing, and renderer picker entries. Keep launch defaults in shared/providerModels and Rust pricing in sync.
