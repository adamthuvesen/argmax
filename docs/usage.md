# Usage

The Usage page (sidebar → Hacking → Usage) shows tokens and cost per provider
over the last 24 hours, 7 days, or 30 days: a summary band (the total, then one
tile per provider), a full-width chart, a token-flow band, and a breakdown by
model or day. It reads every provider transcript on disk, not only the sessions
Argmax launched, so it is the same number a terminal-only user would get.
Cursor is the exception: it keeps no token log, so its figures are estimated
from the chats Argmax ran (see [Cursor estimate](#cursor-estimate)).

The iPhone model breakdown shows the top 12 models in descending order of the
selected metric (tokens or cost). Its bars use that same metric.

Below that ledger is **Remaining on your plans**: live included usage left on
each provider login (plan name, remaining percent, next reset). Those figures
come from the provider account, including use outside Argmax, and are not the
list-price spend above. Enterprise, Teams, API-key, and unsigned-in rows show
a label instead of remaining bars. Fetch happens once when the page opens;
Refresh on that card retries remaining only. The iPhone app shows the same
read as a card on its Usage page
([ios/Argmax/README.md](../ios/Argmax/README.md)).

The same read has a second, smaller home: **Plans left** at the top of the
sidebar's Argmax menu ([IdentityPlans.tsx](../src/renderer/components/IdentityPlans.tsx)),
so the figures are one click away from any chat. It draws one meter per
reported window, grouped by provider, using the page's own `RemainingBar` and
series colours. A login that reports no window — Cursor, an API key, a
signed-out CLI — is left out instead of shown empty; when no login reports one
the block disappears and the menu keeps the shape it has always had, and the
Usage page remains the place a failed read is explained. Opening the menu
paints the cached figures and re-reads the accounts only once they are more
than five minutes old, so repeated opens do not poll provider endpoints.

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
provider with no usage source would be listed but could not be chosen; since
Cursor gained its estimate every provider has one.
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
OpenCode's figure for an `openrouter/` model is the exception. It is the
catalog's cheapest rate per field, not what the host billed, so the table
prices those turns ([providers.md](providers.md#opencode)).
Cursor's figures, tokens and dollars alike, are estimates and read "≈"; when
they are part of a larger total, the hero says how much ("≈$12.40 estimated
for Cursor", from `UsageSummary::estimated_cost_usd` / `estimated_tokens`).

## Router cost

Below the remaining card, a **Router** card shows what each Auto tier cost in
the page's window: Frontier, Balance, Speed, each with chats, turns, total
cost, cost per turn, median turn time and time to first activity, escalations,
and the model mix. It appears only when a
chat was routed in the window. The read is `usage:router-cost`
([routing/cost.rs](../src-tauri/src/routing/cost.rs)).

Each desktop tier expands to its recorded routing decisions, grouped by task
kind, difficulty, provider, model, effort, decision, and reason. The breakdown
separates launches (including classifier fallbacks), kept follow-ups, reroutes,
and escalations. It shows both decision counts and turns, because goal
continuations can share a route decision. It uses the same answered route
windows as the totals, excluding pins and unanswered windows. Missing
classification or effort stays explicitly unrecorded. Escalations measure
router actions, not successful outcomes or all user corrections.

Desktop shows pricing coverage as priced turns / total turns.
On desktop and iPhone, **First activity** includes reasoning and tool calls, not only a
text answer. Its existing wire field remains `medianFirstAnswerSeconds`.

The iPhone Usage tab shows the same card under its remaining card
([RouterViews.swift](../ios/Argmax/Sources/Insights/RouterViews.swift)). The
table is too wide for a phone, so a bar splits the turns across tiers, and
each tier is a block: cost beside its name, chats, turns and cost per turn
under it, then turn time, first activity and escalations in a stat strip. The
phone fetches it beside `usage:summary`, caches it with that summary, and
hides the card when the read fails or the Mac predates the channel.

- **One window per `turn_routes` row.** Every routed turn records a row, `kept`
  included. A row's window runs from its `created_at` to the chat's next row
  (open-ended for the last), and its turns are charged to the tier on its own
  row, so a chat that escalated splits across tiers. The route timestamp starts
  its first turn. A `user.message` after completion or cancellation starts a
  continuation, while messages steering an active turn do not. Goal
  continuations, which record no route row, count in the window before them.
  Rows from the window's start (the same start as the page's range) are
  counted.
- **A pin ends the chat's Router spend.** When the user picks another model,
  provider, or effort, the chat leaves Auto and records a `pinned` row
  ([routing.md](routing.md)). That row closes the window before it and is
  never a turn itself, so later work is not charged to a tier.
- **Claude, Codex, Grok, OpenCode** are priced from the `usage_events` inside
  each turn's window, by the ledger's rule: Grok and OpenCode's own dollar
  figure wins, then the list-price table. Pricing runs up to the next turn's
  start, clipped at the next route, because final usage can be recorded just
  after completion. A continuation without usage stays unpriced even when
  an earlier turn on the same route has usage.
- **Times are medians per tier.** Turn time runs from the send to the turn's
  `session.completed` / `session.cancelled`, less any time an approval waited
  on the user; first activity runs from the send to the first text, reasoning,
  or tool call. A window's first turn starts at its route row; a later one (a
  goal continuation) at its own `user.message`, so a message sent mid-turn
  starts nothing. Running and unanswered turns have no time. Medians, because
  one long agentic turn would carry an average. Both are wall clock: the only
  figure every provider has, and the one the user waits through.
- **Each row is priced by its own provider.** A Cursor chat that escalated to
  Claude prices its Claude rows from usage and only its Cursor rows as below.
- **Cursor is estimated** the way the Usage page estimates it (see
  [Cursor estimate](#cursor-estimate)), each call charged to the latest route
  row at or before it, and every amount that contains it is shown with "≈".
- **Unanswered turns are left out.** A turn with no reply, reasoning, tool
  call, or usage in its window (cancelled or failed before the model answered)
  cost nothing and is not counted anywhere: not in chats, turns, or the model
  mix. A tier left with no turns disappears, and so does the card. A turn still
  waiting on its first reply joins once that reply lands.
- **Unknown turns are unpriced.** An answered turn with no usage recorded (cut
  off before its usage landed), or on a model neither table knows, is counted
  in turns and listed as unpriced, never $0, and left out of the per-turn
  figure.

## Cursor estimate

ACP reports no tokens and `cursor-agent` stores none on disk (its
`~/.cursor/chats` stores hold message blobs, no counts or per-call model), so
[usage/cursor.rs](../src-tauri/src/usage/cursor.rs) rebuilds each Cursor chat
Argmax ran from its own `events` rows. The Usage page and the Router card share
it.

- **Tokens are text length / 4.** A model call happens at every
  `command.started`, `agent.started`, and `message.completed`. Each call
  cache-reads a 20k-token base (a one-shot `cursor-agent -p` measured ~18.8k on
  2026-09-27) plus the conversation so far, takes what arrived since the last
  call as input, and outputs its own event. A `/clear` (`session.cleared`)
  empties the conversation.
- **The conversation is what the model saw, not what was logged.** Cursor's
  event payload repeats a command's output four times (`stdout` and
  `interleavedOutput`, under `result` and again under `raw`); the copies under
  `raw` and `interleavedOutput` are dropped. One event adds at most 10k tokens:
  Cursor writes output past 40 KB (`fileOutputThresholdBytes`) to a file and
  shows the model a preview. A conversation past 1M tokens, the window of every
  Cursor model Argmax offers, is compacted, so it starts over.
- **How close it is.** Run over Claude and Codex chats with recorded usage
  (144 and 142 chats since 2026-09-10), the summed cache reads came to 1.6x
  and 0.7x of the real ones, with per-chat medians of 0.64 and 0.96. Before the
  dedupe, cap, and window, the sums were 3.0x and 1.8x: long chats, which carry
  most of the tokens, ran far past what any model can hold. On the live
  database, the change took Cursor's 30 days from ≈$244 to ≈$110.
- **Prices are Cursor's published list rates** ([cursor.com/docs/models](https://cursor.com/docs/models),
  fetched 2026-09-27), Standard not Fast, kept in that module rather than the
  ledger's table, matched by model family so an effort alias
  (`grok-4.7-medium`) prices as its family. Cursor's Auto
  (`auto-smart[...]`) bills whatever model it routed each request to, so it
  has no rate: its tokens are counted and marked *unpriced*. Composer 2.5 is
  the exception to Standard: Argmax runs it on Fast since
  2026-10-02T18:00Z, so calls from then price at Fast's $3 / $0.50 / $15
  (input / cache read / output) and earlier calls keep Standard's rate.
- **Which chats.** A chat counts when it is on Cursor now or has a Cursor
  Router row. Each call takes its provider and model from the chat's latest
  Router row at or before it; without one, from the chat's provider switches,
  priced at the chat's current model. A chat that left Cursor by a plain
  provider switch, with no Router row, is not counted: finding one means
  walking every recent chat's whole event history (~350 ms warm over 30 days),
  and it was 1 of 128 Cursor chats in the 30 days before 2026-09-27. A Cursor
  model changed mid-chat is priced at the current one, since the switch is not
  recorded.
- **Terminal use is not counted.** Only chats Argmax ran have a transcript
  here, so Cursor's tile covers Argmax chats, not all Cursor use.
- **Cost.** The read runs on every `usage:summary`, over the whole
  conversation of each Cursor chat active in this window or the one before it
  (earlier turns are context), once for both. On a copy of the 4 GB live
  database (release build, 2026-09-27), the 30-day summary took 0.26 s warm, of
  which the ledger was ~20 ms; the first, cold read of 60 days of Cursor chats
  took ~1.1 s. Moving the estimate into the incremental ledger would remove it.

## Sources

| Provider | Files | Usage record |
|---|---|---|
| Claude | `~/.claude/projects/<slug>/<session>.jsonl` and `<session>/subagents/*.jsonl` | `type:"assistant"` → `message.usage` |
| Codex | `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` and `~/.codex/archived_sessions/rollout-*.jsonl` | `event_msg` / `token_count` → `info.last_token_usage` |
| Grok Build | `~/.grok/sessions/<cwd>/<session>/updates.jsonl` | `turn_completed` → `usage` and `usage.modelUsage` |
| OpenCode | `~/.local/share/opencode/opencode.db` (`message.data`, read-only) | `tokens` and `cost` on assistant rows |
| Cursor | Argmax's own `events` rows for the chats it ran | none: estimated, see [Cursor estimate](#cursor-estimate) |

Remaining usage is a second, live read. It does not go through `usage_hourly`.
Verification mode disables its network, Keychain, and Codex app-server reads. A build with
the `verification` Cargo feature answers instead from a scripted source
(`usage/remaining/verification.rs`): the Claude adapter reads fixed windows (37% used
in the 5-hour window, 12% weekly) through its real parser, and no other read succeeds.

| Provider | Remaining source | Notes |
|---|---|---|
| Claude | `GET https://api.anthropic.com/api/oauth/usage` with Claude Code OAuth (Keychain / `.credentials.json` / `CLAUDE_CODE_OAUTH_TOKEN`). Plan from `~/.claude.json` `oauthAccount`. | Undocumented; the same endpoint Claude Code uses for `/usage`. Reports the 5-hour session, weekly (all models), and Fable weekly (`limits[]` → `weekly_scoped`). Rate-limited if polled hard. Keychain service is namespaced per config dir — see below. |
| Codex | `codex app-server` `account/rateLimits/read`, else the newest `rate_limits` object in a local rollout. | Official JSON-RPC. Windows are labeled from duration — Pro may report weekly on `primary` with no 5-hour window. |
| Grok | `GET https://cli-chat-proxy.grok.com/v1/billing?format=credits` with `~/.grok/auth.json`. | Same call Grok Build's `/usage` makes. |
| OpenCode | `GET https://openrouter.ai/api/v1/key` with `OPENROUTER_API_KEY` or the `openrouter` key in OpenCode's `auth.json`. | A key with a credit limit shows one meter, "Credit, $X of $Y". A key without a limit shows the dollars spent. |
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
different credential store than the sessions it starts. When a profile's
`.credentials.json` and keychain item both hold a token, the one with the later
`expiresAt` wins: on macOS the CLI refreshes only the keychain, so a file left
by a run that could not reach it keeps an expired token forever. The comparison
stays inside one profile; the default profile's credentials are read only when
the configured one has none, since they may belong to another account. A token that reads but
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
- After the dashboard is ready, the renderer prefetches the default 30-day
  summary and the remaining-plan read on an idle tick (in parallel) and stores
  both in memory, so the first Usage open can paint from cache while a warm
  sweep runs on Rust's blocking pool. Hovering Hacking in the sidebar kicks
  the same warm if idle prefetch has not finished yet.

Day buckets follow the machine's local zone (`chrono::Local`), which is the
zone the renderer resolves too. Hour buckets are UTC hours.

## Checking the numbers

`argmax usage --days 7 --json` prints the ledger as per-day, per-model token
totals from `<app-data>/local-state/argmax.sqlite`, the same database the
running app uses. Setting `ARGMAX_DATA_DIR` changes `<app-data>` for both the
app and this command. `node scripts/check-usage-oracle.mjs --days 7` compares
those with `ccusage daily --json` and `codexbar cost --format json` for Claude
and Codex.
A row where all three agree is `ok`; a row where Argmax matches one oracle
and the other differs is `oracles-differ` and is reported, not failed; a row
where Argmax matches neither is a `MISMATCH` and fails the script. On
2026-09-03 every Claude row matched ccusage exactly and every Codex row
matched CodexBar exactly; the residual rows were ccusage counting Codex fork
copies and CodexBar counting one extra Claude message. Costs are not
compared: the tools price from different tables.

For a session Argmax launched, the scanner's per-session totals also match the
`usage_events` rows the live normalizer wrote.
