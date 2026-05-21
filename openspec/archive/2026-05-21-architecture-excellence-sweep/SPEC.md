# Argmax Architecture Excellence Sweep

## Goal

Raise Argmax's architecture and code quality without changing product behavior. The end state is a smaller, clearer codebase with verified contracts, fewer oversized UI/service surfaces, no AI-slop cleanup opportunities left in the touched areas, and an audit trail explaining every meaningful keep/change decision.

## Context

Argmax is an Electron desktop app with `src/main/` services and IPC, a React/Vite renderer in `src/renderer/`, and shared Zod/type contracts in `src/shared/`. The project is already mature: docs in `agents/docs/` are mandatory before touching a subsystem, SQLite migrations are append-only/checksummed, renderer state is dashboard-delta driven, provider output rendering depends on normalized timeline events rather than raw JSONL, and tests query by role/aria-label/title rather than styling hooks.

This spec replaces the older UX-polish Ralph loop currently present in `openspec/custom/ralph/`. Treat existing `PROGRESS.md` and `FINDINGS.md` as stale artifacts from that loop until the first task initializes fresh state for this architecture sweep.

Discovery already found these real evidence points:

- Large files that deserve careful review before any split: `src/renderer/components/SessionConversation.tsx` (~1,623 lines), `src/renderer/App.tsx` (~1,365), `src/main/providers/providerSessionService.ts` (~1,200), `src/main/persistence/migrations.ts` (~1,126), `src/main/providers/providerEventNormalizer.ts` (~890), `src/shared/types.ts` (~901), `src/shared/ipcSchemas.ts` (~785), `src/renderer/hooks/useReviewState.ts` (~729), `src/renderer/components/Sidebar.tsx` (~715), and `src/renderer/components/LaunchSurface.tsx` (~693).
- `providerSessionService.ts` and `providerEventNormalizer.ts` contain explicit 2026-05-14 architectural decision comments saying previous splits were considered and deferred. Do not split them unless fresh evidence disproves those comments with a simpler call surface and equal or better tests.
- Engram recalls recurring fragile areas: provider event normalization, hidden tool/card rendering, sub-agent echo suppression, dashboard freshness, approval resolution, and the raw-event-to-visible-UI boundary.
- Recent audits in `openspec/custom/issues/audit-2026-05-19.md` fixed several correctness bugs. Do not reopen fixed items unless the current code proves they regressed.
- Validation commands exist in `package.json`: `npm run lint`, `npm run typecheck`, `npm run build`, and `npm test`. Never run `npm test` in parallel with another `npm test` because it rebuilds native modules.

Guardrails for this loop:

- No behavior changes unless a task names a failing/fragile behavior and adds or updates a regression test.
- No new dependencies, runtimes, UI libraries, migration rewrites, or broad style sweeps.
- No "architecture astronaut" work: add an abstraction only when it removes real duplication, shrinks a hot file, clarifies a boundary, or matches an existing pattern.
- Preserve IPC, provider, migration, and dashboard contracts unless the task explicitly proves a bug.
- For each touched subsystem, read its matching `agents/docs/*.md` first and update that doc in the same task if code and docs disagree.
- One task per iteration. Make a small commit after each task that changes code and passes its validation. Never push.
- Treat "no change" as a valid excellent outcome when the evidence says the current shape is already simpler than the alternatives.

Worklist discipline:

- `ARCHITECTURE_AUDIT.md` is the control artifact. Candidate changes must be recorded there before implementation begins.
- Every candidate gets an id (`A1`, `A2`, `B1`, etc.), file:line evidence, expected simplification, risk, affected tests, and one of these states: `candidate`, `in_progress`, `done`, `keep`, `deferred`, or `rejected`.
- Ralph may implement only one candidate per iteration. If a candidate needs more than one commit, split it before editing.
- A candidate is too large if it touches more than one subsystem, requires more than one new public API, or cannot be verified by a focused test command. Split it or mark it `deferred`.

## Tasks

