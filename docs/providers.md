# Providers

Argmax manages Claude Code, Codex, Cursor Agent, OpenCode, and Grok Build through Rust services in [src-tauri/src/providers](../src-tauri/src/providers).

## Architecture

- [adapters.rs](../src-tauri/src/providers/adapters.rs): Constructs CLI arguments for structured JSON modes. Centralizes auto-approve bypass flags.
- [environment.rs](../src-tauri/src/providers/environment.rs): Hydrates user login shell environment and PATH for spawned processes.
- [discovery.rs](../src-tauri/src/providers/discovery.rs): Detects installed provider binaries and versions.
- [cloud.rs](../src-tauri/src/providers/cloud.rs): Validates pushed GitHub branches, clones isolated launch checkouts, and builds bounded chat context.
- [claude_cloud.rs](../src-tauri/src/providers/claude_cloud.rs), [codex_cloud.rs](../src-tauri/src/providers/codex_cloud.rs), and [cursor_cloud.rs](../src-tauri/src/providers/cursor_cloud.rs): Discover provider environments and launch separate hosted tasks.
- [runtime.rs](../src-tauri/src/providers/runtime.rs): Selects native bidirectional transports for chats. Claude uses SDK control, Codex uses app-server, Cursor and Grok use ACP, and OpenCode uses HTTP/SSE. See [approval settings](approvals-checks.md). Legacy structured argument builders remain available for fixtures and restricted helper flows.
- [session_service.rs](../src-tauri/src/providers/session_service.rs): Orchestrates launch, resume, user input, resize, cancellation, and orphan recovery.
- [follow_up.rs](../src-tauri/src/providers/follow_up.rs): Composes the prompt a follow-up turn launches with. A session holding a native resume id sends the user's message alone because the CLI replays its own rollout. Without one, such as after a provider switch, the prompt carries a capped visible transcript: 12 messages, 12k chars, with child-agent rows excluded. A pending project handoff note rides along either way. Claude, Codex, OpenCode, and eligible Cursor native subagent references are resolved against the current parent conversation at delivery time.
- [orphan_cleanup.rs](../src-tauri/src/providers/orphan_cleanup.rs): Terminates lingering provider processes during startup recovery.
- [normalizer/](../src-tauri/src/providers/normalizer): Translates provider JSONL/stdout streams into normalized timeline events. Session sync replays transcript files through the same code, with `NormalizerSessionContext::for_transcript_replay` set: replay mode is what lets a `type:"user"` line become a `user.message`, since on live stdout such a line only ever carries a tool result. See [session-sync.md](session-sync.md).
- [flush_queue.rs](../src-tauri/src/providers/flush_queue.rs): Batches event writes to SQLite and emits `dashboard:delta`. Complete ordinary output shares a bounded ~25 ms persistence window per session. Newline-less fragments retain a short idle debounce so arbitrary PTY chunk boundaries stay intact. Approvals, permission blocks, errors, completion, process exit, and cancellation flush immediately.
- [subagent_trace/](../src-tauri/src/providers/subagent_trace): Imports trace-backed child activity and reconciles authoritative child lineage when a provider omits a launch row.
- [pricing.rs](../src-tauri/src/providers/pricing.rs): Token pricing models matching `src/shared/providerModels.ts`.
- [one_shot.rs](../src-tauri/src/providers/one_shot.rs): One-shot helper calls to a provider CLI, all on the cheap `PROVIDER_TITLE_MODEL` (`providerModels.ts`) with tools and config loading off. Two callers: short session titles (`workspaces:autotitle`) and the composer's suggested follow-up (`session:suggest-follow-up`). Claude uses `claude-sonnet-5-5 --effort low`; OpenCode stays on the free `opencode/big-pickle` model; Grok uses `grok-4.7` (the Grok Build SKU rate, cheaper than 4.5) with `--disallowed-tools` (an empty `--tools` allowlist is ignored), `--max-turns 1`, `--output-format json`, and a `{title}` JSON schema on the title path so a screenshot launch cannot land the "I'll glance at…" tool-loop preamble as the sidebar label.

The title prompt frames the launch prompt as data addressed to a *different* agent, because the helper has none of the session's tools: a prompt like "read this Notion page and answer her questions" otherwise reads as a question put to the titler, which answers it. That framing is a nudge, not a guarantee, so `sanitize_title` is the gate that holds for all five providers — it sits after each provider's answer extraction, scans line by line so a "Here's the title:" preamble costs only its own line, and rejects any line that opens conversationally or runs past twelve words. A rejected answer leaves the renderer's prompt-derived label (`titleFromPrompt`) in place rather than pinning a truncated refusal to the sidebar.

Raw provider output is saved for debugging, but only normalized timeline events are displayed in chat. The persisted payload stays compatible with existing rows and provider fixtures. The renderer decodes it once through [canonicalTimeline.ts](../src/renderer/lib/canonicalTimeline.ts), then routes behavior from the resulting typed event instead of reading semantic payload keys in each feature.

Goals work on every provider: the evaluator is a one-shot call Argmax makes
itself rather than a provider capability. See [goals.md](goals.md).

## Cloud tasks

Argmax can start a hosted task with Claude, Codex, or Cursor from the launch
composer or send an existing chat to its provider's cloud. Composer launches use the
registered project's repository checkout and the composer prompt as the task
brief. Active-chat launches send a bounded visible transcript; it
excludes tool payloads, raw provider output, and child-agent rows.
`cloud:prepare` builds that brief and closes it with one instruction: the text
after `/cloud` when there is one (the optional `instruction` input, accepted
only for a chat), or a fixed "continue this task" line otherwise. The dialog
launches that brief as returned and shows the full text behind a disclosure. Both paths
require a GitHub branch whose local `HEAD` matches the branch on `origin`.
Uncommitted work stays in the local checkout, while unpushed commits must be
pushed before launch. Neither is uploaded implicitly. The
selected provider is retained. The hosted service chooses its cloud model,
so the local model and reasoning settings are not advertised as cloud settings.

### Claude Cloud

Setup stays in Claude Code and git. Sign in to a first-party Claude Code
account with cloud access, use `/remote-env` to select a hosted environment,
and make sure the local machine can fetch the repository's GitHub origin.
Argmax uses those existing credentials and settings. Its bundle handoff does
not require the Claude GitHub App to be installed for the repository; direct
GitHub clone and push workflows inside the hosted session still do.

Launch revalidates the checkout, clones the remote branch into a temporary
directory, verifies its source commit, and runs `claude --cloud` there. It uses
`--safe-mode`, forces the repository bundle path, and passes the hosted
environment ID currently selected in Claude Code settings. Argmax does not
store a personal environment ID. Claude Cloud can create a synthetic commit
from that bundle, so the cloud checkout's `HEAD` may differ from the source
commit shown in the handoff dialog even though its contents came from that
verified revision.

This integration is version-sensitive. It was verified with Claude Code
2.1.278 and currently relies on that CLI's `--cloud` command plus its internal
`CCR_FORCE_BUNDLE=1` switch. Reverify the launch path when upgrading Claude
Code.

### Codex Cloud

Sign in to the Codex CLI with a ChatGPT account and configure a cloud
environment for the repository at chatgpt.com/codex. Preparation reads the
CLI's file-backed ChatGPT credentials and discovers environments associated with the
selected GitHub repository. A single matching environment is selected
automatically. If there are several, choose one in the review dialog.
Argmax rechecks that association before launching, rather than storing a
personal environment ID or accepting an environment from another repository.

