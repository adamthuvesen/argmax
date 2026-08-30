# Chat Surface and Interactive Cards

The chat surface renders assistant bubbles, tools, and interactive cards: **PlanCard** (Claude Code plan mode) and **QuestionCard** (Claude Code `AskUserQuestion`, Cursor `askQuestionToolCall`).

## Components and Structure

- **Conversation Shell:** [SessionConversation.tsx](../src/renderer/components/SessionConversation.tsx) derives timeline projections, thinking states, turn models, and scroll anchoring.
- **Turns & Cards:** [SessionConversationTurn.tsx](../src/renderer/components/SessionConversationTurn.tsx) renders individual turns, card containers, and card submission handlers via [PlanCard.tsx](../src/renderer/components/PlanCard.tsx) and [QuestionCard.tsx](../src/renderer/components/QuestionCard.tsx).
- **Timeline Logic:** [sessionConversationModel.ts](../src/renderer/lib/sessionConversationModel.ts) handles event filtering, raw transcript suppression checks, tool pairing, and last-significant-event selection.
- **Composer:** [SessionComposer.tsx](../src/renderer/components/SessionComposer.tsx) handles prompt inputs, file attachments, model/mode chips, follow-up queues, and send/stop actions.
- **Actions Menu:** [SessionActionsMenu.tsx](../src/renderer/components/SessionActionsMenu.tsx) handles workspace actions, PR refreshes, git shortcuts, and panel toggles.

## Card Architecture

In headless structured mode (`-p --output-format stream-json`), tools like `ExitPlanMode` and `AskUserQuestion` return tool results with status errors to signal pause for input. Argmax extracts the structured payload (`input.plan` or `input.questions`) and displays it as an interactive card instead of a failed tool call.

`SendUserMessage` carries plain user-facing text, so it is normalized directly into `message.completed` rather than a card.

### Card Detection Rules

Defined in [turnInteractiveCards.ts](../src/renderer/lib/turnInteractiveCards.ts) and [sessionTurnView.ts](../src/renderer/lib/sessionTurnView.ts):

| Rule | Target | Behavior |
|---|---|---|
| **First valid wins** | `AskUserQuestion` | Pins card key to the first valid tool call to preserve user selections across retry loops. |
| **Tool row hidden** | `ExitPlanMode`, ask-question tools | Hides matching raw tool IDs from the rendered conversation. |
| **Flatten tool-groups** | ask-question tools | If all items in a tool-group are ask-question tools, the entire group row is hidden. |
| **Error rendering** | Both cards | Cards render even when tool status is `error` (standard behavior in non-interactive CLI modes). |
| **Post-card text suppression** | Both cards | Assistant text with `createdAt > tool.createdAt` in the same turn is filtered out to avoid duplicate plans or speculative responses before user submission. |

### Keyboard Navigation

Component tests in [PlanCard.test.tsx](../src/renderer/components/PlanCard.test.tsx) and [QuestionCard.test.tsx](../src/renderer/components/QuestionCard.test.tsx).

| Key | Action |
|---|---|
| `↑` / `↓` | Move selection between options |
| `1`-`9` | Select option by number |
| `Space` | Toggle checkbox (multi-select questions) |
| `Enter` | Submit response |
| `Escape` | No-op (cards require explicit selection or response) |

After submission, cards collapse to a single-line summary with an expand chevron.

### Submission Flow

When submitting a PlanCard or QuestionCard, `sendAfterTerminate` in [sessionConversationHelpers.ts](../src/renderer/components/sessionConversationHelpers.ts) terminates the running probe before sending the answer to prevent queuing behind trailing provider output.

Question responses format as `**<header>**: <chosen label>` per question, joined with newlines.

## Thinking Indicators and Thought Blocks

### Pre-Answer Thinking Indicator
The animated thinking indicator displays during inactive periods while a session is running:
- **Suppressed when:** `session.state !== "running"`, text is streaming (`message.delta`), a visible tool is executing, a subagent is running (`parent_tool_use_id`), or an interactive card is awaiting user input.
- **Timers:** Initial turn start shows immediately; mid-turn silent gaps wait 700 ms; gaps after completed text wait 1800 ms to avoid flicker before final state transitions. Stays visible for at least 600 ms once shown.
- **Turn starts on send:** `SessionConversation` marks turn start on `onSendSessionInput` rather than waiting for backend state flips, preventing empty chat delays during provider spawn.

