# Session Sync

Session sync imports sessions started in external provider CLIs (such as running `claude` in a terminal) by reading provider transcript files. Configured in Settings → Agents → Session sync.

## Behavior

- **Read-only:** Sync never modifies provider transcript files.
- **Resuming:** Continuing an imported session resumes the underlying provider conversation ID.
- **Adoption:** When a user sends a message into an imported session, `synced_sessions.adopted` is set to `true` ([session_service.rs](../src-tauri/src/providers/session_service.rs)). Adopted sessions become regular Argmax sessions and are never pruned.
- **Pruning:** Un-adopted sessions outside the active sync window (24 hours or 7 days) or deleted from disk are removed on sweep.
- **Scope:** Only sessions located inside registered Argmax projects are imported. Sessions created by Argmax itself are skipped.

## Sweep Loop

[sync/engine.rs](../src-tauri/src/sync/engine.rs) polls transcripts every 60 seconds and on settings updates. Users can also trigger on-demand sync via `sync:run-now` (or right-click "Sync now" in the sidebar).

Per provider, each sweep:
1. Prunes un-adopted sessions if disabled or outside the activity window (based on file mtime).
2. Scans for transcripts modified within the window.
3. Filters paths to registered project directories.
4. Imports new entries, appends changes to growing files (publishing live summary deltas), and prunes missing files.

Events use deterministic IDs (`sync:<provider>:<external id>:<line>:<index>`) with insert-if-absent to prevent duplicate timeline rows.

## Provider Support

- **Claude Code:** Supported ([sync/claude.rs](../src-tauri/src/sync/claude.rs)). Reads `~/.claude/projects/<slug>/<sessionId>.jsonl`. The `cwd` is parsed from the JSON lines rather than decoded from the directory slug. Events pass through the existing Claude normalizer.
- **Codex, Cursor, OpenCode:** Currently unsupported in transcript sync.

## Data Storage

- `sync.json`: Sync preferences stored in the app data folder.
- `synced_sessions`: Tracking table with provider, external ID, source path, byte cursor, mtime, and adoption state (migration v18).
- `sessions.imported`: Display flag for sidebar indicators.
- `DashboardDelta`: Includes `removedSessionIds` and `removedWorkspaceIds` so the UI prunes deleted imports without full page reloads.
