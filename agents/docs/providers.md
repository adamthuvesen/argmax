# Providers

Claude Code and Codex are the two adapters today. Sessions are either PTY-based (interactive) or stdin/stdout JSON (structured). Both adapters live in [src/main/providers/providerAdapters.ts](../../src/main/providers/providerAdapters.ts).

## Launch flow

1. Renderer calls `window.maestro.providers.launch({ workspaceId, provider, prompt, modelLabel, modelId, reasoningEffort?, cols, rows })`
2. IPC handler validates via `launchProviderSessionInputSchema` in [src/shared/ipcSchemas.ts](../../src/shared/ipcSchemas.ts)
3. [providerSessionService.ts](../../src/main/providers/providerSessionService.ts) `launch()`:
   - Resolves the workspace's `path` and `branch`
   - Builds CLI args via the adapter's `interactiveArgs(input)` or `structuredArgs(input)`
   - Spawns either a PTY (`node-pty`) or a stdio child
   - Buffers output per stream, coalesces events, tracks activity timestamp
4. Output flows into the events table; the next `dashboard:load` surfaces it to the renderer

## Adding a provider

Append a `ProviderLaunchDefinition` to `providerDefinitions[]` in `providerAdapters.ts`:

```ts
{
  id: "newProvider",
  displayName: "New Provider",
  binaryName: "new-provider-cli",
  structuredArgs: (input) => [...],   // for --json-style invocations
  interactiveArgs: (input) => [...],  // for PTY-attached interactive runs
  structuredStdin: (input) => input.prompt   // optional, only if the binary reads prompt from stdin
}
```

Then register a model in `PROVIDER_MODEL_DEFAULTS` in [src/shared/providerModels.ts](../../src/shared/providerModels.ts) and extend `ProviderId` in `src/shared/types.ts`.

## Model + reasoning effort

`modelId` is always passed via `--model`. Codex also accepts a reasoning-effort flag — `codexReasoningArgs(input)` builds it. Reasoning-effort union: `"low" | "medium" | "high" | "xhigh"` (matches the Codex CLI; do not invent values).

`PROVIDER_MODEL_DEFAULTS` is the single source of truth — both the renderer launcher and the seed/demo data import it. Don't hardcode `"GPT-5.5 Medium"` or `"Claude Sonnet 4.6"` anywhere; reference the constant.

## Session lifecycle

- Sessions are tracked in-memory in `ProviderSessionService` and persisted to SQLite
- `disposeAll()` is wired to Electron's `before-quit` event — kills any spawned PTYs gracefully
- A renderer-side `dashboard.load` poll runs every 1.2s while at least one session is `running` or `waiting`, or a check is `queued`/`running` (see `hasActiveWork()` in `App.tsx`)
