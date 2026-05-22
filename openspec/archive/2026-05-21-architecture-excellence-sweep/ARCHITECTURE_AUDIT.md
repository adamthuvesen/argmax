# Argmax Architecture Excellence Sweep · Audit

This is the control artifact for `openspec/custom/ralph/SPEC.md`.

## Evidence

- **Docs read:** `AGENTS.md`, `agents/docs/architecture.md`, `agents/docs/testing.md`, `agents/docs/providers.md`, `agents/docs/chat-cards.md`, `agents/docs/ipc.md`, `agents/docs/data.md`, `agents/docs/styling.md`.
- **Engram recall:** recurring fragile zones are provider event normalization, hidden tool/card rendering, sub-agent echo suppression, dashboard freshness, approval resolution, and the raw-event-to-visible-UI boundary.
- **Large-file scan:** `src/renderer/components/SessionConversation.tsx` 1,623 lines, `src/renderer/App.tsx` 1,365, `src/main/providers/providerSessionService.ts` 1,200, `src/main/persistence/migrations.ts` 1,126, `src/main/providers/providerEventNormalizer.ts` 890, `src/shared/types.ts` 901, `src/shared/ipcSchemas.ts` 785, `src/renderer/hooks/useReviewState.ts` 729, `src/renderer/components/Sidebar.tsx` 715, `src/renderer/components/LaunchSurface.tsx` 693.
- **Smell scan:** `rg` found no source `as any`, TODO, FIXME, `dashboard.load(` active-refresh misuse, or empty catch blocks. Existing `eslint-disable` entries are narrow and justified in tests/control-regex/React Fast Refresh exceptions.
- **Timer scan:** recurring timers exist in `src/main/gh/ghPoller.ts:61`, `src/main/persistence/database.ts:273`, `src/renderer/components/ThinkingVerbs.tsx:10`, and `src/renderer/components/PerfOverlay.tsx:70`. None are the forbidden dashboard polling loop.
- **Baseline `npm run lint`:** passed with two existing Fast Refresh warnings in `src/renderer/components/settings/AgentsSettings.tsx:9` and `src/renderer/components/settings/settingsPrimitives.tsx:248`.
- **Baseline `npm run typecheck`:** passed.
- **Baseline focused tests:** `npx vitest run src/renderer/components/SessionConversation.test.tsx src/renderer/App.test.tsx src/main/providers/providerEventNormalizer.test.ts src/shared/ipcSchemas.test.ts` passed 209 tests. Existing stderr noise: ProjectKnowledgePanel act warnings and CodeMirror jsdom `getClientRects` errors during App tests.

## Candidate Changes

### A1 — Extract Pure Chat Turn/Card Helpers

- **State:** done
- **Evidence:** `src/renderer/components/SessionConversation.tsx:158-253` contains pure helper logic for folding command tools, finding tools by name, parsing `AskUserQuestion`, and hiding card tools; `src/renderer/components/SessionConversation.tsx:1017-1215` contains dense card derivation and hidden-tool filtering inside render.
- **Expected simplification:** Move the pure helpers into a renderer `lib` module with unit tests, shrinking `SessionConversation.tsx` and making the hidden-tool/card contract testable without rendering the whole chat component.
- **Risk:** Medium. The helper semantics are load-bearing for PlanCard/QuestionCard visibility and Thinking suppression.
- **Affected validation:** `npx vitest run src/renderer/lib/<new-test>.test.ts src/renderer/components/SessionConversation.test.tsx`.

### B1 — Extract App Stored UI Preference Readers

- **State:** done
- **Evidence:** `src/renderer/App.tsx:115-141` owns four localStorage readers and keys while similar read/write behavior already lives in `src/renderer/hooks/usePersistedSetting.ts`; `src/renderer/App.tsx:530-533` persists the same values through the hook.
- **Expected simplification:** Move the four keys/readers into a small renderer lib so App stays the composition root and localStorage defaults are unit-testable.
- **Risk:** Low. The values are local UI defaults only.
- **Affected validation:** `npx vitest run src/renderer/App.test.tsx` plus a small lib test if added.

### A2 — Move Shared Question Types Out Of Component

- **State:** candidate
- **Evidence:** `src/renderer/lib/turnToolItems.ts` parses `AskUserQuestion` payloads but currently needs the `Question` type exported by `src/renderer/components/QuestionCard.tsx`; that makes a renderer lib point at a component for a pure data shape.
- **Expected simplification:** Put `Question` / `QuestionOption` in a tiny lib type module so both the parser and component depend on the same pure type boundary.
- **Risk:** Low. Type-only refactor.
- **Affected validation:** `npx vitest run src/renderer/lib/turnToolItems.test.ts src/renderer/components/QuestionCard.test.tsx src/renderer/components/SessionConversation.test.tsx`.

