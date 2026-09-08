# Session Sync

Session sync imports sessions started in external provider CLIs (such as running `claude` in a terminal) by reading provider transcript files. Configured in Settings → Agents → Chat sync (the UI's display name for this).

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
4. Imports new entries, appends changes to growing files (publishing live summary deltas), and prunes missing files. Creating an import commits its session, timeline events, and sync bookkeeping in one SQLite transaction. A failed import also removes the workspace allocated for it, so the next sweep can retry cleanly.

Events use deterministic IDs (`sync:<provider>:<external id>:<line>:<index>`) with insert-if-absent to prevent duplicate timeline rows.

Growing Claude transcripts are read from the last committed byte offset instead of rescanned from the beginning. The matching absolute line cursor is stored separately because it remains part of the deterministic event ID. Databases created before migration v40 carry a line number in the old `byte_cursor`; the first changed sweep reads that transcript by line once and records both coordinates. An unterminated final JSONL row may be displayed when it is already valid JSON, but its cursor is held at the row start until the newline arrives, so a partially written row is never skipped.

Transcript open, metadata, seek, and read errors fail the sweep without advancing its cursor or source mtime. Invalid JSON, oversized rows, and ordinary end-of-file remain consumable transcript content, so a later successful sweep retries I/O failures without getting stuck on rows the importer intentionally ignores.

## Provider Support

- **Claude Code:** Supported ([sync/claude.rs](../src-tauri/src/sync/claude.rs)). Reads `~/.claude/projects/<slug>/<sessionId>.jsonl`. The `cwd` is parsed from the JSON lines rather than decoded from the directory slug. The sweep classifies nothing itself: `sync/claude.rs` decides only which lines to hand over (everything but sidechain rows, non-object lines, and oversized ones), and each one goes through the same Claude normalizer the live stdout path uses, stamped with the transcript line's own timestamp. The sweep runs it with `NormalizerSessionContext::for_transcript_replay`, and that flag is the only difference from a live launch: replay mode reads a `type:"user"` line as the human's prompt (`user.message`, payload `{ "source": "sync" }`). Live prompts are recorded before submission through stdin, so user envelopes on stdout are interpreted as tool results. Compaction comes from the `system/compact_boundary` row exactly as it does live; the `isCompactSummary` body beside it is written for the model and stays hidden.
- **Codex, Cursor, OpenCode, Grok Build:** Currently unsupported in transcript sync.

## Data Storage

- `sync.json`: Sync preferences stored in the app data folder.
- `synced_sessions`: Tracking table with provider, external ID, source path, byte and line cursors, mtime, and adoption state (migrations v18 and v40).
- `sessions.imported`: Display flag for sidebar indicators.
- `DashboardDelta`: Includes `removedSessionIds` and `removedWorkspaceIds` so the UI prunes deleted imports without full page reloads.
