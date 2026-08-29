# Workspaces, Review, Files, Git

Rust owns workspace lifecycle and git operations.

## Workspaces

[src-tauri/src/workspaces](../src-tauri/src/workspaces) creates isolated/current workspaces, refreshes status, pins, archives, keeps, and opens IDEs. Active workspaces subscribe to a filesystem watcher at creation and on startup recovery. Watches are keyed by canonical checkout path, not by workspace, so the many sessions that share one checkout cost a single OS watch and a single debounced refresh between them. The watch is torn down when its last subscriber unsubscribes. Watchers use a capacity-one dirty signal, a 200 ms trailing debounce, and a one-second maximum refresh interval so continuous churn cannot starve status updates. Events confined to `.git/objects`, `.git/lfs`, `.git/fsmonitor--daemon`, or `*.lock` files are dropped before the debounce because they cannot change status. One refresh reads branch and dirty state with a single `git status --porcelain --branch` and applies it to every subscribed workspace. Refresh loops spawn on Tauri's async runtime so install is safe from sync IPC such as `create_current`. Startup restore skips a checkout whose path is gone (`WATCHER_PATH_MISSING`) instead of treating that as a recursive-watch fallback.

Archive splits by workspace kind. A shared-checkout workspace has no destructive step — no worktree removal, no branch change — so archive persists `archived` immediately (the row can never bounce back into the sidebar), closes admission through the lifecycle gate, and drains providers, checks, terminals, and pending approvals in a background task whose failures are logged per subsystem rather than resurrecting the row. An isolated worktree keeps the strict sequence: archive persists the authoritative `archiving` state, closes admission, waits for in-flight admissions, then cancels the three process owners concurrently — each under its own bounded wait with a subsystem-specific error (`WORKSPACE_PROVIDER_TIMEOUT`, `WORKSPACE_CHECK_TIMEOUT`, `WORKSPACE_TERMINAL_TIMEOUT`) so a failed archive names the culprit — expires pending approvals, closes the watcher, re-checks git status, removes the worktree, and finally persists `archived`. A dirty non-forced archive returns to `kept` without tearing down a still-live checkout; the renderer re-prompts once with the fresh change count and retries with `force` on confirmation, so a stale snapshot cannot silently bounce the row. Failures before teardown restore the prior state. Once teardown has begun, failures persist `archive-failed`, keep admission closed, and leave the watcher available only when the path still exists; the sidebar row shows the failed cross. Startup finalizes a shared `archiving` row as `archived` (nothing destructive was pending) and an isolated one only when its path is absent and Git no longer registers the worktree. Other stranded rows become `archive-failed` instead of triggering a destructive retry. Use Keep or Retry Archive explicitly.

The launcher composer exposes this choice per launch via the "Worktree" toggle (off by default → current checkout), persisted to `localStorage` (`argmax.workspaceMode`). `worktree` calls `create_isolated` (forking `argmax/<slug>-<short-id>` from the launch's base ref, falling back to the project's default branch); `current` calls `create_current` (shared checkout). See [src/renderer/lib/workspaceMode.ts](../src/renderer/lib/workspaceMode.ts).

A project's setup command (Settings → Projects) runs once inside each freshly created isolated worktree, after `git worktree add` and before `create_isolated` returns — so the agent that launches next finds its dependencies in place. It runs through `CheckService`, which gives it the standard destructive-command gate, five-minute timeout, output capture, and a persisted check row. A failing or timed-out setup command never blocks the workspace: creation still succeeds and the failure is visible as the check row. Shared-checkout workspaces skip it (the checkout already has its dependencies). The renderer shows a toast while a launch waits on it, since a slow `npm install` would otherwise read as a hung launch.

## Scratch workspaces (repo-less side chats)

`workspaces:create-scratch` creates a workspace with no user repository behind
it: a per-chat directory under the app data dir's `local-state/side-chats/`,
initialized as a minimal git repo (one empty commit on `main`, explicit
identity, signing off) because provider CLIs assume a checkout — Codex refuses
to run outside one. With HEAD resolving, every git-touching subsystem (status
watcher, review plumbing, checks) works normally instead of needing gating;
repo-coupled UI hides itself off `workspace.kind` instead.

`workspaces.kind` (migration v15) distinguishes `git` (real checkouts, both
worktree and shared), `scratch` (visible side chats), and `popup` (ephemeral
"More details" mini-sessions, excluded from the sidebar). All scratch rows are
owned by a hidden singleton project with the stable id `scratch-side-chats`
(`SCRATCH_PROJECT_ID` in Rust and `src/shared/types.ts`); its `repo_path` is
the scratch root, which satisfies the schema without pointing at a user repo.
The renderer must exclude that project from repo pickers and per-project
grouping. Scratch rows persist `shared_workspace = true` deliberately: archive
takes the state-flip-plus-teardown path, and the directory is left in place
(it is app-owned and cheap).

