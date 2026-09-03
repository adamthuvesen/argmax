# Usage

The Usage page (sidebar → Usage) shows tokens and cost per provider over the
past 24 hours, 7 days, or 30 days: a total, one row per provider, a chart, a
totals strip, and a breakdown by model or day. It reads every provider
transcript on disk, not only the sessions Argmax launched, so it is the same
number a terminal-only user would get.

Dollar figures are an **API estimate at list price**. Subscriptions bill
differently, so the page says "at list price" and shows the date of the price
table (`PRICING_AS_OF` in [usage/mod.rs](../src-tauri/src/usage/mod.rs)). A
model the table does not know is counted in tokens and marked *unpriced*,
never shown as $0. Grok Build and OpenCode keep their own dollar figure in
their logs; those win over the table and are marked *provider reported*.

## Sources

| Provider | Files | Usage record |
|---|---|---|
| Claude | `~/.claude/projects/<slug>/<session>.jsonl` and `<session>/subagents/*.jsonl` | `type:"assistant"` → `message.usage` |
| Codex | `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` and `~/.codex/archived_sessions/rollout-*.jsonl` | `event_msg` / `token_count` → `info.last_token_usage` |
| Grok Build | `~/.grok/sessions/<cwd>/<session>/updates.jsonl` | `turn_completed` → `usage` and `usage.modelUsage` |
| OpenCode | `~/.local/share/opencode/opencode.db` (`message.data`, read-only) | `tokens` and `cost` on assistant rows |
| Cursor | none | Cursor keeps no local token log; the page says so |

Parsers live in [usage/claude.rs](../src-tauri/src/usage/claude.rs),
[codex.rs](../src-tauri/src/usage/codex.rs), [grok.rs](../src-tauri/src/usage/grok.rs),
and [opencode.rs](../src-tauri/src/usage/opencode.rs), and produce one
`UsageRecord` per billed call ([records.rs](../src-tauri/src/usage/records.rs)).

## Counting rules

These are the rules that make the numbers right. Each has a fixture test.

- **Claude repeats usage per content block, and the early blocks are
  partial.** Every block of one message restates `usage` under the same
  `message.id`, but blocks written mid-stream carry a small `output_tokens`
  (1 or 5 where the settled bill is 300). The key `message.id:requestId`
  counts the message once and keeps the block with the largest count, within
  a file and across files (a resumed session copies its history into a new
  file).
- **Claude 1 h cache writes cost 2x input**, 5 m writes 1.25x. The transcript
  splits them under `cache_creation`; the ledger keeps them apart.
- **Subagent transcripts belong to the parent session** (the directory above
  `subagents/`). Their calls are real API calls and are counted.
- **Codex `last_token_usage`, never `total_token_usage`.** The latter is
  cumulative. Consecutive identical `token_count` events are dropped. Codex
  `input_tokens` includes the cached part; uncached input is the difference.
- **Codex forks copy history.** A forked or subagent rollout starts with the
  parent's lines re-stamped within a second of each other, including a copy of
  the parent's `session_meta`; only the rollout's own first `session_meta`
  names it, records inside the burst are skipped, and counting starts at the
  first line more than a second after its predecessor.
- **Grok reports per model** under `modelUsage`; cost ticks are USD × 1e10,
  and a model without its own ticks gets a token-share slice of the turn's
  aggregate.
- **`<synthetic>` and all-zero usage lines are skipped.**

## Scan

[usage/scanner.rs](../src-tauri/src/usage/scanner.rs) sweeps the sources and
folds records into `usage_hourly` (migration v27, see [data.md](data.md)):
one row per provider, model, session, source file, and UTC hour. Dollars are
computed at query time from the pricing table, so a price change re-prices
history without a rescan.

- Files are found by mtime within the 90-day retention plus 36 hours of slack.
- An unchanged `(size, mtime)` skips the file. A grown file whose 64 bytes
  before the old cursor still hash the same is read from the cursor. Anything
  else drops the file's rows and is parsed again.
- A file touched in the last five minutes keeps its trailing partial line for
  the next sweep, since the writer may be mid-line.
- Billed-call keys are remembered in `usage_dedupe_keys` per source file, so a
  reparse of one file does not lose the claims of another.
- `PARSER_VERSION` in the scanner is stored in `usage_scan_meta`; bumping it
  empties the ledger and rescans.
- The first sweep is cold and runs in the background when the page is first
  opened; the page shows "Scanning N of M transcripts". Later sweeps are warm,
  run inline on every `usage:summary`, and take well under a second.
- At boot, a ledger that has completed before is refreshed in the background.

Day buckets follow the machine's local zone (`chrono::Local`), which is the
zone the renderer resolves too. Hour buckets are UTC hours.

## Checking the numbers

`argmax usage --days 7 --json` prints the ledger as per-day, per-model token
totals. `node scripts/check-usage-oracle.mjs --days 7` compares those with
`ccusage daily --json` and `codexbar cost --format json` for Claude and Codex.
A row where all three agree is `ok`; a row where Argmax matches one oracle
and the other differs is `oracles-differ` and is reported, not failed; a row
where Argmax matches neither is a `MISMATCH` and fails the script. On
2026-09-03 every Claude row matched ccusage exactly and every Codex row
matched CodexBar exactly; the residual rows were ccusage counting Codex fork
copies and CodexBar counting one extra Claude message. Costs are not
compared: the tools price from different tables.

For a session Argmax launched, the scanner's per-session totals also match the
`usage_events` rows the live normalizer wrote.
