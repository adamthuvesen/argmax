# Plan: Argmax agent tools (sessions, messaging, browser) over MCP

## Scope

**Objective.** Every agent Argmax launches gets one MCP server, `argmax`, with tools to launch, observe, message, wait on, and stop other Argmax sessions, and to drive Argmax's built-in browser. The tools work the same across Claude Code, Codex, Cursor, OpenCode, and Grok Build.

**What already exists and is reused.** `session_control.rs` already runs a private Unix socket per app run, issues a per-session bearer token, injects `ARGMAX_SESSION_LAUNCH_SOCKET` / `ARGMAX_SESSION_LAUNCH_TOKEN` / `ARGMAX_BIN` into every non-ACP child, and dispatches `argmax session launch|move|list|message` from `main.rs` before the GUI boots. `providers:send-input` already queues a message into a mid-turn session and delivers it at turn end. The MCP server is a new face on that socket, not a second control plane.

**Binding constraints.**
- One Rust binary, no sidecar: the MCP server is `argmax mcp` (stdio) in the same executable, proxying to the app over the existing socket. `rmcp` 3.x is the SDK.
- stdio transport everywhere. It is the only transport all five CLIs and the ACP spec guarantee. HTTP is not needed while the server lives in the same binary.
- Per-session credential stays. A tool call can only act with the token of the session that made it.
- Agents see the browser in their own pane: a session's browser tabs are that session's review-panel Browser mode, and the user watches the agent browse.
- Auto-approve is Argmax's default permission mode, so no new approval dialogs. Safety comes from caps, visibility, and revocable tokens.
- SQLite migrations are append-only. Renderer tests query by role/label.

**Out of scope.** Cross-machine messaging, sampling/elicitation via MCP (no target CLI supports them), remote-bridge exposure of browser tools, a11y snapshots of the Argmax UI itself.

## Decisions taken (with the evidence)

| Decision | Choice | Why |
|---|---|---|
| MCP SDK | `rmcp` 3.2 (official Rust SDK, stdio + `#[tool]` macro) | Same process as the app; TS SDK is mid v1→v2 split; no Node sidecar in the bundle. |
| Transport | stdio, `argmax mcp --socket … --token …` | Universally supported; the binary already has a CLI dispatch hook in `main.rs`. |
| Injection | Claude `--mcp-config` inline JSON; Codex `-c mcp_servers.argmax.*`; Cursor ACP `session/new`/`session/load` `mcpServers`; OpenCode temp `opencode.json` via `OPENCODE_CONFIG`; Grok project-scoped `.grok/config.toml` in the worktree | Each CLI's per-launch mechanism, all cited in the research brief. Cursor PTY path and Grok have no ephemeral flag, see risks. |
| Messaging model | Queue-until-idle (exists) plus a blocking `session_wait` tool plus automatic completion notifications to the launching session | Claude Code Agent Teams and Codex `wait_agent` both ship this pair. No CLI surfaces MCP server push notifications into the model, so pull + queue is the only portable design. |
| Browser interaction | Accessibility snapshot with `ref` handles, injected as JS; click/type by ref | Playwright MCP, Chrome DevTools MCP, Vercel agent-browser, and Claude-in-Chrome converge on this. Our own ~200-line snapshot script: Playwright's is private, browser-use's needs CDP. |
| Screenshot | `WKWebView.takeSnapshot(with:)` via `objc2-web-kit` | wry 0.55/0.56 has no capture API. |
| Loop guards | Launch depth ≤ 2, no self-messaging, per-session launch cap, completion notification is one-shot | Goose blocks recursive spawn; Claude Code issue #85047 documents the ack/idle ping-pong. |

## Tool surface (namespace `argmax`, shown to Claude as `mcp__argmax__<tool>`)

Sessions
- `session_list({ project?, all? })` → id, project, task label, provider, state, last activity, launched_by.
- `session_launch({ prompt, project?, provider?, model?, worktree?, task_label? })` → session id. Defaults to the caller's project and provider.
- `session_status({ session })` → state, current turn age, last assistant message, unread inbox count.
- `session_read({ session, cursor?, limit? })` → normalized events since cursor (text, tool rows, answers), next cursor.
- `session_message({ session, message })` → `{ queued }`. Idle target starts a turn, running target gets it at turn end.
- `session_wait({ sessions?, timeout_s })` → returns on: a watched session reaching idle/complete/failed, or a message arriving in the caller's inbox. Codex `wait_agent` shape.
- `inbox_read()` → undelivered messages for the caller, marks them delivered.
- `session_stop({ session })` → terminates the running turn (`providers:terminate`).
- `session_move({ project, worktree?, keep_source? })` → existing behaviour.

