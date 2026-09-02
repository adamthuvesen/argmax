# Multitask

A multitask is a chat dispatched from inside another chat while its agent is mid-turn: the small, often unrelated fix you think of halfway through something else. The turn in flight is never touched — no queueing behind it, no stopping it, no second turn in the same session. The multitask runs as a sibling session, by default in the same checkout as the chat that started it, and reports back into that chat when it is done.

## Dispatching one

Two paths, both in the composer ([SessionComposer.tsx](../src/renderer/components/SessionComposer.tsx)):

- `/multitask <prompt>` — typed straight into the composer, also reachable from the slash menu.
- **Multitask** on a queued follow-up — promotes a message waiting behind the running turn. It leaves the queue (it is running now) and, unlike "Send now", never interrupts the turn.

Both call `session:multitask` ([ipc/session.rs](../src-tauri/src/ipc/session.rs)), which lands in [multitask.rs](../src-tauri/src/multitask.rs).

## What the dispatch does

`dispatch` reads the parent session and its workspace, then launches through the ordinary `launch_with_spec` path:

- **Same checkout by default.** The new workspace points at the parent's checkout, so the fix lands on the branch the person is already on. `worktree: true` is the escape hatch for work expected to collide, and the card then shows an **Isolated** badge.
- **Inherited launch settings.** Provider, model, reasoning effort, permission mode, and agent mode come from the parent, so a multitask runs like the chat it came from. Fast mode does not: it is a per-launch choice, and a side fix is not where you spend it.
- **Fresh context.** The multitask is a new provider conversation, not a fork of the parent's transcript. Nothing about the parent's session — its handle, its provider process, its `provider_conversation_id` — is reused, which is exactly why the parent's turn keeps running undisturbed.
- **Shared-checkout guardrails.** When it shares the checkout, the prompt carries a preamble naming the branch and task already in progress and asking the agent to stage only its own files. An isolated multitask gets the bare prompt.
- **Its own lineage.** The child records `launched_by_session_id` (so both chats keep the link back) with `launch_kind = 'multitask'` and `launch_depth = 0`. Launch depth exists to stop an agent from launching agents without end; a person asking for one more chat is not that, so a multitask dispatched from a chat two agents deep still starts at the top. For the same reason multitasks do not count against the per-session agent launch cap ([sessions.rs](../src-tauri/src/persistence/sessions.rs) counts `launch_kind = 'agent'` only).

## Reporting back

Delivery is passive on purpose: the parent is told, but never interrupted.

1. On dispatch, a `multitask.launched` row is written to the **parent's** timeline with the child's session and workspace ids, the label, and the prompt.
2. When the child's turn ends, `notify_launcher_of_turn_end` routes it to `record_multitask_finish` instead of the ordinary completion notice ([session_service.rs](../src-tauri/src/providers/session_service.rs)): a `multitask.finished` row lands in the parent's timeline, and a `multitask`-kind inbox row is recorded. A multitask never wakes the parent with a turn of its own.
3. The next time the person sends a message in the parent chat, up to `MAX_RESULTS_PER_PROMPT` undelivered results ride in as a preamble on the launch prompt. The persisted `user.message` stays exactly what the person typed.

## In the chat

`multitask.launched` / `multitask.finished` are conversation-visible event types ([sessionConversationModel.ts](../src/renderer/lib/sessionConversationModel.ts)), folded into a `multitask` render item by [foldConversation.ts](../src/renderer/lib/foldConversation.ts) and drawn by [MultitaskCard.tsx](../src/renderer/components/MultitaskCard.tsx).

Two rules shape how the card sits in the transcript:

- **A dispatch is not a turn boundary.** Multitask rows are deferred and emitted when the turn they landed in closes, so dispatching one mid-turn never splits that turn's block into two — which would read as an interruption the agent never had.
- **One card per multitask.** The dispatch row opens the card and the finish row, which can arrive a whole turn later, merges into it wherever it already sits (keyed by child session id). A finish whose dispatch has fallen out of the transcript window still renders on its own.

The card carries the label, the state, **Stop** while it runs, and **Open** to jump into the child chat. From the child, the session actions menu offers "Open launching chat" — the same link in reverse.

## Testing

- Rust: [src-tauri/tests/multitask.rs](../src-tauri/tests/multitask.rs) — same-checkout sibling with inherited settings and guardrail prompt, isolated worktree, finishing without starting a turn in the parent, results riding the next prompt but not the persisted message, lineage and launch caps.
- Renderer: `multitask.test.ts`, `foldConversation.test.ts` (turn splitting and card merging), `MultitaskCard.test.tsx`, `SessionComposer.multitask.test.tsx`.

## Related

- [ADR 0006 — A multitask is a sibling session](adr/0006-a-multitask-is-a-sibling-session.md)
- [workspaces.md](workspaces.md) for shared checkouts, [chat-cards.md](chat-cards.md) for the chat surface.