- [ ] **[HIGH]** Initialize this architecture sweep state. Replace stale UX-polish state in `openspec/custom/ralph/PROGRESS.md` with a fresh log for this spec, preserve any old content in an archive note or clearly labelled historical section, and create `openspec/custom/ralph/ARCHITECTURE_AUDIT.md` with sections for Evidence, Candidate Changes, Keep Decisions, Completed Changes, Deferred Items, and Final Verification. Validation: `git diff -- openspec/custom/ralph/PROGRESS.md openspec/custom/ralph/ARCHITECTURE_AUDIT.md` shows only Ralph bookkeeping, not implementation code.
- [ ] **[HIGH]** Produce an evidence-based architecture audit before editing source. Read `AGENTS.md`, `agents/docs/architecture.md`, `agents/docs/testing.md`, and the relevant deep docs for every area examined. Run lightweight repo scans for large files, duplicate-looking helpers, TODO/FIXME markers, `eslint-disable`, `as any`, `dashboard.load(`, `setInterval`, and oversized test fixtures. Write exact file:line evidence and a ranked candidate list to `ARCHITECTURE_AUDIT.md`. Validation: the audit names at least eight candidate or keep-decision ids with exact file:line references, expected simplification, risk, and affected validation commands; no source files are changed.
- [ ] **[HIGH]** Establish a verification baseline. Run `npm run lint`, `npm run typecheck`, and a focused fast test set covering renderer/shared/provider boundaries (`npx vitest run src/renderer/components/SessionConversation.test.tsx src/renderer/App.test.tsx src/main/providers/providerEventNormalizer.test.ts src/shared/ipcSchemas.test.ts`). Record pass/fail status and any pre-existing failures in `PROGRESS.md`. Validation: every recorded failure includes the command, failing test or lint rule, and whether it predates this loop.
- [ ] **[HIGH]** Triage the audit into an implementation worklist. Convert the evidence into prioritized candidates grouped by area: visible-chat boundary, App composition root, provider lifecycle, provider normalizer, dashboard/review state, IPC/shared contracts, renderer chrome, and touched CSS. Mark candidates `deferred` when they are broad, risky, or not clearly simpler than the current code. Validation: `ARCHITECTURE_AUDIT.md` contains a ranked list of one-iteration candidates and at least three explicit keep/defer/reject decisions.
- [ ] **[HIGH]** Implement the top-ranked visible-chat boundary candidate, if one survived triage. Start with `src/renderer/components/SessionConversation.tsx`, `src/renderer/lib/foldConversation.ts`, `src/renderer/lib/toolCalls.tsx`, `src/main/providers/providerEventNormalizer.ts`, and `agents/docs/chat-cards.md`. Move only pure hidden-tool/card/render-model logic that can be tested without prop drilling; otherwise record a keep-decision and do not edit source. Validation: existing `SessionConversation` and normalizer tests pass, and any extraction reduces `SessionConversation.tsx` by at least 75 lines or removes duplicated logic.
- [ ] **[HIGH]** Implement the top-ranked `App.tsx` composition candidate, if one survived triage. Only extract code that is pure, locally testable, and already conceptually separate: persisted UI setting readers, lazy-overlay warming, grid command handlers, or dashboard action wiring. Do not create a generic app-controller object. Validation: `App.test.tsx` passes, browser-preview behavior still uses `demoSnapshot`, and `App.tsx` shrinks or the keep-decision documents why it should remain as the composition root.
- [ ] **[HIGH]** Implement the top-ranked provider lifecycle candidate, if one survived triage. Review `src/main/providers/providerSessionService.ts` against its architectural decision comment. If one small boundary is objectively cleaner, extract only that boundary behind an existing module such as `sessionFlushQueue.ts` or a new narrowly-named module with a call surface of three functions or fewer; otherwise update `ARCHITECTURE_AUDIT.md` with a keep-decision. Validation: provider session tests pass, no behavior changes to launch/sendInput/terminate/recovery, and the decision comment remains true or is updated.
- [ ] **[HIGH]** Implement the top-ranked provider normalizer candidate, if one survived triage. Prefer adding fixture-driven tests for uncovered Claude/Codex/Cursor quirks over splitting files. Split provider handlers only if the audit proves each extracted handler has a stable boundary, shared helpers stay shared, and tests become clearer. Validation: `providerEventNormalizer.test.ts` passes with any new fixtures, usage pricing still uses `providerModels.ts`, and lifecycle protocol rows remain hidden from visible chat.
- [ ] **[MEDIUM]** Implement the top-ranked renderer state candidate, if one survived triage. Focus on `src/renderer/hooks/useDashboardSession.ts`, `src/renderer/hooks/useReviewState.ts`, `src/renderer/lib/snapshot.ts`, and their tests. Remove redundant cached state only when it can be derived from SQLite-first snapshots or dashboard deltas without extra IPC reads. Validation: focused hook tests pass, no recurring renderer polling is introduced, and `dashboard.load()` remains a compatibility path rather than an active refresh path.
- [ ] **[MEDIUM]** Implement the top-ranked IPC/shared contract candidate, if one survived triage. Focus on `src/shared/types.ts`, `src/shared/ipcSchemas.ts`, `src/main/ipc/*.ts`, and `agents/docs/ipc.md`. Consolidate repeated schema fragments only when they already describe the same contract; do not hide channel definitions behind clever factories. Validation: `src/main/__tests__/ipcHandlers.test.ts` and `src/shared/ipcSchemas.test.ts` pass, and `IPC_CHANNELS` parity remains exact.
- [ ] **[MEDIUM]** Implement the top-ranked renderer chrome candidate, if one survived triage. Focus on `Sidebar.tsx`, `SidebarSessionRow.tsx`, `LaunchSurface.tsx`, `SettingsPanel.tsx`, `ModelSelector.tsx`, `GitActionsDropdown.tsx`, `FilePopover.tsx`, `SkillPopover.tsx`, and existing hooks such as `useDismissOnOutsideOrEscape`. Extract or inline only when it removes duplicate event handling or deletes wrapper JSX. Validation: affected component tests pass and accessible labels/titles remain stable.
- [ ] **[MEDIUM]** Perform a targeted CSS/token cleanup only for components touched by earlier tasks. Use `agents/docs/styling.md`; migrate raw color/spacing/motion values to existing tokens only in touched rules, remove obsolete comments/selectors proven unused by `rg`, and avoid palette redesign. If no touched CSS has clear token or dead-selector cleanup, record a keep-decision instead. Validation: `npm run lint` passes and the touched UI still uses role/aria/title contracts in tests.
- [ ] **[MEDIUM]** Run a remove-ai-slop pass on every file changed by this loop. Remove obvious comments, single-use wrappers, impossible defensive checks, stale imports, unnecessary `eslint-disable`, and `as any` casts introduced or exposed by the work. Do not touch unrelated files. Validation: `git diff` shows simplification rather than churn, and lint/typecheck pass.
- [ ] **[LOW]** Update docs for any architectural decision changed or reaffirmed by the loop. Prefer short notes in the relevant `agents/docs/*.md` file or a decision entry in `ARCHITECTURE_AUDIT.md`; do not add broad new docs. Validation: every source-level architecture comment changed in this loop has a matching doc/audit note.
- [ ] **[LOW]** Final verification and closeout. Run `npm run lint`, `npm run typecheck`, `npm run build`, and `npm test` one at a time. Update `ARCHITECTURE_AUDIT.md` with final Completed Changes, Keep Decisions, and Deferred Items. Validation: commands pass or failures are explicitly documented as pre-existing with evidence, and `git status --short` contains only intentional files.

