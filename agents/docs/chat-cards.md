# Chat — interactive cards

The chat surface renders two kinds of *interactive cards* on top of the normal
assistant bubble stream: **PlanCard** (Claude Code plan mode) and
**QuestionCard** (Claude Code `AskUserQuestion`). Everything here lives in
[src/renderer/components/SessionConversation.tsx](../../src/renderer/components/SessionConversation.tsx)
plus the two card components ([PlanCard.tsx](../../src/renderer/components/PlanCard.tsx),
[QuestionCard.tsx](../../src/renderer/components/QuestionCard.tsx)).

## Why cards exist

Claude Code's `ExitPlanMode` and `AskUserQuestion` tools are designed for
interactive sessions. Argmax launches Claude in **structured-json** mode
(`-p --output-format stream-json` — see
[providerAdapters.ts](../../src/main/providers/providerAdapters.ts)), which
has no interactive stdin. The CLI handles this by returning a
`tool_result { is_error: true, content: "Exit plan mode?" / "Answer questions?" }`
and ending the turn.

The plan / question content the model wanted to deliver still arrives — it's
in the tool's `input.plan` or `input.questions`. We extract that and render it
ourselves as a card. The user clicks an option; the answer becomes the next
user message; Claude's next turn picks it up via `--resume`.

## Detection rules (per turn)

Both detections run inside the `renderItems.map(...)` "turn" branch around
[SessionConversation.tsx:1157](../../src/renderer/components/SessionConversation.tsx:1157).

| Rule | Applies to | Why |
|---|---|---|
| **First valid wins** | `AskUserQuestion` | Haiku retries on validation/deny errors. Pinning the card key to the first valid tool keeps the user's in-progress selections alive across retries. |
| **All matching ids hidden** | both tools | Every `ExitPlanMode` / `AskUserQuestion` tool id (any status) goes into a filter set so the raw tool row never renders. |
| **Flatten tool-groups** | `AskUserQuestion` | Two retries inside the 75 ms parallel window fold into a `tool-group`. Detection looks inside groups; if the group is *only* `AskUserQuestion`s the group row is hidden too. |
| **Card renders on `error` too** | both tools | The tool reliably ends in `error` in `-p` mode. Card-render path skips only `status === "running"`, never `done`-vs-`error`. |
| **Post-card text suppressed** | both tools | Assistant text with `createdAt > tool.createdAt` is filtered out. For PlanCards the model re-emits the plan as a duplicate bubble; for QuestionCards it confabulates "Thanks based on your input" with fabricated answers BEFORE the user has touched the card. The card already conveys the ask in both cases. The cutoff is per-turn, so genuine follow-up scan results in the *next* turn (after the user submits) still come through. Pre-tool intro narration always stays. |

## Thinking indicator

The "Thinking" bubble is suppressed when any of these are true:

