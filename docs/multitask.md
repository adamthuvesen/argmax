# Multitask

A multitask is a chat dispatched from inside another chat while its agent is mid-turn: the small, often unrelated fix you think of halfway through something else. The turn in flight is never touched — no queueing behind it, no stopping it, no second turn in the same session. The multitask runs as a sibling session, by default in the same checkout as the chat that started it, and reports back into that chat when it is done.

## Dispatching one

Two paths, both in the composer ([SessionComposer.tsx](../src/renderer/components/SessionComposer.tsx)):

- `/multitask <prompt>` — typed straight into the composer, also reachable from the slash menu.
- **Multitask** on a queued follow-up — promotes a message waiting behind the running turn. It leaves the queue (it is running now) and, unlike "Send now", never interrupts the turn.

Both call `session:multitask` ([ipc/session.rs](../src-tauri/src/ipc/session.rs)), which lands in [multitask.rs](../src-tauri/src/multitask.rs).

## What the dispatch does

`dispatch` reads the parent session and its workspace, then launches through the ordinary `launch_with_spec` path:

- **Same checkout by default.** The new workspace points at the parent's checkout, so the fix lands on the branch the person is already on. `worktree: true` is the escape hatch for work expected to collide, and the chat row then reads `Multitask · isolated`.
- **Inherited launch settings.** Provider, model, reasoning effort, permission mode, and agent mode come from the parent, so a multitask runs like the chat it came from. Fast mode does not: it is a per-launch choice, and a side fix is not where you spend it.
- **Fresh context.** The multitask is a new provider conversation, not a fork of the parent's transcript. Nothing about the parent's session — its handle, its provider process, its `provider_conversation_id` — is reused, which is exactly why the parent's turn keeps running undisturbed.
- **Shared-checkout guardrails.** When it shares the checkout, the prompt carries a preamble naming the branch and task already in progress and asking the agent to stage only its own files. An isolated multitask gets the bare prompt.
- **Its own lineage.** The child records `launched_by_session_id` (so both chats keep the link back) with `launch_kind = 'multitask'` and `launch_depth = 0`. Launch depth exists to stop an agent from launching agents without end; a person asking for one more chat is not that, so a multitask dispatched from a chat two agents deep still starts at the top. For the same reason multitasks do not count against the per-session agent launch cap ([sessions.rs](../src-tauri/src/persistence/sessions.rs) counts `launch_kind = 'agent'` only).

## Reporting back

Delivery is passive on purpose: the parent is told, but never interrupted.

1. On dispatch, a `multitask.launched` row is written to the **parent's** timeline with the child's session and workspace ids, the label, and the prompt.
2. When the child's turn ends, `notify_launcher_of_turn_end` routes it to `record_multitask_finish` instead of the ordinary completion notice ([session_service.rs](../src-tauri/src/providers/session_service.rs)): a `multitask.finished` row lands in the parent's timeline, and a `multitask`-kind inbox row is recorded. A multitask never wakes the parent with a turn of its own.
3. The next time the person sends a message in the parent chat, up to `MAX_RESULTS_PER_PROMPT` undelivered results ride in as a preamble on the launch prompt. The persisted `user.message` stays exactly what the person typed.

A multitask that was mid-turn when the app went down never reaches step 2, so `recover_orphaned_sessions` writes the finish row itself while it marks the orphan `failed` — the same passive delivery, one boot later.

## In the chat

`multitask.launched` / `multitask.finished` are conversation-visible event types ([sessionConversationModel.ts](../src/renderer/lib/sessionConversationModel.ts)). [foldConversation.ts](../src/renderer/lib/foldConversation.ts) hangs them on the turn they were dispatched from, and [SessionConversationTurn.tsx](../src/renderer/components/SessionConversationTurn.tsx) draws each one among that turn's tool rows with [MultitaskRow.tsx](../src/renderer/components/MultitaskRow.tsx).

The row has the shape of a subagent launch row, because that is what a multitask is to the reader: work running alongside this turn, opened in the same dock — not another chat in the sidebar. Six rules shape it:

