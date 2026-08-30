# Session Sync

Picks up sessions you started *outside* Argmax — a plain `claude` in a
terminal — by reading the provider CLI's own transcript store, and keeps doing
it: new sessions appear on the next sweep, not only when you first switch it
on. Settings → Agents → Session sync.

## The contract

The provider's files are the source of truth. An imported session is a
disposable projection of one, so:

- It carries the provider conversation id, which is the resume id — continuing
  an imported session in Argmax resumes the real conversation.
- Until you continue it, it can be deleted and re-imported freely. Turning a
  provider off, narrowing the window, or losing the source file prunes it, and
  re-enabling brings it back.
- Sync never writes to the provider's files.

**Adoption** is the hinge. The first time you send a message into an imported
session ([session_service.rs](../src-tauri/src/providers/session_service.rs)),
`synced_sessions.adopted` flips. From then on it is an ordinary session and the
pruner never touches it, whatever the settings do.

Windows are 24 hours or 7 days. There is deliberately no "sync everything": the
stores hold years of sessions, and importing all of them would bury the
dashboard and cost minutes of parsing for sessions nobody will reopen.

## Sweep

[sync/engine.rs](../src-tauri/src/sync/engine.rs) runs one sweep per tick
(60s, spawned in [lib.rs](../src-tauri/src/lib.rs)) and on every settings
change, so a toggle's effect is visible immediately. The first sweep after
launch is also the catch-up for everything that happened while Argmax was
closed.

Polling, not a filesystem watcher: watchers on the provider stores would fire
on every keystroke of every running CLI, and this app has been bitten by
watcher amplification before.

Per provider, per sweep:

1. **Disabled** → prune every un-adopted import and stop.
2. **Prune** what fell outside the window, judged by *last activity* — the same
   clock discovery uses (file mtime). Judging by start time instead would
   delete a long-running session that is still active and re-import it in the
   same sweep.
3. **Discover** transcripts modified inside the window.
4. **Filter to registered projects.** A session whose cwd is inside no
   registered project is not imported; that filter is what keeps the sweep
   small (on a typical machine, hundreds of transcript files reduce to a
   handful).
5. **Import** the new ones, **extend** the ones whose file grew, and prune any
   whose transcript disappeared. An extension publishes the new timeline
   events with the summary delta, so an open conversation view shows the
   external continuation live — no reopen needed.

A conversation id Argmax already owns is skipped, so a session Argmax launched
is never imported as a duplicate of itself.

The sweep also runs on demand: Settings → Agents → Session sync has a
run-now path (`sync:run-now`), and right-clicking an imported sidebar row
offers **Sync now**. Manual runs take the same sweep lock as the timer, so
they never overlap it.

Idempotence comes from deterministic event ids —
`sync:<provider>:<external id>:<line>:<index>` — inserted with
`persist_timeline_event_if_absent`. Re-reading a transcript after a crash, a
settings change, or a plain re-run never duplicates a bubble; the byte cursor
is an optimization, not the correctness mechanism.

## Providers

Only **Claude Code** is readable today
([sync/claude.rs](../src-tauri/src/sync/claude.rs)):
`~/.claude/projects/<slug>/<sessionId>.jsonl`, one JSON object per line. The
directory slug is a lossy encoding of the cwd (`/`, `.`, and spaces all become
`-`), so it is never decoded back into a path — the real `cwd` is read out of
the file's own lines. Sidechain (subagent) rows are dropped.

Those line shapes are the same ones the CLI writes to stdout under
`--output-format stream-json`, so the existing Claude normalizer turns them
into timeline events unchanged — imported sessions render as ordinary chat,
not raw protocol text.

Codex, Cursor, and OpenCode render as disabled toggles rather than switches
that silently do nothing. Codex's rollout files
(`~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`) carry a `session_meta` header
with `session_id` and `cwd`, but wrap events as `event_msg` payloads rather
than the `item.completed` envelope the Codex normalizer expects, so they need a
translation layer first. `SyncConfig::normalized` forces unsupported providers
off however `sync.json` was hand-edited.

## Data

- `sync.json` in the app data dir holds the config, mirroring `remote.json`.
- `sessions.imported` is a denormalized display flag (the sidebar marker), so
  dashboard reads need no join.
- `synced_sessions` holds the bookkeeping: provider, external id, source path,
  byte cursor, source mtime, and `adopted`. Migration v18; see
  [data.md](data.md).
- Each import gets its own workspace at the project's checkout
  (`shared_workspace: true`), the same shape Argmax uses for its own
  current-checkout sessions, so the sidebar lists it as an ordinary row.

Pruning deletes rows in the background, which the delta protocol — whole-object
replacement — cannot express. `DashboardDelta` therefore carries
`removedSessionIds` / `removedWorkspaceIds`, and the renderer's
`mergeDashboardDelta` drops those rows before merging the rest.