### Extended-Thinking (Thought Blocks)
Model reasoning traces (`payload.thinking === true` from Claude thinking deltas, Codex reasoning, or Cursor stream events) are routed to [ThoughtBlock.tsx](../src/renderer/components/ThoughtBlock.tsx):
- **Live streaming:** Thought blocks expand while active and collapse when answer text begins streaming.
- **Hold open on scroll:** `holdOpen` keeps a block expanded while it is the newest turn to avoid scroll-jumping the viewport mid-stream.
- **Persistence:** [snapshot.ts](../src/renderer/lib/snapshot.ts) and [sessionConversationModel.ts](../src/renderer/lib/sessionConversationModel.ts) preserve thinking deltas during event pruning.

## Context Compaction & Provider Handoff

- **Context compaction:** Provider compaction events (`session.compacting` / `session.compacted`) are collapsed into a single `compaction` render item by [foldConversation.ts](../src/renderer/lib/foldConversation.ts) and rendered by [CompactionNotice.tsx](../src/renderer/components/CompactionNotice.tsx) (`Compacted context · 471k → 10.7k`). Synthetic summary prompts injected by the provider are dropped.
- **Provider handoff:** Changing providers on an idle session creates a `session.provider-changed` marker rendered by [ProviderSwitchNotice.tsx](../src/renderer/components/ProviderSwitchNotice.tsx) (`Cursor → Codex · GPT-5.6 Sol`). Follow-ups restart fresh with the capped transcript.

## Subagent Activity Panes

Subagent tool calls (Claude `Task`/`Agent`, Codex `spawn_agent`, OpenCode `task`, Cursor `taskToolCall`/ACP `task`) display a summary launch row in the parent conversation (`Launched <codename>`).

- **Grid isolation:** Clicking the row opens [AgentActivityPane.tsx](../src/renderer/components/AgentActivityPane.tsx) as a dependent grid cell keyed by `parentSessionId` and `parentToolUseId`. Closing the parent session closes its agent panes.
- **Trace imports:** `session:agent-events` fetches and parses trace files on demand. Parsed rows are saved with deterministic IDs (`trace:<provider>:<sessionId>:<parentToolUseId>:<childId>:<seq>:<kind>`) and hidden from the main chat view.

## Single-Line Activity Mode

Configured in Settings → Agents ("Tool calls in chat"): **Show expanded / Show collapsed / Single line**. In single-line mode, consecutive tool calls collapse into a single self-updating `ActivitySummaryLine` ("Explored 2 files, edited 1 file") and completed Thought blocks fold away.

## Smooth Answer Reveal & Live Auto-Scroll

- **Paced reveal:** [StreamingMarkdown.tsx](../src/renderer/components/StreamingMarkdown.tsx) paces large visible streaming chunks to avoid abrupt layout jumps. Progress is cached in a module-level map keyed by `revealKey` (session/agent ID + group creation time + group ID) so switching sessions does not restart reveals from scratch.
- **Auto-follow scroll:** [useSmartFollowScroll.ts](../src/renderer/hooks/useSmartFollowScroll.ts) locks viewport to the physical bottom during output. Upward user gestures detach auto-follow and show the scroll-to-bottom button.
- **Tail reserve & resize:** `.conversation-list` maintains constant bottom padding (`--space-8`). A `ResizeObserver` monitors the viewport and composer textarea to adjust scroll offsets dynamically as drafts expand.
- **Workspace card:** [WorkspaceCard.tsx](../src/renderer/components/WorkspaceCard.tsx) floats worktree status and a glanceable subagent roster avatar stack in the right gutter when pane width allows. Docking the review or log panel automatically hides the card.

## Follow-up Queuing & Drafts

- **Mid-turn messages:** Submitting a prompt while an agent is running places the message into a pending queue. Users can delete queued messages or click **Send now** to interrupt the active turn (`providers:send-queued-message-now`).
- **Drafts:** Unsent drafts and screenshots persist in `localStorage` under `argmax.composer.drafts` via [composerDrafts.ts](../src/renderer/lib/composerDrafts.ts), keyed by session ID or `launch-<projectId>`. Changing projects in the launcher transfers text via `carryTextOnRetarget`.
- **Selection annotations:** Highlighted text in the transcript opens [SelectionToolbar.tsx](../src/renderer/components/SelectionToolbar.tsx). "Add to chat" inserts the excerpt as a blockquote annotation in the prompt. Line comments from the review panel and open review tabs append context in the same format.
- **Side chat & popup:** "Ask in side chat" opens a scratch-workspace session with the selected excerpt. "More details" opens [DetailsPopup.tsx](../src/renderer/components/DetailsPopup.tsx) against an ephemeral popup-kind session.
