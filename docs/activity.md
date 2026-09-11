# Activity

The Activity page (sidebar → Hacking, the view it opens on) shows the user's
own engineering output over the last 24 hours, 7 days, 30 days, 12 months, or
the current calendar year: commits and lines, a per-repository ledger, a chart,
a year of contribution days, streaks, working cadence, and the pull requests and
reviews that went with them.

It counts the person, not the app. Commits come out of `git log` in every
registered project's main checkout, on **every branch**, whether Argmax
launched the session that wrote them or the user typed them in a terminal —
the same number `git log --author=you` would give. Pull requests and reviews
come from `gh` under the signed-in account, so they include repositories
Argmax has never opened.

The page arrives in one piece. The local ledger is authoritative and is swept
inline on every read once it has completed once, so the commits are current.
The GitHub half is a cache: the read answers with whatever is stored and kicks
a refresh off behind it, which means the first open after signing in shows no
pull requests and the next one does. Nothing on the page waits on the network.

`ActivitySummary::previous` is the one comparison the renderer cannot work out
for itself: the same-length window immediately before this one, narrowed the
same way, so the page can say "312 commits, up 18% on the previous 30 days".
It is cut on local dates rather than by subtracting hours, so a DST change does
not slide the edge, and it is `null` when the commit ledger cannot honestly
cover that earlier window — when the ledger holds nothing inside it, or when
its oldest commit starts after the window began. A first install must not read
as up 100%.

## Sources

| Half | Source | Record |
|---|---|---|
| Commits | `git log --all --no-merges --numstat` in each `projects.repo_path` | one row per SHA in `activity_commits` |
| Author identity | `git config user.email` in each repo, plus `git config --global user.email` | the union is `authorEmails` |
| Pull requests | `gh api graphql` → `search(query: "author:<login> is:pr created:>=…")` and a second search on `merged:>=…` | `activity_github_prs` |
| Reviews | `gh api graphql` → `search(query: "reviewed-by:<login> -author:<login> is:pr updated:>=…")` with nested `reviews(author: <login>)` | one row per submission in `activity_github_reviews` |
| Login | `gh api user --jq .login` | `activity_github_meta.login` |

The ledger reaches back **13 months** (`LEDGER_MONTHS` in
[activity/mod.rs](../src-tauri/src/activity/mod.rs)) — twelve for the longest
window plus a month of slack, so the 12-month window's `previous` has
something to stand on.

## Counting rules

These are the rules that make the numbers right. Each has a fixture test.

- **A commit belongs to the user when its author email is one of
  `authorEmails`.** `--author` is passed to git as a `--fixed-strings` filter
  so an address with a `+` or a `.` in it cannot match more than itself, and
  the parser re-checks the match case-insensitively — `--author` matches a
  substring of `Name <email>`, so a colleague whose address contains the
  user's would otherwise slip through.
- **Every branch, once.** `--all` reaches worktree branches through the main
  checkout, and a SHA reachable from two refs is stored once. Merge commits
  are excluded: their diff is not work anyone wrote.
- **A rebase must not double-count.** Each sweep re-reads a project's whole
  13-month span and deletes that project's rows from the span's start before
  inserting, so a rewritten branch replaces its old SHAs instead of leaving
  them behind.
- **Binary files change a file, not lines.** `numstat` reports `-` for both
  counts; the row counts as one file and zero lines. A rename prints its path
  as `src/{old => new}.rs`, which the counts ignore.
- **Timestamps are stored as RFC 3339 UTC**, never as git printed them. The
  ledger is range-scanned as text, and `2026-09-01T10:00:00+02:00` does not
  sort against `2026-09-01T09:30:00Z`. Buckets are cut on the committer date;
  the author date is carried but not bucketed on.
- **A project removed from `projects` is forgotten** by the next sweep. A
  repository that moved or stopped being a checkout keeps its rows and is
  logged, because the project is still there.
- **`prsClosed` is closed without merging.** GitHub stamps `closedAt` on a
  merge too, so a merged PR is only ever counted as merged.
- **A PR counts by the event that happened in the window.** One opened last
  year and merged last week is in `prsMerged` but not `prsOpened`, which is why
  the refresh runs two searches. `pullRequests` is ordered by newest activity,
  so that PR leads the list it only joined because of the merge.
- **A PENDING review was never sent**, so it has no `submittedAt` and is not a
  review the user gave. One row per submission: approving a PR you had already
  commented on is two reviews.
- **`reviewsGiven` excludes the user's own PRs** — the search does it with
  `-author:<login>`.

## Windows and buckets

Every boundary is cut on the IANA zone the renderer names in `timeZone`, not on
the machine's zone, and an unknown name is rejected rather than falling back to
UTC. `rangeEnd` is always *now*: a window that ran to the end of today would
claim hours that have not happened.

