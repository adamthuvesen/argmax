# Approvals And Checks

## Approvals

[src-tauri/src/approvals](../../src-tauri/src/approvals) owns command-risk classification and approval resolution. Dangerous commands become pending approval rows; resolving an approval feeds the provider follow-up queue when the provider supports a response.

IPC:

- `approvals:pending`
- `approvals:resolve`

## Checks

[src-tauri/src/checks/service.rs](../../src-tauri/src/checks/service.rs) runs configured workspace checks with a timeout, sanitized environment, output cap, and cancellation. Results persist as check rows and appear in dashboard snapshots/deltas.

IPC:

- `checks:run`
