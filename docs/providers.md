# Providers

Argmax manages Claude Code, Codex, Cursor Agent, OpenCode, and Grok Build through Rust services in [src-tauri/src/providers](../src-tauri/src/providers).

## Architecture

- [adapters.rs](../src-tauri/src/providers/adapters.rs): Constructs CLI arguments and stdin for structured JSON modes. Centralizes auto-approve bypass flags.
- [environment.rs](../src-tauri/src/providers/environment.rs): Hydrates user login shell environment and PATH for spawned processes.
- [discovery.rs](../src-tauri/src/providers/discovery.rs): Detects installed provider binaries and versions.
- [runtime.rs](../src-tauri/src/providers/runtime.rs): Selects native bidirectional transports for chats. Claude uses SDK control, Codex uses app-server, Cursor and Grok use ACP, and OpenCode uses HTTP/SSE. See [approval settings](approvals-checks.md). Legacy structured argument builders remain available for fixtures and restricted helper flows.
- [session_service.rs](../src-tauri/src/providers/session_service.rs): Orchestrates launch, resume, user input, resize, cancellation, and orphan recovery.
- [follow_up.rs](../src-tauri/src/providers/follow_up.rs): Composes the prompt a follow-up turn launches with. A session holding a native resume id sends the user's message alone because the CLI replays its own rollout. Without one, such as after a provider switch, the prompt carries a capped visible transcript: 12 messages, 12k chars, with child-agent rows excluded. A pending project handoff note rides along either way. Claude, Codex, OpenCode, and eligible Cursor native subagent references are resolved against the current parent conversation at delivery time.
- [orphan_cleanup.rs](../src-tauri/src/providers/orphan_cleanup.rs): Terminates lingering provider processes during startup recovery.
- [normalizer/](../src-tauri/src/providers/normalizer): Translates provider JSONL/stdout streams into normalized timeline events. Session sync replays transcript files through the same code, with `NormalizerSessionContext::for_transcript_replay` set: replay mode is what lets a `type:"user"` line become a `user.message`, since on live stdout such a line only ever carries a tool result. See [session-sync.md](session-sync.md).
- [flush_queue.rs](../src-tauri/src/providers/flush_queue.rs): Batches event writes to SQLite and emits `dashboard:delta`. Complete JSONL lines flush immediately; non-newline trailing fragments are debounced for ~16 ms so interactive sessions surface output promptly.
- [subagent_trace/](../src-tauri/src/providers/subagent_trace): Imports trace-backed child activity and reconciles authoritative child lineage when a provider omits a launch row.
- [pricing.rs](../src-tauri/src/providers/pricing.rs): Token pricing models matching `src/shared/providerModels.ts`.
- [one_shot.rs](../src-tauri/src/providers/one_shot.rs): One-shot helper calls to a provider CLI, all on the cheap `PROVIDER_TITLE_MODEL` (`providerModels.ts`) with tools and config loading off. Two callers: short session titles (`workspaces:autotitle`) and the composer's suggested follow-up (`session:suggest-follow-up`). Claude uses `claude-sonnet-5 --effort low`; OpenCode stays on the free `opencode/big-pickle` model; Grok uses `grok-4.6` (the cheaper of its two SKUs) with `--tools ""`.

Raw provider output is saved for debugging, but only normalized timeline events are displayed in chat. The persisted payload stays compatible with existing rows and provider fixtures. The renderer decodes it once through [canonicalTimeline.ts](../src/renderer/lib/canonicalTimeline.ts), then routes behavior from the resulting typed event instead of reading semantic payload keys in each feature.

## Verification profiles

`npm run verify` starts a disposable profile with a scripted Claude executable.
The fixture follows the production discovery, adapter, PTY, normalizer, and
persistence paths. It validates the resume argument and exposes file barriers
so the runner can inspect streaming text and a running tool before allowing
the next events through. See [verification.md](verification.md).

Setting `ARGMAX_VERIFICATION` requests fixture-only discovery. Startup requires
the exact value `1`, the `verification` Cargo feature, an existing absolute
`ARGMAX_VERIFICATION_HOME`, and an executable provider override such as
`ARGMAX_VERIFICATION_CLAUDE_BINARY`. Missing or malformed configuration fails
before services start. Unconfigured providers remain unavailable, and fixture
children receive an isolated environment without provider credentials.

The fixture covers Argmax's integration behavior for Claude's stream format.
It does not establish compatibility with a newly released provider CLI.

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