- **It sits inside the turn, where the work forked.** The row is sorted into the turn's body by the dispatch's timestamp, the same way a subagent launch is. It is not a seam — it joins the turn instead of ending it, so dispatching one mid-turn never splits that turn's block in two, which would read as an interruption the agent never had.
- **One row per multitask.** The dispatch row opens it and the finish row, which can arrive a whole turn later, merges into it wherever it already sits (keyed by child session id) — so a multitask that finishes during a later turn still updates the row in the turn that started it. A finish whose dispatch has fallen out of the transcript window renders on its own, without a link, since there is nothing left to open.
- **The session outranks the timeline.** The row takes its state from the child's session row whenever that session is still in the snapshot, and falls back to the events otherwise. The timeline only knows what was written, so a multitask whose turn ended while the app was shut would otherwise claim to be running for good.
- **A finished row says what it found.** The first line of the answer rides the status line (`Completed · Corrected the 0.4 heading to 2026.`), stripped of its markdown and cut at 120 characters by `multitaskAnswerPreview`. It is a pointer, not the delivery: the whole answer is in the dock tab, and the agent still gets it as a preamble on the next prompt.
- **The mark says which it is.** Running, it shares the subagents' working nest — at that moment they are doing the same thing. Settled, it carries the Split glyph its dock tab uses, so the transcript and the tab strip name a multitask the same way. Its status words are the launch row's own (`Running` / `Completed` / `Failed`) plus `Stopped`.
- **Stop rides the row.** A running multitask can be stopped without opening it; the button appears on hover, and whenever it is tabbed to. Stopping one stops only that session: the early-stop rule that hands a pane back to the launcher ([earlyStop.ts](../src/renderer/lib/earlyStop.ts)) is a pane behaviour, and a multitask has no pane, so the chat that dispatched it stays exactly where it was — launcher draft included.

Because a multitask shares the dock's tab strip with the subagents, it is counted in the workspace card's section beside it too ([subagentSummary.ts](../src/renderer/lib/subagentSummary.ts)); that section is named `Alongside` rather than `Subagents` once a multitask is in it.

## Not in the sidebar

A multitask belongs to the chat that dispatched it, so it has no sidebar row: `hiddenMultitaskWorkspaceIds` ([multitask.ts](../src/renderer/lib/multitask.ts)) drops its workspace from every sidebar section. The one exception is an orphan — a multitask whose launching chat has left the snapshot. There is nowhere else to reach it from and its checkout may hold uncommitted work, so its row comes back.

This is the only thing `sessions.launch_kind` reaches the renderer for: an agent-launched session is a chat in its own right and keeps its row, and only `multitask` loses one.

## In the dock

Clicking the row opens the multitask as a tab in the review panel's Agents view, beside this session's subagents ([AgentsView.tsx](../src/renderer/components/AgentsView.tsx)). A tab id is a provider tool-use id for a subagent and `multitask:<sessionId>` for a multitask ([agentTabs.ts](../src/renderer/lib/agentTabs.ts)); the view resolves each to either `AgentActivity` or [MultitaskPanel.tsx](../src/renderer/components/MultitaskPanel.tsx).

A multitask is a real session, so its tab is the ordinary chat surface rather than a read-only transcript: it can be answered and steered without leaving the chat you were watching. The panel takes every session's events (the pane-scoped `events` a subagent transcript reads belong to the parent), keeps the review state inert — the dock *is* the review panel — and drops the checks card, which the parent chat already carries for the same checkout. The composer carries an expand button — the way back to a full pane, for when a side errand turns into the work.

The chat a multitask was dispatched from is reachable the other way too: the session actions menu offers "Open launching chat".

A surface that hands the pane no multitasks has no dock to host them — the phone — and its rows open the chat itself instead.

## Testing

- Rust: [src-tauri/tests/multitask.rs](../src-tauri/tests/multitask.rs) — same-checkout sibling with inherited settings and guardrail prompt, isolated worktree, finishing without starting a turn in the parent, results riding the next prompt but not the persisted message, lineage and launch caps.
- Renderer: `multitask.test.ts` (notices, sidebar hiding, grouping), `agentTabs.test.ts`, `foldConversation.test.ts` (the row riding inside its turn, and merging across turns), `MultitaskRow.test.tsx`, `subagentSummary.test.ts` (multitasks in the card's count), `SessionComposer.multitask.test.tsx`, and `App.multitask.test.tsx` end to end — no sidebar row, the row inside the turn block, the dock tab carrying the multitask's own transcript, and a stop that leaves the dispatching chat alone.

## Related

- [ADR 0006 — A multitask is a sibling session](adr/0006-a-multitask-is-a-sibling-session.md)
- [workspaces.md](workspaces.md) for shared checkouts, [chat-cards.md](chat-cards.md) for the chat surface.
