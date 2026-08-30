# Approvals are never faked

Only a provider that exposes both an approval request *and* a response transport can be answered from inside Argmax. Claude and Codex expose the request but no response channel this runtime retains, so they are `observable-only`: their gate becomes a `permission.blocked` event and a blocked session that the user resolves in the provider's own interface. Cursor and OpenCode are `unsupported` — no detector at all.

The tempting shortcut is to show an Approve button anyway and implement it by adding a bypass flag or replaying the command. That would make the button lie: the user would think they had granted one specific command when Argmax had actually disabled the gate or run something the provider never sanctioned. A blocked session is worse UX and honest. A provider is promoted to `respondable` only after its exact response protocol is verified — not because the blocked state is annoying.
