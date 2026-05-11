# Providers

Claude Code and Codex are the two adapters today. Sessions can be PTY-based (interactive) or stdin/stdout JSON (structured), but the default path is structured JSON for speed and cleaner event parsing. Both adapters live in [src/main/providers/providerAdapters.ts](../../src/main/providers/providerAdapters.ts).

## Default models

`PROVIDER_MODELS` and `PROVIDER_MODEL_DEFAULTS` in [src/shared/providerModels.ts](../../src/shared/providerModels.ts) are the source of truth for picker options and launch defaults:

| Provider | Default | Launch mode |
|---|---|---|
| Claude | `Claude Sonnet` (`sonnet`) | `structured-json` |
| Codex | `GPT-5.3 Codex` (`gpt-5.3-codex`, `medium` reasoning) | `structured-json` |

Do not duplicate these labels, ids, reasoning values, or launch modes in renderer fixtures, seed data, or docs examples.

## Launch flow

1. Renderer calls `window.argmax.providers.launch({ workspaceId, provider, prompt, modelLabel, modelId, reasoningEffort?, cols, rows })`
2. IPC handler validates via `launchProviderSessionInputSchema` in [src/shared/ipcSchemas.ts](../../src/shared/ipcSchemas.ts)
3. [providerSessionService.ts](../../src/main/providers/providerSessionService.ts) `launch()`:
   - Resolves the workspace's `path` and `branch`
   - Resolves launch mode from `PROVIDER_MODEL_DEFAULTS[input.provider].launchMode`
   - Builds CLI args via the adapter's `interactiveArgs(input)`, `structuredArgs(input)`, or `structuredResumeArgs(input, providerConversationId)`
   - Spawns either a PTY (`node-pty`) or a stdio child
   - Buffers output per stream, coalesces events, tracks activity timestamp
4. Output is persisted as raw output and normalized timeline events; committed rows are pushed to the renderer as `dashboard:delta` events, and `session:eventsSince` provides selected-session cursor reconciliation

## Follow-up turns

Argmax chats are durable UI sessions; structured provider processes may still be one process per turn. To keep follow-up prompts inside the same native provider conversation, `sessions.provider_conversation_id` stores the provider's resume id. Claude structured launches set `--session-id <argmax session id>` and resume with `--resume <provider_conversation_id>`. Codex structured launches capture `thread.started.thread_id` from JSONL and resume with `codex exec resume <provider_conversation_id> --json`.

The selected model is also durable session state: `sessions.model_id`, `sessions.model_label`, and `sessions.reasoning_effort` are passed to resumed turns. Changing the model in the renderer affects the next prompt in the same provider conversation; it does not send a live `/model` command to an already-running interactive process.

## Adding a provider

Append a `ProviderLaunchDefinition` to `providerDefinitions[]` in `providerAdapters.ts`:

```ts
{
  id: "newProvider",
  displayName: "New Provider",
  binaryName: "new-provider-cli",
  structuredArgs: (input) => [...],   // for --json-style invocations
  structuredResumeArgs: (input, resumeId) => [...], // for follow-up turns
  interactiveArgs: (input) => [...],  // for PTY-attached interactive runs
  structuredStdin: (input) => input.prompt   // optional, only if the binary reads prompt from stdin
}
```

Then register models in `PROVIDER_MODELS`, choose a default in `PROVIDER_MODEL_DEFAULTS`, and extend `ProviderId` in `src/shared/types.ts`.

## Model + reasoning effort

`modelId` is always passed via `--model`. Codex also accepts a reasoning-effort flag — `codexReasoningArgs(input)` builds it. Reasoning-effort union: `"low" | "medium" | "high" | "xhigh"` (matches the Codex CLI; do not invent values).

`PROVIDER_MODELS` / `PROVIDER_MODEL_DEFAULTS` are the single source of truth — both the renderer launcher and seed/demo data should import them. Don't hardcode model labels like `"GPT-5.5 Medium"` or `"Claude Sonnet 4.6"` anywhere; reference the registry.

## Permission defaults

Argmax is a trusted, single-user local app, so provider sessions intentionally launch with full write and command permissions by default. Claude launches with `--permission-mode bypassPermissions`; Codex launches with `--dangerously-bypass-approvals-and-sandbox`. Keep these flags centralized in `providerAdapters.ts` so composer launches, follow-up launches, structured JSON runs, and PTY runs stay consistent.

## Rendering provider output

- Normalized events (`message.delta`, `message.completed`, `error`, etc.) are the chat source of truth.
- Raw output is still persisted for audit/debugging, but renderer chat fallback must filter provider protocol JSON lines with a `type` field. Examples: Claude `{"type":"init", ...}` and Codex `{"type":"thread.started"}` / `{"type":"turn.started"}`.
- PTY streams are not rendered in chat fallback; they are too noisy for the conversation surface.
- The "Thinking" bubble appears only before visible assistant output. Once a non-user conversation event exists, hide the indicator even if the session state still says `running`.

## Session lifecycle

- Sessions are tracked in-memory in `ProviderSessionService` and persisted to SQLite
- `disposeAll()` is wired to Electron's `before-quit` event — kills any spawned PTYs gracefully
- `ProviderSessionService` publishes dashboard deltas only after persistence succeeds. Launch deltas include the session, workspace, `user.message`, `session.started`, and refreshed projects. Micro-batch deltas include persisted timeline events, raw outputs, any changed session activity, and refreshed projects. Exit/failure deltas include final raw output, session/workspace state, final event, and refreshed projects.
- The renderer uses `dashboard.list()` plus `approvals.pending()` for initial state, `dashboard.onDelta()` for pushed provider-session updates, `workspaces.status()` plus `approvals.pending()` for active-work status polling, and `session.eventsSince()` rowid cursors for selected-session event/raw-output tails.
- `dashboard.load()` remains a compatibility full snapshot wrapper, not the normal active-session refresh path. SQLite remains the source of truth; focused reads and cursor tails are the recovery path for missed deltas, renderer refreshes, and future multi-window quirks.
