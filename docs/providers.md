# Providers

Argmax launches Claude Code, Codex, and Cursor Agent through Rust services in [src-tauri/src/providers](../src-tauri/src/providers).

## Shape

- [adapters.rs](../src-tauri/src/providers/adapters.rs) builds argv/stdin for structured-json launches. Permission bypass flags stay centralized here.
- [environment.rs](../src-tauri/src/providers/environment.rs) builds provider PATH/env.
- [discovery.rs](../src-tauri/src/providers/discovery.rs) finds provider CLIs.
- [runtime.rs](../src-tauri/src/providers/runtime.rs) owns PTY/process launch.
- [session_service.rs](../src-tauri/src/providers/session_service.rs) owns launch, resume, send-input, resize, terminate, cancellation, orphan recovery, and follow-up queues.
- [follow_up.rs](../src-tauri/src/providers/follow_up.rs) builds the capped visible transcript used when resuming a completed session.
- [orphan_cleanup.rs](../src-tauri/src/providers/orphan_cleanup.rs) matches and terminates detached provider CLIs during startup recovery.
- [normalizer](../src-tauri/src/providers/normalizer) maps provider JSONL/stdout into timeline events.
- [flush_queue.rs](../src-tauri/src/providers/flush_queue.rs) micro-batches event writes and publishes `dashboard:delta` after commit. Complete JSONL lines flush immediately; any trailing fragment without a newline is debounced-flushed (~16 ms after the last stdout chunk) so interactive sessions that stay alive after answering still surface chat rows before Stop.
- [pricing.rs](../src-tauri/src/providers/pricing.rs) mirrors renderer pricing defaults.
- [title.rs](../src-tauri/src/providers/title.rs) runs a best-effort, locked-down one-shot CLI call to replace the provisional first-line sidebar label with a short generated title.

Provider protocol output is persisted for debugging but must not render as chat. Visible chat is normalized timeline events.

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

On startup, orphan recovery marks sessions left in `running` as failed and
terminates any detached provider CLI whose argv still references the Argmax
session id or stored provider conversation id. Without that cleanup, an
unobserved Claude/Codex/Cursor process can keep working on the same resume id
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
`provider_conversation_id`, and relaunches fresh. Claude/Codex/Cursor resume ids
do not translate, so the new agent rebuilds context from the same visible
transcript instead of using a native resume. Switching is gated to idle sessions:
the composer locks the picker to the session's provider while a turn is running.
A follow-up sent mid-turn queues and keeps the current provider. A switch
requires `model_label`/`model_id` for the new provider. A `session.provider-changed`
timeline marker records the handoff.

Claude structured launches use `--output-format stream-json`, `--verbose`,
`--include-partial-messages`, and `--brief` so answer/thinking deltas stream
live and Claude can send explicit user-facing messages through `SendUserMessage`.
The normalizer unwraps `stream_event` rows, maps `SendUserMessage` tool calls to
`message.completed`, and maps a successful `result` row's `result` field to
`message.completed`.

Fast mode is an Argmax launch preference, not a persisted provider edit:
Claude receives it via `--settings {"fastMode":true|false}` and Codex receives
the priority service tier (`-c service_tier="priority"`) only when enabled.
Cursor has no fast-mode or reasoning-effort flag — it exposes both as distinct
model ids — so `cursor_model_for` in [adapters.rs](../src-tauri/src/providers/adapters.rs)
folds the chosen effort and fast mode into the launched `--model` (e.g.
`gpt-5.5-extra-high`, `claude-opus-4-8-max-fast`). Effort variants exist only for
GPT-5.5 and Opus 4.8 (clamped to each family's ceiling), and every Cursor model
but Gemini 3.5 Flash has a `-fast` variant; the picker mirrors this by only
offering effort/Speed where a variant exists.

Cursor's provider conversation id is the `session_id` from its `system/init`
JSON row; persist it so follow-ups can resume with `cursor-agent --resume`.

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

Session titles are not exposed by Claude/Codex/Cursor protocol streams. New
sessions first show the renderer's `titleFromPrompt` label, then the renderer
fires `workspaces:autotitle` after `providers:launch` succeeds. The generated
title only overwrites while the workspace label is still marked auto, so manual
renames win over late title results.

## Adding A Provider

Add the adapter, discovery metadata, normalizer mapping and fixtures, model defaults/pricing, and renderer picker entries. Keep launch defaults in shared/providerModels and Rust pricing in sync.