### B2 — Keep App Lazy Import Warming In App

- **State:** keep
- **Evidence:** `src/renderer/App.tsx:13-28` explains why import functions are top-level and shared with `React.lazy`; `src/renderer/App.tsx:220-240` warms chunks on idle after first paint.
- **Expected simplification:** None. Extracting this would obscure the lazy import/cache relationship for little line reduction.
- **Risk:** Low if left alone; medium if abstracted.
- **Affected validation:** None.

### C1 — Keep ProviderSessionService Cohesive Unless New Evidence Appears

- **State:** keep
- **Evidence:** `src/main/providers/providerSessionService.ts:1-21` records an architectural decision that flush orchestration needs private buffers and lifecycle state; the current imports at `src/main/providers/providerSessionService.ts:44-67` already extract adapters, flush queue, payload caps, learnings, recovery, and prompts.
- **Expected simplification:** No safe split identified yet.
- **Risk:** High if split prematurely because launch/sendInput/terminate/recovery tests cover integrated behavior.
- **Affected validation:** Provider session tests if touched later.

### D1 — Keep ProviderEventNormalizer Unified For Now

- **State:** keep
- **Evidence:** `src/main/providers/providerEventNormalizer.ts:1-18` records a decision to keep Claude/Codex/Cursor dispatch together while Cursor shapes stabilize; `src/main/providers/providerEventNormalizer.ts:29-71` shows shared session context for Codex/Cursor metadata.
- **Expected simplification:** No split until provider-specific changes collide in review.
- **Risk:** Medium-high if split now because shared usage/context helpers would be threaded through new module boundaries.
- **Affected validation:** Provider normalizer fixtures if touched later.

### E1 — Keep Dashboard Refresh Shape

- **State:** keep
- **Evidence:** `src/renderer/hooks/useDashboardSession.ts:78-88` has separate load/refresh tokens; `src/renderer/hooks/useDashboardSession.ts:168-213` uses focused `workspaces.status()` + `approvals.pending()` and upsert semantics; docs forbid recurring dashboard polling.
- **Expected simplification:** No redundant active refresh path found.
- **Risk:** High if simplified blindly; this code encodes previous race fixes.
- **Affected validation:** `npx vitest run src/renderer/hooks/useDashboardSession.test.tsx src/renderer/App.test.tsx` if touched later.

### F1 — Defer Review State Split

- **State:** deferred
- **Evidence:** `src/renderer/hooks/useReviewState.ts:135-219` owns many related bits of review/file-editor state, but `src/renderer/hooks/useReviewState.ts:150-165` and `194-219` document why dispatch/listener refs are synchronized.
- **Expected simplification:** Possible future split between changed-files diff state and file-editor tab state, but it is more than one iteration and touches many tests.
- **Risk:** High. The hook handles dirty buffers, external mtime changes, read-only project mode, and workspace mode.
- **Affected validation:** `npx vitest run src/renderer/hooks/useReviewState.test.tsx src/renderer/components/ReviewPanel.test.tsx`.

### G1 — Keep IPC Schema Inventory Explicit

- **State:** keep
- **Evidence:** `src/shared/ipcSchemas.ts:4-18` documents schema ownership; `src/shared/ipcSchemas.ts:49-132` already has shared building blocks for provider ids, refs, file paths, size caps, and ids.
- **Expected simplification:** No duplicate schema fragment found that is safer than current explicit channel definitions.
- **Risk:** Medium if clever factories hide `IPC_CHANNELS` inventory.
- **Affected validation:** IPC parity and schema tests if touched later.

### H1 — Defer Sidebar Menu/Drag Split

- **State:** deferred
- **Evidence:** `src/renderer/components/Sidebar.tsx:123-181` owns boot collapse seeding plus sort/project menus; `src/renderer/components/Sidebar.tsx:213-241` computes workspace/session derived maps. It is large, but the menu behavior is already on `useDismissOnOutsideOrEscape`.
- **Expected simplification:** A future project-menu component may help, but drag/order/collapse state makes this larger than one clean candidate right now.
- **Risk:** Medium. Accessible labels and localStorage behavior are heavily tested.
- **Affected validation:** `npx vitest run src/renderer/components/Sidebar.test.tsx src/renderer/components/SidebarSessionRow.test.tsx`.

