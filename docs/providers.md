# Providers

Argmax manages Claude Code, Codex, Cursor Agent, and OpenCode through Rust services in [src-tauri/src/providers](../src-tauri/src/providers).

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
- [pricing.rs](../src-tauri/src/providers/pricing.rs): Token pricing models matching `src/shared/providerModels.ts`.
- [title.rs](../src-tauri/src/providers/title.rs): Generates short session titles using background CLI calls.

Raw provider output is saved for debugging, but only normalized timeline events are displayed in chat.

## Permissions and Approvals

Native permission gates are reported in `ProviderCapabilityReport.approvalSupport`.
- Claude and Codex: Observable-only in structured PTY mode. Gate events become `permission.blocked` notifications.
- Cursor and OpenCode: Native gate detection is unsupported.
- Approval rows store provider correlation fields as opaque payload data without mocking user approval responses.

## MCP Configuration

Model Context Protocol (MCP) servers are configured in each provider's native CLI or config files:
- **Claude Code:** `claude mcp add <name> -- <command>` or `/mcp` in interactive sessions.
- **Codex:** `codex mcp add <name> -- <command>` or `~/.codex/config.toml`.
- **Cursor:** Settings > Tools & MCP or `~/.cursor/mcp.json`.
- **OpenCode:** `opencode mcp add` or `~/.config/opencode/opencode.json`.

Spawned sessions run in the workspace worktree. Project-scoped `.mcp.json` or `.cursor/mcp.json` files must be committed to git to appear inside isolated worktrees.

*Codex connectors note:* `codex exec` runs without ChatGPT desktop app connectors (Notion, Linear, Google Drive). Use direct remote MCP URLs via `codex mcp add --url <url>` instead.

## Session Lifecycle and Follow-ups

- **Startup cleanup:** Sessions left in `running`, `waiting`, or `blocked` states are marked failed on startup. Matching background provider processes are terminated and pending approvals cancelled.
- **Follow-up prompts:** Follow-up turns use the provider resume ID when available, passing a capped transcript of visible `user.message`, `message.completed`, and `error` events. Hidden subagent rows are excluded.
- **Provider switching:** Changing the provider on an idle session clears `provider_conversation_id`, starts a new provider process with the capped transcript, and records a `session.provider-changed` marker.
- **Forking:** `session:fork` creates a new session flagged with `resume_fork`. The next turn invokes the provider's fork flag (`--fork-session` for Claude, `exec fork` for Codex, `--fork` for OpenCode). Cursor does not support session forking.
- **Fast mode & reasoning effort:** Claude uses `--settings {"fastMode": ...}`. Codex uses `-c service_tier="priority"`. Cursor encodes effort and fast mode into the model string (e.g. `gpt-5.6-sol-xhigh-fast`).

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

## Subagent Activity

Subagent tool calls (`Task`, `spawn_agent`, `taskToolCall`) open an activity pane:
- **Claude:** Emits child events directly in the stdout stream with `parent_tool_use_id`.
- **Codex:** Reads child JSONL traces from `~/.codex/sessions/YYYY/MM/DD` or `~/.codex/archived_sessions`.
- **Cursor:** Reads transcripts from `~/.cursor/projects/*/agent-transcripts/<agentId>/`.

`session:agent-events` fetches and parses trace files on demand. Parsed rows are saved with deterministic IDs (`trace:<provider>:<sessionId>:<parentToolUseId>:<childId>:<seq>:<kind>`) and hidden from the main chat view.

## Agent-Launched Sessions

Hosted agents can spawn top-level Argmax sessions using the CLI helper:

```bash
"$ARGMAX_BIN" session launch --project <name-or-path> --prompt '<task>'
```

The CLI communicates with Argmax over a private local Unix socket using bearer credentials ([session_control.rs](../src-tauri/src/session_control.rs)). Requests execute through `WorkspaceService` and `ProviderSessionService`.

## Default Model Selection

Defaults are configured in Settings → Agents → Default model (`localStorage.argmax.launch.model`). When unset, the app selects the highest priority installed provider:
1. Claude (Opus 5)
2. Codex (GPT-5.6 Sol)
3. Cursor (Grok 4.6)
4. OpenCode (GLM-5.3-Flash)
5. Fallback: Big Pickle
