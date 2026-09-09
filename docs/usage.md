# Usage

The Usage page (sidebar → Usage) shows tokens and cost per provider over the
last 24 hours, 7 days, or 30 days: a summary band (the total, then one tile
per provider), a full-width chart, a token-flow band, and a breakdown by
model or day. It reads every provider
transcript on disk, not only the sessions Argmax launched, so it is the same
number a terminal-only user would get.

Below that ledger is **Remaining on your plans**: live included usage left on
each provider login (plan name, remaining percent, next reset). Those figures
come from the provider account, including use outside Argmax, and are not the
list-price spend above. Enterprise, Teams, API-key, and unsigned-in rows show
a label instead of remaining bars. Fetch happens once when the page opens;
Refresh on that card retries remaining only.

The page arrives in one piece: the ledger and the remaining read are separate
fetches, and the skeleton covers both until the slower one lands, so no part
of the page paints alone and reflows a beat later. The wait is capped at
`REMAINING_HOLD_MS` (2 s) in [UsagePanel.tsx](../src/renderer/components/usage/UsagePanel.tsx) —
the remaining read talks to provider accounts behind a 10-second timeout, and
a slow or signed-out login must not hold the local numbers back. After that
first paint the remaining card stays up: a window switch skeletons the ledger
alone, since remaining does not follow the window.

The header carries the page's three controls: a provider picker, a range
picker, and the Cost/Tokens switch. Choosing a provider narrows the total,
chart, token flow, and breakdown to it; so does pressing that provider's tile
in the band, and the two stay in step. "All providers" in the picker, a
second press on the tile, or "Show all" beside the total widens back out. A
provider with no local usage source (Cursor) is listed but cannot be chosen.
The tiles themselves never narrow, so their shares stay shares of the whole
window while one provider is in focus. Providers are told apart by colour
alone: one series colour per provider, on the tile dot, the picker row, the
curve, and the breakdown table.

`UsageSummary::previous` is the one comparison the renderer cannot work out
for itself: the cost, tokens, and session count of the equally long window
immediately before this one, so the page can say "$1,872, up 34% on the
previous 30 days". It follows the provider filter and the same price table as
the current window, and is cut on the same boundaries — the 24 hours before
for 24h, the 7 or 30 local days before for the day windows, so a DST change
does not slide the edge. It is `null` when the ledger cannot honestly cover
that earlier window: when it holds nothing inside it, or when the oldest
record the ledger has starts after the window began. A first install must not
read as up 100%.

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

Remaining usage is a second, live read. It does not go through `usage_hourly`.

| Provider | Remaining source | Notes |
|---|---|---|
| Claude | `GET https://api.anthropic.com/api/oauth/usage` with Claude Code OAuth (Keychain / `.credentials.json` / `CLAUDE_CODE_OAUTH_TOKEN`). Plan from `~/.claude.json` `oauthAccount`. | Undocumented; the same endpoint Claude Code uses for `/usage`. Reports the 5-hour session, weekly (all models), and Fable weekly (`limits[]` → `weekly_scoped`). Rate-limited if polled hard. Keychain service is namespaced per config dir — see below. |
| Codex | `codex app-server` `account/rateLimits/read`, else the newest `rate_limits` object in a local rollout. | Official JSON-RPC. Windows are labeled from duration — Pro may report weekly on `primary` with no 5-hour window. |
| Grok | `GET https://cli-chat-proxy.grok.com/v1/billing?format=credits` with `~/.grok/auth.json`. | Same call Grok Build's `/usage` makes. |
| OpenCode | `GET https://opencode.ai/zen/go/v1/usage` when an OpenCode Go key is present. | Zen / BYOK have no OpenCode subscription quota. |
| Cursor | Local `cli-config.json` `authInfo` only. | Teams/Enterprise is a label. Remaining numbers need unofficial dashboard APIs; the card links to the [Spending dashboard](https://cursor.com/dashboard/spending). |

**Claude's keychain item is named after the config dir.** Claude Code stores
credentials under `Claude Code-credentials-<first 8 hex of
sha256(CLAUDE_CONFIG_DIR)>`, hashing the exported string verbatim — so a
trailing slash renames the item on the CLI's side too. The bare `Claude
Code-credentials` is what an older CLI wrote and what today's CLI writes when
the variable is unset; it survives as a stale item nothing refreshes, so it is
read only as a fallback. The config dir is resolved from the login-shell
environment, the same one provider launches are hydrated with: a Finder-launched
Argmax inherits launchd's minimal environment and would otherwise read a
different credential store than the sessions it starts. A token that reads but
gets a 401 says the login expired, never "sign in".

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
stores one normalized row per source and billed call in
`usage_contributions` (migration v39, see [data.md](data.md)). A deterministic
winner is chosen across copied transcripts, then folded into `usage_hourly`:
one row per provider, model, session, winning source file, and UTC hour.
Dollars are computed at query time from the pricing table, so a price change
re-prices history without a rescan.

- Files are found by mtime within the 90-day retention plus 36 hours of slack.
- An unchanged `(size, mtime)` skips a fully consumed file. A grown file whose
  64 bytes before the old cursor still hash the same is read from the cursor.
  A same-size write is always reparsed, even if its final bytes happen to
  match. Anything else replaces that source's contributions.
- A file touched in the last five minutes keeps its trailing partial line for
  the next sweep, since the writer may be mid-line. It is consumed after the
  five-minute settling time even when size and mtime have not changed.
- Codex parser state (session, model, fork-copy burst, and last token
  signature) is committed with its byte cursor. Missing or malformed state
  causes a full reparse instead of guessing from a tail.
- Repeated billed-call keys keep one contribution per source. The record with
  the largest processed-token count wins globally, with source path as the
  stable tie-breaker. A later settled Claude block can replace its partial
  block, and deleting the winner promotes a retained copy.
- Winner selection happens before the hour filter. Pruning keeps old copies
  when the same billed call also has a contribution inside retention, so a
  copied call cannot move into the visible window when its older winner ages
  out.
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