## Validation

- Before source edits: `npm run lint`, `npm run typecheck`, and focused Vitest commands establish a baseline.
- After each source-changing task: run the smallest relevant focused Vitest command, plus `npm run lint` and `npm run typecheck` when TypeScript or shared contracts changed.
- After provider changes: run `npx vitest run src/main/providers/providerEventNormalizer.test.ts src/main/providers/providerSessionService.test.ts src/main/providers/providerSessionService.queue.test.ts`.
- After IPC/schema changes: run `npx vitest run src/main/__tests__/ipcHandlers.test.ts src/shared/ipcSchemas.test.ts`.
- After renderer/chat changes: run the affected component/hook tests and avoid assertions by `className`.
- Final closeout: run `npm run lint`, `npm run typecheck`, `npm run build`, and `npm test` sequentially.

## Definition of Done

- `openspec/custom/ralph/ARCHITECTURE_AUDIT.md` contains the evidence scan, completed changes, keep decisions, and deferred items with file:line references.
- Every code change is tied to a task, a test/validation command, and an entry in `PROGRESS.md`.
- No new dependency, runtime, IPC behavior, migration rewrite, UI framework, or broad style sweep was introduced.
- Touched files are simpler by concrete evidence: less duplication, smaller hot component/service surfaces, clearer boundaries, or a documented keep-decision proving no change was the better architecture.
- Final `npm run lint`, `npm run typecheck`, `npm run build`, and `npm test` have passed, or any failure is documented as pre-existing with exact command output and rationale.
- `git status --short` contains only intentional architecture-sweep artifacts and source changes.

## Stop Condition

After completing each task, output:

<promise>TASK_DONE</promise>

When all tasks are complete and all definition-of-done criteria are met,
output instead:

<promise>COMPLETE</promise>

## Notes for the Agent

1. Read `openspec/custom/ralph/PROGRESS.md` at the start of every iteration
2. Pick the highest-priority incomplete task
3. Complete only one task per iteration
4. Update `openspec/custom/ralph/PROGRESS.md` with what was done, found, and decided
5. Include a machine-readable state block in `openspec/custom/ralph/PROGRESS.md`:

```text
RALPH_STATUS: TASK_DONE | COMPLETE | BLOCKED
RALPH_REMAINING_TASKS: <non-negative integer>
RALPH_LAST_TASK: <short summary>
```

6. Use `RALPH_STATUS: COMPLETE` only when all tasks are done and `RALPH_REMAINING_TASKS: 0`
7. Run validation before marking a task done
8. If blocked, document the blocker and move to the next viable task
9. Keep commits atomic and conventional; never push from this loop
10. If a task's evidence says "leave this alone", record that keep-decision and count the task complete
