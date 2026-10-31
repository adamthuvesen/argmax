# Usage

The Usage page shows tokens and cost per provider over a chosen window. It reads every provider transcript on disk, not only sessions Argmax launched, so it is the number a terminal-only user would get. Cursor is the exception, because it keeps no token log.

| Concern | Owner |
|---|---|
| Page | [UsagePanel.tsx](../src/renderer/components/usage/UsagePanel.tsx) |
| Ledger, price table | [usage/mod.rs](../src-tauri/src/usage/mod.rs) |
| Parsers | [claude.rs](../src-tauri/src/usage/claude.rs), [codex.rs](../src-tauri/src/usage/codex.rs), [grok.rs](../src-tauri/src/usage/grok.rs), [opencode.rs](../src-tauri/src/usage/opencode.rs) |
| Scan | [scanner.rs](../src-tauri/src/usage/scanner.rs) |
| Cursor estimate | [cursor.rs](../src-tauri/src/usage/cursor.rs) |
| Router cost | [routing/cost.rs](../src-tauri/src/routing/cost.rs) |
| Remaining | [usage/remaining](../src-tauri/src/usage/remaining) |
| iPhone | [ios/Argmax/README.md](../ios/Argmax/README.md) |

## What the figures mean

Dollars are an **API estimate at list price**, because subscriptions bill differently. The page shows the date of the table (`PRICING_AS_OF`).

