# Chat: Interactive Cards

The chat surface renders two kinds of *interactive cards* on top of the normal
assistant bubble stream: **PlanCard** (Claude Code plan mode) and
**QuestionCard** (Claude Code `AskUserQuestion`, Cursor `askQuestionToolCall`).
Claude's newer `--brief` `SendUserMessage` tool is plain assistant text, so
the normalizer maps it to `message.completed` instead of a card.
Turn detection and card state live in
[turnInteractiveCards.ts](../src/renderer/lib/turnInteractiveCards.ts)
and [turnToolItems.ts](../src/renderer/lib/turnToolItems.ts). Question parsing
lives in [questions.ts](../src/renderer/lib/questions.ts). Rendering still flows
through the turn body in
[SessionConversation.tsx](../src/renderer/components/SessionConversation.tsx),
[SessionConversationTurn.tsx](../src/renderer/components/SessionConversationTurn.tsx),
[PlanCard.tsx](../src/renderer/components/PlanCard.tsx), and
[QuestionCard.tsx](../src/renderer/components/QuestionCard.tsx).

## Chat surface ownership

[SessionConversation.tsx](../src/renderer/components/SessionConversation.tsx)
is the shell: it derives the timeline projections, thinking state, turn model,
card handlers, scroll behavior, and pane chrome. Pure timeline plumbing lives in
[sessionConversationModel.ts](../src/renderer/lib/sessionConversationModel.ts):
conversation-event filtering, raw transcript suppression checks, tool-call
pairing, and last-significant-event selection. The prompt box, attachment flow,
model/mode chips, queued follow-ups, stop/send controls, and focus behavior live in
[SessionComposer.tsx](../src/renderer/components/SessionComposer.tsx).
Header actions, PR refresh state, git actions, and debug-log toggling are handled in
[SessionActionsMenu.tsx](../src/renderer/components/SessionActionsMenu.tsx).

## Why cards exist

Claude Code's `ExitPlanMode` and `AskUserQuestion` tools are designed for
interactive sessions. Argmax launches Claude in **structured-json** mode
(`-p --output-format stream-json`; see
[adapters.rs](../src-tauri/src/providers/adapters.rs)), which has no
interactive stdin. The CLI handles this by returning a
`tool_result { is_error: true, content: "Exit plan mode?" / "Answer questions?" }`
and ending the turn.

Claude Code's `--brief` mode exposes `SendUserMessage` instead. That tool only
carries text for the user, so it is normalized into an assistant bubble rather
than a `QuestionCard`; persisted raw `SendUserMessage` tool rows are hidden if
they reach the renderer.

The plan / question content the model wanted to deliver still arrives in the
tool's `input.plan` or `input.questions`. We extract that and render it as a
card. The user clicks an option, the answer becomes the next user message, and
Claude's next turn picks it up via `--resume`.

## Detection rules (per turn)

Turn view-model prep (assistant group fold, card cutoff, hidden tool ids) lives in
[sessionTurnView.ts](../src/renderer/lib/sessionTurnView.ts). The turn branch
in [SessionConversation.tsx](../src/renderer/components/SessionConversation.tsx)
consumes `buildTurnRenderState` and renders cards through
[SessionConversationTurn.tsx](../src/renderer/components/SessionConversationTurn.tsx).

| Rule | Applies to | Why |
|---|---|---|
| **First valid wins** | `AskUserQuestion` | Haiku retries on validation/deny errors. Pinning the card key to the first valid tool keeps the user's in-progress selections alive across retries. |
| **All matching ids hidden** | both tools | Every `ExitPlanMode` / ask-question tool id (any status) goes into a filter set so the raw tool row never renders. |
| **Flatten tool-groups** | ask-question tools | Two retries inside the 75 ms parallel window fold into a `tool-group`. Detection looks inside groups; if the group is *only* ask-question tools the group row is hidden too. |
| **Card renders on `error` too** | both tools | The tool reliably ends in `error` in `-p` mode. Card-render path skips only `status === "running"`, never `done`-vs-`error`. |
| **Post-card text suppressed** | both tools | Assistant text with `createdAt > tool.createdAt` is filtered out. For PlanCards the model re-emits the plan as a duplicate bubble; for QuestionCards it confabulates "Thanks based on your input" with fabricated answers BEFORE the user has touched the card. The card already conveys the ask in both cases. The cutoff is per-turn, so genuine follow-up scan results in the *next* turn (after the user submits) still come through. Pre-tool intro narration always stays. |

