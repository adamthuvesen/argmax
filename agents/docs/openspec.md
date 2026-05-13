# OpenSpec

Argmax uses OpenSpec for change tracking. Artifacts live under [openspec/](../../openspec/).

## Layout

```
openspec/
├── changes/         Proposed and active changes — each has proposal.md, tasks.md, specs/* (delta specs)
│   └── archive/     Completed changes after archival
├── specs/           Main specs (the source of truth, populated as changes archive)
└── custom/          Repo-specific extensions
    ├── ralph/       Ralph autonomous-loop spec
    ├── issues/      Issue notes / bug receipts
    └── reviews/     Code-review checklists
```

A change folder may not be present until you propose one; `archive/` and `specs/` populate as work flows through.

## Workflow

A non-trivial change goes:

1. **Propose** — `/opsx:propose` (or `/opsx:interview` → `/opsx:propose`) scaffolds `openspec/changes/<slug>/{proposal.md, tasks.md, specs/*.md}`.
2. **Implement** — `/opsx:apply` walks the task list one item at a time. For test-first work use `/opsx:impl-tdd` instead — it parses `WHEN/THEN` scenarios, writes a failing acceptance test per scenario, then runs a bounded red-green loop with per-scenario commits.
3. **Verify** — `/opsx:verify` cross-checks each spec scenario against the implementation.
4. **Archive** — `/opsx:archive` syncs delta specs into `openspec/specs/` and moves the change folder to `openspec/changes/archive/`.

`/opsx:sync` exists for the edge case of updating main specs from a delta without archiving.

## Editing rules

- **Never modify scenarios outside the stated delta.** Each delta must be reviewable in isolation; reaching outside it makes archival unsafe.
- Scenarios use `WHEN ... THEN ...` framing. They become the acceptance tests under `/opsx:impl-tdd`.
- `tasks.md` is the running checklist — check items off as you go, but treat the proposal + spec deltas as the load-bearing artifacts.
- Skill workflows live in `~/.claude/agents/` (user-global). This doc only points at them.