- `session.state !== "running"`
- the last significant event is `message.delta` (streaming caret is the indicator)
- a *visible* tool is running (`tool.name` is not `ExitPlanMode` / `AskUserQuestion`; the tool's own spinner is the indicator)
- **there is an outstanding card ask** — the most-recent `AskUserQuestion` / `ExitPlanMode` happened after the last `user.message` ([SessionConversation.tsx:686](../../src/renderer/components/SessionConversation.tsx:686))

The outstanding-card gate is the load-bearing one for cards: while a card is
on screen waiting for the user, the agent is *waiting on the user*, not
"thinking". Showing Thinking would mislead. When the user submits, a new
`user.message` lands → `lastUserMessageTime` advances past the tool's
`createdAt` → Thinking resumes for the new turn.

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
(see [providerSessionService.ts](../../src/main/providers/providerSessionService.ts)),
so the terminated session resumes cleanly via `--resume <conversationId>` with
the answer as the next user message.

## QuestionCard answer format

The card formats the user's picks as `**<header>**: <chosen label>` per
question, joined with blank lines. Multi-select joins selections with commas.
The model has the full question text from the original tool call, so the
short header is enough context.

## Keyboard contract (PlanCard + QuestionCard, and any future ask-user card)

One contract; deviations are bugs. Locked by component tests in
[PlanCard.test.tsx](../../src/renderer/components/PlanCard.test.tsx) and
[QuestionCard.test.tsx](../../src/renderer/components/QuestionCard.test.tsx).

| Key            | Effect                                                                    |
| -------------- | ------------------------------------------------------------------------- |
| `↑` / `↓`      | Move selection between options                                            |
| `1`–`9`        | Pick the nth option (also moves selection)                                |
| `Space`        | Toggle the focused option — multi-select questions only                   |
| `Enter`        | Submit. Triggers `onAccept`/`onReject` (PlanCard) or `onAnswer` (QuestionCard) |
| `Escape`       | **No-op.** Cards are not dismissable; the answer is the dismiss.          |

On submit the card collapses to a one-line summary header with an Expand
chevron so the chat history stays scannable. Once collapsed, the user can
still expand to review what they answered.

Cards autofocus their listbox on mount, but never steal focus from a text
input the user is typing in (the [useEffect typing-target guard](../../src/renderer/components/PlanCard.tsx) skips
when `document.activeElement` is an `INPUT`/`TEXTAREA`/contenteditable).

The footer surfaces the contract visually as decorative `aria-hidden` key
hints, so sighted keyboard users don't have to discover it.

## Other knobs

- **`exitPlanCard.onAccept`** writes `agentMode = "auto"` back to local
  storage and sends `"Proceed with the plan above."` — leaving plan mode for
  the next turn.
- **`exitPlanCard.onReject`** focuses the composer for free-form feedback.
- Cards re-use Plan-card CSS via the `.plan-card` class.
  Question-specific tweaks (denser type, lighter dividers, integrated submit
  pill) live under `.question-card` in [styles.css](../../src/renderer/styles.css).

## Tests

All of the above are locked in by
[src/renderer/components/SessionConversation.test.tsx](../../src/renderer/components/SessionConversation.test.tsx) — search the file for the
relevant `it(...)` titles:

- "renders an ExitPlanMode tool call as a PlanCard, hiding the raw tool row"
- "renders a PlanCard from ExitPlanMode even when the tool ended in error (denied in structured-json mode)"
- "renders a failed AskUserQuestion tool call as a QuestionCard and submits the chosen answer"
- "still renders the QuestionCard when AskUserQuestion retries fold into a tool-group"
- "hides the ExitPlanMode tool row immediately, even while still running (no flicker)"
- "renders an AskUserQuestion card immediately from command.started and hides the raw row"
- "suppresses the Thinking indicator while AskUserQuestion is outstanding (the card is the ask)"
- "restores Thinking once the user submits and a new user.message arrives"
- "hides assistant text emitted AFTER an ExitPlanMode card so the plan isn't duplicated as a chat bubble"
- "hides hallucinated assistant prose emitted AFTER an AskUserQuestion card"
- "terminates the in-flight probe before sending the QuestionCard answer (no queue wait)"

## When to revisit

If Claude Code ever supports `AskUserQuestion` / `ExitPlanMode` *non-interactively*
in `-p` mode (i.e. returns success instead of erroring), all the
"render-card-on-error" logic still works but the outstanding-card gate would
need refinement — the tool's `command.completed` would arrive with success
content rather than the user's eventual answer. Today the gate releases only
when a new `user.message` lands, which is correct for the current behavior.

## Adjacent chat surface notes

Not card-specific, but living next to cards in the same conversation surface
(file these here so they aren't lost):

- **Per-turn timestamps, not per-bubble.** `TurnBlock` renders a single
  `headerTimestampIso` in its header (same-day → `HH:mm`, otherwise short
  date + time). `ChatBubble` no longer renders a `chat-bubble-timestamp` —
  the per-bubble timestamp was removed when the turn header took over.
- **Mascot happy-flash.** The composer mascot pops to its "happy" expression
  for 1.5 s after each `message.completed`. `SessionConversation` tracks
  `lastCompletedIdRef` so re-renders don't re-fire the flash; the first
  observation per session is skipped (stale completions on open).
- **Thinking → answered reveal.** `TurnBlock` sets `data-just-revealed` on
  `.turn-block-body` for 280 ms the first time the turn gains any visible
  child, so the first element animates in instead of popping.
- **FileChip basename + hover-intent preview.** `FileChip` shows
  `basename` (+ optional `:line`) — full path lives in `aria-label`, the
  tooltip, and the hover-intent popover. After 500 ms of hover (or
  immediately on focus) a `FilePreviewPopover` mounts and fetches a
  `useFilePreview` snippet via `workspace:readFile`; module-level cache
  keyed by `workspaceId|path|line`. The popover stays out of IPC traffic
  during passive scroll-by because the timer never fires.
- **Submit terminate helper.** `sendAfterTerminate(sessionId, isRunning,
  onTerminateSession, send, onError)` in `SessionConversation` factors out
  the "terminate-then-send" dance used by PlanCard / QuestionCard submits
  and other card-style flows.
