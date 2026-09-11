# Approvals and Checks

## Approvals

[src-tauri/src/approvals](../src-tauri/src/approvals) handles command risk classification and approval state.

Settings → Agents offers three permission choices independently for each provider. An existing global choice seeds every provider until you change its setting. **Provider defaults** is the default for new installations and lets each CLI load its own user and project configuration. Existing chat policies are preserved. **Full access** explicitly bypasses native gates where the provider supports it. **Ask for approval** selects the provider's interactive permission policy. Plan mode keeps the provider's planning restrictions.

| Provider | Native response transport | Native user configuration |
| --- | --- | --- |
| Claude Code | Stream JSON SDK control requests and responses | `~/.claude/settings.json` |
| Codex | App-server JSON-RPC command, file and permission responses | `~/.codex/config.toml` |
| Cursor | ACP permission options | `~/.cursor/cli-config.json` |
| OpenCode | Local authenticated HTTP server and SSE permissions | `~/.config/opencode/opencode.json` |
| Grok Build | ACP permission options | `~/.grok/config.toml` |

The CLI also controls project configuration and supported environment overrides. Argmax does not copy or rewrite dotfiles. Model, reasoning, worktree, conversation and MCP integration still come from the chat launch. Restricted title and suggestion helpers retain their separate policy.

Changing Settings does not update existing chats. A chat launched through
`session_launch` inherits its parent's saved permission mode, so asking an
existing chat to launch another chat does not pick up a changed setting.
Start a chat from the launcher to use the current provider setting.

For Codex, Full access disables sandbox restrictions and sets
`approvalPolicy: on-request` with `approvalsReviewer: auto_review`. Codex
automatically reviews eligible command and MCP approval requests, so an
approved request can execute without a user click. Automatic review can
still reject an action. Ask for approval selects the user as reviewer.

Provider defaults leaves approval configuration to Codex, including repo
overrides in `.codex/config.toml`. A repo's `approval_policy = "never"`
overrides a user's `on-request` setting and can fail with
`MCP tool call requires approval, but approval policy is never` or
`approval required by policy, but AskForApproval is set to Never` before the
action reaches review. To allow automatic review, use
`approval_policy = "on-request"` and `approvals_reviewer = "auto_review"`.
When diagnosing a mismatch, compare the chat's stored `permission_mode`
with the Codex rollout's `turn_context.approval_policy`, rather than reading
Settings alone.

A native request is persisted with its live invocation and request identifiers before the provider receives a response. The chat shows the action, working directory and provider, with **Approve** and **Reject**. A decision is delivered only to that waiting request. Codex permission-profile requests state their scope in the action and grant access only for the current turn, never the whole session. Duplicate decisions fail, and cancelled or disconnected requests cannot resume an old process. Rejection returns control to the provider so it can explain or choose another action. Each provider’s setting applies to its new chats, including scheduled runs, automatic PR-fix chats and More details popups. Mobile launches inherit the host setting. Saves are atomic and serialized, and Settings shows save failures with a retry action. Existing chats retain their stored choice. Cursor retains native pre-allowed rules even in Ask for approval, because its ACP CLI has no force-prompt override.

A tool call the chat draws as an **interactive card** is never gated. The card is already in front of the user with its own button, and pressing it terminates the turn and sends the answer as a new message, so the tool result is discarded either way — an Approve/Reject row beside it asks permission to show a question the user is looking at. `renders_as_interactive_card` in [providers/mod.rs](../src-tauri/src/providers/mod.rs) holds the names, in step with [turnInteractiveCards.ts](../src/renderer/lib/turnInteractiveCards.ts).

Cursor's question tool arrives on the same channel as its permissions. When a client does not implement `cursor/ask_question` — this one does not — the CLI falls back to `session/request_permission` with every answer as an `allow_once` option and a `__ask_question_skip__` reject. Two buttons cannot carry a multiple-choice question, and "Approve" would pick the first answer and report it to the model as the user's, so a request carrying more than one `allow_once` is declined rather than shown ([acp.rs](../src-tauri/src/providers/acp.rs)). The model asks again in prose, which the composer answers. Codex and OpenCode need none of this: Codex's MCP tool calls arrive as notifications and structurally cannot reach the approval broker, and OpenCode's ask tool is named `question`, which draws no card.

A response failure stays visible in the card. Approval is never implemented by replaying a command or silently changing the chat to Full access. A CLI that cannot complete the required protocol handshake fails its launch instead of falling back to an output-only approval flow.

IPC channels:
- `approvals:pending`
- `approvals:resolve`

## Checks

[src-tauri/src/checks/service.rs](../src-tauri/src/checks/service.rs) executes configured workspace check commands with timeout, environment sanitation, output limits, and cancellation support. Results persist in SQLite and stream through `dashboard:delta`.

IPC channels:
- `checks:run`
