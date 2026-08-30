# Approvals and Checks

## Approvals

[src-tauri/src/approvals](../src-tauri/src/approvals) handles command risk classification and approval state.

- **Capability reporting:** Claude and Codex are currently `observable-only` in structured PTY mode. Permission events create a `permission.blocked` event and transition the session to blocked. Cursor and OpenCode have no native gate detection.
- **Resolution:** Compare-and-set from `pending` state, recording an `approval.resolved` event and emitting a dashboard delta.

IPC channels:
- `approvals:pending`
- `approvals:resolve`

## Checks

[src-tauri/src/checks/service.rs](../src-tauri/src/checks/service.rs) executes configured workspace check commands with timeout, environment sanitation, output limits, and cancellation support. Results persist in SQLite and stream through `dashboard:delta`.

IPC channels:
- `checks:run`
