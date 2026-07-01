# Providers

Argmax launches Claude Code, Codex, and Cursor Agent through Rust services in [src-tauri/src/providers](../../src-tauri/src/providers).

## Shape

- [adapters.rs](../../src-tauri/src/providers/adapters.rs) builds argv/stdin for structured-json launches. Permission bypass flags stay centralized here.
- [environment.rs](../../src-tauri/src/providers/environment.rs) builds provider PATH/env.
- [discovery.rs](../../src-tauri/src/providers/discovery.rs) finds provider CLIs.
- [runtime.rs](../../src-tauri/src/providers/runtime.rs) owns PTY/process launch.
- [session_service.rs](../../src-tauri/src/providers/session_service.rs) owns launch, resume, send-input, resize, terminate, cancellation, orphan recovery, and follow-up queues.
- [follow_up.rs](../../src-tauri/src/providers/follow_up.rs) builds the capped visible transcript used when resuming a completed session.
- [orphan_cleanup.rs](../../src-tauri/src/providers/orphan_cleanup.rs) matches and terminates detached provider CLIs during startup recovery.
- [normalizer](../../src-tauri/src/providers/normalizer) maps provider JSONL/stdout into timeline events.
- [flush_queue.rs](../../src-tauri/src/providers/flush_queue.rs) micro-batches event writes and publishes `dashboard:delta` after commit. Complete JSONL lines flush immediately; any trailing fragment without a newline is debounced-flushed (~16 ms after the last stdout chunk) so interactive sessions that stay alive after answering still surface chat rows before Stop.
- [pricing.rs](../../src-tauri/src/providers/pricing.rs) mirrors renderer pricing defaults.
- [title.rs](../../src-tauri/src/providers/title.rs) runs a best-effort, locked-down one-shot CLI call to replace the provisional first-line sidebar label with a short generated title.

Provider protocol output is persisted for debugging but must not render as chat. Visible chat is normalized timeline events.

On startup, orphan recovery marks sessions left in `running` as failed and
terminates any detached provider CLI whose argv still references the Argmax
session id or stored provider conversation id. Without that cleanup, an
unobserved old Claude/Codex/Cursor process can keep working on the same resume
id while the user tries to continue the session again.

Follow-up launches still use the provider resume id when available, but the
prompt also includes a capped transcript of visible `user.message`,
`message.completed`, and `error` events from the same Argmax session. The
timeline row remains the raw user follow-up; only the provider launch prompt is
contextualized.

An idle follow-up can also switch provider. When `providers:send-input` carries
a `provider` that differs from the session's current one, `send_input` repoints
the session to the new provider + model, clears the (provider-specific)
`provider_conversation_id`, and relaunches fresh — Claude/Codex/Cursor resume ids
don't translate, so the new agent rebuilds context from the same visible
transcript rather than a native resume. Switching is gated to idle sessions: the
composer locks the picker to the session's provider while a turn is running (a
follow-up sent mid-turn queues and keeps the current provider), and a switch
requires `model_label`/`model_id` for the new provider. A `session.provider-changed`
timeline marker records the handoff.

Claude structured launches use `--output-format stream-json`, `--verbose`, and
`--include-partial-messages` so answer and thinking deltas stream live. The
normalizer unwraps `stream_event` rows and maps a successful `result` row's
`result` field to `message.completed`.

Fast mode is an Argmax launch preference, not a persisted provider edit:
Claude receives it via `--settings {"fastMode":true|false}`, and Cursor
receives a merged model override (`model[fast=true]`) only when enabled. Codex
does not receive a fast-mode flag.

Cursor's provider conversation id is the `session_id` from its `system/init`
JSON row; persist it so follow-ups can resume with `cursor-agent --resume`.

Session titles are not exposed by Claude/Codex/Cursor protocol streams. New
sessions first show the renderer's `titleFromPrompt` label, then the renderer
fires `workspaces:autotitle` after `providers:launch` succeeds. The generated
title only overwrites while the workspace label is still marked auto, so manual
renames win over late title results.

## Adding A Provider

Add the adapter, discovery metadata, normalizer mapping and fixtures, model defaults/pricing, and renderer picker entries. Keep launch defaults in shared/providerModels and Rust pricing in sync.
