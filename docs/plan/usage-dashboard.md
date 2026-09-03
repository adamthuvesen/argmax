# Plan: Usage dashboard

## Scope

**Objective.** A Usage page in Argmax showing, per connected provider (Claude, Codex, Grok Build, OpenCode), cost at list price and tokens for Past 24h / 7 days / 30 days: a hero total with session count, per-provider rows with share and tokens, a daily (hourly for 24h) area chart, a totals row (processed, cached input, uncached input, output, cache savings), and a Model / Day breakdown table. Data comes from every local transcript on disk, not only Argmax-launched sessions.

**Decision.** Numbers come from a native Rust scanner over the provider logs, not from CodexBar or ccusage. Those two cover Claude and Codex (ccusage adds OpenCode), neither reads Grok Build, and their cost figures for the same day already disagree. Argmax already owns the per-provider normalizers, the pricing table, a cursor-based transcript walker, and SQLite. CodexBar and ccusage are used as token oracles in verification only.

**Binding constraints.** Rust owns file IO and SQLite (ADR 0001); migrations are append-only; IPC follows the seven-step checklist in `docs/ipc.md`; blocking work goes through `read_off_main`; no third-party UI or chart library (`docs/styling.md`); pricing stays in `providers/pricing.rs` and `src/shared/providerModels.ts`; renderer tests query by role and label; standalone pages own the sidebar column like Schedule does.

**Out of scope.** Cursor local usage (no local token source exists), rate-limit and quota windows, a 90-day view, exports, remote-bridge support for the page.

## Data sources (verified 2026-09-03)

| Provider | Path | Usage record | Notes |
|---|---|---|---|
| Claude | `~/.claude/projects/**/*.jsonl` incl. `<session>/subagents/*.jsonl` | `type:"assistant"` → `message.usage` | Every content block repeats the same usage under one `message.id`; dedupe on `message.id:requestId` within and across files. `cache_creation.ephemeral_1h_input_tokens` bills at 2x input, not 1.25x. Skip `<synthetic>`. |
| Codex | `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` | `event_msg` / `token_count` → `info.last_token_usage` | Model comes from the preceding `turn_context`. Drop consecutive identical `token_count` events. Forked and subagent rollouts copy parent history in a sub-second burst; suppress with a 1 s gap heuristic. |
| Grok Build | `~/.grok/sessions/<cwd>/<id>/updates.jsonl` | `params.update.sessionUpdate == "turn_completed"` → `usage` | `modelUsage` per model, `costUsdTicks` is provider-reported cost (ticks ÷ 1e10), `inputTokens` includes the cached portion, dedupe on `prompt_id`. Only read `updates.jsonl`. |
| OpenCode | `~/.local/share/opencode/opencode.db` | `message.data` JSON with `tokens` and `cost` | Read-only SQLite open; step rows sum to the turn. Cost is provider-reported. |

## Phase 1: Parsers and golden fixtures

**Deliverable:** A pure `usage::records` module that turns one provider file (or OpenCode row batch) into `UsageRecord { provider, model_id, session_id, at_ms, tokens: { input_uncached, cache_read, cache_write_5m, cache_write_1h, output, reasoning }, reported_cost_usd: Option<f64>, dedupe_key: Option<String> }`, with every known quirk pinned by a fixture.

**Files:** `src-tauri/src/usage/mod.rs`, `records.rs`, `claude.rs`, `codex.rs`, `grok.rs`, `opencode.rs` — new, thin over the existing extractors in `providers/normalizer/*`; `src-tauri/tests/fixtures/usage/*.jsonl` — redacted real lines; `src-tauri/src/providers/pricing.rs` — add a `cache_write_1h` rate and make `cost_of` distinguish priced from unpriced instead of returning `0.0`.

**Work:** line pre-filter (`"usage"`, `token_count`, `turn_completed`); Claude dedupe on `message.id:requestId`, 1 h cache writes read separately, subagent transcripts attributed to the parent session directory; Codex model from `turn_context`, `last_token_usage`, duplicate-signature drop, fork copy-burst suppression; Grok per-model records with tick cost and token-share pro-rating; OpenCode one record per assistant row; unknown model → unpriced, logged once, never `$0`.

**Success check:** `cargo test --manifest-path src-tauri/Cargo.toml usage::` passes fixtures for: Claude three-block message counted once; resumed session repeating a message id across two files counted once; subagent transcript attributed to parent; 1 h cache write priced at 2x; Codex duplicate `token_count` dropped; Codex fork copy suppressed while a real turn 5 s later counts; Grok two-model turn splits cost by ticks; `codex-auto-review` lands in the unpriced bucket.

## Phase 2: Scanner, cache, and storage

**Deliverable:** An incremental scan that walks the four sources for files touched in the last 90 days, resumes from byte cursors, and persists hour buckets in Argmax's SQLite. The cold scan runs in the background; warm scans are cheap enough to run on every page request.

**Files:** `src-tauri/src/persistence/migrations.rs` — migration adding `usage_scan_files`, `usage_hourly`, `usage_dedupe_keys`, `usage_scan_meta`; `src-tauri/src/persistence/usage_scan.rs` — queries; `src-tauri/src/usage/scanner.rs` — walker and cache; `src-tauri/src/usage/summary.rs` — window aggregation; `docs/data.md` — table list.

