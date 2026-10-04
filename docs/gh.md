# GitHub CI Feedback

GitHub PR and check status is managed in Rust under [src-tauri/src/gh](../src-tauri/src/gh).

- [service.rs](../src-tauri/src/gh/service.rs): Resolves PRs from session branch context and explicit PR references, then caches the result in SQLite. GitHub state synchronizes across every cached row for the same project and PR number. Session attribution is recorded separately from that state.
- [poller.rs](../src-tauri/src/gh/poller.rs): Polls running sessions, sessions that completed in the last two minutes, sessions with an open PR, and sessions with a PR watch. Its transition ledger includes the PR lifecycle state, so an `OPEN` to `MERGED` change emits `dashboard:delta` even when the head SHA and checks are unchanged. It examines every associated PR, triggers eligible check-failure follow-ups, and can archive an isolated workspace after its PR work has merged.
- [watch.rs](../src-tauri/src/gh/watch.rs): The PR watch pass. It runs inside the poller's tick and sends watch notices. See [PR Watch](#pr-watch).
- [src-tauri/src/util/gh_runner.rs](../src-tauri/src/util/gh_runner.rs): Subprocess runner interface for mocking in tests.

## Poll Cadence

Each refresh spawns `gh pr view`, so the poller only refreshes every tick (60s) where something can move soon. Running and recently completed sessions refresh every tick. A session polled only because it has an open PR backs off while its PRs are settled: if a refresh shows no pending checks, no refresh error, and no change, the wait doubles, from 1 tick to 2, 4, 8, and then the 10-minute cap (`OPEN_PR_BACKOFF_CAP`). A change resets the wait to one tick. That includes a new head SHA, check state, PR state, or metadata. A failed refresh, or a follow-up or archive that was deferred, also resets it. When a session runs again, its backoff is cleared. The worst-case delay for noticing a push or merge made outside Argmax on a settled PR is therefore the cap.