Side chats launch through the normal new-session launcher, not a dedicated
surface: the launcher's context picker offers "Side chat — no repository"
alongside the projects, which flips
[LaunchSurface](../src/renderer/components/LaunchSurface.tsx) into chat mode —
same composer, model picker, and agent-mode toggle, but no branch, worktree,
review panel, or file autocomplete, and a launch calls
`workspaces:create-scratch` instead of the worktree/checkout paths. Chat-mode
drafts key off `SCRATCH_PROJECT_ID` so they never mix with a project's unsent
prompt. The sidebar gives side chats their own always-bottom "Side chats"
section (both view modes); its "+" opens the launcher pre-set to chat mode,
while every plain new-session entry point resets it to project mode. A
transcript selection's "Ask in side chat" action rides the same launch path
with a seeded prompt (see [chat-cards.md](chat-cards.md)).

`popup`-kind scratch workspaces back the "More details" explainer popup and
are fully ephemeral: they never appear in the sidebar (kind gating), only one
exists at a time, and closing the popup terminates the session and archives
the workspace (`force: true` — its contents are discard-on-close by design).
Archiving a popup also deletes its scratch directory (confined to the scratch
root) once the background teardown drains its processes; visible side chats
keep theirs. A renderer sweep archives any non-archived popup rows left
behind by a crash, so they cannot accumulate against the dashboard row
budget.

## Sidebar Priority section

The sidebar floats attention-worthy workspaces (session `attention` of `approval-needed`, `blocked`, `failed`, or `review-ready`; `archived`/`kept` excluded) into a Priority section directly under Pinned and above the date/project groups, sorted by severity then oldest-waiting. Attention older than 24 hours — or of unknown age (pre-migration rows have no `attention_changed_at`) — is history, not triage, and stays out of the section. The selector is pure and client-side: [src/renderer/lib/priority.ts](../src/renderer/lib/priority.ts) joins `snapshot.sessions` attention onto workspaces, so it updates via normal `dashboard:delta` merges.

A workspace lives in exactly one sidebar section. Pinned takes precedence over Priority: a pinned workspace stays in Pinned even when it has fresh attention or a manual add. Unpinned Priority rows leave their date/project group and drop back when resolved, dismissed, aged out, or pinned.

Section order top to bottom is Pinned, Priority, then Today, Last 7 Days, Last 30 Days, and Older in sessions view (or project groups in projects view). Empty recency buckets are omitted. The sidebar has no section title bar, because the recency labels already name the list. In sessions view the newest non-empty recency bucket doubles as the list header: its label and collapse chevron sit on the left, and the "Sidebar view options" and "Add Project" actions sit on the right. Every section header keeps its chevron in the same place, tucked against the label rather than out at the row's right edge. Pinned and Priority collapse the same way and persist through the same `argmax.sidebar.collapsedDateGroups` set under the keys `pinned` and `priority`, but they never host the "…" and "+" actions. The Priority header instead carries a hover-revealed "Clear" button in that column, which dismisses every row the section holds in one go. Projects view has the same shape: a "Projects" header sits where the newest recency bucket does and hosts the same two actions, so both views start their list on the same line. It only names the grouping. Nothing collapses from it. A sessions view with no bucket to host the actions falls back to a quiet label-less strip above the groups, so view-mode switching is always reachable. Pinned stays first because a pin is a standing user choice, while Priority is transient triage. Each app launch opens with Pinned expanded and every other section collapsed, so a fresh window shows the standing pins and nothing else. Mid-session toggles persist and survive a re-mount, and the next launch collapses everything but Pinned again. A sessionStorage marker (`argmax.sidebar.bootGroupCollapseSeeded`, alongside `argmax.sidebar.bootCollapseSeeded` for project groups) makes that seed fire once per launch rather than once per mount. Rows outside a project group carry the owning project's name as a muted second line with no leading folder glyph, matching the sidebar's plain title-plus-subtitle density. Only a live signal earns a leading mark: running, awaiting input or approval, failed, and open or merged pull requests. Idle and completed rows are text only, though they keep the marker column reserved so every title lines up. Custom icons still render on any row that has one.

Right-click → "Remove from priority" calls `workspaces:set-priority-dismissed`, stamping `workspaces.priority_dismissed_at` (and clearing any manual add). Opening any attention-driven Priority session and then leaving it (another session, the launcher, Settings, or another project) stamps the same dismissal — Priority is an unread list, and opening the session is reading it. A workspace that still has a `running` session is not demoted by that navigation, because a live turn is still a priority reason, and a purely manual add (no attention) stays until explicitly removed. A dismissal only suppresses the row while it is newer than the session's `attention_changed_at` (stamped in `update_session_state` whenever the attention value changes), so a later wait after more agent work re-promotes the workspace without any server-side clearing. Right-click → "Add to priority" on an unpinned, non-priority row calls `workspaces:set-priority-added` (`workspaces.priority_added_at`): a manual add needs no attention, never ages out, and clears any standing dismissal. Pinned rows do not offer that action, because a pin already chooses their section. "Clear" on the Priority header is the bulk form of the dismissal: one `workspaces:set-priority-dismissed` per listed workspace, which empties both flavors of entry (dismissal clears a manual add) and drops the rows back into their date or project group. The section is toggleable in Settings → General (`argmax.sidebar.priority.visible`, default on).

