# Providers

Argmax orchestrates three CLIs: **Claude Code**, **Codex**, and **Cursor Agent**. Adapters live in [src/main/providers/providerAdapters.ts](../../src/main/providers/providerAdapters.ts); the orchestrator is [providerSessionService.ts](../../src/main/providers/providerSessionService.ts).

## Defaults

`PROVIDER_MODELS` and `PROVIDER_MODEL_DEFAULTS` in [src/shared/providerModels.ts](../../src/shared/providerModels.ts) are the **single source of truth** for picker options and launch fallbacks.

| Provider | Default model | Reasoning | Launch mode |
|---|---|---|---|
| `claude` | Claude Haiku 4.5 | — | `structured-json` |
| `codex` | Codex Spark | `medium` | `structured-json` |
| `cursor` | Cursor Composer 2 | — | `structured-json` |

Do not duplicate model labels, ids, reasoning values, or launch modes in renderer fixtures, seed data, or docs examples. Always read from the registry.

`MODEL_PRICING` (same file) maps `modelId → { input, output, cacheRead, cacheWrite }` USD per 1M tokens; `costOf(usage, modelId)` is the one entry point. Unknown ids warn once and return `0` — never throw, never block streaming.

## Launch flow

1. Renderer calls `window.argmax.providers.launch(input)` where input matches `launchProviderSessionInputSchema`: `{ workspaceId, provider, prompt, modelLabel, modelId, reasoningEffort?, permissionMode?, cols, rows }`.
2. IPC handler validates via Zod (see [ipc.md](ipc.md)).
3. `ProviderSessionService.launch()`:
   - Resolves the workspace's `path` and `branch`.
   - Reads launch mode from `PROVIDER_MODEL_DEFAULTS[provider].launchMode`.
   - Builds CLI args via the adapter's `structuredArgs`, `structuredResumeArgs`, or `interactiveArgs`.
   - Spawns either a PTY (`node-pty`) or a stdio child (`child_process.spawn`).
   - Buffers output per stream, coalesces normalized events, throttles `lastActivityAt` writes.
4. Persistence happens transactionally; **only then** does main publish a `dashboard:delta`. The selected-session `session.eventsSince()` reads provide cursor-based reconciliation if a delta is missed.

## Follow-up turns and durable sessions

Argmax sessions are durable UI rows. The underlying provider may be one process per turn in structured mode, so we resume the provider conversation instead of starting fresh:

- `sessions.provider_conversation_id` stores the provider-side resume id.
- **Claude** structured launches pass `--session-id <argmax session id>` and resume with `--resume <provider_conversation_id>`.
- **Codex** structured launches capture `thread.started.thread_id` from the JSONL stream and resume with `codex exec resume --json … <id> -` (prompt arrives via stdin).
- **Cursor** structured launches resume with `cursor-agent agent -p --resume <id> --output-format stream-json --stream-partial-output …`.

`sessions.model_id`, `sessions.model_label`, and `sessions.reasoning_effort` are durable session state too. Changing the model in the renderer affects the **next** prompt in the same provider conversation; it does not push a live `/model` command into an already-running interactive process.

## Permission modes

`permissionMode` is `"auto-approve"` or `"ask-each-time"` (schema in [ipcSchemas.ts](../../src/shared/ipcSchemas.ts)). In auto-approve, adapters pass the provider's bypass flag:

| Provider | Bypass flags |
|---|---|
| Claude | `--permission-mode bypassPermissions` |
| Codex | `--dangerously-bypass-approvals-and-sandbox` |
| Cursor | `--force --trust` (skips file-write prompt + workspace-trust prompt) |

Argmax is a trusted single-user local app, so auto-approve is the common case. Keep these flags centralized in `providerAdapters.ts`; never inline them at call sites.

## Reasoning effort

Union: `"low" | "medium" | "high" | "xhigh"` (matches the Codex CLI — don't invent values).

- **Codex** passes `-c model_reasoning_effort=<level>`; Spark also pins `model_reasoning_summary=none` so global config can't inject one.
- **Claude** has no direct CLI knob, so the adapter pipes an `--append-system-prompt` that nudges reasoning depth (`CLAUDE_REASONING_SYSTEM_PROMPTS` in `providerAdapters.ts`). Avoids "think hard / ultrathink" magic strings, which the Opus 4.5 guide flags as unstable when extended thinking is off at the API level.
- **Cursor** does not currently take a reasoning flag.

## Rendering provider output

- Normalized timeline events (`message.delta`, `message.completed`, `error`, `command.*`, `approval.*`, etc.) are the chat source of truth.
- Raw output is persisted for audit and a human-readable fallback, but it must filter provider-protocol JSON lines (anything with a `type` field carrying a provider lifecycle keyword). The normalizer handles per-provider quirks in [providerEventNormalizer.ts](../../src/main/providers/providerEventNormalizer.ts).
- PTY streams stay out of the chat fallback — too noisy.
- **Cursor cumulative deltas.** Cursor's `--stream-partial-output` emits each assistant row as a *cumulative snapshot* of the message so far, not an incremental chunk. The normalizer tracks the prior cumulative text per session and strips it from each new row before emitting `message.delta` — otherwise the renderer would render "ExplExplorinExploring…". The final cumulative row (no `timestamp_ms`) becomes `message.completed` and resets the per-session state.
- The "Thinking" bubble appears only before visible assistant output; the first `message.delta`/`message.completed`/`error` for that turn removes it, even if the session is still `running`.

## Adding a provider

1. Append a `ProviderLaunchDefinition` to `providerDefinitions[]` in `providerAdapters.ts`:

   ```ts
   {
     id: "newProvider",
     displayName: "New Provider",
     binaryName: "new-provider-cli",
     structuredArgs: (input) => [...],
     structuredResumeArgs: (input, resumeId) => [...],
     interactiveArgs: (input) => [...],            // throw if not supported yet
     structuredStdin: (input) => input.prompt      // optional; only if prompt arrives via stdin
   }
   ```

2. Register models in `PROVIDER_MODELS` and pick a default in `PROVIDER_MODEL_DEFAULTS` ([src/shared/providerModels.ts](../../src/shared/providerModels.ts)).
3. Extend the `ProviderId` union in [src/shared/types.ts](../../src/shared/types.ts).
4. Teach the normalizer about its event shape in [providerEventNormalizer.ts](../../src/main/providers/providerEventNormalizer.ts) — usage extraction is the part most providers diverge on.
5. Add pricing rows to `MODEL_PRICING` if the model isn't already there.
6. Add fixtures under `src/main/providers/__fixtures__/` and a unit test that walks the fixture through the normalizer.

## Session lifecycle

- `ProviderSessionService` tracks sessions in-memory and persists every transition.
- `recoverOrphanedSessions()` runs at boot — anything left in `running` from a previous process is reconciled before IPC accepts connections.
- Output is coalesced into micro-batches; `dashboard:delta` is broadcast only after the SQLite write commits. Launch deltas include the session + workspace + `user.message` + `session.started`; mid-stream deltas include persisted events, raw outputs, session activity, and refreshed projects; exit/failure deltas include the final event and refreshed state.
- `disposeAll()` is wired to Electron's `before-quit` — every spawned PTY/child is killed gracefully (then SIGKILL-escalated by `scheduleSigkillEscalation` if it ignores the polite signal).