Launch runs in an isolated temporary checkout and uses `codex cloud exec --env <id> --branch <branch> --attempts 1`
with the task brief passed as a positional argument after `--`. Codex resolves
the branch remotely. The reviewed commit is the verified branch tip at
submission, not a guarantee against a subsequent remote branch update.
Environment discovery uses the same version-sensitive ChatGPT backend route
as the Codex CLI's cloud task browser. Reverify it when upgrading Codex.

### Cursor Cloud

Provide `CURSOR_API_KEY` through the shell credential setup or the `keys-sync`
cache and grant Cursor access to the repository. Argmax checks its hydrated
login-shell environment first, then reads only the Cursor key from
`~/.local/share/dotfiles/agent-secrets.json`. The cache must be a regular,
non-symlink file owned by the user with mode `0600`. Preparation checks the
Cloud Agents API and repository access. Cursor uses the repository's hosted
environment setup, so there is no separate environment ID to select.

Launch calls the Cursor Cloud Agents API with the GitHub repository and
verified commit SHA. Automatic pull request creation and work on the current
branch are disabled. Cursor's local ACP connection is separate from this API.

### Results

The new cloud conversation is not synchronized back into Argmax. A successful
handoff writes a provider-named hosted link as a `session.note`. A launch
from the composer returns the hosted link directly and does not create a local
session or agent. A timeout or an exit without a link is reported as
delivery-unknown and is never retried automatically because the billable cloud
session may already exist.

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

## Connections

Model Context Protocol (MCP) servers are configured in each provider's native CLI or config files:
- **Claude Code:** `claude mcp add <name> -- <command>` or `/mcp` in interactive sessions.
- **Codex:** `codex mcp add <name> -- <command>` or `~/.codex/config.toml`.
- **Cursor:** Settings > Tools & MCP or `~/.cursor/mcp.json`.
- **OpenCode:** `opencode mcp add` or `~/.config/opencode/opencode.json`.
- **Grok Build:** `grok mcp add <name> -- <command>` or `~/.grok/config.toml`.

Spawned sessions run in the workspace worktree. Project-scoped `.mcp.json` or `.cursor/mcp.json` files must be committed to git to appear inside isolated worktrees.

Argmax adds one server of its own per launch — `argmax`, the agent tools — through each provider's per-launch mechanism, without disturbing the user's configured servers. For Cursor's one-shot path and for Grok that mechanism is a config file written into the workspace and put back when the child exits; a `.cursor/mcp.json` the user keeps is merged, never replaced ([agent-tools.md](agent-tools.md)).

The provider-facing prompt also carries a short routing instruction before the
user's text. It tells every provider to discover and use Argmax MCP tools for
Argmax-owned operations instead of generic UI automation, even when the MCP
client defers the server instructions or tool schemas. Provider-native slash
commands keep `/` at byte zero so the CLI can expand them. Argmax persists the
original user text, and strips the routing prefix when importing provider
transcripts, so the instruction does not appear in chat.

Codex sessions also receive ChatGPT's app-managed `cua_repl` server when the
`computer-use@openai-bundled` plugin is enabled and its
`unified-computer-use` runtime is present in the Codex plugin cache. This makes
the Computer Use tools available in Argmax without replacing the user's Codex
MCP configuration. ChatGPT installs and updates that runtime, so Argmax leaves
Codex unchanged when the plugin is disabled or the runtime is unavailable.

Customize → Integrations → Connections calls `connections:list` for a provider. `/mcp` opens the same inventory for the selected or active provider. The inventory includes MCP servers, installed plugins, and provider connectors when the provider reports them. Claude and OpenCode health-check their servers, so Argmax can show **Connected** or **Needs login**. Other providers often expose configuration without token validity, which Argmax shows as **Unknown**. A local stdio server is **Available** because it does not use a separate MCP OAuth login.

Authentication stays with the provider. A connection row can copy the provider's login command or settings route when one exists. Argmax does not read, store, or broker provider OAuth tokens.

*Codex connectors note:* `codex exec` runs without ChatGPT desktop app connectors (Notion, Linear, Google Drive). Use direct remote MCP URLs via `codex mcp add --url <url>` instead.

### Optional Engram setup

