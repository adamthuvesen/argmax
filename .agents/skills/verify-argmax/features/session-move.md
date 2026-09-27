# Move chat to another checkout

An agent moves its running chat to an existing sibling worktree. The chat
continues there with its conversation, and the source workspace stays open.

Source: scripts/verify.mjs, scripts/verification/session-move.mjs, scripts/verification/provider-fixture.mjs
Inventory-id: scenario:session-move

## Sub-features

- `session-move` has the fixture agent request a move mid-turn to a sibling worktree, then follows the chat there in the native window.

## How to get to it (user POV)

Ask an agent to continue in another worktree. It calls `session_move`, and the
chat reappears under the destination checkout with a `Moved to …` notice.

## Driving it with verify.mjs

Preconditions: `launch` completed and `doctor` exits 0. No source edits during the run.

- **Move.** Run `node .agents/skills/verify-argmax/verify.mjs drive session-move`.
  The source chat shows, the destination chat completes on branch
  `verification-session-move-target`, and the window follows it.
- **Proof.** `verdict.json` checks only the terminal state. The move itself is
  proven by `drive-session-move-*/native/session-move.json`: its assertions cover the
  source and destination seams, the carried conversation, the retained source
  workspace, and the displayed `Moved to sibling, existing checkout` status. The same
  directory has `session-move-source.png` and `session-move-destination.png`; the
  destination shot shows the continued chat on the target branch, and the notice
  may sit outside its frame.

## Gotchas

The destination carries a new provider conversation id, which the SQLite check expects.
The sibling worktree is created inside the scenario's scratch repository.
