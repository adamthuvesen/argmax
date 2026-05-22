# Architecture

Two processes, three source folders, one IPC contract.

Open the right deep dive when you need it:

| Topic | Doc |
|---|---|
| IPC contract, channels, schemas | [ipc.md](ipc.md) |
| Provider adapters, launch/resume | [providers.md](providers.md) |
| SQLite schema, migrations, retention | [data.md](data.md) |
| Worktrees, review, checkpoints | [workspaces.md](workspaces.md) |
| Approvals risk policy, checks | [approvals-checks.md](approvals-checks.md) |
| Integrated terminal panel | [terminal.md](terminal.md) |
| GitHub CI feedback loop | [gh.md](gh.md) |
| Learnings (per-project memory) | [memory.md](memory.md) |
| Startup, IPC, and renderer perf budgets | [performance.md](performance.md) |
| Native modules, lifecycle, preload | [electron.md](electron.md) |
| Styling, tokens, motion | [styling.md](styling.md) |
| Tests | [testing.md](testing.md) |
| OpenSpec workflow | [openspec.md](openspec.md) |
| Signing + notarization | [release.md](release.md) |

## Main process — `src/main/`

Entry: [src/main/main.ts](../../src/main/main.ts). Boots the database, services, IPC, menu, and `BrowserWindow` inside `app.whenReady()`; binds cleanup to `before-quit`.

| Folder | Role |
|---|---|
| `approvals/` | `ApprovalService` + `dangerousActionPolicy` command-risk classifier |
| `attachments/` | `AttachmentStore` + `argmax-attachment://` protocol handler for composer image paste/drop |
| `checks/` | `CheckService` — spawns commands with 5-min wall-clock cap and cancellation |
| `constants/` | Shared subsystem timeouts (provider PTY, check, gh poll, etc.) |
| `dock/` | macOS dock badge for attention counts |
| `files/` | Workspace file tree + previews (binary/size-skipped) |
| `gh/` | `GhService` (gh CLI wrapper) + `GhPoller` (PR check-state polling) |
| `git/` | `runGitText` / `runGitBuffer` + `GitOpsService` for commit/push/branch/PR actions |
| `ide/` | `mdfind`-based IDE detection (VS Code, Cursor, Windsurf, etc.) + launch |
| `ipc/` | Per-namespace handler registrars (`registerProjectHandlers`, `registerWorkspaceHandlers`, …) consumed by [src/main/ipc.ts](../../src/main/ipc.ts) |
| `judges/` | Tournament judge — criterion runners + score aggregator |
| `mcp/` | User-scope MCP registry + `McpAuthService` (interactive PTY for OAuth-style MCP server enrollment) |
| `memory/` | `learningExtractor` + `learningInjector` (project-scoped pitfalls) |
| `notifications/` | OS notifications gated on window-focus state |
| `persistence/` | `database.ts`, `migrations.ts`, `seed.ts` — SQLite is the source of truth |
| `projects/` | Project registration, settings, branch switching, gh remote resolution |
| `providers/` | Claude / Codex / Cursor adapters + `ProviderSessionService` |
| `review/` | `GitReviewService` + `CheckpointService` (binary patches under `${dataDirectory}/checkpoints/`) |
| `sessions/` | `sessionAttention` (which sessions need a user nudge) |
| `skills/` | Local skill registry — `~/.claude/skills`, `~/.codex/{skills,prompts}`, `~/.cursor/skills`, plugin caches, plus per-workspace `.claude` / `.codex` / `.cursor` directories. Precedence: workspace > user > codex-prompt > system > plugin |
| `terminal/` | `TerminalService` — user-spawned PTYs for the integrated terminal panel |
| `tournaments/` | `TournamentService` — parallel contestants in worktrees + deterministic judge pipeline |
| `updater/` | `UpdateService` — `electron-updater` wrapper (packaged builds only) |
| `util/` | Pure helpers: `workspacePaths`, `appNavigation`, `deltaCoalescer` (60 fps push throttle), `ipcLatency` (per-channel histogram), `startupTimer` (phase marks for diagnostics) |
| `workspaces/` | `WorkspaceService` — git worktrees, fs.watch debouncing |

`main.ts` wires services together in this order: `createDatabase()` → `NotificationService` → `DockBadgeService` → `ProviderSessionService` (then `recoverOrphanedSessions()` to mop up sessions left `running` from a previous crash) → `TerminalService` → `McpAuthService` → `registerIpcHandlers()` → construct `GhPoller` + `UpdateService` (packaged only) → application menu → `BrowserWindow` (`createWindow()`) → `ghPoller.start()` → `updateService.runStartupCheck()`. The `dashboard:delta` publisher runs every push through `DeltaCoalescer` at ~60 fps so streaming-heavy turns don't pin the renderer.