## Thinking indicator

The "Thinking" bubble is suppressed when any of these are true:

- `session.state !== "running"`
- the last significant event is `message.delta` (visible assistant text is actively streaming)
- a *visible* tool is running (`tool.name` is not `ExitPlanMode` / an ask-question tool; the tool's own spinner is the indicator)
- **there is an outstanding card ask**: the most-recent `AskUserQuestion` / `ExitPlanMode` happened after the last `user.message` ([turnInteractiveCards.ts](../src/renderer/lib/turnInteractiveCards.ts) /
[SessionConversation.tsx](../src/renderer/components/SessionConversation.tsx))

The outstanding-card check is the one cards depend on: while a card is
on screen waiting for the user, the agent is *waiting on the user*, not
"thinking". Showing Thinking would mislead. When the user submits, a new
`user.message` lands → `lastUserMessageTime` advances past the tool's
`createdAt` → Thinking resumes for the new turn.

Otherwise, if the session is still running, the bubble is shown during any
silent gap: before the first answer, after a completed answer chunk, and after a
completed tool row while the model decides what to do next.
The first empty beat appears immediately. Most mid-turn silent gaps use a 700 ms
show delay. Gaps after completed assistant text use a longer 1800 ms grace
period, because final answer events often arrive shortly before the terminal
session-state delta; this prevents a bogus one-second tail Thinking bubble when
the turn is already done. Once the label is visible it stays up for at least
600 ms, so rapid delta/tool chatter does not make it blink.

These conditions are provider-agnostic. Do **not** suppress Thinking on the
`session.streaming` first-byte beacon for Codex (an earlier heuristic did): the
beacon fires on raw child bytes, but Codex then reasons for seconds before any
visible item lands, so suppressing on it blanked the entire initial wait. The
beacon's only job is suppressing the raw-stdout transcript fallback (via
`hasRenderableContent`), not the Thinking indicator.

## Smooth answer reveal

Provider deltas are not equally fine-grained. Claude and Cursor often stream
small `message.delta` fragments, but either can still deliver a larger paragraph
or block, and Codex frequently surfaces completed protocol items. The renderer
does not split or rewrite persisted events. Instead,
[StreamingMarkdown.tsx](../src/renderer/components/StreamingMarkdown.tsx)
reveals large *visible* streaming backlogs at a fixed character cadence. Small
token-like deltas render immediately; large chunks are paced. Only the latest
turn of a running session is treated as streaming. When a session stops before a
`message.completed` row arrives, its stored delta-only answer is rendered as
history and snaps to the exact final text on reopen, so copy/paste stays
faithful. Reduced-motion users skip the paced reveal.

## Live auto-scroll

The conversation list uses [useSmartFollowScroll.ts](../src/renderer/hooks/useSmartFollowScroll.ts)
to follow live output. `.conversation-list` keeps a constant bottom padding
(`--space-8`) in every state — idle and live alike. That gap is deliberately
*not* toggled per turn: a reserve that only appeared while streaming would be
reclaimed the instant the turn ended, jerking the view up as the last line
settled. The steady gap keeps the latest rendered text clear of the bottom edge
and above the composer without that wobble. While a session is running, any text
growth eases the viewport to the physical bottom via one `requestAnimationFrame`
follower that reads the latest bottom each frame, so rapid growth updates a
moving target instead of restarting native smooth-scroll animations. If the user
scrolls up with real input, auto-follow pauses and the scroll-to-latest FAB
appears as before. The hook also observes direct conversation-list children with
`ResizeObserver`, because smooth text reveal grows an existing assistant turn
without changing the `conversationItems` array.

