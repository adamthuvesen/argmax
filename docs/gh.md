# GitHub CI Feedback

GitHub PR and check status is managed in Rust under [src-tauri/src/gh](../src-tauri/src/gh).

- [service.rs](../src-tauri/src/gh/service.rs): Resolves PRs from session branch context and explicit PR references, then caches the result in SQLite. GitHub state synchronizes across every cached row for the same project and PR number. Session attribution is recorded separately from that state.
- [poller.rs](../src-tauri/src/gh/poller.rs): Polls running sessions, sessions that completed in the last two minutes, and sessions with an open PR. Its transition ledger includes the PR lifecycle state, so an `OPEN` to `MERGED` change emits `dashboard:delta` even when the head SHA and checks are unchanged. It examines every associated PR, triggers eligible check-failure follow-ups, and can archive an isolated workspace after its PR work has merged.
- [src-tauri/src/util/gh_runner.rs](../src-tauri/src/util/gh_runner.rs): Subprocess runner interface for mocking in tests.

## The Check-Failure Follow-Up

One red commit gets one follow-up per workspace. Several sessions can have work evidence for the same PR, so a per-session guard could launch duplicate agents. The guard is the in-memory ledger keyed `workspace:pr:head_sha` plus its persisted twin, `check_failure_launched_in_workspace`, which survives a restart mid-failure.

Only verified work on the checkout’s branch can launch a follow-up. References and unverified discoveries cannot. The launch also waits for the checkout to be free: while any session sharing its path is still running, the follow-up is deferred rather than dropped, because a second agent would edit the same tree the running one is mid-turn in and the sidebar resolves only one session per workspace. A still-failing PR is therefore re-evaluated on every tick, not only on the tick its state changed — a check that stays red offers no second transition to hang the retry on. Only a genuine state change publishes a `dashboard:delta`.

## Archive On Merge

Settings → Projects carries a per-project opt-in, `projects.archive_on_merge` (off by default, saved through `projects:update-settings`). With it on, a tick can archive the workspace when its primary PR has merged and every worked PR is merged. An open, closed-unmerged, unknown, or stale worked PR defers archive. Its checkout and branch are retained in the archive location and the sidebar row is hidden. This preserves local files but does not reclaim their disk space. Without it a merged PR only repaints the marker.

The workspace is resolved at fire time. A ledger entry keyed `merged:workspace:pr` means one merge archives once however many sessions in the checkout observed it. A busy workspace defers because archive drains its processes before moving the checkout. A merged PR stays merged, so the hook is re-evaluated on every tick while the session is still polled and deduped by the ledger. An archived workspace leaves the poll set on its own. Startup recovery validates a retained checkout and repairs Git registration after an interrupted move.

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
Isolated workspaces retain discovery on their owned branch.

Migration v49 preserves historical links as unverified and retains the cached
GitHub state. Incremental event repair uses original event identities and times
to recover stronger evidence. A dismissal survives repair and later polling.
Pinning an unverified PR confirms it as a reference, not as work eligible for
automatic editing.

Primary selection uses a user pin first. Automatic selection prefers open PRs
with work evidence, then other worked PRs, then references. Within each group,
the latest meaningful session activity wins, with the PR number as a stable
tie-breaker. Refresh timestamps never select a PR. A workspace projects the
same most recently active session that its chat displays.

The workspace card shows the primary PR and expandable history, including
individual state, branch, and exact links. The sidebar aggregates verified
associations: any open PR wins, all merged shows merged, and other terminal
combinations show closed. Running and awaiting-input markers retain their
precedence. Priority uses actual PR changes rather than polling freshness.

Existing PR links open their exact stored URL. The separate create action
validates the displayed checkout branch against Git and supplies `--head` to
`gh pr create`. It may open an existing PR for that branch, but opening one
does not promote it to session work. Shared cards call the branch header
“Checkout branch” because historical PRs can belong to other branches.

Refreshes serialize per project PR across service instances. Failed reads
retain cached state and expose the refresh error. Merged state cannot regress,
and closed PRs remain eligible for refresh so reopening can be observed.

IPC channels:
- `prs:list-for-session`
- `prs:refresh`
- `prs:set-primary` (a null PR number returns to automatic selection)
- `prs:dismiss`
- `git:view-or-create-pr` (checkout creation action, with optional expected branch)

Workspace summaries expose the plural `prs`, aggregate `prSummaryState`, and
legacy scalar primary fields. `prCreatedAt` and `prMergedAt` retain GitHub's
milestone timestamps for the optional Appearance celebration. That celebration
defaults off and does not run on ordinary turn completion.