| Window | `rangeStart` | Resolution | Buckets |
|---|---|---|---|
| `24h` | the current local hour, 23 hours back | hour | 24 |
| `7d` / `30d` | local midnight 6 / 29 days ago | day | 7 / 30 |
| `12m` | local midnight 12 months ago | week | first bucket to the next Monday, then Mondays |
| `year` | local midnight on January 1 | week | same |

A week window's first bucket is short: it starts at `rangeStart` and runs to
the following Monday. Snapping `rangeStart` back to a Monday instead would make
the calendar year start in December, and no bucket may begin outside the range
it sums.

`previous` steps back by the same shape: 24 hours for `24h`, 7 or 30 local
days, 12 local months, and for `year` the same number of days as have elapsed
since January 1.

## What narrows and what does not

Choosing a project narrows `totals`, `previous`, `series`, `streaks`,
`cadence`, `pullRequests` (through the project each repository maps to),
`reviews`, and `medianCycleSeconds`.

`repositories` and `heatmap` never narrow — the same rule the Usage tiles
follow. Their shares stay shares of the whole window while one project is in
focus, so `ActivityRepository::share` is that repository's commits over the
window's commits **across every repository**, not over the narrowed total.

Two more scopes worth naming, because they are not the window:

- `streaks.currentDays` and `streaks.longestDays` run over every local day the
  ledger holds. A 40-day streak is a 40-day streak whether or not the 7-day
  view can see all of it. A streak counts as current while today is still
  open, so yesterday's commit keeps it alive until midnight.
- `streaks.busiestDay` is the exception and is scoped to the window.
- `ActivityRepository::lastCommitAt` is the newest commit in the whole ledger,
  so a repository with a quiet month still says when it was last touched.

A pull request is matched to a local project through that project's stored
GitHub remote, compared case-insensitively. A repository with no registered
project keeps `projectId: null` and still counts in the unnarrowed totals.

## Scan

[activity/scanner.rs](../src-tauri/src/activity/scanner.rs) sweeps every
project in the `projects` table into `activity_commits` (migration v44, see
[data.md](data.md)).

- Four repositories are read at once. Each is one `git log` subprocess; the
  sweep runs on the blocking pool and owns a throwaway current-thread runtime
  for the fan-out rather than borrowing the app's shared workers.
- One repository failing does not fail the sweep. It is logged and skipped.
- `PARSER_VERSION` is stored in `activity_scan_meta`; bumping it empties the
  ledger and rescans.
- The sweep also resolves each project's GitHub remote while it holds a writer
  connection, because `projects::get_project_remote` shells out to git and
  stores what it finds — the summary's pooled read-only connection cannot.
- The first sweep is cold and runs in the background when the page is first
  opened; the page shows "Scanning N of M repositories". Later sweeps are warm
  and run inline on every `activity:summary`.
- At boot, a ledger that has completed before is refreshed in the background.
- After the dashboard is ready, the renderer prefetches the default 30-day
  summary on an idle tick and stores it in memory, so the first Activity open
  can paint from cache while a warm sweep runs on Rust's blocking pool.
  Hovering Hacking in the sidebar kicks the same warm if idle prefetch has
  not finished yet.

## GitHub cache

[activity/github.rs](../src-tauri/src/activity/github.rs) runs through the
shared [gh_runner](../src-tauri/src/util/gh_runner.rs), so tests stub `gh`
rather than the network.

- A refresh runs at most every 10 minutes (`REFRESH_INTERVAL`). GitHub's
  search API is the rate-limited one, and the page is opened far more often
  than a PR changes state.
- A failed refresh stores `last_error` and keeps the cache. `github.error`
  carries the reason while cached rows are still being served, so a flaky
  network shows yesterday's numbers with a note rather than an empty page.
  The next attempt waits `RETRY_INTERVAL` (1 minute) from the last one, and
  only one refresh runs at a time, so a page read that lands mid-fetch or
  mid-outage does not restart the paginated walk.
- `github.available` is false until the app knows which account this is.
  Missing `gh` and a signed-out `gh` both say so in plain English; the local
  half of the page renders either way.
- A different login drops the cached rows. They belong to another account and
  would otherwise be counted as this one's work.
- GraphQL reports failures inside a 200 body, so an `errors[]` answer is an
  error, never "you have no pull requests".

## Checking the numbers

The commit half is checkable directly. For one project:

```bash
git -C <repo_path> log --all --no-merges --oneline \
  --since="13 months ago" --fixed-strings --author="$(git config user.email)" | wc -l
```

That count should match the sum of `repositories[].commits` for that project
over the `12m` window, allowing for the window being 12 months rather than 13.
