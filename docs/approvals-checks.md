# Approvals and Checks

## Approvals

[src-tauri/src/approvals](../src-tauri/src/approvals) handles command risk classification and approval state.

Settings → Agents offers three permission choices. **Provider defaults** is the default for new installations and lets each CLI load its own user and project configuration. Existing saved choices and chat policies are preserved. **Full access** explicitly bypasses native gates where the provider supports it. **Ask for approval** selects the provider's interactive permission policy. Plan mode keeps the provider's planning restrictions.

| Provider | Native response transport | Native user configuration |
| --- | --- | --- |
| Claude Code | Stream JSON SDK control requests and responses | `~/.claude/settings.json` |
| Codex | App-server JSON-RPC command, file and permission responses | `~/.codex/config.toml` |
| Cursor | ACP permission options | `~/.cursor/cli-config.json` |
| OpenCode | Local authenticated HTTP server and SSE permissions | `~/.config/opencode/opencode.json` |
| Grok Build | ACP permission options | `~/.grok/config.toml` |

The CLI also controls project configuration and supported environment overrides. Argmax does not copy or rewrite dotfiles. Model, reasoning, worktree, conversation and MCP integration still come from the chat launch. Restricted title and suggestion helpers retain their separate policy.

A native request is persisted with its live invocation and request identifiers before the provider receives a response. The chat shows the action, working directory and provider, with **Approve** and **Reject**. A decision is delivered only to that waiting request. Codex permission-profile requests state their scope in the action and grant access only for the current turn, never the whole session. Duplicate decisions fail, and cancelled or disconnected requests cannot resume an old process. Rejection returns control to the provider so it can explain or choose another action. Settings changes apply to new chats, including scheduled runs, automatic PR-fix chats and More details popups. Mobile launches inherit the host setting. Saves are atomic and serialized, and Settings shows save failures with a retry action. Existing chats retain their stored choice. Cursor retains native pre-allowed rules even in Ask for approval, because its ACP CLI has no force-prompt override.

A response failure stays visible in the card. Approval is never implemented by replaying a command or silently changing the chat to Full access. A CLI that cannot complete the required protocol handshake fails its launch instead of falling back to an output-only approval flow.

IPC channels:
- `approvals:pending`
- `approvals:resolve`

## Checks

[src-tauri/src/checks/service.rs](../src-tauri/src/checks/service.rs) executes configured workspace check commands with timeout, environment sanitation, output limits, and cancellation support. Results persist in SQLite and stream through `dashboard:delta`.

IPC channels:
- `checks:run`
