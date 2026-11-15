# GitHub CI Feedback

Rust manages GitHub PR and check status under [src-tauri/src/gh](../src-tauri/src/gh).

- [service.rs](../src-tauri/src/gh/service.rs) resolves PRs and caches them in SQLite.
- [poller.rs](../src-tauri/src/gh/poller.rs) polls sessions and runs the follow-up, Arc, and merge hooks.
- [watch.rs](../src-tauri/src/gh/watch.rs) is the PR watch pass, inside the poller's tick.
- [gh_runner.rs](../src-tauri/src/util/gh_runner.rs) is the subprocess seam for tests.

## Poll cadence

The poller ticks every 60 seconds. Each refresh spawns `gh pr view`, so it only refreshes where something can move soon.

Running and recently completed sessions refresh every tick. A session polled only for its open PR backs off while the PR is settled, up to `OPEN_PR_BACKOFF_CAP`. Any change, failed refresh, or deferred hook resets the wait. A PR watch never backs off. The worst-case delay for noticing an outside push on a settled PR is the cap.

The cadence does not depend on window visibility. Follow-ups and merge cleanup must act while the user is away.

## The check-failure follow-up

One red commit gets one follow-up per workspace. Several sessions can have evidence for one PR, so a per-session guard could launch duplicates. The guard is the in-memory ledger keyed `workspace:pr:head_sha` and its persisted twin, `check_failure_launched_in_workspace`, which survives a restart.

Only verified work on the checkout's branch can launch a follow-up. The launch waits for the checkout to be free, because a second agent would edit a tree the running one is mid-turn in. A deferred follow-up is re-evaluated on every refresh, because a check that stays red offers no second transition.

It is suppressed in two cases:

- **A live Arc's member, once its notice is delivered.** On each tick, `detect_transition` checks that the Arc notice's `session_messages` row exists. If the row does not exist, the ordinary gates apply as if no Arc existed. A paused or done Arc never suppresses.
- **A watched PR.** The watching session owns the fix. A failed lookup counts as watched, for the same reason a failed launch-guard lookup counts as launched.

## Arc PR/CI events

A PR with work evidence on a session in a live Arc sends a message to the coordinator. `ArcEventHook` in the poller fires on three transitions, independent of the follow-up's busy-checkout gate and the `merge_cleanup` setting:

- **Checks failing:** `check_state` reaches `failure` on an `OPEN` PR.
- **Checks passing:** `check_state` reaches `success` from `failure`.
- **Merged:** `pr_state` reaches `MERGED`.

Detection reads a snapshot of `gh_pull_requests` once at the top of the tick, before that tick's refreshes write it. Each kind therefore fires once per transition. A restart fires nothing new, because the snapshot is the persisted row, not an in-memory ledger. A `failure` → `pending` → `success` sequence over separate ticks reports no passing, and that is accepted as the simplest correct rule.

Delivery is `send_system_notice`, with `from_session_id = NULL`. A row lands before an attempted turn, so an idle coordinator wakes and a busy one collects it from its inbox. A failed send rolls the row back.

Deduplication is entirely persisted (`arc_event_message_id`). The key holds `project_id`, because a PR number alone collides across projects, and `observedAt`, the canonical PR row's `updated_at`. `INSERT OR IGNORE` collapses concurrent observers.

**Limitation.** Archiving a member's workspace removes it from `pollable_sessions`. A PR only that session observed stops being polled and never reports passing or merged. The check-failure follow-up has the same limit.

## PR watch