Argmax adds one server of its own per launch — `argmax`, the agent tools — through each provider's per-launch mechanism, without disturbing the user's configured servers. For Cursor's one-shot path and for Grok that mechanism is a config file written into the workspace and put back when the child exits; a `.cursor/mcp.json` the user keeps is merged, never replaced ([agent-tools.md](agent-tools.md)).

*Codex connectors note:* `codex exec` runs without ChatGPT desktop app connectors (Notion, Linear, Google Drive). Use direct remote MCP URLs via `codex mcp add --url <url>` instead.

## Session Lifecycle and Follow-ups

An idle follow-up persists the user message and returns, then spawns the provider in the background. The PTY/CLI spawn does not block the send IPC.

- **Startup cleanup:** Sessions left in `running`, `waiting`, or `blocked` states are marked failed on startup. Matching background provider processes are terminated and pending approvals cancelled.
- **Follow-up prompts:** Follow-up turns use the provider resume ID when available, without repeating its transcript. A referenced Claude, Codex, OpenCode, or eligible Cursor dock name adds a validated name-to-child-ID mapping. Fresh conversations receive a capped transcript of visible `user.message`, `message.completed`, and `error` events. Hidden subagent rows are excluded.
- **Native Claude, Codex, OpenCode, and Cursor subagents:** A persistent child stays addressable through its parent native conversation and can appear as multiple runs in one dock tab. Claude uses `SendMessage`. Codex uses `send_input`, with `resume_agent` when the child needs revival. OpenCode invokes its native `task` tool with the existing `task_id`. Cursor uses `taskToolCall` and the authoritative child id from the completed result. Composer 2.5 child references remain excluded until its native child identity is supported. A successful delivery or `pending_init` state is not completion. An ordinary session launch remains an independent session. Grok keeps its existing subagent behavior.
- **Provider switching:** Changing the provider on an idle session clears `provider_conversation_id`, starts a new provider process with the capped transcript, and records a `session.provider-changed` marker.
- **Clear:** `/clear` in the session composer drops `provider_conversation_id`, writes a `session.cleared` watermark, and hides the existing transcript. The next message starts a fresh provider conversation in the same workspace. A running session is stopped first. Headless provider CLIs do not honor `/clear` as a prompt, so Argmax owns the command for every provider.
- **Forking:** `session:fork` creates a new session flagged with `resume_fork`. The next turn invokes the provider's fork flag (`--fork-session` for Claude and Grok, `exec fork` for Codex, `--fork` for OpenCode). Cursor does not support session forking.
- **Session moves:** An agent-requested move waits for the current turn to settle and copies the transcript into a fresh session at the destination. A cross-project move always clears `provider_conversation_id`. A move to another checkout of the same project carries it where the provider allows — see below. The first destination turn receives the handoff note, plus the capped transcript when the conversation did not travel.
- **Default agent:** one model and one reasoning effort for the whole app (Settings → Agents), not a per-project setting. A model that doesn't offer the chosen effort runs at Medium instead, and failing that at the nearest level it does offer — see `effortForModel` in [providerModels.ts](../src/shared/providerModels.ts). A fresh install starts on Opus 5 at Medium. The renderer owns the preference and mirrors it through `system:set-default-agent` so the sessions Argmax starts on its own (the PR check-failure fix chat) use it too.
- **Fast mode & reasoning effort:** Claude uses `--settings {"fastMode": ...}` and `--append-system-prompt` for effort (including Max/Ultra). Codex uses `-c service_tier="priority"` and `-c model_reasoning_effort=...` (Astra/Sol/Terra through ultra, Luna through max). Cursor encodes effort and fast mode into the model string (e.g. `gpt-5.6-sol-max-fast`). Grok takes `--reasoning-effort` and has no fast mode; its CLI accepts only low/medium/high/xhigh, so Max and Ultra clamp to xhigh.

### Session moves and the provider conversation

A move to another checkout of the same project is the same work continuing in a
different worktree, so it carries the provider conversation rather than starting
cold. Two provider facts have to hold at once, and only Claude and Codex have
both — `move_carries_conversation` in
[adapters.rs](../src-tauri/src/providers/adapters.rs) is the single place that
records which:

| Provider | Resume follows the new cwd | Can fork on resume | Carries |
|---|---|---|---|
| Claude | yes | `--fork-session` | yes |
| Codex | yes | `exec fork` | yes |
| Cursor | yes | no | no |
| OpenCode | **no** | `--fork` | no |
| Grok | **no** | `--fork-session` | no |