- A model the table does not know is counted in tokens and marked *unpriced*, never shown as $0.
- Grok Build and OpenCode keep their own dollar figure, which wins and is marked *provider reported*.
- OpenCode's figure for an `openrouter/` model is the exception. It is the catalog's cheapest rate, not what the host billed, so the table prices those turns ([providers.md](providers.md#opencode)).
- Vercel AI Gateway turns keep OpenCode's figure, which is also an estimate.
- Cursor's figures read "≈".

$ / 1M is cost over processed tokens, so models compare on price rather than volume. An unpriced row has no rate. A day row includes unpriced tokens, which pulls that day's rate down.

`UsageSummary::previous` is the window before this one, cut on the same boundaries so a DST change does not slide the edge. It is `null` when the ledger cannot honestly cover that window, because a first install must not read as up 100%.

The tiles never narrow, so their shares stay shares of the whole window while one provider is in focus. Providers are told apart by color ([styling.md](styling.md#provider-and-emblem-colors)).

## Remaining on your plans

Live included usage for each provider login, including use outside Argmax. It is not the list-price spend above, and it does not go through `usage_hourly`.

| Provider | Source | Notes |
|---|---|---|
| Claude | `GET https://api.anthropic.com/api/oauth/usage` with Claude Code OAuth | Undocumented, the endpoint behind `/usage`. Rate-limited if polled hard. |
| Codex | `codex app-server` `account/rateLimits/read`, else the newest local rollout | Official. Windows are labeled from duration. |
| Grok | `GET https://cli-chat-proxy.grok.com/v1/billing?format=credits` | The call behind Grok Build's `/usage`. |
| OpenCode | The selected gateway's key endpoint | Follows the OpenCode gateway setting. |
| Cursor | Local `cli-config.json` only | Remaining numbers need unofficial APIs, so the card links to Cursor's dashboard. |

**The page arrives in one piece.** The ledger and remaining reads are separate, and the skeleton covers both, capped at `REMAINING_HOLD_MS`. The remaining read talks to provider accounts, and a slow login must not hold local numbers back.

**A second home.** **Plans left** in the sidebar's Argmax menu ([IdentityPlans.tsx](../src/renderer/components/IdentityPlans.tsx)) and the composer chip share this read. It re-reads only once figures are stale, so repeated opens do not poll provider endpoints.

**Claude's keychain item is named after the config dir:** `Claude Code-credentials-<first 8 hex of sha256(CLAUDE_CONFIG_DIR)>`, hashing the exported string verbatim, so a trailing slash renames it.

- The bare name is a stale item nothing refreshes, so it is only a fallback.
- The config dir comes from the login-shell environment, because a Finder-launched Argmax inherits launchd's minimal one and would read a different store than its sessions.
- When `.credentials.json` and the keychain item both hold a token, the later `expiresAt` wins. The CLI refreshes only the keychain, so an old file keeps an expired token forever.
- The default profile's credentials are read only when the configured one has none, because they may belong to another account.
- A 401 says the login expired, never "sign in".

Verification mode disables network, Keychain, and app-server reads. A `verification` build answers from `usage/remaining/verification.rs`.

## Router cost

The **Router** card shows what each Auto tier cost in the page's window. The read is `usage:router-cost`, and [usage-router.css](../src/renderer/styles/usage-router.css) styles it. The browser preview draws `demoRouterCost`. The phone shows the same read ([RouterViews.swift](../ios/Argmax/Sources/Insights/RouterViews.swift)) and hides the card when the Mac predates the channel.

- **One window per `turn_routes` row.** A row's window runs to the chat's next row, and its turns are charged to that row's tier, so a chat that escalated splits across tiers. Goal continuations record no row, so they count in the window before them.
- **A pin ends the chat's Router spend.** The `pinned` row closes the window and is never a turn ([routing.md](routing.md#user-pins)).
- **Pricing follows the ledger's rule.** It runs up to the next turn's start, clipped at the next route, because final usage can be recorded just after completion. Each row is priced by its own provider.
- **Tokens are output only.** Input and cache reads track context size, not work.
- **Times are wall-clock medians,** less approval waits. Wall clock is the only figure every provider has. A mean would be carried by one long turn.
- **Tok / s is work over time,** because turn time alone rewards a tier that gets small tasks. It is a throughput proxy, not a quality measure.
- **Unanswered and cancelled turns are left out.** Cancelled spend still appears in the ledger.
- **Unknown turns are unpriced,** never $0, and left out of the per-turn figure.
- **Escalations measure router actions,** not outcomes or all user corrections.

## Cursor estimate

ACP reports no tokens, and `cursor-agent` stores none, so [cursor.rs](../src-tauri/src/usage/cursor.rs) rebuilds each chat Argmax ran from its own `events` rows. The page and Router card share it.

- **Tokens are text length / 4.** A model call happens at each `command.started`, `agent.started`, and `message.completed`.
- **The conversation is what the model saw, not what was logged.** Cursor's payload repeats command output four times, so the copies are dropped. Each event is capped, because Cursor writes large output to a file. A conversation past the window starts over, because it was compacted.
- **Accuracy.** Run over Claude and Codex chats with recorded usage (2026-09-10 onward), summed cache reads came to 1.6x and 0.7x of real, so treat this as ±2x.
- **Prices are Cursor's published rates,** kept in that module. Cursor's Auto has no rate, because it bills whatever it routed to.
- **Coverage.** A chat counts when it is on Cursor now or has a Cursor Router row. A chat that left by a plain switch is not counted, because finding one means walking every recent chat's history. Terminal use is not counted.
- **Cost.** The read runs on every `usage:summary`. Moving it into the incremental ledger would remove that.

## Sources

| Provider | Files | Usage record |
|---|---|---|
| Claude | `~/.claude/projects/<slug>/<session>.jsonl` and `<session>/subagents/*.jsonl` | `type:"assistant"` → `message.usage` |
| Codex | `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` and `~/.codex/archived_sessions/rollout-*.jsonl` | `event_msg` / `token_count` → `info.last_token_usage` |
| Grok Build | `~/.grok/sessions/<cwd>/<session>/updates.jsonl` | `turn_completed` → `usage` |
| OpenCode | `~/.local/share/opencode/opencode.db`, read-only | `tokens` and `cost` on assistant rows |
| Cursor | Argmax's own `events` rows | none: estimated |

## Counting rules

These rules make the numbers right. Each has a fixture test.

- **Claude repeats usage per content block, and early blocks are partial.** The key `message.id:requestId` counts a message once and keeps the block with the largest count, across files, because a resumed session copies its history.
- **Claude 1 h cache writes cost more than 5 m writes.** The ledger keeps them apart.
- **Subagent transcripts belong to the parent session.** Their calls are real and counted.
- **Codex `last_token_usage`, never `total_token_usage`.** The latter is cumulative. `input_tokens` includes the cached part.
- **Codex forks copy history.** A forked rollout starts with the parent's lines re-stamped within a second, so records inside that burst are skipped.
- **Grok reports per model,** in ticks of USD × 1e10. A model without its own ticks gets a token-share slice.
- **`<synthetic>` and all-zero usage lines are skipped.**
- **Codex's approval reviewer is left out,** because it is approval machinery, not a model the user picked.

## Scan

[scanner.rs](../src-tauri/src/usage/scanner.rs) stores one row per source and billed call in `usage_contributions`, picks a deterministic winner across copied transcripts, and folds it into `usage_hourly` ([data.md](data.md)). Dollars are computed at query time, so a price change re-prices history without a rescan.

- A grown file whose bytes before the old cursor still hash the same is read from the cursor. A same-size write is always reparsed.
- A file touched in the last five minutes keeps its partial trailing line, because the writer may be mid-line.
- Codex parser state is committed with its byte cursor. Bad state causes a full reparse rather than guessing from a tail.
- The record with the most processed tokens wins, so a settled Claude block replaces a partial one. Deleting the winner promotes a copy.
- Winner selection happens before the hour filter, so a copied call cannot move into the visible window when its older winner ages out.
- `PARSER_VERSION` is stored, and bumping it empties the ledger and rescans.
- The first sweep runs in the background with progress on the page. Later sweeps run inline, so they must stay fast ([performance.md](performance.md#usage-scan)).

Day buckets follow the machine's local zone, and hour buckets are UTC.

## Checking the numbers

`argmax usage --days 7 --json` prints the ledger from the database the app uses. `node scripts/check-usage-oracle.mjs --days 7` compares it with `ccusage` and `codexbar`.

- A row where all agree is `ok`.
- A row where Argmax matches one oracle is `oracles-differ`, which is reported, not failed.
- A row matching neither is a `MISMATCH`, which fails the script.

Costs are not compared, because the tools price from different tables.
