# Providers

Argmax manages Claude Code, Codex, Cursor Agent, OpenCode, and Grok Build through Rust services in [src-tauri/src/providers](../src-tauri/src/providers).

## Architecture

- [adapters.rs](../src-tauri/src/providers/adapters.rs): Constructs CLI arguments and stdin for structured JSON modes. Centralizes auto-approve bypass flags.
- [environment.rs](../src-tauri/src/providers/environment.rs): Hydrates user login shell environment and PATH for spawned processes.
- [discovery.rs](../src-tauri/src/providers/discovery.rs): Detects installed provider binaries and versions.
- [runtime.rs](../src-tauri/src/providers/runtime.rs): Manages PTY process execution.
- [session_service.rs](../src-tauri/src/providers/session_service.rs): Orchestrates launch, resume, user input, resize, cancellation, and orphan recovery.
- [follow_up.rs](../src-tauri/src/providers/follow_up.rs): Generates the capped visible transcript for session resumes and provider switches.
- [orphan_cleanup.rs](../src-tauri/src/providers/orphan_cleanup.rs): Terminates lingering provider processes during startup recovery.
- [normalizer/](../src-tauri/src/providers/normalizer): Translates provider JSONL/stdout streams into normalized timeline events.
- [flush_queue.rs](../src-tauri/src/providers/flush_queue.rs): Batches event writes to SQLite and emits `dashboard:delta`. Complete JSONL lines flush immediately; non-newline trailing fragments are debounced for ~16 ms so interactive sessions surface output promptly.
- [subagent_trace.rs](../src-tauri/src/providers/subagent_trace.rs): Imports trace-backed child activity and reconciles authoritative child lineage when a provider omits a launch row.
- [pricing.rs](../src-tauri/src/providers/pricing.rs): Token pricing models matching `src/shared/providerModels.ts`.
- [one_shot.rs](../src-tauri/src/providers/one_shot.rs): One-shot helper calls to a provider CLI, all on the cheap `PROVIDER_TITLE_MODEL` (`providerModels.ts`) with tools and config loading off. Two callers: short session titles (`workspaces:autotitle`) and the composer's suggested follow-up (`session:suggest-follow-up`). Claude uses `claude-sonnet-5 --effort low`; OpenCode stays on the free `opencode/big-pickle` model; Grok uses `grok-4.6` (the cheaper of its two SKUs) with `--tools ""`.

Raw provider output is saved for debugging, but only normalized timeline events are displayed in chat.

## Permissions and Approvals

Native permission gates are reported in `ProviderCapabilityReport.approvalSupport`.
- Claude, Codex, and Grok: Observable-only in structured PTY mode. Gate events become `permission.blocked` notifications.
- Cursor and OpenCode: Native gate detection is unsupported.
- Approval rows store provider correlation fields as opaque payload data without mocking user approval responses.

## MCP Configuration

Model Context Protocol (MCP) servers are configured in each provider's native CLI or config files:
- **Claude Code:** `claude mcp add <name> -- <command>` or `/mcp` in interactive sessions.
- **Codex:** `codex mcp add <name> -- <command>` or `~/.codex/config.toml`.
- **Cursor:** Settings > Tools & MCP or `~/.cursor/mcp.json`.
- **OpenCode:** `opencode mcp add` or `~/.config/opencode/opencode.json`.
- **Grok Build:** `grok mcp add <name> -- <command>` or `~/.grok/config.toml`.

Spawned sessions run in the workspace worktree. Project-scoped `.mcp.json` or `.cursor/mcp.json` files must be committed to git to appear inside isolated worktrees.

*Codex connectors note:* `codex exec` runs without ChatGPT desktop app connectors (Notion, Linear, Google Drive). Use direct remote MCP URLs via `codex mcp add --url <url>` instead.

## Session Lifecycle and Follow-ups

