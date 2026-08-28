# Workspaces, Review, Files, Git

Rust owns workspace lifecycle and git operations.

## Workspaces

[src-tauri/src/workspaces](../src-tauri/src/workspaces) creates isolated/current workspaces, refreshes status, pins, archives, keeps, and opens IDEs. Active workspaces subscribe to a filesystem watcher at creation and on startup recovery. Watches are keyed by canonical checkout path, not by workspace, so the many sessions that share one checkout cost a single OS watch and a single debounced refresh between them. The watch is torn down when its last subscriber unsubscribes. Watchers use a capacity-one dirty signal, a 200 ms trailing debounce, and a one-second maximum refresh interval so continuous churn cannot starve status updates. Events confined to `.git/objects`, `.git/lfs`, `.git/fsmonitor--daemon`, or `*.lock` files are dropped before the debounce because they cannot change status. One refresh reads branch and dirty state with a single `git status --porcelain --branch` and applies it to every subscribed workspace. Refresh loops spawn on Tauri's async runtime so install is safe from sync IPC such as `create_current`. Startup restore skips a checkout whose path is gone (`WATCHER_PATH_MISSING`) instead of treating that as a recursive-watch fallback.

Archive first persists the authoritative `archiving` state and closes admission for providers, checks, and terminals through the shared workspace lifecycle gate. It then cancels those three process owners concurrently under one bounded quiescence wait, expires pending approvals, closes the watcher, refreshes git status, removes an isolated worktree, and finally persists `archived`. A dirty non-forced archive returns to `kept` without tearing down a still-live checkout. Failures before teardown restore the prior state. Once teardown has begun, failures persist `archive-failed`, keep admission closed, and leave the watcher available only when the path still exists. Startup finalizes an isolated `archiving` row as `archived` only when its path is absent and Git no longer registers the worktree. Other stranded rows become `archive-failed` instead of triggering a destructive retry. Use Keep or Retry Archive explicitly.

The launcher composer exposes this choice per launch via the "Worktree" toggle (off by default → current checkout), persisted to `localStorage` (`argmax.workspaceMode`). `worktree` calls `create_isolated` (forking `argmax/<slug>` from the live branch); `current` calls `create_current` (shared checkout). See [src/renderer/lib/workspaceMode.ts](../src/renderer/lib/workspaceMode.ts).

## Sidebar Priority section

The sidebar floats attention-worthy workspaces (session `attention` of `approval-needed`, `blocked`, `failed`, or `review-ready`; `archived`/`kept` excluded) into a Priority section directly under Pinned and above the date/project groups, sorted by severity then oldest-waiting. Attention older than 24 hours — or of unknown age (pre-migration rows have no `attention_changed_at`) — is history, not triage, and stays out of the section. The selector is pure and client-side: [src/renderer/lib/priority.ts](../src/renderer/lib/priority.ts) joins `snapshot.sessions` attention onto workspaces, so it updates via normal `dashboard:delta` merges.

A workspace lives in exactly one sidebar section. Pinned takes precedence over Priority: a pinned workspace stays in Pinned even when it has fresh attention or a manual add. Unpinned Priority rows leave their date/project group and drop back when resolved, dismissed, aged out, or pinned.

Section order top to bottom is Pinned, Priority, then Today, Last 7 Days, Last 30 Days, and Older in sessions view (or project groups in projects view). Empty recency buckets are omitted. The sidebar has no section title bar, because the recency labels already name the list. In sessions view the newest non-empty recency bucket doubles as the list header: its label and collapse chevron sit on the left, and the "Sidebar view options" and "Add Project" actions sit on the right. Every section header keeps its chevron in the same place, tucked against the label rather than out at the row's right edge. Pinned and Priority collapse the same way and persist through the same `argmax.sidebar.collapsedDateGroups` set under the keys `pinned` and `priority`, but they never host the "…" and "+" actions. Projects view (and a sessions view with no bucket to host them) keeps those two actions in a quiet label-less strip above the groups, so view-mode switching is always reachable. Pinned stays first because a pin is a standing user choice, while Priority is transient triage. Rows outside a project group carry the owning project's name as a muted second line with no leading folder glyph, matching the sidebar's plain title-plus-subtitle density. Only a live signal earns a leading mark: running, awaiting input or approval, failed, and open or merged pull requests. Idle and completed rows are text only, though they keep the marker column reserved so every title lines up. Custom icons still render on any row that has one.

Right-click → "Remove from priority" calls `workspaces:set-priority-dismissed`, stamping `workspaces.priority_dismissed_at` (and clearing any manual add). A dismissal only suppresses the row while it is newer than the session's `attention_changed_at` (stamped in `update_session_state` whenever the attention value changes), so fresh attention re-promotes the workspace without any server-side clearing. Right-click → "Add to priority" on an unpinned, non-priority row calls `workspaces:set-priority-added` (`workspaces.priority_added_at`): a manual add needs no attention, never ages out, and clears any standing dismissal. Pinned rows do not offer that action, because a pin already chooses their section. The section is toggleable in Settings → General (`argmax.sidebar.priority.visible`, default on).

## Custom row icons

Right-click → "Edit Icon" opens a popover with a color swatch row, a search field, and a grid of curated Lucide icons ([src/renderer/lib/sessionIcons.ts](../src/renderer/lib/sessionIcons.ts)). Picking an icon calls `workspaces:set-icon`, which writes `workspaces.icon` and `workspaces.icon_color`, so the choice is per workspace row and survives restart. The first swatch is "Default icon": it sends both values as null and returns the row to its default leading mark.

A custom icon replaces the leading status marker, so live state moves to a small corner dot on the glyph. The dot follows the marker's own precedence (awaiting input, then running, then merged/open PR, then failed) and reuses the same tokens, so nothing about running / failed / PR / awaiting is lost.

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
otherwise be read as an untracked add and diffed against the wrong side. A base
branch that no longer resolves downgrades every scope to the working tree
rather than failing the request.

"Last turn" has no git equivalent because git does not know what a turn is, so it
comes from the transcript: [lastTurnFiles.ts](../src/renderer/lib/lastTurnFiles.ts)
collects the paths of every file-writing tool call after the newest
`user.message` and narrows the branch list to them. It reuses the branch query,
so switching into it costs no git work, and it matches by path suffix because
Claude reports absolute tool paths while Codex reports relative ones. The scope
is only offered where a transcript exists, so the launcher's panel omits it.

## Files

[src-tauri/src/files/workspace_files.rs](../src-tauri/src/files/workspace_files.rs) powers file tree, preview, mtime-checked writes, stats, and content grep. Every path resolves through [workspace_paths.rs](../src-tauri/src/util/workspace_paths.rs) to prevent traversal outside the workspace/project root.

## Git

[src-tauri/src/git](../src-tauri/src/git) exposes argv-only git execution plus commit, push, branch creation, and PR view/create actions. Do not shell-interpolate user-controlled git args.
