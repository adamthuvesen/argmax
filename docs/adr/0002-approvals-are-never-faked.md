# Approvals are never faked

Only a provider that exposes both an approval request and a response transport can be answered from inside Argmax. The runtime now retains native response channels for all five providers: Claude SDK control, Codex app-server, Cursor and Grok ACP, and OpenCode HTTP/SSE.

Each decision answers the exact waiting provider request. Argmax never implements approval by adding a bypass flag, replaying the action, or granting a persistent permission without displaying its scope. Requests expire with their live invocation. A protocol or response failure is surfaced, and unsupported requests fail closed.

Provider defaults leaves native permission configuration to the CLI. Full access is a separate, explicit launch setting. See [Approvals and Checks](../approvals-checks.md) for settings and lifecycle behavior.