- **Startup cleanup:** Sessions left in `running`, `waiting`, or `blocked` states are marked failed on startup. Matching background provider processes are terminated and pending approvals cancelled.
- **Follow-up prompts:** Follow-up turns use the provider resume ID when available, passing a capped transcript of visible `user.message`, `message.completed`, and `error` events. Hidden subagent rows are excluded.
- **Provider switching:** Changing the provider on an idle session clears `provider_conversation_id`, starts a new provider process with the capped transcript, and records a `session.provider-changed` marker.
- **Forking:** `session:fork` creates a new session flagged with `resume_fork`. The next turn invokes the provider's fork flag (`--fork-session` for Claude and Grok, `exec fork` for Codex, `--fork` for OpenCode). Cursor does not support session forking.
- **Project moves:** An agent-requested move waits for the current turn to settle, copies the transcript into a fresh session in the destination project, and clears `provider_conversation_id`. The first destination turn receives the capped transcript plus the project handoff.
- **Fast mode & reasoning effort:** Claude uses `--settings {"fastMode": ...}` and `--append-system-prompt` for effort (including Max/Ultra). Codex uses `-c service_tier="priority"` and `-c model_reasoning_effort=...` (Sol/Terra through ultra, Luna through max). Cursor encodes effort and fast mode into the model string (e.g. `gpt-5.6-sol-max-fast`). Grok takes `--reasoning-effort` and has no fast mode; its CLI accepts only low/medium/high/xhigh, so Max and Ultra clamp to xhigh.

## Cursor Warm ACP Runtime

To avoid startup overhead, `composer-2.5` launches run over Agent Client Protocol (ACP) against a pooled `cursor-agent acp` process ([cursor_acp.rs](../src-tauri/src/providers/cursor_acp.rs)).
- **Scope:** Restricted to `composer-2.5`. Other models with reasoning variants fall back to one-shot PTY execution.
- **Turn lifecycle:** ACP notifications translate into standard Cursor stream events. Tool rows are named from `rawInput._toolName` to prevent sub-agents from collapsing into generic `other` tools.
- **Permissions:** Auto-answered with allow, matching `--force --trust` one-shot semantics.
- **Cancellation & cleanup:** `terminate` cancels in-flight prompts. Workspace pool entries are evicted when isolated workspaces archive or are removed.

## OpenCode

OpenCode runs via `opencode run --dir <workspace> --format json --thinking -m <provider/model>`.
- The `--dir` flag ensures tools execute in the workspace directory rather than the root directory.
- OpenCode uses a SQLite store at `~/.local/share/opencode/opencode.db`. Discovery probes and title generation use temporary `XDG_DATA_HOME` directories to prevent database lock contention with active sessions.

## Grok Build

Grok Build runs via `grok "--single=<prompt>" --cwd <workspace> --output-format streaming-messages-json --include-partial-messages`.

- **It speaks Claude Code's wire format.** `system/init`, Anthropic `stream_event` content blocks, whole `assistant` messages, and a closing `result` are byte-identical to `claude --output-format stream-json`. Grok therefore has no normalizer of its own: `speaks_claude_stream_json` in [normalizer/mod.rs](../src-tauri/src/providers/normalizer/mod.rs) routes it down Claude's path. If Grok ever forks that format, the fixture test in that file is what fails.
- **The prompt must ride the `=` form.** `-p`/`--single` takes the prompt as a flag *value*, not the trailing positional Claude and Cursor use. Passed as two argv entries, the CLI rejects any prompt starting with `-` with a bare usage error — a pasted diff or a "- do this" bullet trips it. `--single=<prompt>` is the only form clap always reads as a value.
- **`--cwd` is passed explicitly** even though the child is already spawned in the worktree: with `[cli] use_leader` enabled the turn runs inside a shared leader process whose cwd is not the child's. Same trap OpenCode's `--dir` covers.
- **Plan mode** maps to the bundled read-only `plan` agent (`--agent plan`, `permission_mode: plan`, no edit tools) rather than a prompt prefix.
- **Skills** come from `.grok/skills`, `.agents/skills`, and — by Grok's own compatibility rules — `.claude/skills`, plus `~/.grok/installed-plugins/<plugin>/skills` and the bundled cache at `~/.grok/bundled/skills`.
- **Pricing** is the `grok-4.6-build` / `grok-4.5-build` SKU rate, not xAI's published API list price. The rates in `MODEL_PRICING` were solved from the CLI's own `total_cost_usd` and reproduce it exactly; note 4.5 costs twice 4.6, so the default and title model both stay on 4.6.
- **Session sync is not supported.** Grok stores transcripts under `~/.grok/sessions/<percent-encoded-cwd>/<uuid>/`, which is a lossless cwd mapping, but Argmax has no reader for it yet — the Settings toggle renders disabled.