## Renderer — `src/renderer/`

React 19 + Vite. [App.tsx](../../src/renderer/App.tsx) composes the shell; dashboard lifecycle lives in [useDashboardSession.ts](../../src/renderer/hooks/useDashboardSession.ts) with [loadDashboardSnapshot.ts](../../src/renderer/lib/loadDashboardSnapshot.ts). Grid selection and pane open/drop wiring live in [useAppGridSelection.ts](../../src/renderer/hooks/useAppGridSelection.ts); lazy overlay chunks prefetch via [useLazyOverlayPrefetch.ts](../../src/renderer/hooks/useLazyOverlayPrefetch.ts). Appearance/IDE prefs use [useLauncherAppearance.ts](../../src/renderer/hooks/useLauncherAppearance.ts); boolean UI prefs use [uiPreferences.ts](../../src/renderer/lib/uiPreferences.ts). Multi-pane work goes through [SessionMultiGrid.tsx](../../src/renderer/components/SessionMultiGrid.tsx) — a 3×3 grid with drag-and-drop and edge-only split, backed by the pure [gridState](../../src/renderer/lib/gridState.ts) reducer. Chat turn prep is in [sessionTurnView.ts](../../src/renderer/lib/sessionTurnView.ts) with card state in [turnInteractiveCards.ts](../../src/renderer/lib/turnInteractiveCards.ts). Heavy panels (`SettingsPanel`, `WelcomePane`, `McpAuthDialog`, `ReviewPanel`, `TerminalPanel`, command palette + search overlays) are `React.lazy`-mounted so the prod bundle ships them as separate chunks; overlay CSS is split under [styles/overlays-*.css](../../src/renderer/styles/). Browser-preview mode (Vite without Electron) detects the missing `window.argmax` and falls back to [demoSnapshot.ts](../../src/renderer/demoSnapshot.ts) — see `isBrowserPreview()`.

Integration tests for the shell use [appTestHarness.ts](../../src/test/appTestHarness.ts) and [fixtures/dashboardSnapshot.ts](../../src/test/fixtures/dashboardSnapshot.ts) (`App.test.tsx`, `App.sidebar.test.tsx`, `App.grid.test.tsx`, `App.settings.test.tsx`).

**Dashboard freshness is SQLite-first and read-focused:**

- `dashboard.list()` — projects, workspaces, sessions, checks, checkpoints. Composed with `approvals.pending()` for the initial render.
- `session.eventsSince({ sessionId, eventCursor?, rawOutputCursor? })` — selected-session timeline events + raw outputs, using SQLite `rowid` cursors. Omitted cursors return the latest tail (500 events, 100 raw outputs).
- `workspaces.status({ workspaceIds? })` + `approvals.pending()` — focused refresh used when the window regains visibility (`document.visibilitychange`). There is no recurring `setInterval` poll today; streaming `dashboard.onDelta()` is the steady-state.
- `dashboard.onDelta()` — push channel. Main publishes provider-session deltas only **after** rows commit, then funnels every push through `DeltaCoalescer` at ~60 fps. The renderer upserts by id, sorts by timestamp fields, and caps live `events` / `rawOutputs` to dashboard limits.
- `dashboard.load()` — compatibility full snapshot. Avoid for active-session refresh; it exists for older callers and the browser-preview path.

**Two-track output rendering.** Normalized timeline events drive the visible chat. Raw provider output is persisted for audit/debug but the renderer must filter protocol JSON lines (Claude `init`, Codex `thread.started` / `turn.started`, Cursor `system/init`, etc.) out of the human-readable fallback. The "Thinking" indicator is pre-answer only — hide it the moment any visible assistant event arrives, even if the session is still `running`.

## Shared — `src/shared/`

The contract layer. The renderer imports **types only**; Zod validation runs in main.

| File | Role |
|---|---|
| [types.ts](../../src/shared/types.ts) | All TS types for dashboard data + the `ArgmaxApi` surface |
| [ipcSchemas.ts](../../src/shared/ipcSchemas.ts) | Zod schemas + parsed-input type aliases + `IPC_CHANNELS` |
| [providerModels.ts](../../src/shared/providerModels.ts) | `PROVIDER_MODELS`, `PROVIDER_MODEL_DEFAULTS`, `MODEL_PRICING`, `costOf()` |
| [safeJson.ts](../../src/shared/safeJson.ts) | Guarded JSON parsing for untrusted provider output |
| [terminalControls.ts](../../src/shared/terminalControls.ts) | ANSI stripping used by the normalizer |

See [ipc.md](ipc.md) for the full IPC channel inventory and the steps to add one safely.
