# Branch names, linked repositories, and snooze shelf

Settings → Projects validates and saves a branch-name template and manages
linked repositories, a saved template names real worktree branches, and a chat
can be snoozed to a collapsed shelf and unsnoozed.

Source: scripts/verify.mjs, scripts/verification/workflows.mjs, src/renderer/components/settings/BranchTemplatePanel.tsx, src/renderer/components/settings/LinkedReposPanel.tsx, src/renderer/components/SidebarSessionRow.tsx
Inventory-id: scenario:workspace-settings

## Sub-features

- `workspace-settings` also starts chats from the New chat picker with a branch that a worktree already holds (see below), and snoozes and unsnoozes the seeded chat from its row menu, saves and rejects branch templates in Settings → Projects, links and removes a repository, and reads back worktree branch names.

## How to get to it (user POV)

Right-click a chat row to snooze it. Open Customize, then Projects, for Branch
names and Linked repositories.

## Driving it with verify.mjs

Preconditions: `launch` completed and `doctor` exits 0. No source edits during the run.

- **Run.** `node .agents/skills/verify-argmax/verify.mjs drive workspace-settings`.
- **Proof.** `native/workspace-settings.json` lists the assertions: a one-hour
  `snoozedUntil` that leaves the chat's state alone, a hidden row while the shelf is
  collapsed, a cleared time after Unsnooze; `{nope}` rejected with the placeholder
  message; the project template saved; relative and project-own paths rejected and
  the valid sibling stored as its canonical root, disabled by its toggle, and
  removed (SQLite `project_linked_repos`); and the branches `adam/feat-hello-world`
  then `adam/feat-hello-world-2` from two worktree chats. PNGs: `snooze-shelf-*`,
  `settings-branch-names`, `settings-linked-repository`.

## Gotchas

PR conflict notices have no UI and are not driven here (see the `gh::poller` tests).
The Projects nav entry and menu items are found by their visible text, so a renamed
label fails the drive at that click. The linked-repository row check reads
`SELECT * FROM project_linked_repos` and expects an `enabled` column.

## New chat picker with an occupied branch

The drive creates a worktree chat on its own branch (with a commit, so its tip differs from
main), then uses the real launcher: Switch branch, pick, Worktree toggle, type, Start agent.
Assertions (`native/workspace-settings.json`, run on the final source):
- Pick an occupied branch: no launcher error, the chip shows the branch, and the main
  checkout's branch, HEAD, status and worktree list are unchanged before Start.
- Worktree off: a new chat in the existing worktree (same real path and branch), the scripted
  provider's cwd is that path, the earlier chat's events, state and worktree are untouched, the
  main checkout is unchanged, and the earlier chat still takes a follow-up in its own checkout.
- Worktree on, same branch: a fresh `adam/` tree at a different path whose HEAD is the picked
  branch's tip, provider cwd is the new tree, main unchanged except one more worktree.
- An unoccupied branch, Worktree off: nothing on disk changes at pick time; after Start the main
  checkout is on that branch and the chat runs there.
Git itself refuses the old behavior (`'<branch>' is already used by worktree at ...`), which
is what the picker hit before the fix.