Grok and OpenCode keep executing in the directory their conversation started in
whatever `--cwd` / `--dir` says on resume, verified by resuming a session from a
second directory and having the agent report its own `pwd`. Carrying a
conversation for those two would leave the agent editing the old checkout while
the moved workspace, its diff, and its pull-request actions all describe the new
one. Cursor's resume does follow the new directory, but it has no fork flag, and
the move copies the transcript into a second session row — both rows resuming
one conversation would interleave two chats into it.

Where the conversation is carried, it is carried as a fork (`resume_fork`), for
that same reason: `--keep-source` leaves the origin chat live and resumable.

A cold start is not a lost transcript. The copied timeline travels either way,
and the destination's first turn opens with the capped transcript, so the chat
reads continuously whichever side of the table a provider is on.

## Cursor Warm ACP Runtime

The Cursor catalog starts with **Auto Cost (Cursor)**, **Auto Balance (Cursor)**,
and **Auto Intelligence (Cursor)**, below the picker's shared recent-model prefix.
Their model IDs are `auto-smart[optimize_for=cost]`,
`auto-smart[optimize_for=balanced]`, and `auto-smart[optimize_for=intelligence]`.
These bracket parameters were verified with live CLI requests on 2026-09-07,
even though `--list-models` only listed plain Auto. Auto has no manual reasoning
effort or Fast control. Billing retains the existing Cursor telemetry placeholder,
not an estimate of the routed model's actual cost.

Cursor's one-shot result usage contains billing totals across model calls, not
current context occupancy. Argmax keeps those totals for usage accounting but
does not derive context tokens from them. The composer hides the context ring
for all Cursor models, including sessions with previously saved context values.
ACP provides no token usage or context occupancy.

Chat launches run over Agent Client Protocol (ACP) against a pooled `cursor-agent acp` process ([cursor_acp.rs](../src-tauri/src/providers/cursor_acp.rs)).
- **Scope:** All Cursor models use ACP. A launch takes the configuration Cursor advertises for the requested model's family, whatever effort and Fast state that carries. Cursor lists exactly one variant per family, it does not follow the parameters saved in `cli-config.json`, and `session/set_model` rejects any id it did not list — so requiring an exact match rejected most of the catalog, the default model included. A family Cursor does not advertise at all still returns an error rather than silently changing models.
- **Turn lifecycle:** ACP notifications translate into standard Cursor stream events. Tool rows are named from `rawInput._toolName` to prevent sub-agents from collapsing into generic `other` tools.
- **Permissions:** Provider defaults preserves native permission rules. Full access launches a separate forced ACP pool and allows requests. Ask for approval forwards native requests to the chat, but Cursor actions already allowed by its rules may still run without prompting. Pools are isolated by permission mode.
- **Agent tools:** The `argmax` MCP server rides in `session/new` and `session/load` as an `mcpServers` entry, so the warm shared process still hands each session its own credential ([agent-tools.md](agent-tools.md)).
- **Cancellation & cleanup:** `terminate` cancels in-flight prompts. Workspace pool entries are evicted when isolated workspaces archive or are removed. The server runs in its own process group and teardown signals the group, so the MCP servers it started die with it.

## OpenCode