An agent calls `pr_watch` once and ends its turn ([agent-tools.md](agent-tools.md#pr-watches)). Argmax then polls that PR and wakes the session when there is something to act on. The watch is a `pr_watches` row, one per session and PR.

### One writer per tick

The poller's tick stays the only writer of `gh_pull_requests`:

1. A watched session is always due.
2. The refresh fanout refreshes it and views the watched PR by number if needed.
3. Transition detection runs against the snapshot from the top of the tick.
4. The watch pass runs last, reads the rows the fanout wrote, and never writes them.

A second writer between the snapshot and `detect_transition` would swallow the Arc events and the follow-up, because the next snapshot would already show the new state. See [ADR 0013](adr/0013-pr-watch.md).

The pass makes one extra `gh pr view` per watched PR, and calls GraphQL for review threads only when something moved. A head that differs from the refreshed row means a push landed between the reads, so the pass skips the PR until the next tick. Any read error also skips it.

After three consecutive failed reads, Argmax sends one `watch degraded` notice and keeps retrying. The next complete read sends one `watch recovered` notice with any delayed events. That state persists across restarts.

### Events

Each pass sends at most one notice, listing new events in this order. [watch.rs](../src-tauri/src/gh/watch.rs) owns the cursors and the text.

1. **Merged or closed.** A terminal PR reports nothing else, and the watch ends. With `cleanupOnMerge`, the pass runs [PR cleanup](workspaces.md#pr-cleanup) first and includes its report. The notice starts a turn in the checkout, so the checkout stays, and the report tells the agent to call `pr_cleanup`.
2. **Head changed.** This resets the check cursors. It is not a wake by itself, because the agent pushed it.
3. **Checks failing.** Each check is keyed `workflow/name@sha`, because two workflows can each have a `build`. A re-run that fails again is reported again.
4. **Merge conflict.** Entering and leaving `CONFLICTING` are each reported once. `UNKNOWN` never moves the cursor, because GitHub reports it while it recomputes after a push.
5. **New or edited feedback.** Full body hashes detect edits. `gh pr view` drops author type, so the GraphQL read supplies the bot marks.
6. **Checks green.** Reported once per head, with unresolved threads and requested reviewers. Argmax reports what the merge gate needs and does not decide the merge.

An unknown check state counts as pending, so it never reads as green. An empty rollup is not green, because checks register a moment after a push.

Feedback the viewer wrote, and an empty `COMMENTED` review, are recorded as seen and do not wake the session. Feedback created before the watch seeds silently, because the agent reads existing feedback when it starts.

### Delivery and dedupe

In the chat a watch notice is one quiet line that opens to the full text. The agent receives the whole notice. A `Babysitting PR #42` pill sits on the composer while the watch is active.

The notice id is `pr-watch:<watchId>:<seq>:<headSha7>`. `seq` is the watch's own count, so a head that returns to an earlier sha still gets a new id.

`send_system_notice` cannot share a transaction with the watch row, so the row is an outbox. One statement moves the cursors and stages the notice. Then the notice is delivered, and then cleared. A failed send or a crash re-delivers that exact notice, and the inbox's `INSERT OR IGNORE` ignores a repeat. Nothing is lost and nothing is sent twice.

The pass skips a PR whose row this tick's refresh did not write, because a stale row could call a PR green after it merged. A PR number GitHub never resolves ends the watch with one notice after 10 ticks.

A watch on an archived chat keeps polling, but an archived chat cannot take a turn, so events are not sent.

### Overlap

- A watched PR suppresses the check-failure follow-up. Arc events are unchanged.
- Merge cleanup waits while a session watches the merged PR. The merged notice starts a turn, and archiving in the same tick would cancel it.

## Merge cleanup

Settings → Projects saves the primary folder's policy. Each workspace reads it from its pinned folder, so changing the primary preserves existing chats' behavior.

- `off` (the default): a merged PR only repaints the marker.
- `archive`: archive the workspace. The checkout is retained for a recovery window ([workspaces.md](workspaces.md#lifecycle--watchers)), and the branch for good.
- `remove-checkout`: delete the checkout, then run [PR cleanup](workspaces.md#pr-cleanup). The chat stays in its sidebar section, read-only. See [ADR 0014](adr/0014-merged-chats-stay-listed-without-a-checkout.md).

`archive_merged_workspace` in [gh/hooks.rs](../src-tauri/src/gh/hooks.rs) acts when the workspace's primary PR has merged and every worked PR is merged. A ledger entry means one merge acts once. A busy workspace defers, because both modes drain its processes first.

- It acts on merges the poller sees, not on history. Turning the setting on does not sweep old merges.
- Neither mode is ever forced. A worktree with uncommitted or untracked changes returns to `kept`, because work that outlived the PR is not ours to delete.
- `remove-checkout` also keeps a checkout whose HEAD the merged PR does not contain, and keeps it when the fetch of the merged head fails.
- Isolated workspaces only. Applying this to a shared checkout would close a chat in a tree the user is still working in.

A removed checkout leaves the row `archived` with `checkout_removed_at` set. `isInArchivedSection` keeps it in its normal section, while every capability check stays on `state`, so the composer is disabled.

## Session PRs

A session keeps every associated PR. `gh_pull_requests` stores GitHub state once per project and PR number. `session_pr_links` stores the session's relationship. `session_pr_evidence` keeps the source event and time, so transcript replay cannot reorder work.

Relationships distinguish work, a reference, and an unverified discovery:

- A successful creation or mutation can establish work.
- Viewing a PR establishes a reference.
- A URL printed by an unrelated command proves nothing.
- A shared-checkout branch observation proves nothing, because another session can move that checkout.

A dismissal survives repair and later polling. Pinning an unverified PR confirms it as a reference, not as work eligible for automatic editing.

`shows_on_chat` in `argmax-store/src/workspaces.rs` applies one filter for the card, the git menu, the sidebar marker, and the phone row, so those surfaces cannot disagree. A PR only viewed keeps its link for polling but does not show.

Primary selection takes a user pin first, then open worked PRs, then other worked PRs, by the latest meaningful session activity. Refresh timestamps never select a PR. Priority placement uses the aggregate instead, because an open PR is outstanding work even when the primary has merged.

Failed reads keep cached state and expose the error. Merged state cannot regress. Closed PRs stay eligible for refresh, so a reopening can be observed.