**Work:** walker filters by suffix and `mtime >= now − 90d − 36h`; unchanged `(size, mtime)` skips a file; a grown file whose guard hash matches parses only the tail; anything else deletes the file's rows and reparses; a trailing line without a newline waits for the next scan; cross-file dedupe through `usage_dedupe_keys`; rows and keys older than 90 days pruned; a `parser_version` bump truncates and rescans; `summary(window, time_zone)` buckets by local calendar day (UTC hour for 24h), prices at query time from the table except where `reported_cost_usd` is set, computes cache savings as cache_read × (input rate − cache-read rate), counts distinct sessions, and carries a provenance per bucket (`provider_reported`, `list_price`, `unpriced`). Scans run on `spawn_blocking` behind a mutex so concurrent requests share one scan.

**Success check:** append-only growth parses only the tail; a rewritten file reparses fully and its old rows disappear; a deleted file's rows are pruned; migration checksum test passes; a 23:30 Stockholm turn lands on the right day. Cold 30-day scan time recorded in the PR; warm scan under 300 ms.

## Phase 3: IPC and the CLI oracle

**Deliverable:** One request channel `usage:summary { window: "24h" | "7d" | "30d", timeZone }` returning `{ scan, totals, providers[], series[], models[], days[] }`, and a dev subcommand `argmax usage --days 7 --json` printing per-day per-model tokens for oracle comparison.

**Files:** `src-tauri/src/ipc/usage.rs`; `src-tauri/src/ipc/mod.rs`; `src-tauri/src/ipc/inputs.rs`; `src-tauri/tests/fixtures/channels.txt` and `src-tauri/tests/ipc_inventory.rs`; `src-tauri/src/remote/dispatch.rs` (`REMOTE_UNSUPPORTED_CHANNELS`); `src/shared/ipcSchemas.ts`, `src/shared/types.ts`, `src/renderer/lib/tauriBridge.ts`; `src/shared/bindings.d.ts` regenerated; `src-tauri/src/main.rs` — `usage` dispatch next to `session`; `scripts/check-usage-oracle.mjs`; `docs/ipc.md`, `docs/verification.md`.

**Success check:** `npm run generate:bindings && npm run check:bindings && npm run check:tauri-bridge && npm run check:main-thread` clean; `node scripts/check-usage-oracle.mjs --days 7` reports zero token mismatches for Claude and Codex, or each mismatch is explained in the PR. Cost differences are out of scope for the oracle.

## Phase 4: The page

**Deliverable:** A standalone Usage page opened from a new sidebar rail item between Schedule and Customize, rendered in Argmax's own tokens in both themes.

**Files:** `src/renderer/components/Sidebar.tsx`; `src/renderer/App.tsx` (`isUsageOpen`, `data-usage-open`, `UsageRail`, palette action); `src/renderer/components/usage/{UsagePanel,UsageRail,UsageHero,UsageProviderRows,UsageAreaChart,UsageTotals,UsageBreakdown}.tsx`, `usagePresentation.ts`, `formatUsd.ts`; `src/renderer/styles/usage.css` aggregating `usage-layout.css` and `usage-chart.css`; `src/renderer/styles/tokens.css` (`--usage-claude`, `--usage-codex`, `--usage-grok`, `--usage-opencode`); `src/renderer/components/settings/AgentsSettings.tsx` ("View usage" link); `docs/styling.md`.

**Work:** header with the range label and two segmented controls (Cost | Tokens, Past 24h | 7 days | 30 days); hero with the total "at list price" and session count; provider rows; a hand-rolled SVG area chart (monotone cubic, nice ticks, hover crosshair and tooltip, `role="img"` plus a visually hidden table); five stat tiles; Model | Day breakdown with an "unpriced" badge; cold-scan progress, empty, and error states; refresh every 60 s while mounted.

**Success check:** renderer tests by role for opening the page, the window toggle, the Cost/Tokens toggle, the scanning state, the unpriced badge, and the chart's hidden table. `npm run lint`, `npm run typecheck`, `npm test` green. Screenshots of both themes in the PR.

## Final checks

- `npm test`, `npm run check:bindings`, `npm run check:tauri-bridge`, `npm run check:main-thread`, `npm run check:bundle`.
- Oracle gate on a 7-day window, and for Argmax-launched sessions a per-session comparison of scanner totals against `usage_events`.
- A `test:perf` case for building the 30-day series under 5 ms; cold and warm scan times recorded in `docs/performance.md`.
- Docs: `docs/data.md`, `docs/ipc.md`, `docs/styling.md`, and a new `docs/usage.md` stating the data sources, dedupe rules, and the list-price caveat, indexed from `AGENTS.md`.

## Risks

- Dedupe heuristics are inherited from ccusage and T3 Code, not proven. Fixtures from real files on this machine plus the oracle gate catch drift.
- Cold scan over about 2 GB of JSONL. Pre-filter before parsing, background task, progress UI, byte-cursor resume.
- Pricing-table staleness produces confident wrong dollars. Date-stamp the table in the UI, keep unknown models unpriced, and cross-check per-model list prices against CodexBar in the PR.
- Cursor has no local token source. The page shows "No local usage data" for it.