OpenCode chats use a dedicated authenticated localhost `opencode serve` process. Argmax subscribes to SSE before submitting the prompt and responds to native permissions through HTTP. Requests carry the workspace directory. The `run --format json` argument builder remains for restricted helper flows.
- OpenCode uses a SQLite store at `~/.local/share/opencode/opencode.db`. Discovery probes and title generation use temporary `XDG_DATA_HOME` directories to prevent database lock contention with active sessions.
- **Muse Spark 1.3 is free because it is a contributor SKU.** Meta trains on the prompts and completions it sees, which is what `-contributor-free` in its id means. Zen offers no non-contributor Muse 1.3. It is also the only free-tier model that takes `--variant`, so `opencode_variant_args` matches on the full id rather than the `opencode-go/` prefix; its ladder is low → xhigh (the CLI's `minimal` variant has no rung on Argmax's ladder, and Meta's `max` reasoning mode had not shipped as of the 2026-09-02 release).

## Grok Build

Grok Build chats use a pooled `grok agent stdio` ACP process, isolated by workspace and permission mode. ACP updates translate into the existing Claude-shaped normalizer events. Restricted helper flows retain the one-shot CLI described below.

- **It speaks Claude Code's wire format.** `system/init`, Anthropic `stream_event` content blocks, whole `assistant` messages, and a closing `result` are the same envelopes as `claude --output-format stream-json`. Grok therefore has no normalizer of its own: `speaks_claude_stream_json` in [normalizer/mod.rs](../src-tauri/src/providers/normalizer/mod.rs) routes it down Claude's path. The envelopes match; the content arrays do not always. Claude typically emits `[thinking, text, tool_use]`. Grok often interleaves many tiny thinking/text pairs in one snapshot (and inserts `server_tool_use` / `web_search_tool_result` for built-in search). `extract_content_blocks` concatenates those runs and treats server search as a tool boundary so the chat does not render each phrase as its own paragraph. If Grok ever forks the envelope types, the fixture test in that file is what fails.
- **The prompt must ride the `=` form.** `-p`/`--single` takes the prompt as a flag *value*, not the trailing positional Claude and Cursor use. Passed as two argv entries, the CLI rejects any prompt starting with `-` with a bare usage error — a pasted diff or a "- do this" bullet trips it. `--single=<prompt>` is the only form clap always reads as a value.
- **`--cwd` is passed explicitly** even though the child is already spawned in the worktree: with `[cli] use_leader` enabled the turn runs inside a shared leader process whose cwd is not the child's. Same trap OpenCode's `--dir` covers.
- **Repo-local MCP servers are gated on folder trust.** `grok inspect --json` reports `projectTrusted: false` for a checkout the user has never accepted, and the `.grok/config.toml` Argmax writes is ignored until it is true. A launch therefore records the workspace in Grok's own `trusted_folders.toml` and gives the entry back at the end ([agent-tools.md](agent-tools.md)).
- **Plan mode** maps to the bundled read-only `plan` agent (`--agent plan`, `permission_mode: plan`, no edit tools) rather than a prompt prefix.
- **Skills** come from `.grok/skills`, `.agents/skills`, and — by Grok's own compatibility rules — `.claude/skills`, plus `~/.grok/installed-plugins/<plugin>/skills` and the bundled cache at `~/.grok/bundled/skills`.
- **Pricing** is the `grok-4.6-build` / `grok-4.5-build` SKU rate, not xAI's published API list price. The rates in `MODEL_PRICING` were solved from the CLI's own `total_cost_usd` and reproduce it exactly; note 4.5 costs twice 4.6, so the default and title model both stay on 4.6.
- **Session sync is not supported.** Grok stores transcripts under `~/.grok/sessions/<percent-encoded-cwd>/<uuid>/` (`$GROK_HOME/sessions/…` when that variable is set), which is a lossless cwd mapping, but Argmax has no reader for it yet — the Settings toggle renders disabled.

## Subagent Activity

Subagent tool calls (`Task`, `spawn_agent`, `taskToolCall`) open an activity pane:
- **Claude:** Emits child events directly in the stdout stream with `parent_tool_use_id`. Tool calls are forwarded by default; a subagent's text and thinking blocks arrive only with `--forward-subagent-text` (Claude Code 2.1.258+), which the adapter passes on launch and resume, so a subagent that only writes still streams into the pane. Native Claude child identity is scoped by both the parent native conversation and child session id. A later `SendMessage` continuation is a separate run in the same dock, with lifecycle `task_started` and `task_notification` events kept separate from the delivery message. Claude also emits those lifecycle subtypes for background Bash jobs, so Argmax ignores starts explicitly typed as non-agent tasks and remembers their ids to reject the untyped notifications. Print mode runs with `CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS=0`. This removes Claude's ten-minute wait ceiling for background children, while the user's Stop action still terminates the provider process and its process group.
- **Codex:** Reads child JSONL traces from `~/.codex/sessions/YYYY/MM/DD` or `~/.codex/archived_sessions`. A child `session_meta.parent_thread_id` can recover a launch omitted from structured stdout.
- **Cursor:** Reads transcripts from `~/.cursor/projects/*/agent-transcripts/<agentId>/`. One-shot Cursor models support persistent native task references. The ACP-only `composer-2.5` path is intentionally excluded from native reference forwarding, even when a fallback would otherwise be available. Cursor's task result carries the authoritative child `agentId`; initial task arguments can contain a different id.
- **OpenCode:** Emits the `task` launch through structured stdout. Argmax has no separate OpenCode child-trace source.
- **Grok:** Does not stream child events on the parent PTY. `spawn_subagent` returns a launch receipt (`Subagent started in background` wrapped as `{"type":"Text","text":"..."}`); the child writes its own session under `~/.grok/sessions/<percent-encoded cwd>/<child-id>/chat_history.jsonl` (or under `$GROK_HOME` when set; Argmax resolves both the trust store and the session store through the same `grok_home`), linked from the parent's `subagents/<id>/meta.json`. Argmax imports that transcript on demand the same way it imports Codex and Cursor traces. The receipt is launch metadata, not the agent's answer.

`session:agent-events` fetches and parses trace files on demand. Parsed rows are saved with deterministic IDs (`trace:<provider>:<sessionId>:<parentToolUseId>:<childId>:<seq>:<kind>`) and hidden from the main chat view.

Trace recovery requires authoritative lineage. Argmax does not attach a transcript to a parent by time or repository alone. Claude and OpenCode stay stream-native. Cursor uses its streamed launch plus an agent ID or the existing prompt match. Codex may synthesize a launch from the child trace because the trace names its parent conversation directly. If the real Codex launch arrives later, reconciliation keeps the real row, reparents the imported child rows, and emits hidden tombstones that remove the synthetic row from open chats.

Initial session backfill and open agent panes run reconciliation off the main thread. Live agent-control events queue one serialized scan per session. A terminal provider event waits for the final serialized scan and includes its new launch or tombstone rows in the same dashboard delta, so completion cannot stop the renderer poll before recovery arrives.

## Measured File-Change Diffs

Codex reports a file write as a `file_change` item carrying a path and a kind (`add` / `update` / `delete`) and nothing else — no diff, no before/after, no line counts — on both `item.started` and `item.completed`. `codex exec` has no flag that adds one, and in auto-approve mode the approval path that would carry `fileChanges` never fires, so the chat had no line stat and no inline diff for a Codex edit. Claude and Cursor send edit content, so their stats come from the tool input as usual.

The provider stream can't be made to supply it either. Timed against a real run, `item.started` lands 0.4 ms before the write reaches disk and `item.completed` 1.4 ms after it, so there is no moment at which Argmax could read the file's "before" state on receiving an event.

[measured_diffs.rs](../src-tauri/src/providers/measured_diffs.rs) measures it from git instead, using [tree_snapshot.rs](../src-tauri/src/git/tree_snapshot.rs):

- **Mark at each turn boundary.** Every prompt send (launch, relaunch, and a live handle's follow-up) marks the worktree as a git tree object, written through a scratch `GIT_INDEX_FILE` so the user's index and worktree are untouched. Only already-dirty paths are staged (`git diff --name-only HEAD` plus `ls-files --others`); everything else matches the seed tree, which on a 1900-file repo is 140 ms instead of 570 ms. The mark is taken off the send path, since the agent's first write is a model round-trip away.
- **Re-mark per write.** A `command.completed` for a file change re-marks only the paths it reported, so `before → after` is that write's own diff. The mark then advances, which is what keeps two edits to one file two diffs instead of one counted twice — and keeps work that was already uncommitted when the turn began attributed to nobody.
- **Written back onto the tool row.** The measured diff goes into the tool's own `command.completed` payload as `unified_diff` per change entry, and the row is republished under its existing id and rowid. The renderer already reads a unified diff there, so the stat and the inline diff both come from one artifact and no new event type exists.
- **Absent on every failure.** No git repo, a lost mark, a path outside the workspace, a path that is no longer a file, a diff over 128 KB, or a turn that predates the feature: the row keeps its name and shows no stat. Deletions are skipped by design — the content never reached us. Nothing is backfilled for old sessions.
- Blobs and trees land in the repo's object database unreferenced, which `git gc` collects.

## Tool Event Identity

Provider tool IDs are local to a provider invocation and may repeat in a long session. The renderer pairs `command.started` and `command.completed` by the provider-native ID scoped with `payload.providerInvocationId`:
- Claude: `id` on `tool_use`, then `tool_use_id` on `tool_result`.
- Codex: item `id`.
- Cursor, including ACP: `call_id`.
- OpenCode: `call_id`.

Historical events without `providerInvocationId` use chronological unmatched-pair correlation. `ToolCall.toolUseId` keeps the raw provider ID because subagent parent-child linkage uses that value.

## Agent Session Control

Sessions can launch, list, message, and move other sessions, and drive Argmax's
own browser. Every provider gets those as tools on the `argmax` MCP server, and
every launch carries the same one-line instruction. The `argmax session …` CLI
still speaks the same socket from a terminal. See
[agent-tools.md](agent-tools.md) and
[ADR 0005](adr/0005-agent-tools-are-one-mcp-server.md).

## Default Model Selection

Defaults are configured in Settings → Agents → Default model (`localStorage.argmax.launch.model`). When unset, the app selects the highest priority installed provider:
1. Claude (Opus 5)
2. Codex (GPT-5.6 Sol)
3. Cursor (Grok 4.6)
4. OpenCode (GLM-5.3-Flash)
5. Grok Build (Grok 4.6)
6. Fallback: Big Pickle