Browser (tabs are owned by the calling session)
- `browser_open({ url })` → tab id; opens Browser mode in the caller's pane.
- `browser_navigate({ tab?, url })`, `browser_back`, `browser_reload`, `browser_tabs()`, `browser_close({ tab })`.
- `browser_snapshot({ tab?, interactive_only? })` → a11y text tree with `[ref=e12]` handles.
- `browser_click({ ref })`, `browser_type({ ref, text, submit? })`, `browser_select({ ref, value })`, `browser_press_key({ key })`, `browser_scroll({ ref?, direction, amount? })`, `browser_hover({ ref })`.
- `browser_get_text({ tab?, max_chars? })` → readable page text (main content first).
- `browser_find({ query })` → refs whose role/name/text match.
- `browser_wait_for({ text?, ref?, url?, timeout_s })`.
- `browser_screenshot({ tab?, ref? })` → PNG (image content block).
- `browser_evaluate({ expression })` → JSON result.

## Phase 0: Spikes (bounded, throwaway, one day) — done, d2772215

**Deliverable:** five yes/no answers before any production code.
**Work:**
1. `rmcp` stdio hello-world compiled into `argmax mcp`; Claude Code lists the tool via `--mcp-config`.
2. Cursor ACP: `session/new` with an `mcpServers` stdio entry carrying `env` → does the tool appear, and does `session/load` carry it too?
3. OpenCode `OPENCODE_CONFIG=<tmp>/opencode.json` with a local MCP entry; Grok `.grok/config.toml` in cwd. Codex `-c mcp_servers.argmax.command=…` with `args` array quoting.
4. `objc2-web-kit` `takeSnapshotWithConfiguration:completionHandler:` on a wry child webview from Rust → PNG bytes.
5. `evaluate_script_with_callback` returning a 50 KB JSON string from a WKWebView (size and latency).
**Success check:** each spike either demonstrated in a scratch instance (`scripts/scratch-app.mjs`) or written up as blocked with the exact error. Cursor PTY (non-composer) and Grok results decide whether Phase 5 needs a fallback.

## Phase 1: MCP server with parity to today's CLI — done, 85318299

**Deliverable:** agents on Claude, Codex, Cursor ACP, and OpenCode get `session_list/launch/message/move` as MCP tools. The prompt-prefix instruction shrinks to one line for those providers and stays as is for Grok/Cursor PTY until Phase 5.
**Files:**
- `src-tauri/Cargo.toml` — add `rmcp` (server, macros, transport-io).
- `src-tauri/src/mcp/mod.rs`, `mcp/server.rs`, `mcp/session_tools.rs` — `#[tool_router]` server; each tool serialises a `SessionControlRequest` and sends it over the socket with the token from env.
- `src-tauri/src/session_control.rs` — extract the JSON socket protocol into a typed enum shared by CLI and MCP; add `Status`, `Read`, `Stop`, `Wait`, `Inbox` variants (stubs in this phase, filled in Phase 2); trim `SESSION_LAUNCH_INSTRUCTION`.
- `src-tauri/src/main.rs` — dispatch `mcp` subcommand next to `session`.
- `src-tauri/src/providers/adapters.rs` — `mcp_config_args(provider, launch_config)` appended in both fresh and resume arg builders for Claude and Codex; OpenCode writes `<worktree>/.argmax/opencode.json` and sets `OPENCODE_CONFIG`.
- `src-tauri/src/providers/cursor_acp.rs` — replace the two `"mcpServers": []` literals with the stdio descriptor carrying the per-session env. Remove the "warm ACP cannot hold a credential" exclusion, since the credential now rides in the server spec, not the process env.
- `src-tauri/src/providers/runtime.rs` — pass `SessionLaunchProcessConfig` to the arg builders.
- `src-tauri/tests` — arg-builder snapshots per provider; socket protocol round-trip tests.
**Success check:** rung-3 scratch instance, `scripts/bridge.mjs chat --provider claude --prompt "list argmax sessions with the argmax tool"` shows a `mcp__argmax__session_list` tool row with a JSON result. Repeat for codex, opencode, cursor. `cargo test`, `npm test` green.