## Extended-thinking (Thought block)

Distinct from the pre-answer "Thinking" indicator above: provider-visible
thinking content is surfaced by the normalizers as `message.delta` events with
`payload.thinking === true`. Claude streams `thinking_delta` fragments from
`--include-partial-messages`, Codex emits completed `reasoning` items when
reasoning summaries are enabled, and Cursor emits `thinking/delta` rows in
`stream-json` mode. The renderer treats all three the same way. Raw hidden
reasoning and opaque token counters are never rendered as Thought blocks.

Two layers cooperate to keep it visible and out of the way:

- **Survival.** `pruneSupersededDeltas` ([snapshot.ts](../src/renderer/lib/snapshot.ts))
  and `buildConversationEvents`
  ([sessionConversationModel.ts](../src/renderer/lib/sessionConversationModel.ts))
  both make an exception for thinking deltas, so they are *not* dropped when the
  turn's `message.completed` lands. Keep these in sync: a thinking delta kept by
  one and dropped by the other produces a flash-then-vanish.
- **Fold + dedup + rendering.** `coalesceAssistantGroups`
  ([sessionTurnView.ts](../src/renderer/lib/sessionTurnView.ts)) folds the
  streamed thinking fragments into one growing `AssistantGroup` (`thinking:
  true`), kept in a buffer separate from the answer (flushed whenever the kind
  flips). The whole assistant message later re-sends the *full* reasoning as one
  block; a cumulative-aware append (`appendThinking`) dedups it to a no-op
  instead of doubling the text.
  [SessionConversationTurn.tsx](../src/renderer/components/SessionConversationTurn.tsx)
  routes thinking groups to [ThoughtBlock.tsx](../src/renderer/components/ThoughtBlock.tsx)
  instead of an inline answer bubble, keeping their chronological position in the
  turn body (before the tools and answer they preceded). The block uses a quiet
  title-case label and keeps the expanded reasoning body aligned to the same
  turn content edge.

**Expand while live, setting when done.** The Thought block takes a `live`
prop, computed per turn in `SessionConversationTurn` as *latest turn + session
running + not paused on a card + no answer text yet*. While `live`, the block is
**expanded** and labeled "Thinking". The reasoning streams in token-by-token,
in place of the generic Thinking indicator (the pulsing label still covers the
gap before any assistant content arrives). The instant the first answer token lands
(or the turn stops being the active one, or it pauses for input), `live` flips
off and the block follows the saved `argmax.thinking.expanded` default from
Settings → Agents → Thinking blocks. A manual toggle overrides the auto behavior
(same `userToggle ?? auto` pattern as the turn chip and tool groups).

## Subagent activity panes

Agent tool rows (`Task`, Codex `spawn_agent`, Cursor `taskToolCall`) open an
in-app activity pane instead of dumping child-agent prose into the parent chat.
The row itself is a split control: clicking the main row opens or focuses the
pane, while the small chevron still expands inline metadata. The parent
projection hides rows with `parent_tool_use_id` and Codex child-thread
`agent_message` rows; the pane projection reads those same persisted events and
shows them as the subagent's own timeline.

Agent panes are dependent grid cells, keyed by `parentSessionId` and
`parentToolUseId`. Opening the same subagent focuses the existing pane. Closing
or replacing the parent session pane also closes its agent panes, so a subagent
view never survives as a standalone session when the user switches context. If
the split grid is full, the row click shows the pane-limit toast and leaves the
current panes alone.