### I1 — Keep CSS Sweep Tied To Touched Components

- **State:** keep
- **Evidence:** `agents/docs/styling.md` explicitly says a loop-wide raw-value sweep would create 700+ line edits and tokens should migrate incrementally.
- **Expected simplification:** No standalone CSS cleanup until a touched component exposes dead selectors or raw values.
- **Risk:** Low if obeyed; high churn if ignored.
- **Affected validation:** Component tests and lint if CSS touched later.

### J1 — Move Shared Settings Helpers Out Of Component Files

- **State:** done
- **Evidence:** Baseline lint warned about non-component exports in `src/renderer/components/settings/AgentsSettings.tsx:9` and `src/renderer/components/settings/settingsPrimitives.tsx:248`; `src/renderer/components/WelcomePane.tsx:5-18` duplicated provider install hints already present in settings.
- **Expected simplification:** Move provider install hints and log download behavior into `src/renderer/lib/` so component files export components/primitives and lint is clean.
- **Risk:** Low. No behavior change; App tests cover provider hints and log download.
- **Affected validation:** `npm run lint`, `npx vitest run src/renderer/App.test.tsx`, `npm run typecheck`.

## Keep Decisions

- **B2:** App lazy import warming stays in `App.tsx`.
- **C1:** `ProviderSessionService` remains cohesive in this pass unless a later task uncovers narrower evidence.
- **D1:** `providerEventNormalizer.ts` remains unified in this pass.
- **E1:** `useDashboardSession` refresh/upsert shape remains intact.
- **G1:** IPC schema inventory stays explicit.
- **I1:** CSS cleanup remains scoped to touched components only.

## Completed Changes

- **INIT** — Initialized fresh sweep state in `openspec/custom/ralph/PROGRESS.md` and created this audit control artifact.
- **BASELINE** — Ran lint, typecheck, and focused renderer/shared/provider tests before source edits.
- **A1** — Extracted pure turn-tool/card helpers from `SessionConversation.tsx` into `src/renderer/lib/turnToolItems.ts`, added `src/renderer/lib/turnToolItems.test.ts`, reduced `SessionConversation.tsx` from 1,623 to 1,529 lines, and committed `bff5c70 refactor(chat): extract turn tool item helpers`.
- **B1** — Extracted App UI preference keys/readers into `src/renderer/lib/uiPreferences.ts`, added `src/renderer/lib/uiPreferences.test.ts`, reduced `App.tsx` from 1,365 to 1,347 lines, and committed `22fb311 refactor(app): extract ui preference readers`.
- **A2** — Moved `Question` / `QuestionOption` into `src/renderer/lib/questions.ts` so pure parser helpers do not depend on component-owned data types; committed `36a9c41 refactor(chat): share question data types`.
- **J1** — Moved provider install hints and log download behavior to `src/renderer/lib/`, removed duplicate hint definitions, got `npm run lint` fully clean, and committed `6084d65 refactor(settings): move shared helpers out of components`.
- **SLOP1** — Removed stale audit/Ralph labels from comments in touched renderer files while preserving the explanatory content; committed `1bca633 chore(renderer): remove stale audit labels`.

## Deferred Items

- **F1:** Review-state hook split is deferred; too broad for one iteration.
- **H1:** Sidebar menu/drag split is deferred; too broad for one iteration.

## Final Verification

- `npm run lint` — clean.
- `npm run typecheck` — passed.
- `npm run build` — passed; main renderer chunk 1.58 MB, under 2.00 MB budget by 0.42 MB.
- `npm test` first run — failed once on `src/test/perf.test.ts` parseUnifiedDiff p95 (42.1 ms vs 20 ms) while the full suite was hot.
- `npx vitest run src/test/perf.test.ts` — passed isolated, proving the parser budget itself was not regressed.
- `npm test` rerun — passed: 109 files, 1,074 tests.
- `git status --short` — clean for tracked files.

## Closeout

- **Completed:** INIT, BASELINE, A1, B1, A2, J1, SLOP1, final verification.
- **Keep decisions:** B2, C1, D1, E1, G1, I1.
- **Deferred:** F1 and H1 because each is broader than one clean iteration and the current code carries explicit race/interaction constraints.
- **Net result:** extracted pure chat/tool helpers, extracted App preference readers, moved shared question types into lib, removed duplicate provider install hints, moved log download behavior out of component primitives, cleaned stale audit labels, and got lint from "pass with warnings" to clean.
