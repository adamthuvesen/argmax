# Plan — browser reads agents can trust

Make Argmax's browser tools easy for any agent on any site. No domain-specific
schemas, no new tools, no flight (or any other vertical) vocabulary.

Cookie banners, challenge pages, SPAs that keep spinning, and card-shaped
result lists are the same problem on docs, dashboards, search, and shops. The
browser tools already cost 27 of 55 MCP tools and about 37% of the prefix —
the fix is richer replies on the verbs that exist.

## Scope

**Do:** dismiss cookie CMPs on agent tabs; say what the page *is* on every
read; extract repeating items and filled fields; make waits miss with a
description; echo whether a click/type moved the page.

**Do not:** add tools; add travel/price/trip-type fields; install a browser
extension (WKWebView cannot); set session `attention` from a captcha; vendor
DuckDuckGo Autoconsent (needs a background message bridge). Cookie handling is
a compact init script, same shape as `dialog.js`.

Localhost and loopback skip cookie auto-click so an agent testing a first-party
banner still sees it.

## Phase 1: Cookie banners vanish on agent tabs

**Deliverable:** Opening a third-party page in an agent tab dismisses a CMP
without a tool call. A leftover banner still shows `state: cookie`.

**Files:** `src-tauri/src/browser/cookie.js` (new); `src-tauri/src/ipc/browser.rs`;
`src-tauri/src/providers/mcp_injection.rs`; `src/test/browserAgentScripts.test.ts`;
`docs/browser.md`; `docs/agent-tools.md`

**Work:** Document-start script on every frame of session-owned tabs. Click a
known CMP accept control, else an accept/reject button inside a cookie-shaped
dialog. Prefer accept so embeds unlock. One click per load. MCP instructions
say banners are auto-dismissed and leftover ones may still be accepted.

**Success check:** Vitest: OneTrust-style Accept all is clicked; a non-cookie
"Accept" is not; localhost is left alone.

## Phase 2: `state:` on every read

**Deliverable:** Snapshot, extract, and get-text report `captcha` | `cookie` |
`error` | `loading` | `ready` plus a short reason. Wait misses include the
same line instead of a bare timeout error.

**Files:** `snapshot.js`; `automation.rs`; `types.ts`; bindings; docs; tests

**Work:** Header line on the aria tree (`state: captcha — Cloudflare challenge`),
and a `state` field on the JSON reads. Detection is conservative (challenge
frames, cookie dialogs, error titles/URLs, `aria-busy` / `progressbar`).
`empty_results` is out: silence and a spinner look the same.

**Success check:** Vitest fixtures for each kind; snapshot tree always has a
`state:` line.

## Phase 3: Extract items and fields

**Deliverable:** `browser_extract` returns repeating visible items (cards,
listrows) and labeled form fields with their current values, still generic.

**Files:** `snapshot.js`; `PageExtraction` in `automation.rs`; `types.ts`;
bindings; tool description; tests

**Work:** Groups of ≥3 similar siblings (`listitem`, `row`, `li`, `article`).
Cap 40 items, short text, a `ref` when the row is clickable. Fields from
visible inputs/comboboxes. Existing headings/sections/tables/links stay.

**Success check:** A list of four cards becomes four `items`; a search form
becomes `fields` with names and values.

## Phase 4: Waits and action echo

**Deliverable:** `browser_wait_for` can wait for network quiet or a minimum
item count, and a miss returns the page instead of `BROWSER_WAIT_TIMEOUT`.
Click/type report whether the URL or visible text moved, and whether a listbox
opened.

**Files:** `actions.js`; `capture.js`; `automation.rs`; `browser_tools.rs`;
`types.ts`; docs; tests

**Work:** `quiet_ms` uses in-flight fetch/XHR from capture. `min_count` counts
visible list-like nodes (optionally containing `text`). Timeout is a structured
miss: `matched: false`, `state`, sample text, inflight count. Default timeout
stays 10s, cap 60s.

**Success check:** Vitest for quiet/min_count/miss payload and click echo;
Rust deserializes the new wait action shape.

## Out of this change

Subtree snapshot-by-ref, snapshot diffs, tab summaries, form-fill
orchestrators, persistent bot profiles, GPC headers, EasyList cosmetic hiding
as the cookie strategy, and any per-site recipe book.
