# A PR watch is a step in the gh poller's tick

Babysitting a pull request used to mean an agent polling GitHub from its own shell every 30 seconds. Each provider did it differently, with long `sleep` calls, `until` loops, Bash timeouts, and a bundled script for Grok. Argmax already polls every session's PR, and it can wake any provider's session through the inbox. So an agent now calls `pr_watch` once and ends its turn, and Argmax sends a watch notice when there is something to act on.

The watch is not a second poller. The 60 second tick stays the only writer of `gh_pull_requests`. The tick snapshots that table before its refresh fanout, and Arc events and the check-failure follow-up compare against the snapshot. A watch loop that refreshed a PR between the snapshot and transition detection would make the next snapshot already show the new state, and the Arc `merged` and `checks failing` events would never fire. So a watched session is always due on the ordinary tick, the fanout refreshes its PR, and the watch pass runs last, reading those rows and writing only its own cursors. Its extra `gh` reads add feedback and check names, never PR state.

Argmax reports and the agent decides. A checks-green notice lists unresolved review threads and requested reviewers, but Argmax does not judge whether the merge gate passes. Review bots, required approvals, and repository policy vary too much for a rule in the poller, and the babysit skill already owns that judgment.

A watched PR suppresses the automatic check-failure follow-up for that PR. The watching session is already responsible for the fix, and a follow-up agent working the same red commit would be two agents on one problem, the same reason [ADR 0011](0011-arc-events-replace-check-failure-follow-ups.md) gives for Arc members. Arc events are unchanged, because a coordinator still needs to hear what its members' PRs do.

Cursors move only after the notice's inbox row is stored, and the notice id is derived from the events it reports. A crash between the two writes repeats the pass, which rebuilds the same id, and the inbox ignores the duplicate. Nothing is dropped and nothing is sent twice.

## Addendum: notice ids, the outbox, and PR cleanup

A notice id carries the watch's own notice count, not a hash of its events. A head that returns to an earlier sha would otherwise rebuild an old id, and the inbox would ignore the wake. `send_system_notice` cannot join a transaction with the watch row, so the row is an outbox: one statement moves the cursors and stages the notice, delivery follows, and a later pass redelivers a staged notice exactly as it was. A crash can no longer repeat old events in a new notice.

PR cleanup runs in the watch pass when a watched PR merges with `cleanupOnMerge`, before the merged notice. Archive on merge waits for that watch, so cleanup finishes before the checkout moves. Cleanup never archives or hides the chat. "Babysit" means one path: fix until green, merge, clean up, and the chat and its checkout stay.