## Custom row icons

Right-click → "Edit Icon" opens a popover with a color swatch row, a search field, and a grid of curated Lucide icons ([src/renderer/lib/sessionIcons.ts](../src/renderer/lib/sessionIcons.ts)). Picking an icon calls `workspaces:set-icon`, which writes `workspaces.icon` and `workspaces.icon_color`, so the choice is per workspace row and survives restart. The first swatch is "Default icon": it sends both values as null and returns the row to its default leading mark.

A custom icon replaces the leading status marker, so live state moves to a small corner dot on the glyph. The dot follows the marker's own precedence (awaiting input, then merged/open PR, then failed) and reuses the same tokens, so nothing is lost. A turn in flight is the exception: the working marker takes the cell back for as long as it runs, and the icon returns when the turn ends.

## Review

Changed files are listed and diffs are loaded for workspace or project targets
through one command surface in
[src-tauri/src/review/git_review.rs](../src-tauri/src/review/git_review.rs).

### Changes scope

The Changes view's scope chip picks which slice of the work to show. It
defaults to the whole branch, so a reader sees what the task changed without
having to know what was committed when.

| Scope | `ReviewComparison` | Git range |
|---|---|---|
| All on branch (default) | `branch` | `merge-base(base_ref, HEAD)` → working tree, plus untracked |
| Committed | `committed` | `merge-base(base_ref, HEAD)..HEAD` |
| Uncommitted | `workingTree` | `HEAD` → working tree, plus untracked |
| Last turn | `branch`, narrowed client-side | not applicable |

`ReviewBaseline` carries the resolved base ref into `resolve_comparison`.
Committed mode phrases its base as a `<merge-base>..HEAD` range so every
`git diff <base> -- <path>` call site works unchanged. It also skips the
working-tree probes, because a file that is both committed and dirty would
otherwise be read as an untracked add and diffed against the wrong side.

The comparison base is the workspace's recorded `base_ref`, then the project's
default branch, then `main` or `master`. For those integration names, review
prefers `origin/<name>` when the remote-tracking ref exists and shares a
merge-base with HEAD, so a stale local `main` does not count already-rebased
upstream commits as this branch's work. Argmax does not fetch. A candidate that
resolves to the same commit as HEAD is skipped, because that comparison is
empty. Shared-checkout sessions (`create_current`) store the project default
as `base_ref`. Isolated worktrees still store the fork point. After the agent
commits there, that fork point is no longer HEAD and the review shows only this
task's commits. A base that no longer resolves, and has no fallback, downgrades
every scope to the working tree rather than failing the request.

"Last turn" has no git equivalent because git does not know what a turn is, so it
comes from the transcript: [lastTurnFiles.ts](../src/renderer/lib/lastTurnFiles.ts)
collects the paths of every file-writing tool call after the newest
`user.message` and narrows the branch list to them. It reuses the branch query,
so switching into it costs no git work, and it matches by path suffix because
Claude reports absolute tool paths while Codex reports relative ones. The scope
is only offered where a transcript exists, so the launcher's panel omits it.

## Files

[src-tauri/src/files/workspace_files.rs](../src-tauri/src/files/workspace_files.rs) powers file tree, preview, mtime-checked writes, stats, and content grep. Every path resolves through [workspace_paths.rs](../src-tauri/src/util/workspace_paths.rs) to prevent traversal outside the workspace/project root.

The review file tree uses `@react-symbols/icons` to map known filenames, extensions, and folder names to Symbols theme icons. The expand chevron remains the source of truth for folder state. Argmax overrides `CLAUDE.md` and `Cargo.toml` with Claude and Rust icons. The library owns the broader mapping, including `package.json`, `.gitignore`, TypeScript configs, Vite configs, and common language extensions.

Folder glyphs wear the app accent instead of the library's slate. Every Symbols folder icon — plain, open, and the monochrome parts of badged variants — is painted in `#64748B`, so [overlays-review-files.css](../src/renderer/styles/overlays-review-files.css) retints exactly that value to `var(--accent)` under `.workspace-tree-dir`. File-type icons and the saturated badge marks that tell `src` from `assets` keep the library's own colors. A library color change breaks the tint, which is why the accent CSS contract test pins the slate.

## Git

[src-tauri/src/git](../src-tauri/src/git) exposes argv-only git execution plus commit, push, branch creation, and PR view/create actions. Do not shell-interpolate user-controlled git args.