For Claude, child prose and tool calls normally arrive in the parent provider
stream with `parent_tool_use_id`, so no extra backfill is needed. Codex and
Cursor expose richer child details in provider-local traces: Codex writes child
session JSONL under `~/.codex/sessions` / `~/.codex/archived_sessions`, while
Cursor writes child transcripts under
`~/.cursor/projects/*/agent-transcripts/<agentId>/`. Opening an agent pane calls
`session:agent-events`; the backend tries to import those trace rows into
normal `events` rows with `traceImported: true`, `providerChildSessionId`,
`traceSource`, `traceSequence`, and the spawning `parent_tool_use_id`. Imported
rows use deterministic IDs, so repeated pane opens or live polling do not
duplicate events.

The pane polls `session:agent-events` only while the parent session or agent
tool is still running. Main chat polling stays on `session:events-since`, so a
normal chat view does not scan provider trace directories. While a running
subagent has no imported child rows yet, the pane shows the same quiet Thinking
state as the main chat. The limited-data notice appears only after the pane has
settled and the provider still did not expose child activity. Child tool rows
stay compact while running; the spinner carries live state so fast tools do not
flash open and closed as completions arrive.

Providers can emit a launch-looking row before the real child link exists, then
retry with the same prompt once the child is created. The parent projection hides
the earlier unresolved row when a later same-prompt agent has child evidence —
but only once the earlier row is no longer running, since a running row may be
a legitimate parallel agent whose open pane must not be force-closed.
Two completed same-prompt agents still render as two real launches. If trace
import fails because a provider moves or redacts its local files, the pane keeps
safe launch metadata and shows a load or limited-data notice instead of breaking
the chat. Provider-private async launch receipts (for example Claude metadata
that names internal agent ids or output files) are never rendered as the
subagent result.

## Submission flow

When the user clicks Submit on a PlanCard or QuestionCard, the handler must
terminate the still-alive probe *before* sending the answer. Otherwise the
answer gets queued in main behind whatever fallback text the model is still
emitting, and the user waits for that to finish before the next turn starts.

```ts
// SessionConversation.tsx, handlePlanAccept / handleQuestionAnswer
if (session.state === "running") {
  void onTerminateSession(sessionId).then(() =>
    onSendSessionInput(sessionId, message, selectedModel, mode)
  );
} else {
  void onSendSessionInput(sessionId, message, selectedModel, mode);
}
```

Main's `sendInput` already relaunches the agent when no live handle exists
(see [session_service.rs](../src-tauri/src/providers/session_service.rs)),
so the terminated session resumes via `--resume <conversationId>` and sends a
capped visible transcript plus the answer as the next user message. The UI
timeline still stores only the raw answer text.

## QuestionCard answer format

The card formats the user's picks as `**<header>**: <chosen label>` per
question, joined with blank lines. Multi-select joins selections with commas.
The model has the full question text from the original tool call, so the
short header is enough context.

## Keyboard contract (PlanCard + QuestionCard, and any future ask-user card)

One contract; deviations are bugs. Locked by component tests in
[PlanCard.test.tsx](../src/renderer/components/PlanCard.test.tsx) and
[QuestionCard.test.tsx](../src/renderer/components/QuestionCard.test.tsx).

| Key            | Effect                                                                    |
| -------------- | ------------------------------------------------------------------------- |
| `↑` / `↓`      | Move selection between options                                            |
| `1`-`9`        | Pick the nth option (also moves selection)                                |
| `Space`        | Toggle the focused option; multi-select questions only                    |
| `Enter`        | Submit. Triggers `onAccept`/`onReject` (PlanCard) or `onAnswer` (QuestionCard) |
| `Escape`       | **No-op.** Cards are not dismissible; the answer dismisses the card.      |

On submit the card collapses to a one-line summary header with an Expand
chevron so the chat history stays scannable. Once collapsed, the user can
still expand to review what they answered.

Cards autofocus their listbox on mount, but never steal focus from a text
input the user is typing in (the [useEffect typing-target guard](../src/renderer/components/PlanCard.tsx) skips
when `document.activeElement` is an `INPUT`/`TEXTAREA`/contenteditable).

The footer surfaces the contract visually as decorative `aria-hidden` key
hints, so sighted keyboard users don't have to discover it.

## Other knobs