## Subagent Activity

Subagent tool calls (`Task`, `spawn_agent`, `taskToolCall`) open an activity pane:
- **Claude:** Emits child events directly in the stdout stream with `parent_tool_use_id`.
- **Codex:** Reads child JSONL traces from `~/.codex/sessions/YYYY/MM/DD` or `~/.codex/archived_sessions`. A child `session_meta.parent_thread_id` can recover a launch omitted from structured stdout.
- **Cursor:** Reads transcripts from `~/.cursor/projects/*/agent-transcripts/<agentId>/`.
- **OpenCode:** Emits the `task` launch through structured stdout. Argmax has no separate OpenCode child-trace source.

`session:agent-events` fetches and parses trace files on demand. Parsed rows are saved with deterministic IDs (`trace:<provider>:<sessionId>:<parentToolUseId>:<childId>:<seq>:<kind>`) and hidden from the main chat view.

Trace recovery requires authoritative lineage. Argmax does not attach a transcript to a parent by time or repository alone. Claude and OpenCode stay stream-native. Cursor uses its streamed launch plus an agent ID or the existing prompt match. Codex may synthesize a launch from the child trace because the trace names its parent conversation directly. If the real Codex launch arrives later, reconciliation keeps the real row, reparents the imported child rows, and emits hidden tombstones that remove the synthetic row from open chats.

Initial session backfill and open agent panes run reconciliation off the main thread. Live agent-control events queue one serialized scan per session. A terminal provider event waits for the final serialized scan and includes its new launch or tombstone rows in the same dashboard delta, so completion cannot stop the renderer poll before recovery arrives.

## Tool Event Identity

Provider tool IDs are local to a provider invocation and may repeat in a long session. The renderer pairs `command.started` and `command.completed` by the provider-native ID scoped with `payload.providerInvocationId`:
- Claude: `id` on `tool_use`, then `tool_use_id` on `tool_result`.
- Codex: item `id`.
- Cursor, including ACP: `call_id`.
- OpenCode: `call_id`.

Historical events without `providerInvocationId` use chronological unmatched-pair correlation. `ToolCall.toolUseId` keeps the raw provider ID because subagent parent-child linkage uses that value.

## Agent Session Control

Hosted agents can create a top-level Argmax session when the user explicitly requests one:

```bash
"$ARGMAX_BIN" session launch --project <name-or-path> --prompt '<task>'
```

They can also move the current chat to a different registered project:

```bash
"$ARGMAX_BIN" session move --project <name-or-path> [--worktree] [--keep-source]
```

The move is scheduled because the command runs inside the active turn. It executes after that turn settles, uses the destination project's shared checkout by default, and archives the source workspace without forcing dirty-worktree deletion. `--worktree` creates an isolated destination. `--keep-source` leaves the source workspace open.

The CLI communicates with Argmax over a private local Unix socket using bearer credentials ([session_control.rs](../src-tauri/src/session_control.rs)). The instruction forbids automatic launches and moves. Warm Cursor ACP sessions do not receive this control because their shared process cannot safely hold a per-session credential.

## Default Model Selection

Defaults are configured in Settings → Agents → Default model (`localStorage.argmax.launch.model`). When unset, the app selects the highest priority installed provider:
1. Claude (Opus 5)
2. Codex (GPT-5.6 Sol)
3. Cursor (Grok 4.6)
4. OpenCode (GLM-5.3-Flash)
5. Grok Build (Grok 4.6)
6. Fallback: Big Pickle