Settings → Integrations → Engram guides users through connecting an existing
[Engram installation](https://github.com/adamthuvesen/engram#run-it). Enter its
absolute installation path and choose a provider to generate a native MCP
command or configuration snippet. Run the command in a terminal, or merge the
snippet into the provider's existing configuration. Refresh Connections and
start a new chat with that provider to use its memory tools.

Engram is optional and separately installed. Argmax does not install it, store
its credentials, or write provider configuration through this guide. The setup
uses user-scoped connections, so it applies to the provider outside Argmax too.
Remove or disable the connection through the provider's own MCP settings.

Agents retrieve Engram memories through tool calls. Connecting it does not
automatically inject memories into every chat. Use project-scoped recall and
verify changeable claims against current code or sources. Argmax's built-in
project learnings remain separate (see [memory.md](memory.md)).

## Session Lifecycle and Follow-ups

An idle follow-up persists the user message and returns, then spawns the provider in the background. The PTY/CLI spawn does not block the send IPC.

While a turn is running, ordinary input stays queued. A queued follow-up has
**Steer** for Codex, Claude and OpenCode and **Stop and send** for explicit interruption.
Both use `providers:send-queued-message-now`, with optional `delivery: "steer"`
selecting guidance for the existing turn. Omitting delivery preserves interruption.
Codex uses app-server `turn/steer` with `expectedTurnId`. Claude writes a user
envelope to its existing stream-json connection; the flushed write is the
acknowledgement. OpenCode posts the text to `prompt_async` on the session its turn is already
running; the HTTP acknowledgement is the acknowledgement. None of the three
starts a replacement process. Cursor and Grok run over ACP, whose only mid-turn
request is `session/cancel`, so they have no Steer.

**OpenCode reads guidance at its next step, and the 204 comes before the store.**
OpenCode keeps one run per busy session and re-reads the conversation at every
step, so a message stored mid-run is answered by that run once the current tool
call ends. `prompt_async` returns before the message is stored, though, so the
run can go idle without it; OpenCode then starts a new run for the message. The
server stays up until every acknowledged message has been seen
(`message.updated`, role `user`) and the newest one answered, re-checking a
deferred idle every 3 seconds for up to 30. A message stored in the moment
between the run's last check and its end is never answered: the turn closes and
the chat shows an error asking to send it again. See `Steering` in
[opencode_server.rs](../src-tauri/src/providers/opencode_server.rs).

Claude's `--replay-user-messages` echo is *not* the acknowledgement. Claude
replays a steered message only when it picks it up, and a turn inside a long
tool call holds that for minutes, so waiting on the echo reported delivered
guidance as delivery-unknown. The echo is still tracked: the reader withholds
the turn's `result` until Claude has consumed every written follow-up, and the
replayed copy is suppressed because Argmax already persisted that user message.
Echo matching accepts Claude's expanded slash-command envelope when its command
and complete arguments match the pending prompt. Comparing only literal prompt
text leaves commands such as `/review` unacknowledged and discards their final
`result`, keeping the chat running after its answer.
A follow-up that never reached stdin — the turn closed first, or Claude had not
taken up the turn's first message yet (`STEER_NOT_READY`) — is unsent, not
uncertain.

**Codex's `turn/steer` ack is not one during a compaction.** Codex decides
whether to rewrite its context *before* it ingests the turn's own input: the
thread emits a `context_compaction` item, nothing else for as long as it runs
(two minutes on a large thread), and only then the `userMessage` item that
proves the prompt arrived. A steer inside that window is acknowledged and
dropped — the text appears nowhere in the thread's rollout — so
[codex_app_server.rs](../src-tauri/src/providers/codex_app_server.rs) refuses it
with `STEER_CONTEXT_COMPACTION` and the row stays queued. The same window
swallows a whole turn: a Stop before the `userMessage` item leaves a chat
showing a message the model never read, so `ProviderRuntimeHandle::input_delivered`
reports it and the session service writes a `session.note`
(`turn.input-undelivered`) after the cancellation row. Every other transport
writes the prompt on the way in and reports delivered.

Steering inherits the running turn's settings. A queued change to model or
reasoning effort must wait for another turn. Accepted guidance is persisted
as `user.message` with `payload.delivery: "steer"`, without resetting turn timing
or provider normalization. Failures restore the queued message in a paused state.
An uncertain acknowledgement is marked delivery-unknown and must not automatically
retry. Stop can still cancel the running provider while steering is pending.
An inbox-backed message is claimed before steering so `inbox_read` cannot deliver
it again while acknowledgement is pending. Definite rejection releases that claim.
Messages from other sessions steer automatically on the same path, and a definite
rejection returns them to the ordinary queue rather than leaving them unsent (see
[agent-tools.md](agent-tools.md#the-inbox)).

The ignored `live_codex_turn_consumes_steering_without_cancellation` and
`live_claude_turn_consumes_steering_without_cancellation` Rust tests verify the
installed CLIs. Each sends guidance during a tool call and checks that the same
process consumes it. Run them explicitly with `cargo test --manifest-path
src-tauri/Cargo.toml --lib live_codex_turn_consumes_steering -- --ignored` (substitute
`live_claude_turn_consumes_steering` for Claude). They use the developer's provider
account and a temporary project.

- **Startup cleanup:** Sessions left in `running`, `waiting`, or `blocked` states are marked failed on startup. Matching background provider processes are terminated and pending approvals cancelled.
- **Stop wins over an in-flight send:** Each send captures a per-session generation before its database work. Stop advances that generation before teardown, so a send that began earlier cannot persist a new user turn or spawn a replacement process after cancellation finishes.
- **Follow-up prompts:** Follow-up turns use the provider resume ID when available, without repeating its transcript. A referenced Claude, Codex, OpenCode, or eligible Cursor dock name adds a validated name-to-child-ID mapping. Fresh conversations receive a capped transcript of visible `user.message`, `message.completed`, and `error` events. Hidden subagent rows are excluded.
- **Native Claude, Codex, OpenCode, and Cursor subagents:** A persistent child stays addressable through its parent native conversation and can appear as multiple runs in one dock tab. Claude uses `SendMessage`. Codex uses `send_input`, with `resume_agent` when the child needs revival. OpenCode invokes its native `task` tool with the existing `task_id`. Cursor uses ACP `task` events and the authoritative child id from the completed result. Composer 2.5 child references remain excluded until its native child identity is supported. A successful delivery or `pending_init` state is not completion. An ordinary session launch remains an independent session. Grok keeps its existing subagent behavior.
- **Provider switching:** Changing the provider on an idle session clears `provider_conversation_id` and the previous model's reported `context_window`, starts a new provider process with the capped transcript, and records a `session.provider-changed` marker. Occupancy stays until the new provider reports; the context ring uses the new model's catalog window in the meantime. Changing model on the same provider likewise drops a reported window that belonged to the old id.
- **Clear:** `/clear` in the session composer drops `provider_conversation_id`, writes a `session.cleared` watermark, and hides the existing transcript. The next message starts a fresh provider conversation in the same workspace. A running session is stopped first. Headless provider CLIs do not honor `/clear` as a prompt, so Argmax owns the command for every provider.
- **Forking:** `session:fork` creates a new session flagged with `resume_fork`. The next turn invokes the provider's fork flag (`--fork-session` for Claude and Grok, `exec fork` for Codex, `--fork` for OpenCode). Cursor does not support session forking.
- **Session moves:** An agent-requested move waits for the current turn to settle and copies the transcript into a fresh session at the destination. A cross-project move always clears `provider_conversation_id`. A move to another checkout of the same project carries it where the provider allows — see below. The first destination turn receives the handoff note, plus the capped transcript when the conversation did not travel.
- **Default agent:** one model and one reasoning effort for the whole app (Settings → Agents), not a per-project setting. A model that doesn't offer the chosen effort runs at Medium instead, and failing that at the nearest level it does offer — see `effortForModel` in [providerModels.ts](../src/shared/providerModels.ts). A fresh install starts on Opus 5 at Medium. The renderer owns the preference and mirrors it through `system:set-default-agent` so the sessions Argmax starts on its own (the PR check-failure fix chat) use it too.
- **Fast mode:** The model catalog explicitly marks eligible models. The picker offers the Fast mode row and shows the Fast indicator only for those entries, and launch and follow-up requests gate the saved preference by that eligibility. Eligible today: Codex Astra, Sol, Terra, and Luna (`serviceTier: "priority"` per turn), Grok 4.7 (`grok-4.7-build-fast` on ACP and the CLI), Claude Opus 5.5 (`"fastMode": true` in `--settings`, twice the price), and every Cursor model whose ACP config has a `fast` option (Composer 2.5, Grok 4.7, GPT-5.6 Sol/Terra/Luna, Opus 5.5; not Gemini 3.8 Flash or Auto). Availability depends on the provider account. OpenCode has none. [Claude's documentation](https://code.claude.com/docs/en/fast-mode) limits Fast to Opus 5.5, 5 and 4.8 and says enabling it on another model switches to Opus, so the rest of the Claude catalog stays ineligible. Unknown models default to ineligible. The picker's control is the **Fast mode** row at the foot of the list (Off / On); it is not called Speed because that names a Router tier. [Codex's speed documentation](https://learn.chatgpt.com/docs/agent-configuration/speed) covers Astra and the GPT-5.6 family.
- **Reasoning effort:** Claude gets the CLI's `--effort` flag (low → max; Ultra clamps to max, the flag's ceiling). The appended system prompt never varies with effort, while cache reuse still depends on the model and endpoint below. Codex app-server receives the effort per turn (Astra/Sol/Terra through ultra, Luna through max). Cursor ACP sets it as the model's `thought_level` config option, described below. Legacy CLI builders retain Codex's `service_tier` and `model_reasoning_effort` overrides and Cursor's effort and `-fast` model suffixes for helper flows. Grok's CLI accepts only low/medium/high/xhigh, so Max and Ultra clamp to xhigh.
- **Context window:** Claude's 1M models launch on the `[1m]` spelling of their id (`claude-opus-5-5[1m]`, `claude-opus-5[1m]`, `claude-fable-5-1[1m]`), since the CLI only resolves a bare id's window through a first-party lookup — behind a custom `ANTHROPIC_BASE_URL` it assumes 200k and auto-compacts there, a fifth of the way into the advertised window. The suffix rides on the launch flag alone; the CLI reports the bare id back, so usage and pricing are unchanged. The catalog's `contextWindow` decides which ids get it (`CLAUDE_LONG_CONTEXT_MODELS` in [adapters.rs](../src-tauri/src/providers/adapters.rs)).

### Follow-up cache boundaries

Argmax chooses a model and effort between turns. A native conversation ID
preserves the provider's history, but does not prove that a server-side prompt
cache entry survived. A cache miss can leave an earlier matching prefix alive,
so returning from model B to model A may reuse A's prefix if it is still
available. No idle duration proves that a switch is free.

- **Codex:** Each turn starts a new app-server process, resumes the durable
  thread, and sends the selected model and effort in `turn/start`. Codex
  0.156.1's `reasoning_effort_override` is an opt-in development feature;
  Argmax does not enable it, though the user's Codex configuration still
  applies. A request-level effort change has no established
  cache-preservation guarantee. The public GPT-6
  `configuration_update` mechanism requires a stable request-level effort and
  compatible history handling around compaction and truncation. Those API
  rules alone do not establish the behavior of Codex app-server on resumed
  turns. [App-server protocol](https://learn.chatgpt.com/docs/app-server),
  [reasoning updates](https://developers.openai.com/api/docs/guides/reasoning#change-reasoning-mid-conversation),
  [prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching).
- **Claude Code:** The resumed control process receives `--model` and
  `--effort` again. Claude Code documents cache-preserving effort changes on
  Opus 5.5 and Fable 5.1 with an API key or Claude subscription, subject to
  its listed platform, gateway, beta, and HIPAA exclusions. Other effort
  changes can reset the cache. A model switch starts a model-specific cache.
  The main conversation may use a one-hour TTL within subscription usage and
  five minutes under API-key or usage-credit billing; custom settings can
  change it. [Claude Code caching](https://code.claude.com/docs/en/prompt-caching).
- **Cursor:** ACP resumes a session and sets its model and thought-level
  options. Cursor documents a cache miss on model switches; it makes no
  corresponding guarantee for ACP effort changes. Argmax lacks native Cursor
  token-usage accounting for cache reads. [Cursor harness](https://cursor.com/blog/continually-improving-agent-harness).
- **OpenCode:** Its native HTTP transport resumes the session and sends the
  selected model and variant with the next prompt. OpenCode Go recommends a
  stable session identifier for routing and caching, but does not guarantee
  cache reuse after a variant change. The underlying service determines cache
  behavior. [OpenCode Go](https://opencode.ai/docs/go/).
- **Grok Build:** ACP loads the session and sets the model and reasoning mode.
  xAI describes stable conversation routing and possible eviction for its API,
  but does not specify an ACP cache contract for these changes. The provider
  reports cache-read and cache-write tokens when available.
  [xAI caching](https://docs.x.ai/developers/advanced-api-usage/prompt-caching/best-practices).

The provider tests check selected settings for effort down → back and model
A → B → A sequences. The Codex fixture additionally starts a fresh process
each turn, resumes the thread, and emits a compaction notification. These
fixture assertions cover selected wire parameters when run; they do not
measure cache reuse or model compliance. A live cache check must record cached and
uncached input tokens, writes, latency, and cost for unchanged, effort-down,
effort-back, and model A → B → A turns, including resume and compaction.

### The agent's todo list

Every provider can publish a plan and each does it differently; the normalizer
reduces all five to one `todo.updated` event. The shapes, the known gaps,
and the `surface: "todo"` stamp that hides the rows are documented in
[chat-cards.md](chat-cards.md). One provider-launch consequence lives here:
**Codex's `update_plan` is off unless asked for.** Both the app-server args in
[codex_app_server.rs](../src-tauri/src/providers/codex_app_server.rs) and the
`exec` argv in [adapters.rs](../src-tauri/src/providers/adapters.rs) pass
`-c tools.update_plan.enabled=true`; without it Codex is told the tool does not
exist. The app-server reports the plan through `turn/plan/updated`, not through
an item lifecycle, and that notification carries a real `inProgress` the `exec`
projection throws away. Each `turn/start` also carries trusted application
context telling Codex to publish a completed step before starting the next one.
Argmax never infers completion from prose because only the provider knows
whether a plan step is actually done.

**Codex searches the live web.** Codex 0.156 defaults `web_search` to
`cached`, which answers from an index rather than fetching the page. Both launch
paths pass `-c web_search="live"`, which overrides the user's own
`~/.codex/config.toml` for this key. Grok needs no equivalent: its `web_fetch`
tool is on by the server-side `web_fetch_enabled` setting (Grok 1.0.41).

**Claude's task tools are off for current models too.** Claude Code 2.1.282
enables `TaskCreate` / `TaskUpdate` only for the 4.x models (and background
jobs); Opus 5.5, Opus 5 and Fable 5.1 get them only with
`CLAUDE_CODE_ENABLE_TODO_TOOLS=true`, which the inline `--settings` env in
[adapters.rs](../src-tauri/src/providers/adapters.rs) sets. Without it the
session's `init` lists only `Task` and `TaskStop`, and no todo card ever
appears.

### Questions the agent asks the user

The question card is documented in [chat-cards.md](chat-cards.md). Claude,
Cursor, Codex, and OpenCode questions reach it.

**Codex's `request_user_input_async` reaches the question dock.** Codex 0.154.0
delivers it as an `agent_message` item with `delivery: "async"` and structured
`questions`. The normalizer converts titles and string options to the existing
`AskUserQuestion` card format. Start and completion keep the same item ID, so
the immediate tool acknowledgement leaves one answerable card. The answer uses
the existing next-user-message flow. Question shapes outside the card's one to
four options remain visible as prose.

**Native `request_user_input` follows Codex's `isBlocking` flag.** The
app-server launch enables `tools.experimental_request_user_input.enabled=true`.
`item/tool/requestUserInput` is a server request, and a blocking one waits for
its answer: Argmax keeps its JSON-RPC response open and publishes a question
card with the request and question IDs. Desktop and iPhone submit structured
answers through `questions:resolve`, which resumes the same turn. Dismissing
sends an empty answer map.

A nonblocking request is published as an async question card and answered
straight away with an empty answer map, so Codex can keep working. Answering
one uses the next-user-message flow shared with `request_user_input_async`.

Pending blocking cards are stored in the timeline and return after a UI
reconnect. Answered, dismissed, and cancelled requests settle the card, and
duplicate or stale answers fail. Answer values are not persisted in the
question events, including answers to secret questions. The launch flag and
protocol remain experimental, so verify their schema when upgrading Codex.

**Cursor's `cursor/ask_question` is a blocking question too.** Cursor sends it
as an ACP extension request, `{toolCallId, title?, questions: [{id, prompt,
options: [{id, label}], allowMultiple}]}`, and waits for the response. The
params name no session, so [acp.rs](../src-tauri/src/providers/acp.rs) finds
the chat from the `tool_call` update that opened `toolCallId`, and
[cursor_acp.rs](../src-tauri/src/providers/cursor_acp.rs) publishes the same
blocking card Codex's `request_user_input` uses. An answer goes back as
`{outcome: {outcome: "answered", answers: [{questionId, selectedOptionIds}]}}`,
with the picked labels mapped back to Cursor's option ids. Dismissing sends
`skipped`, and a turn that ends first sends `cancelled`; Cursor reports both to
the model as a rejected question. A question Argmax cannot show, or cannot
place in one chat, is `skipped` with a reason telling the model to ask in
prose. Cursor 2026.09.23 does not offer the tool to ACP clients at all, in
agent or plan mode, so this path was verified against the CLI bundle's own
handler rather than a live turn.

**MCP elicitations are declined until Argmax has a general form surface.** An
app or MCP server can send `mcpServer/elicitation/request` for structured input
or a URL flow such as connector reauthentication. Argmax returns the protocol's
`decline` response instead of a method-not-found error. The associated tool
result remains visible with its actionable failure, while the redundant
app-server diagnostic is suppressed in current and historical transcripts.

**Grok ACP has no `assistant` envelope of its own, so the bridge writes one per answer burst.** Its answers arrive as `agent_message_chunk` updates, which [grok_acp.rs](../src-tauri/src/providers/grok_acp.rs) forwards as `text_delta`. When a thought, a tool call, or the end of the turn closes a burst, `close_answer` sends the burst's text verbatim as the whole-message `assistant` envelope Claude sends after each text block, and that becomes the burst's `message.completed`. The completion is required. The cursorless session backfill keeps every durable row but only the newest page of deltas ([events.rs](../src-tauri/src/persistence/events.rs)), so an answer stored only as deltas disappeared from every turn except the last few when the chat was reopened, and the turn showed only its steps. Chats recorded before this change still hold delta-only answers. An answer delta, never a `thinking_delta`, also arms the same turn-answer guard Claude's `message.completed` arms ([normalizer/mod.rs](../src-tauri/src/providers/normalizer/mod.rs)). The trailing `result` speaks only when no answer streamed. Otherwise it stays silent instead of repeating every burst as one concatenated bubble at the end of the turn.

**Grok's `ask_user_question` is not exposed over ACP.** The binary carries the
tool and documents it, and `features.ask_user_question` defaults to true, but
over `grok agent stdio` — the only transport Argmax uses — Grok reports the tool
is unavailable and answers in prose, under every permission mode and with
`GROK_ASK_USER_QUESTION` set. Its `enter_plan_mode` / `exit_plan_mode` do arrive
as ordinary ACP tool calls, so the gap is specific to the question tool. Asking
Grok to recite its own tool list is not a check: it claims the tool and then
cannot call it.

**OpenCode's `question` tool blocks its run until the card is answered.**
OpenCode 1.18.32 registers the tool when `OPENCODE_CLIENT` is `app`, `cli`, or
`desktop`, or when `OPENCODE_ENABLE_QUESTION_TOOL` is set. `opencode serve`
leaves the client at its `cli` default, so every Argmax chat has the tool.
(`opencode acp` sets `acp` and drops the tool, and `opencode run` denies it
on the sessions it creates by default.) The call emits `question.asked` on the event stream and waits.
[opencode_server.rs](../src-tauri/src/providers/opencode_server.rs) passes the
request to the same pending-question service as Codex's blocking
`request_user_input`. OpenCode's questions carry no ids, so their position
names them (`q1`, `q2`, ...). `multiple` becomes the card's multi-select and
`custom` (default true) becomes its free-text choice. An answer goes to
`POST /question/{id}/reply` as one list of labels per question (typed text
without the dock's `user_note: ` marker), and the tool returns the answers to
the model within the same turn. A dismissal goes to `/question/{id}/reject`,
which fails the tool with "The user dismissed this question" and ends
OpenCode's run. A request the card cannot hold (more than three questions, more
than four options, or an empty option description) is answered with the reason
and a request to ask in prose, as Cursor's is, so the turn goes on instead of
failing. The tool's own row lands after the card closes and carries the answer
text. The tool raises no `permission.asked` under Ask for approval.

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
effort or Fast control; its `optimize_for` is set as an ACP config option. Billing retains the existing Cursor telemetry placeholder,
not an estimate of the routed model's actual cost.

Cursor's one-shot result usage contains billing totals across model calls, not
current context occupancy. Argmax keeps those totals for usage accounting but
does not derive context tokens from them. The composer hides the context ring
for all Cursor models, including sessions with previously saved context values.
ACP provides no token usage or context occupancy.

Chat launches run over Agent Client Protocol (ACP) against a pooled `cursor-agent acp` process ([cursor_acp.rs](../src-tauri/src/providers/cursor_acp.rs)).
- **Scope:** All Cursor models use ACP. `initialize` declares `clientCapabilities._meta.parameterizedModelPicker`. Without it Cursor lists one preset variant per family (`composer-2.5[fast=true]`), rejects every other, and ignores the app's and `cli-config.json`'s preferences, so the chat's effort and Fast never applied. With it the model is a bare id (`session/set_config_option` `model`), and the answer lists that model's own options. Argmax then sets the effort option (`effort`, `reasoning_effort` or `reasoning`, all category `thought_level`; the nearest offered level, `xhigh` or `extra-high`), `fast` from the chat's Fast mode, and Auto's `optimize_for` from the catalog id. It leaves Claude's on/off `thinking` switch and `context` at Cursor's defaults. A chat with no effort keeps Cursor's default. A family Cursor does not advertise at all still returns an error rather than silently changing models.
- **Turn lifecycle:** ACP notifications translate into standard Cursor stream events. Each translated line carries the native ACP session id, which lets completed task rows link child-agent runs to their provider parent. Tool rows are named from `rawInput._toolName` to prevent sub-agents from collapsing into generic `other` tools.
- **A tool row waits for the update that names it.** Cursor opens *every* tool call nameless — `{"title":"Edit File","kind":"edit","rawInput":{}}` — and fills in `rawInput` and `locations` one `tool_call_update` later. Drawing the row from the opening line froze those empty arguments onto the transcript, which is why an edit read as "Edited file" with no path, no diff, and no place in the changed-files card. A bare `status: in_progress` still draws nothing, since it says nothing about what the tool is; a completion draws the row regardless, because after it nothing more is coming.
- **A write's diff is computed from the pair Cursor sends.** ACP reports a completed write as `content: [{type:"diff", path, oldText, newText}]`, and both sides are the file's *whole* text. A one-line change to a 60-line file arrives as 60 lines each way. `unified_diff` in [unified_diff.rs](../src-tauri/src/providers/unified_diff.rs) reduces the pair to hunks with git's own three lines of context, and the result rides the tool's arguments as `unified_diff`, where the chat's file-change card reads it. Passing the pair through instead would have reported every line of the file as rewritten, `+60 −60` included. Two of Cursor's own markers are decoded on the way: a create arrives as unified-diff header lines with one marker character eaten (`oldText` is the literal `-- /dev/null`, `newText` opens with `++ b/<path>`), and a delete reports the removed path as its own `oldText` with an empty `newText`. These rows also carry an explicit create or delete operation, so an empty-file create and a contentless delete still reach the changed-files card. A diff past 128 KiB is a rewrite and is dropped, leaving the path without a stat.
- **Permissions:** Provider defaults preserves native permission rules. Full access launches a separate forced ACP pool and allows requests. Ask for approval forwards native requests to the chat, but Cursor actions already allowed by its rules may still run without prompting. Cursor's question tool arrives as its own `cursor/ask_question` request and reaches the question dock; a permission request whose options carry more than one `allow_once` is that tool's fallback rather than a permission, and is declined instead of shown — see [approvals-checks.md](approvals-checks.md). Pools are isolated by permission mode.
- **MCP servers:** Cursor stores user-MCP OAuth grants against the ACP process's launch directory rather than `session/new.cwd`. Argmax therefore starts every Cursor ACP process from the user's home directory, giving all Argmax Cursor chats one Cursor-owned authentication scope; authenticate a user MCP once with `cd ~ && cursor-agent mcp login <name>`. The session still works in its checkout. Argmax passes Cursor-approved entries from the checkout's `.cursor/mcp.json` through `session/new` / `session/load` beside its per-session `argmax` server, and starts project stdio servers in that checkout so relative paths retain their meaning. Approve a project server with `cursor-agent mcp enable <name>` from the checkout, and authenticate a project-only remote server there too. Unapproved project servers remain unavailable, matching Cursor's trust gate. If a project server uses configuration ACP cannot represent exactly, Argmax keeps Cursor's native per-checkout launch and logs that the separate checkout login is still required rather than silently dropping fields. The pool fingerprints global and project config, project approvals, and the names holding grants in the active scope, so configuration, approval, or completed login reaches the next chat while token refresh alone does not churn a warm process.
- **Cancellation & cleanup:** `terminate` cancels in-flight prompts. Workspace pool entries are evicted when isolated workspaces archive or are removed. The server runs in its own process group and teardown signals the group, so the MCP servers it started die with it. Cursor's shell keeps its cwd in that warm process. After a shell there has returned output, a later shell that completes with no result replaces the process on the next launch: the cwd was deleted out from under it, Cursor reports the command completed and omits `rawOutput`, and the process would otherwise keep spawning into the missing directory. That is the failure an agent reads as a broken shell and routes around by typing into the integrated terminal.

## OpenCode

OpenCode chats use a dedicated authenticated localhost `opencode serve` process. Argmax subscribes to SSE before submitting the prompt and responds to native permissions through HTTP. Requests carry the workspace directory. The `run --format json` argument builder remains for restricted helper flows.
- **File changes:** `edit` sends `filePath`, `oldString`, and `newString`. `write` sends `filePath` and `content`. The renderer builds an inline diff from those values and includes the path in the changed-files card. Replacement strings are snippets, so their synthetic diff hides line numbers rather than claiming the change starts at line 1.
- **Plan mode stays off.** `OPENCODE_EXPERIMENTAL_PLAN_MODE=true` (honored only for client `cli`) adds `plan_exit` and no other tool: OpenCode 1.18.32 has no `plan_enter` tool, and Argmax never selects the `plan` agent. OpenCode's defaults deny `plan_exit` outside that agent, but Argmax's inline `permission` override (`allow` / `ask`) re-allows it for `build`. Verified live: the build agent calls it, and its Yes/No question arrives through the question card. A Yes then injects a synthetic "The plan at .opencode/plans/<file>.md has been approved... Execute the plan" message pointing at a file that was never written, and the agent spends the turn searching for it.
- OpenCode uses a SQLite store at `~/.local/share/opencode/opencode.db`. Discovery probes and title generation use temporary `XDG_DATA_HOME` directories to prevent database lock contention with active sessions.
- **Muse Spark 1.3 is free because it is a contributor SKU.** Meta trains on the prompts and completions it sees, which is what `-contributor-free` in its id means. Zen offers no non-contributor Muse 1.3. It is also the only free-tier model that takes `--variant`, so `opencode_variant_args` matches on the full id rather than the `opencode-go/` prefix; its ladder is low → xhigh (the CLI's `minimal` variant has no rung on Argmax's ladder, and Meta's `max` reasoning mode had not shipped as of the 2026-09-02 release).

## Grok Build

Grok Build chats use a pooled `grok agent stdio` ACP process, isolated by workspace and permission mode. ACP updates translate into the existing Claude-shaped normalizer events. Restricted helper flows retain the one-shot CLI described below, and so does a fork: ACP can only `session/load` the conversation it was given, which would leave both sessions driving one Grok chat, so `resume_fork` falls through to the CLI's `--fork-session`.

- **File changes:** Grok 1.0.24 names its main edit tool `search_replace` and sends `file_path`, `old_string`, and `new_string` on the opening call. The shared file-change reader treats that as an edit, builds the inline diff, and includes the path in the changed-files card. `write` sends the full new file body. Replacement snippets hide synthetic line numbers.
- **It speaks Claude Code's wire format.** `system/init`, Anthropic `stream_event` content blocks, whole `assistant` messages, and a closing `result` are the same envelopes as `claude --output-format stream-json`. Grok therefore has no normalizer of its own: `speaks_claude_stream_json` in [normalizer/mod.rs](../src-tauri/src/providers/normalizer/mod.rs) routes it down Claude's path. The envelopes match; the content arrays do not always. Claude typically emits `[thinking, text, tool_use]`. Grok often interleaves many tiny thinking/text pairs in one snapshot (and inserts `server_tool_use` / `web_search_tool_result` for built-in search). `extract_content_blocks` concatenates those runs and treats server search as a tool boundary so the chat does not render each phrase as its own paragraph. If Grok ever forks the envelope types, the fixture test in that file is what fails. Since grok 1.0.24 a `--include-partial-messages` turn carries **no** `assistant` envelope: the tool call arrives only as a `content_block_start` whose block already holds the finished `name` and `input`, so `streamed_tool_use_block` raises `command.started` from that block. A block that opens with an empty `input` still belongs to the incremental shape and is left to the closing envelope.
- **The prompt must ride the `=` form.** `-p`/`--single` takes the prompt as a flag *value*, not the trailing positional Claude and Cursor use. Passed as two argv entries, the CLI rejects any prompt starting with `-` with a bare usage error — a pasted diff or a "- do this" bullet trips it. `--single=<prompt>` is the only form clap always reads as a value.
- **`--cwd` is passed explicitly** even though the child is already spawned in the worktree: with `[cli] use_leader` enabled the turn runs inside a shared leader process whose cwd is not the child's. Same trap OpenCode's `--dir` covers.
- **Repo-local MCP servers are gated on folder trust.** `grok inspect --json` reports `projectTrusted: false` for a checkout the user has never accepted, and the `.grok/config.toml` Argmax writes is ignored until it is true. A launch therefore records the workspace in Grok's own `trusted_folders.toml` and gives the entry back at the end ([agent-tools.md](agent-tools.md)).
- **Skills** come from `.grok/skills`, `.agents/skills`, and — by Grok's own compatibility rules — `.claude/skills`, plus `~/.grok/installed-plugins/<plugin>/skills` and the bundled cache at `~/.grok/bundled/skills`.
- **Usage rides the `session/prompt` response.** Grok sends no ACP `usage_update`; the turn's bill is an x.ai `_meta.usage` extension on the prompt response, the same per-model `modelUsage` / `costUsdTicks` shape as its session logs. `usage_lines` in [grok_acp.rs](../src-tauri/src/providers/grok_acp.rs) turns each billed model into a content-less `assistant` line, and the Grok normalizer records it at the cost Grok charged rather than the rate table. The figure totals every model call in the turn, so it leaves the context meter alone.
- **Pricing** is the `grok-4.7-build` / `grok-4.6-build` / `grok-4.5-build` SKU rate, not xAI's published API list price. 4.7 lists at $2 / $6 per million on xAI's API; its SKU bills 0.34x that. Every Grok rate in `MODEL_PRICING` was solved from the `costUsdTicks` Grok reported on 2026-09-27 and reproduces it to the tick: 4.7 and 4.6 at $0.68 / $2.04 / $0.17 (input / output / cache read, doubled since 2026-09-01), 4.5 the same but $0.102 for cache reads, and 4.7 Fast at twice 4.7. Recorded turns carry Grok's own cost, so the table prices only what arrives without one. The default and title calls use 4.7.
- **Session sync is not supported.** Grok stores transcripts under `~/.grok/sessions/<percent-encoded-cwd>/<uuid>/` (`$GROK_HOME/sessions/…` when that variable is set), which is a lossless cwd mapping, but Argmax has no reader for it yet — the Settings toggle renders disabled.

## Subagent Activity

Subagent tool calls (`Task`, `spawn_agent`, `task`) open an activity pane:
- **Claude:** Emits child events directly in the stdout stream with `parent_tool_use_id`. Tool calls are forwarded by default; a subagent's text and thinking blocks arrive only with `--forward-subagent-text` (Claude Code 2.1.258+), which the adapter passes on launch and resume, so a subagent that only writes still streams into the pane. Native Claude child identity is scoped by both the parent native conversation and child session id. A later `SendMessage` continuation is a separate run in the same dock, with lifecycle `task_started` and `task_notification` events kept separate from the delivery message. Claude also emits those lifecycle subtypes for background Bash jobs, so Argmax ignores starts explicitly typed as non-agent tasks and remembers their ids to reject the untyped notifications. Claude launch and resume arguments set [`CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1`](https://code.claude.com/docs/en/env-vars) in the existing inline `--settings` JSON, which overrides user and project settings for this key. Native subagents return their findings through foreground tool results before the parent can finish. This also disables native background Bash and automatic backgrounding. Use Argmax's `terminal_spawn` tool for commands that need to outlive the provider turn (see [terminal.md](terminal.md)). Claude 2.1.269 can emit a child's `task_notification` before an already-running parent answer ends, while the findings are still queued. Its `queued_turn_count` excludes those notifications, and the stream does not consistently expose their delivery to the parent. Keeping tools foreground avoids that premature-completion race while preserving stdin for steering and permission responses. The regression fixture checks the launch setting and child-result ordering. A live 2.1.269 check confirmed that the parent receives the foreground child's answer before its final `result`.
- **Codex:** Reads child JSONL traces from `~/.codex/sessions/YYYY/MM/DD` or `~/.codex/archived_sessions`. A child `session_meta.parent_thread_id` can recover a launch omitted from structured stdout. A successful `close_agent` settles the child's active run even when its receipt still reports the last-known `running` state. That stale snapshot must not hold the parent's completion open. Trace imports also recognize `turn_aborted` as a cancelled child run.
- **Cursor:** Reads transcripts from `~/.cursor/projects/*/agent-transcripts/<agentId>/`. Cursor ACP supports persistent native task references. The `composer-2.5` model remains explicitly excluded from native reference forwarding. Cursor's task result carries the authoritative child `agentId`; initial task arguments can contain a different id. A backgrounded `task` is answered instead with a dispatch receipt — `result: { durationMs, isBackground: true }`, no `success`, no `agentId` — about a hundred milliseconds after the launch, and that call never completes again. The launch row therefore stays Running independently of the parent turn while the session pane polls the matching child transcript. Its authoritative `{"type":"turn_ended","status":"success"}` marker produces `agent.completed`, so the row settles when the child actually finishes whether that happens before or after the parent.
- **OpenCode:** Emits the `task` launch through structured stdout. The server transport forwards a task's running state alongside its terminal state, so the launch opens its `command.started` and `agent.started` rows (with the child session id in `state.metadata`) while the subagent works, and the terminal envelope closes the rows that launch opened rather than opening a second one. Argmax has no separate OpenCode child-trace source.
- **Grok:** Does not stream child events on the parent PTY. `spawn_subagent` returns a launch receipt (`Subagent started in background` wrapped as `{"type":"Text","text":"..."}`); the child writes its own session under `~/.grok/sessions/<percent-encoded cwd>/<child-id>/chat_history.jsonl` (or under `$GROK_HOME` when set; Argmax resolves both the trust store and the session store through the same `grok_home`), linked from the parent's `subagents/<id>/meta.json`. Argmax imports that transcript on demand the same way it imports Codex and Cursor traces. The receipt is launch metadata, not the agent's answer.

`session:agent-events` fetches and parses trace files on demand. Parsed rows are saved with deterministic IDs (`trace:<provider>:<sessionId>:<parentToolUseId>:<childId>:<seq>:<kind>`) and hidden from the main chat view.

Trace recovery requires authoritative lineage. Argmax does not attach a transcript to a parent by time or repository alone. Claude and OpenCode stay stream-native. Cursor uses its streamed launch plus an agent ID or the existing prompt match. Codex may synthesize a launch from the child trace because the trace names its parent conversation directly. If the real Codex launch arrives later, reconciliation keeps the real row, reparents the imported child rows, and emits hidden tombstones that remove the synthetic row from open chats.

Codex synthetic launches follow the latest turn in the child trace. Forked
history can include completed parent turns, so `task_started` clears any earlier
completion. Reconciliation removes a saved completion when the latest turn is
running and replaces outdated results when that turn finishes. The deletion
travels through the session mutation feed so open chats correct their status.

Lineage alone is not enough for Codex, because Codex runs review threads of its own: the guardian that judges a pending action before it runs, and the reviewer behind `/review`. Both are child rollouts naming the parent thread, and neither is a subagent — nobody spawned them and they carry no task. Reconciliation reads them from the rollout header (`thread_source: "guardian_review"`, or a `source.subagent` of `guardian`/`review`) and skips them, and deletes any placeholder launch an earlier sweep invented for one.

A Codex turn ends when its root `turn/completed` arrives and nothing it spawned is still working. The app-server declares children through a collab tool call's `receiverThreadIds` and `agentsStates`, and a turn holds for those. It can also send none of that — Codex 0.154.0 delivered no `spawnAgent` item at all and every `wait` row with both fields empty — and ending the turn kills the app-server process group and each child thread inside it. A turn that has answered therefore also asks the rollouts on disk, every two seconds, whether a child of its thread is still writing: a rollout that names this thread as its parent, carries a `thread_source: "subagent"` spawn (a fork or a guardian review names a parent too, and neither is work anyone is waiting on), has no `task_complete` or `turn_aborted` in its last records, and has been touched in the last two minutes. The silence window is what stops a killed or wedged child from holding the session forever.

Opening a session queues its reconciliation behind the first page rather than ahead of it: the page returns at once, and the scan (which walks the provider's rollout folders for the session's lifetime) lands as a revision hint if it writes anything. Measured 2026-09-23 on a release build over a copy of a 4.3 GB database, a warm first page of the two largest Codex sessions went from 93 ms to 50 ms and from 130 ms to 63 ms. The scan's plan reads through the reader pool, so it no longer holds the writer every provider persists through. Open agent panes run reconciliation off the main thread. Live agent-control events queue one serialized scan per session. Active Codex invocations also request a scan every two seconds, because the provider can omit both spawn and wait events while its children work. The watcher stops when its invocation is replaced or its handle ends or is removed. Unchanged trace files stay cached. Background scans and agent-pane reads publish a session-change hint after writing or deleting rows, so recovery reaches an open chat even when the parent is silent. A terminal provider event waits for the final serialized scan and includes its new launch or tombstone rows in the same dashboard delta.

## Measured File-Change Diffs

Codex reports file writes as `file_change` items. Current app-server rows use `kind: {type: "add" | "update" | "delete"}`. Update rows can carry a unified diff, while add rows put the new file body in `diff`. Older rows use a string kind and may carry only the path and kind. The renderer accepts both kind shapes, treats a headerless add diff as file content, and keeps deletes as deletes.

When a Codex row has no diff or content, Argmax measures the change from git. `codex exec` has no flag that adds the missing content, and in auto-approve mode the approval path that would carry `fileChanges` never fires. Claude, Cursor, OpenCode, and Grok send edit content, so their stats come from the tool input.

The provider stream can't be made to supply it either. Timed against a real run, `item.started` lands 0.4 ms before the write reaches disk and `item.completed` 1.4 ms after it, so there is no moment at which Argmax could read the file's "before" state on receiving an event.

[measured_diffs.rs](../src-tauri/src/providers/measured_diffs.rs) measures it from git instead, using [tree_snapshot.rs](../src-tauri/src/git/tree_snapshot.rs):

- **Mark at each turn boundary.** Every prompt send (launch, relaunch, and a live handle's follow-up) marks the worktree as a git tree object, written through a scratch `GIT_INDEX_FILE` so the user's index and worktree are untouched. Only already-dirty paths are staged (`git diff --name-only HEAD` plus `ls-files --others`); everything else matches the seed tree, which on a 1900-file repo is 140 ms instead of 570 ms. The mark is taken off the send path, since the agent's first write is a model round-trip away.
- **Re-mark per write.** A `command.completed` for a file change re-marks only the paths it reported, so `before → after` is that write's own diff. The mark then advances, which is what keeps two edits to one file two diffs instead of one counted twice — and keeps work that was already uncommitted when the turn began attributed to nobody.
- **Written back onto the tool row.** The measured diff goes into the tool's own `command.completed` payload as `unified_diff` per change entry, and the row is republished under its existing id and rowid. The renderer already reads a unified diff there, so the stat and the inline diff both come from one artifact and no new event type exists.
- **Absent on every failure.** No git repo, a lost mark, a path outside the workspace, a path that is no longer a file, a diff over 128 KB, or a turn that predates the feature: the row keeps its name and shows no stat. Deletions are skipped by design — the content never reached us. Nothing is backfilled for old sessions.
- Blobs and trees land in the repo's object database unreferenced, which `git gc` collects.

## Tool Event Identity

Tool events carry optional versioned `payload.activity` metadata from
`providers/tool_activity.rs`. The same Rust classifier enriches historical
timeline reads without rewriting SQLite. Desktop and iPhone consume its kind,
targets, evidence source, and optional file operation or discovered-tool count.
Native fields and exact known tool identities take precedence over narrowly
recognized commands. Codex `command_actions` (or `commandActions`) supplies
read, search, and file-listing identity when every action is recognized.
Targets come from each action's command operands when available, since native
search paths can be shortened display names. Unknown actions fall back to
command parsing. Literal `sh`, `bash`, and `zsh` wrappers with `-c` or `-lc`
are parsed as their command body, including argv-form commands.
Safe sequences of reads, searches, and listings also
qualify, including `cat file | head` and `sed -n 1,40p file; grep pattern file`.
The first read or search determines a mixed read-only row's identity. Recognized
in-place substitutions with `sed -i` or `perl -pi -e` use edit activity, even
when followed by read-only checks.
`tail`, including live log following with `tail -f`, uses read activity.
`mv`, `cp`, `rm`, and `touch` with literal operands use edit activity and carry
the move, create, or delete operation; a glob or brace list is what the shell
decides, not what we saw, so those stay command activity. `echo`, `printf`, and
`mkdir` produce no activity of their own and do not void the stages around
them, since printing a separator between reads is how a compound read is
written.
Explicit `cat > file` and `cat >> file` writes with quoted heredoc delimiters
use edit activity, including when followed by build checks. A `python3 - <<'PY'`
body is a program, not data, and an agent editing through a shell writes one:
a body calling a write reports the paths that are literal at the call or in the
latest assignment above it, and an edit whose path is computed reports no
target rather than a guessed one. Every other heredoc body stays opaque —
another interpreter, a script argument, an unquoted delimiter — so embedded
examples cannot invent edits. Other unknown programs, script execution,
substitutions, and redirects stay command activity.
A stage that cannot be read ends the scan instead of voiding it: it voids a
read-only claim, because it may have changed the same files, but an edit
already seen still happened, so `sed -i '' … && xcodegen && xcodebuild` is an
edit while `test -s file && rm file` is a command.
Unsupported shell syntax also falls back to command activity, including
descriptor duplication on a heredoc write and quoted tilde targets.
A file path alone does not establish an edit or image view,
and workspace diffs do not attribute opaque commands in a shared checkout.
`git <subcommand>` sequences use git activity with the subcommands as targets
(`Ran git diff`), ranked with reads and searches, so an in-place edit in the
same sequence still wins.
An exit code of 1 from a single recognized search means no matches, including
wrapped searches. Compound commands and explicit failures retain their failure
outcome because later steps may not have run.

Beyond files and shell, five identities cover what used to be the generic
"Used a tool" row: subagent coordination (`agent-message`, `agent-wait`,
`agent-stop`, from Codex `send_message`/`wait_agent`/`close_agent`, Claude
`SendMessage`/`TaskStop`, and the Argmax `session_*` tools under any namespace
shape), memory (`memory-recall`, `memory-save`, from engram under
`mcp__engram__`, `engram_` or bare Codex names, plus Argmax `learnings_*`),
the Argmax browser (`browser`, which keeps its identity when a screenshot
result arrives), and the agent's own plan (`plan`, from `TodoWrite`,
`todo_write`, `updateTodos` and plan-mode switches). Namespaced MCP tools
outside those servers stay generic: a Linear `create` is not a file write and a
memory server's `read` is not a file read. Historical rows classified `tool`
are refreshed on read like `image` and `command` rows, so old transcripts pick
up the new identities without a migration.
Grok's `use_tool` wrapper exposes the invoked tool's name and input to both
clients, preserving the original wrapper in `toolWrapper` so integration
artwork and call details survive discovery.
Computer activity recognizes Codex's `cua_repl` server. Bare `js` and the
`node_repl` server remain generic tools. Argmax browser calls retain their
mascot and integration identity. A screenshot result does not replace a known
computer interaction or Argmax browser call with an image-view activity.
Image detection inspects returned content blocks, excluding server icons and
structured domain data. Historical v1 image and generic command classifications
are refreshed on read so recognition fixes reach old events without rewriting SQLite.

The clients pair starts with results before describing success. An unpaired
start that settles when a session stops remains unconfirmed. Failure and
cancellation status survive provider transport translation. Raw input, output,
and existing diff evidence remain available behind the activity disclosure.

For a bounded, read-only coverage report against real history:

```bash
cargo run --manifest-path src-tauri/Cargo.toml --features helper-bins --bin audit-tool-activity -- /path/to/argmax.sqlite 1000
```

The sample limit is per provider. Counts describe recorded tool starts, not
unique operations or successful file accesses. The report includes generic
fallback names and never prints command arguments or result bodies.

Provider tool IDs are local to a provider invocation and may repeat in a long session. The renderer pairs `command.started` and `command.completed` by the provider-native ID scoped with `payload.providerInvocationId`:
- Claude: `id` on `tool_use`, then `tool_use_id` on `tool_result`.
- Codex: item `id`.
- Cursor, including ACP: `call_id`.
- OpenCode: `call_id`.

Historical events without `providerInvocationId` use chronological unmatched-pair correlation. `ToolCall.toolUseId` keeps the raw provider ID because subagent parent-child linkage uses that value.

## Agent Session Control

Sessions can launch, list, message, and move other sessions, and drive Argmax's
own browser. Every provider gets those as tools on the `argmax` MCP server, and
host policy rides in that server's `instructions` — not on the user prompt.
The `argmax session …` CLI still speaks the same socket from a terminal. See
[agent-tools.md](agent-tools.md) and
[ADR 0005](adr/0005-agent-tools-are-one-mcp-server.md).

## Default Model Selection

Defaults are configured in Settings → Agents → Default model (`localStorage.argmax.launch.model`). When unset, the app selects the highest priority installed provider:
1. Claude (Opus 5.5)
2. Codex (GPT-6 Sol)
3. Cursor (Grok 4.7)
4. OpenCode (GLM-5.3-Flash)
5. Grok Build (Grok 4.7)
6. Fallback: Big Pickle
