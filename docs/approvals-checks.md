# Approvals And Checks

## Approvals

[src-tauri/src/approvals](../src-tauri/src/approvals) owns command-risk classification and approval resolution. Provider permission events become one pending row, one `approval.requested` event, and a `waiting` session transition in the same SQLite transaction only when the provider has a verified live response capability. Provider request identities are persisted so replay cannot create a second row after resolution. Claude and Codex are currently `observable-only`, so their gates become a `permission.blocked` event and a blocked session rather than a fake in-app Approve action. Resolution is compare-and-set from `pending`, records one `approval.resolved` event, and publishes the session delta.

Provider approval capability is explicit in discovery. Claude and Codex are currently `observable-only`: their structured CLIs expose a request, but this runtime does not retain a provider-owned response transport. Cursor is `unsupported` because no native gate detector is enabled. Argmax does not fake approval by adding bypass flags or replaying a command. A provider responder can be enabled only after its exact protocol is verified.

IPC:

- `approvals:pending`
- `approvals:resolve`

## Checks

[src-tauri/src/checks/service.rs](../src-tauri/src/checks/service.rs) runs configured workspace checks with a timeout, sanitized environment, output cap, and cancellation. Results persist as check rows and appear in dashboard snapshots/deltas. Workspace archive owns cancellation and waits for every registered check to unregister before it removes a worktree.

IPC:

- `checks:run`