## Phase 2: Observe, wait, stop, notify — done, 7794c9fc (inbox is migration v25)

**Deliverable:** a parent session can launch a child, block on it, read its answer, stop it, and receive its completion automatically; any session can message any other.
**Files:**
- `src-tauri/src/persistence/migrations.rs` — append migration: `sessions.launched_by_session_id`, `sessions.launch_depth`, table `session_messages(id, from_session_id, to_session_id, body, created_at, delivered_at)`.
- `src-tauri/src/session_control.rs` — implement `Status` (from dashboard state), `Read` (reuse `session:events-since` normalization; return text/tool summaries, cap bytes), `Stop` (`SessionService::terminate`), `Inbox`, `Wait` (subscribe to the in-process session-state broadcast; wake on state change of watched sessions or inbox insert; timeout).
- `src-tauri/src/providers/session_service.rs` — on turn end of a session with `launched_by_session_id`, enqueue a one-shot "Session X finished: <final answer>" message to the parent via the existing queue path; the notification carries the child's last assistant text. Guard: skip if the parent is archived or is the child itself.
- `src-tauri/src/mcp/session_tools.rs` — wire the five tools. Enforce depth ≤ 2, launch cap per session (10), reject self-message.
- Renderer: `src/renderer/components/...` — an "agent message" bubble variant for prompts whose origin is another session (origin column on the user event payload), with a link to the sender; sidebar row shows "launched by <label>" for child sessions; `SessionActions` gets "Open parent".
- `docs/providers.md` "Agent Session Control" → moves to new `docs/agent-tools.md`; `CONTEXT.md` adds "inbox", "launched-by".
**Success check:** scratch scenario script under `scripts/` or `src-tauri/tests`: parent launches child with a prompt that answers "42", calls `session_wait`, then `session_read`, and its final answer contains "42". Second scenario: `session_stop` on a long-running child flips it to cancelled within 2 s. Renderer tests for the bubble and sidebar label by role.

## Phase 3: Browser core — done, 12dd7f39 (automation) and 2fec2d7d (MCP tools)

**Deliverable:** an agent opens a page, reads a snapshot, clicks and types by ref, reads page text; the user sees it happen in that session's pane.
**Files:**
- `src-tauri/src/browser/mod.rs`, `browser/registry.rs` — Rust-owned tab registry `{ tab_id, owner_session_id, url, title, loading }` (today the renderer owns the tab list in `browserPanel.ts`); `browser:tabs` push event so the renderer mirrors it. Agent-created tabs are tagged with the owner session; user-created tabs have no owner.
- `src-tauri/src/browser/snapshot.js` — injected a11y script: walks the DOM, keeps visible + interactive + landmark nodes, assigns stable `data-argmax-ref` ids, emits an indented role/name/value text tree capped at N nodes. Design copied from Playwright's aria snapshot and agent-browser's `[ref=eN]` lines.
- `src-tauri/src/browser/actions.js` — click/type/select/scroll/hover by ref via JS (focus + dispatched Mouse/Keyboard/Input events, `value` set + `input`/`change` events, form submit on `submit: true`).
- `src-tauri/src/ipc/browser.rs` — split into thin IPC over the registry; add `eval_json(tab, script) -> Result<Value>` using `evaluate_script_with_callback` with a request-id map and timeout.
- `src-tauri/src/mcp/browser_tools.rs` — tools call the app over the socket; the app resolves the caller's session → pane, emits `browser:agent-open` so `useReviewState` enters Browser mode in that session's pane (using the existing `claimBrowserSurface`), then performs the action.
- `src/renderer/lib/browserPanel.ts`, `BrowserPanel.tsx` — tab list comes from `browser:tabs`; an agent-owned tab shows a small "agent" badge and is read-only for the user while the session is running (no address-bar hijack mid-action).
- `src-tauri/src/remote/dispatch.rs` — the new channels join `REMOTE_UNSUPPORTED_CHANNELS`.
**Success check:** rung-3 scenario: Claude session with prompt "open https://example.com in the argmax browser, snapshot it, click the 'More information' link, tell me the resulting URL". Answer contains `iana.org`. Rung-4 screenshot shows the Browser tab active in that session's pane with the page. Unit tests for `snapshot.js` and `actions.js` run in vitest against jsdom fixtures.

