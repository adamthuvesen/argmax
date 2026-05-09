# OpenSpec

This project uses OpenSpec for change tracking. Specs live under [openspec/](../../openspec/):

- `openspec/changes/` — proposed and active changes; each has `proposal.md`, `tasks.md`, and `specs/` (delta specs)
- `openspec/changes/archive/` — completed changes after archival
- `openspec/specs/` — main specs (the source of truth, populated as changes archive)
- `openspec/custom/` — repo-specific extensions (audit notes, ralph runner config)

## Workflow

A non-trivial change goes:

1. **Propose** — `opsx-propose` skill scaffolds `openspec/changes/<slug>/{proposal,tasks,specs/*}.md`
2. **Implement** — `opsx-apply` walks the task list one item at a time
3. **Verify** — `opsx-verify` checks that scenarios in spec deltas match the implementation
4. **Archive** — `opsx-archive` syncs delta specs into `openspec/specs/` and moves the change folder to `archive/`

For test-first work, use `opsx-impl-tdd` instead of `opsx-apply` — it parses scenarios, writes failing acceptance tests per scenario, then runs a bounded red-green loop with per-scenario commits.

## Editing rules

- **Never modify scenarios outside the stated delta.** Each delta is meant to be reviewable in isolation; reaching outside it makes archival unsafe.
- Scenarios use `WHEN ... THEN ...` framing. They become the acceptance tests in `opsx-impl-tdd` mode.
- `tasks.md` is the running checklist for implementation; check items off as you go, but treat the proposal + spec deltas as load-bearing artifacts.