A session with a PR watch never backs off. It refreshes on every tick, even when its workspace is archived. See [PR Watch](#pr-watch).

The cadence does not depend on window visibility or focus. Check-failure follow-ups and archive-on-merge have to act while the user is away.

## The Check-Failure Follow-Up

One red commit gets one follow-up per workspace. Several sessions can have work evidence for the same PR, so a per-session guard could launch duplicate agents. The guard is the in-memory ledger keyed `workspace:pr:head_sha` plus its persisted twin, `check_failure_launched_in_workspace`, which survives a restart mid-failure.

Only verified work on the checkout’s branch can launch a follow-up. References and unverified discoveries cannot. The launch also waits for the checkout to be free: while any session sharing its path is still running, the follow-up is deferred rather than dropped, because a second agent would edit the same tree the running one is mid-turn in and the sidebar resolves only one session per workspace. A still-failing PR is therefore re-evaluated on every refresh, not only on the refresh where its state changed. A check that stays red offers no second transition to hang the retry on, so a deferred follow-up also keeps its session from backing off. Only a genuine state change publishes a `dashboard:delta`.

**Suppressed for a live Arc's member, but only once its notice is delivered.** When the observing session's `arc_id` belongs to a *live* Arc (see [data.md](data.md#arcs)), a fresh transition into `failure` gives the Arc's coordinator the first chance to hear about it instead (the checks-failing event below). Suppression is decided at delivery time, not up front: `gh::poller::detect_transition` re-checks, on every later tick the PR is still failing, whether that Arc notice's `session_messages` row actually exists. If it does (delivery succeeded, or is at least still queued for the coordinator), the follow-up stays suppressed. If it does not — the send genuinely failed, or nothing was ever wired to attempt it — this section's ordinary gates apply exactly as they would with no Arc. A paused or done Arc, and an Arc with no coordinator, always keep this section's behavior exactly, from the first tick.

**Suppressed for a watched PR.** When any session has a PR watch on the PR, the follow-up does not launch. The watching session owns the fix and gets a watch notice instead. A lookup error counts as watched, for the same reason a failed launch-guard lookup counts as launched.

## Arc PR/CI Events

A PR with WORK evidence — the same rule `resolve_workspace_id_for_pr_action` applies above — on a session whose Arc is live gets a message to that Arc's coordinator instead of (checks failing) or alongside (checks passing, merged) the ordinary hooks. `gh::poller::ArcEventHook` fires on three transitions, independent of the check-failure hook's own gating (busy checkout) and of `on_pr_merged`'s (the `archive_on_merge` project setting, which this ignores):

- **Checks failing**: `check_state` transitions to `failure` on an `OPEN` PR, from anything other than `failure`.
- **Checks passing**: `check_state` transitions to `success`, from `failure`. This is the simplest correct rule, not "from `failure` or `pending`": each kind is detected from a snapshot of `gh_pull_requests` read once at the top of the tick, before that tick's own refreshes upsert it, so a `failure` → `pending` → `success` sequence spread across separate ticks reports passing only when the poller's immediately preceding snapshot was `failure` — a `pending` tick in between suppresses it. Accept one extra notice on GitHub's `failure` → `pending` → `failure` flap (the middle tick's snapshot never becomes `pending` from the Arc event's point of view, so the second `failure` reads as a fresh transition).
- **Merged**: `pr_state` reaches `MERGED`, from anything other than `MERGED`.

Each kind fires exactly once per transition — the next tick's snapshot already shows the new state, so there's nothing left to detect a second time. A restart with an already-`failure` PR fires no notice: the snapshot is read from the persisted row, which survived the restart, not from an in-memory ledger that would have come back empty. A PR that went red while the app was closed fires once, on the first tick after relaunch.

A coordinator that is itself the PR's worker still gets the message — nothing excludes `session_id == coordinator_session_id`.

Delivery is `ProviderSessionService::send_system_notice`, the same path `session_message` and the completion notice use: a `session_messages` row (`kind = "message"`, `from_session_id = NULL` — there is no sending session, only the PR's member session named in the body) lands before an attempted turn, so an idle coordinator wakes with it and a busy one collects it from its inbox on its next tool call. A genuine send failure rolls that insert back and returns `Err`, so a caller checking whether the row exists sees a clean "not delivered" rather than a row that looks successful. The message is plain and short:

```
Arc "<name>": PR #<n> (<title>) in <project> — checks failing on <sha7>. Member session <id> (<label>). <url>
```

(`checks passing` / `merged` in place of `checks failing on <sha7>`; `merged` carries no commit.)

Deduplication is entirely persisted, keyed `arc:<arcId>:project:<projectId>:pr:<number>:<kind>:<headSha>:<observedAt>` (`merged` omits the sha) — `project_id` is in the key because `pr_number` alone collides across two projects in the same Arc, and `observedAt` is the canonical PR row's `updated_at`, which only moves when its check/PR state actually changes, so the id is stable for one transition across ticks and identical for every session in the Arc observing the same PR in the same tick. `INSERT OR IGNORE` on `session_messages` collapses those concurrent observers into one delivery. There is no in-memory ledger for Arc events — see `gh::poller::arc_event_message_id`.

**Limitation.** A member session's workspace can be archived before its PR resolves. Archiving removes it from the poller's pollable-session set (see `pollable_session_ids` above), so a PR that only that archived session observed stops being polled and never reaches its passing or merged transition. This mirrors the check-failure follow-up's own limitation on an archived workspace; nothing about Arc events widens or narrows it.

## PR Watch

An agent calls `pr_watch` once and ends its turn ([agent-tools.md](agent-tools.md#pr-watches)). Argmax then polls that PR and wakes the session with a watch notice when there is something to act on. This replaces the 30 second shell loop the babysit skill used to run in every provider. The watch is a `pr_watches` row ([data.md](data.md)), one per session and PR.

### One writer per tick

The watch adds no loop and no cadence of its own. The poller's 60 second tick stays the only writer of `gh_pull_requests`:

1. A watched session is always due. It skips `open_pr_backoff` and the workspace-state filter.
2. The refresh fanout refreshes the session as usual. When that refresh did not reach the watched PR this tick, the fanout views it by number. A PR that is not yet linked to the session is still read this way.
3. Transition detection runs against the snapshot taken at the top of the tick, as before.
4. The watch pass runs last. It reads the rows the fanout just wrote and never writes `gh_pull_requests`.

A second writer between the snapshot and `detect_transition` would swallow the Arc `merged` and `checks failing` events and the check-failure follow-up, because the next snapshot would already show the new state. See [ADR 0013](adr/0013-pr-watch.md).

The pass makes one extra `gh pr view <n>` per watched PR. It adds `reviews`, `comments`, `reviewRequests`, `updatedAt`, `mergeCommit`, `mergeable`, and `baseRefName` to the usual fields, and reads each check's `name`, `workflowName`, and `detailsUrl`. It calls `gh api graphql` for review threads only when GitHub's `updatedAt` or the head changed since the last thread read, on the first pass, or before a checks-green notice. When that view shows a different head from the refreshed row, a push landed between the two reads, so the pass skips the PR until the next tick. Any read error, a rate limit included, also skips the PR for that tick.

### Events

Each pass compares what it read with the watch's cursors and sends at most one notice, listing every new event in this order:

1. **Merged** or **closed**. The pass's own view wins over the refreshed row. The notice names the merge commit, and the watch is removed after it. A terminal PR reports nothing else. With `cleanupOnMerge`, the pass runs [PR cleanup](workspaces.md#pr-cleanup) first and puts its report in the merged notice under `Cleanup:`. A cleanup that refuses or fails says so there.
2. **Head changed.** The failing-check and checks-green cursors reset. This is not a wake by itself, because the agent pushed it.
3. **Checks failing.** Each failing or cancelled check that was not reported yet, keyed `workflow/name@sha`, with its workflow and link. Two workflows can each have a `build`. A check seen running or passing again is forgotten, so a re-run that fails again on the same head is reported again.
4. **Merge conflict.** Entering `CONFLICTING` is reported once, with the base branch, and `MERGEABLE` after a reported conflict is reported once as resolved. The watch keeps a cursor, `pr_watches.conflict_state` (`clean`, `conflicting`, or empty until a read said one of them). A first `MERGEABLE` read seeds it without a notice, a first `CONFLICTING` read is reported, and `UNKNOWN` (which GitHub reports while it recomputes after a push) or a missing field never changes it, so a slow recompute cannot invent a transition. The cursor moves in the same staged write as the notice, so a restart cannot repeat it. A merged or closed PR reports its terminal event only, never a conflict. The pass reads `mergeable` and `baseRefName` in its one existing `gh pr view`: no extra call and no GraphQL. The checks-green notice adds a conflict line only when that same read says `CONFLICTING`, never from the stored cursor, so an `UNKNOWN` read after a push cannot repeat a stale warning. A watch created before this cursor existed has none, so the first pass after an upgrade reports a PR that is already conflicting once.
5. **New feedback.** Each new review (author, state, the head it reviewed, first line), PR comment, and review-thread comment (author, `path:line`, first line, link). Bot authors are marked when the login ends in `[bot]` or GraphQL says `Bot`. `gh pr view` drops the author type, so the GraphQL thread read also reads the authors of the last 100 reviews and comments, and their bot logins mark those items. That is how `chatgpt-codex-connector` is marked.
6. **Checks green.** Every check on the head finished without failing, reported once per head. The notice lists unresolved review threads and requested reviewers. Argmax reports what the merge gate needs and does not decide the merge.

A check's state comes from its conclusion, then its state, then its status. `error`, `startup_failure`, and `stale` are failures. `expected`, `requested`, and any value Argmax does not know are pending, so an unknown state never reads as green.

Some feedback is recorded as seen but does not wake the session. That is feedback the viewer wrote (the agent's own thread replies, through the user's `gh` login) and an empty `COMMENTED` review, which only wraps thread comments. An empty rollup is not green, because checks register a moment after a push.

The first pass seeds the feedback cursor. Feedback created before the watch is marked seen without a notice, since the agent reads existing feedback itself when it starts. Feedback created after the watch, even before the first pass, is reported.

A notice is plain text under 4,000 characters. Each list stops at 10 items and ends with "and N more". For example:

```
PR #42 (Fix parser): 1 check failing on feedfac, 2 new feedback items.
Checks failing on feedfac:
- CI / build: https://github.com/acme/widgets/actions/runs/1/job/2
New feedback:
- review by bob: CHANGES_REQUESTED on feedfac: Please split this.
- thread comment by chatgpt-codex-connector [bot] on src/x.rs:12: Off by one https://github.com/acme/widgets/pull/42#discussion_r1
https://github.com/acme/widgets/pull/42
```

### Delivery and dedupe

Delivery is `send_system_notice`, like the Arc events. The tick awaits it. The notice id is `pr-watch:<watchId>:<seq>:<headSha7>`, where `seq` is the watch's own notice count. A head that returns to an earlier sha still gets a new id.

`send_system_notice` cannot share a transaction with the watch row, so the watch row is an outbox. One statement moves the cursors and stages the notice. Then the notice is delivered, and then it is cleared. A failed send leaves it staged, and the next pass delivers that exact notice before it reads anything new. A crash after the inbox row is stored does the same, and the inbox's `INSERT OR IGNORE` ignores the repeated id. New events that arrive in between go in the next notice. Nothing is lost and nothing is sent twice.

The pass skips a PR whose row this tick's refresh did not write, or wrote with an error. A stale row could call a PR green after it merged. The next tick retries.

A PR number that GitHub never resolves is stored with the refresh error `pull request is unavailable`. After 10 such ticks in a row, the watch sends one notice, `PR #<n> not found; watch removed.`, and ends.

A watch on an archived chat keeps polling, but an archived chat cannot take a turn. Its events are not sent, and the PR's merge or close removes the watch.

### Overlap

- A watched PR suppresses the check-failure follow-up (above). Arc events are unchanged: a watched Arc member's coordinator hears about it as before.
- The ordinary poller keeps running. The watch only adds cadence and events for watched PRs.
- Archive on merge waits while a session in the workspace watches the merged PR. The merged notice starts a turn in the chat, and archiving in the same tick would cancel it. The watch ends with that notice, the busy-checkout rule then waits for the turn, and a later tick archives. PR cleanup on merge runs in the watch pass, so it finishes before that archive.

## Archive On Merge

Settings → Projects carries a per-project opt-in, `projects.archive_on_merge` (off by default, saved through `projects:update-settings`). With it on, a tick can archive the workspace when its primary PR has merged and every worked PR is merged. An open, closed-unmerged, unknown, or stale worked PR defers archive. Its checkout and branch are retained in the archive location and the sidebar row is hidden. This preserves local files but does not reclaim their disk space. Without it a merged PR only repaints the marker.

The workspace is resolved at fire time. A ledger entry keyed `merged:workspace:pr` means one merge archives once however many sessions in the checkout observed it. A busy workspace defers because archive drains its processes before moving the checkout. A workspace where a session watches the merged PR also defers, so its merged notice is delivered first (see [PR Watch](#overlap)). A merged PR stays merged, so the hook is re-evaluated on every tick while the session is still polled and deduped by the ledger. An archived workspace leaves the poll set on its own. Startup recovery validates a retained checkout and repairs Git registration after an interrupted move.

It acts on merges the poller sees, not on history: a workspace whose PR was already recorded as `MERGED` before the setting went on is out of the poll set entirely, so turning the setting on does not sweep up what has already piled up. Those are archived by hand.

The archive is never forced. A worktree with uncommitted changes returns to `kept`, and the poller logs that it did — work that outlived the PR is not ours to delete. See [workspaces.md](workspaces.md).

Isolated workspaces only. Archiving a shared checkout deletes nothing, so applying this there would not be cleanup — it would close a chat in a tree the user is still working in. The opt-in query excludes them ([projects.rs](../src-tauri/src/persistence/projects.rs)).

## Session PRs

A session retains every associated PR. `gh_pull_requests` stores GitHub state
once per project and PR number. `session_pr_links` stores the session's
relationship, primary pin, and dismissal. `session_pr_evidence` records the
source event and its original timestamp so transcript replay cannot reorder
work. The legacy `gh_pr` shape remains available to existing callers.

Relationships distinguish work on a PR, a reference to it, and an unverified
discovery. A successful PR creation or mutation can establish work. Viewing a
PR establishes a reference. A URL printed by an unrelated command does not
prove work. Shared-checkout branch observations cannot establish attribution:
another session can move the same checkout while this session is active.
Branch discovery stays within the checkout's origin owner, prefers an exact
HEAD match, then an open PR, and otherwise uses the newest candidate when
GitHub has reused the branch name. On a shared checkout, closed branch-only
candidates and merged candidates whose merge predates the session are rejected.
Their synthetic unverified associations are retracted. Isolated workspaces
retain discovery on their owned branch.

Migration v49 preserves historical links as unverified and retains the cached
GitHub state. Incremental event repair uses original event identities and times
to recover stronger evidence. A dismissal survives repair and later polling.
Pinning an unverified PR confirms it as a reference, not as work eligible for
automatic editing.

The chat's surfaces show only PRs the chat worked on: it created, edited,
merged, closed, reopened, or readied the PR, pushed to its branch, or the PR
belongs to its isolated worktree's branch. A PR the user pinned shows too. A
PR the chat only viewed (`gh pr view`, `checks`, `status`, `review`), opened
through the create action because it already existed, or whose URL merely
appeared keeps its link for polling and repair but does not reach the card,
the git menu, the sidebar marker, or the phone row. The workspace projection
(`shows_on_chat` in `persistence/workspaces.rs`) applies this filter once, so
those surfaces cannot disagree.

Primary selection uses a user pin first. Automatic selection prefers open PRs
with work evidence, then other worked PRs. Within each group,
the latest meaningful session activity wins, with the PR number as a stable
tie-breaker. Refresh timestamps never select a PR. A workspace projects the
same most recently active session that its chat displays.

The workspace card shows the primary PR and expandable history, including
individual state, branch, and exact links. The sidebar marker names that same
primary PR, so pinning one in the card moves the row glyph with it; a row with
several verified associations also carries their count. Running and
awaiting-input markers retain their precedence. Priority placement asks the
aggregate instead — any open PR wins, all merged shows merged, and other
terminal combinations show closed — because an open PR is outstanding work
even when the primary has already merged. Priority uses actual PR changes
rather than polling freshness.

Existing PR links open their exact stored URL. The separate create action
validates the displayed checkout branch against Git and supplies `--head` to
`gh pr create`. It may open an existing PR for that branch, but opening one
does not promote it to session work. The shared card's branch tooltip identifies
the checkout branch because historical PRs can belong to other branches.

Refreshes serialize per project PR across service instances. Failed reads
retain cached state and expose the refresh error. Merged state cannot regress,
and closed PRs remain eligible for refresh so reopening can be observed.

IPC channels:
- `prs:list-for-session`
- `prs:refresh`
- `prs:set-primary` (a null PR number returns to automatic selection)
- `prs:dismiss`
- `prs:cleanup` ([PR cleanup](workspaces.md#pr-cleanup) for a merged PR; returns the report)
- `git:view-or-create-pr` (checkout creation action, with optional expected branch)

Workspace summaries expose the plural `prs`, aggregate `prSummaryState`, and
legacy scalar primary fields. `prCreatedAt` and `prMergedAt` retain GitHub's
milestone timestamps for the optional Appearance celebration. That celebration
defaults off and does not run on ordinary turn completion.