- **`exitPlanCard.onAccept`** writes `agentMode = "auto"` back to local
  storage and sends `"Proceed with the plan above."`, leaving plan mode for
  the next turn.
- **`exitPlanCard.onReject`** focuses the composer for free-form feedback.
- Cards re-use Plan-card CSS via the `.plan-card` class.
  Question-specific tweaks (denser type, lighter dividers, integrated submit
  pill) live under `.question-card` in
  [overlays-launcher-cards.css](../src/renderer/styles/overlays-launcher-cards.css).

## Tests

All of the above is locked in by
[src/renderer/components/SessionConversation.cards.test.tsx](../src/renderer/components/SessionConversation.cards.test.tsx) and
[src/renderer/components/SessionConversation.streaming.test.tsx](../src/renderer/components/SessionConversation.streaming.test.tsx).
Search for the relevant `it(...)` titles:

- "renders an ExitPlanMode tool call as a PlanCard, hiding the raw tool row"
- "renders a PlanCard from ExitPlanMode even when the tool ended in error (denied in structured-json mode)"
- "renders a failed AskUserQuestion tool call as a QuestionCard and submits the chosen answer"
- "still renders the QuestionCard when AskUserQuestion retries fold into a tool-group"
- "hides the ExitPlanMode tool row immediately, even while still running (no flicker)"
- "renders an AskUserQuestion card immediately from command.started and hides the raw row"
- "delays Thinking after a completed assistant chunk while the session is still running"
- "does not flash Thinking when the session completes during the post-answer grace period"
- "suppresses the Thinking indicator while AskUserQuestion is outstanding (the card is the ask)"
- "restores Thinking once the user submits and a new user.message arrives"
- "hides assistant text emitted AFTER an ExitPlanMode card so the plan isn't duplicated as a chat bubble"
- "hides hallucinated assistant prose emitted AFTER an AskUserQuestion card"
- "terminates the in-flight probe before sending the QuestionCard answer (no queue wait)"

## When to revisit

If Claude Code ever supports `AskUserQuestion` / `ExitPlanMode` *non-interactively*
in `-p` mode (i.e. returns success instead of erroring), all the
"render-card-on-error" logic still works but the outstanding-card gate would
need refinement: the tool's `command.completed` would arrive with success
content rather than the user's eventual answer. Today the gate releases only
when a new `user.message` lands, which is correct for the current behavior.

## Adjacent chat surface notes

Not card-specific, but living next to cards in the same conversation surface
(file these here so they aren't lost):

- **Per-turn timestamps, not per-bubble.** `TurnBlock` renders a single
  `headerTimestampIso` in its header. Same-day timestamps use `HH:mm`;
  older ones use short date + time. `ChatBubble` no longer renders a
  `chat-bubble-timestamp` because the turn header owns timing.
- **Thinking to answered reveal.** `TurnBlock` sets `data-just-revealed` on
  `.turn-block-body` for 280 ms the first time the turn gains any visible
  child, so the first element animates in instead of popping.
- **FileChip basename + hover-intent preview.** `FileChip` shows
  `basename` (+ optional `:line`). Full path lives in `aria-label`, the
  tooltip, and the hover-intent popover. After 500 ms of hover (or
  immediately on focus) a `FilePreviewPopover` mounts and fetches a
  `useFilePreview` snippet via `window.argmax.workspace.readFile`
  (`workspace:read-file`); module-level cache
  keyed by `workspaceId|path|line`. The popover stays out of IPC traffic
  during passive scroll-by because the timer never fires.
- **Submit terminate helper.** `sendAfterTerminate(sessionId, isRunning,
  onTerminateSession, send, onError)` in
  [sessionConversationHelpers.ts](../src/renderer/components/sessionConversationHelpers.ts)
  factors out the "terminate-then-send" dance that
  [SessionConversation.tsx](../src/renderer/components/SessionConversation.tsx)
  uses for PlanCard / QuestionCard submits and other card-style flows.
