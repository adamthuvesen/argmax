# Fork at a finished turn and merge findings back

A chat forks at a selected earlier turn, the fork's first message starts a fresh
provider conversation from only that visible history, and the fork's findings
reach a working source as one queued message, exactly once.

Source: scripts/verify.mjs, scripts/verification/workflows.mjs, scripts/verification/provider-fixture.mjs, src-tauri/src/workspaces/orchestration/fork.rs, src-tauri/src/providers/fork_merge.rs
Inventory-id: scenario:fork-merge

## Sub-features

- `fork-merge` forks at turn one of two from the turn footer, sends a first message in the fork, merges from the fork bar while the source runs a held turn, checks the next merge, then forks into an isolated checkout.

## How to get to it (user POV)

Pick a finished turn and fork from it, send the first message in the fork, then
bring its findings back to the source. A busy source queues the message.

## Driving it with verify.mjs

Preconditions: `launch` completed and `doctor` exits 0. No source edits during the run.

- **Fork and merge.** Run `node .agents/skills/verify-argmax/verify.mjs drive fork-merge`.
  The fork and merge are native clicks: the turn footer's "Fork from this turn" and
  "Fork from this turn into an isolated checkout", the fork bar's "Open source" and
  "Bring findings back", and the merge dialog's "Queue for source", "Close" and "Cancel".
  IPC and SQLite are the second read.
- **Proof.** `native/fork-merge.json` lists the assertions and a `coverage` block.
  Fork: portable continuation, copy of turn one without turn two, unchanged
  source events, no new provider conversation launch at fork time (the follow-up suggestion one-shot that opening a finished chat triggers is counted apart as a helper call), lineage in SQLite
  (`session_forks`). First message: no `--resume` or `--fork-session`, a prompt
  with turn one and not turn two, current prompt once. Merge: queued behind the
  running turn, one `pending_messages` row, repeat call is a no-op, native queued
  row visible, drained once, one `fork_merges` range, queue empty, provider told
  once. Next merge: only the fork's new messages. PNGs: `fork-merge-queued` and
  `fork-merge-delivered`.

## Gotchas

Turn footer actions are hidden until the pointer is over the turn, so the driver hovers
first. Turn two offers the same action, so `session_forks.boundary_event_id` is what
proves the clicked turn. Not driven: "Send to source" into an idle source, and a fork of
a running source (`coverage.notDriven`). The fixture decides what to answer from the prompt, so a
merge message (which quotes earlier turns) is matched on its
`Argmax fork merge <id>` footer first.