## Phase 4: Browser completeness — folded into Phase 3, 2fec2d7d

**Deliverable:** screenshot, find, wait_for, keys, evaluate, dialogs, multi-tab.
**Files:**
- `src-tauri/Cargo.toml` — `objc2-web-kit`; `src-tauri/src/browser/snapshot_image.rs` — `takeSnapshot` → PNG, cropped to a ref's bounding box when given.
- `src-tauri/src/browser/actions.js` — `press_key`, `scroll`, `wait_for` (poll inside the page with MutationObserver + timeout), `find`.
- `src-tauri/src/ipc/browser.rs` — dialog handling (`alert/confirm/prompt` overridden in the init script to post to Rust; a `browser_handle_dialog` tool answers).
- `src-tauri/src/mcp/browser_tools.rs` — remaining tools; screenshot returned as an MCP image content block.
- `docs/browser.md` — agent section; `docs/agent-tools.md` — full tool reference.
**Success check:** scenario: "search DuckDuckGo for 'tauri wry', open the first result, screenshot it". Tool rows show snapshot → type → press Enter → wait_for → click → screenshot, and the chat shows the image.

## Phase 5: Providers without an ephemeral injection path, docs, ADR — done, 1855368f (review fixes in d56b1a1b)

**Deliverable:** Grok Build and Cursor's non-ACP path get the tools; the design is recorded.
**Files:**
- `src-tauri/src/providers/adapters.rs` — Grok: write `<worktree>/.grok/config.toml` (project-scoped) at launch and add `.grok/` to the worktree's `.git/info/exclude`; Cursor PTY: same with `.cursor/mcp.json` unless Phase 0 found a flag. Shared checkout ("current" workspaces) must not leave files behind: write, launch, remove on exit.
- `docs/adr/0005-agent-tools-are-one-mcp-server.md` — the table of decisions above, and why the socket + token model is kept.
- `docs/agent-tools.md`, `docs/providers.md`, `docs/browser.md`, `docs/verification.md` (new harness scenarios), `AGENTS.md` index line.
**Success check:** `bridge.mjs chat --provider grok` and `--provider cursor` (non-composer model) both show a working `session_list` tool row; `git status` in the worktree is clean after the session ends.

## Final Checks

- `npm run typecheck`, `npm run lint`, `npx vitest run`, `npm run check:tauri-bridge`, `npm run check:bindings`, `cargo test`, `cargo fmt`, `npm run check:main-thread` (the socket handlers must not block the main thread; `Wait` is async).
- Bundle: `npm run tauri:build`, confirm `argmax mcp` works from the installed `/Applications/Argmax.app/Contents/MacOS/argmax` path (that is what `ARGMAX_BIN` points at).
- Token revocation: a stopped or archived session's token fails every tool with a clear error.
- Perf budget: `browser_snapshot` on a news front page under 300 ms and under 40 KB.

## Risks and Open Questions

- **Initiative.** Decided 2026-09-02: agents may launch, message, and wait on other sessions on their own initiative when the task needs it. Depth cap ≤ 2, per-session launch cap, every launch visible in the sidebar. The old "only when the user explicitly asks" clause is removed from the instruction and tool descriptions.
- **Cursor PTY and Grok config files in a shared checkout.** Writing dotfiles into the user's real repo is the only injection path found. Decided 2026-09-02: acceptable. Write at launch, add to `.git/info/exclude`, remove after the session ends.
- **ACP `session/load` after restart.** Whether Cursor re-reads `mcpServers` on load is Phase 0 spike 2. If not, warm sessions lose the tools after an app restart until the next `session/new`.
- **Synthetic clicks.** JS-dispatched events do not fire for some native controls (file inputs, some `<select>` UIs). Fallback is a native `NSEvent` click at the ref's centre through the window; deferred until a real page needs it.
- **Message delivery mid-turn.** No CLI surfaces server push into a running model. A running agent only sees a message when it calls `session_wait`/`inbox_read` or when its turn ends. The tool descriptions say so.
- **Token in `--mcp-config` argv.** The per-session token becomes visible in `ps`. Same exposure as today's env var to a same-user process; acceptable for a single-user local app, noted in the ADR.
