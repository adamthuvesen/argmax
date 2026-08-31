# Chat Surface and Interactive Cards

The chat surface renders assistant bubbles, tools, and interactive cards: **PlanCard** (Claude Code plan mode) and **QuestionCard** (Claude Code `AskUserQuestion`, Cursor `askQuestionToolCall`).

## Components and Structure

- **Conversation Shell:** [SessionConversation.tsx](../src/renderer/components/SessionConversation.tsx) derives timeline projections, thinking states, turn models, and scroll anchoring.
- **Turns & Cards:** [SessionConversationTurn.tsx](../src/renderer/components/SessionConversationTurn.tsx) renders individual turns, card containers, and card submission handlers via [PlanCard.tsx](../src/renderer/components/PlanCard.tsx) and [QuestionCard.tsx](../src/renderer/components/QuestionCard.tsx).
- **Timeline Logic:** [sessionConversationModel.ts](../src/renderer/lib/sessionConversationModel.ts) handles event filtering, raw transcript suppression checks, tool pairing, and last-significant-event selection.
- **Composer:** [SessionComposer.tsx](../src/renderer/components/SessionComposer.tsx) handles prompt inputs, file attachments, model/mode chips, follow-up queues, and send/stop actions. The launcher composer in [LaunchSurface.tsx](../src/renderer/components/LaunchSurface.tsx) cycles Auto / Plan / Chat with Tab. Chat launches a scratch workspace with no repository attached, so the project picker hides and no longer offers a Chat row.
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

## Activity Rows

Tool activity renders as text, not chrome. One grammar covers every row and every group headline:

**`<verb> <target> <+adds −dels> <chevron>`**, clustered against the same left edge as the assistant prose.

| Part | Component | Styling |
|---|---|---|
| Verb (`Edited`, `Explored`) | `splitLeadingVerb` in [toolCalls.ts](../src/renderer/lib/toolCalls.ts) | `--muted-strong`, UI font |
| Target (file name, headline remainder) | `.tool-call-row-target`, `.tool-call-group-eyebrow-detail` | `--muted`, UI font; `--font-code` only for `data-tool-type="bash"` |
| Line stat | [ActivityStat.tsx](../src/renderer/components/ActivityStat.tsx) | `--diff-add-gutter-fg` / `--diff-del-gutter-fg`, tabular |
| Chevron | `.tool-call-row-chevron` | Hidden on rows until hover; faint at rest on group headlines, which are sometimes a turn's only control |

Rules this surface holds to:

- **No icons.** The verb already names the action, and a glyph column competes with the one left edge. Errors tint the verb rose rather than an icon, so a failing row does not shift its left edge.
- **Invocation-scoped identity.** Provider tool IDs can repeat across turns. `buildSessionToolCalls` scopes them with `providerInvocationId` and uses chronological unmatched pairs for historical rows that predate that field, so a tool stays in the turn that ran it.
- **Verb/target contrast is a token step, not an opacity fade.** Fading `--muted` drops the file name to 2.4:1 in the light theme; `--muted-strong` over `--muted` measures 6.9:1 / 3.6:1 (light) and 8.0:1 / 5.1:1 (dark). Pinned by `accentTokens.test.ts`.
- **Transport is never a row.** Codex's `wait`, `close_agent`, and `send_message_to_thread` name no work and carry only internal thread ids, so `foldCodexAgentControlTools` drops them unconditionally. Matching one to a spawn decides only whether its outcome settles that launch. When a name collides with a real tool, the Codex thread ids in the input are what identify the transport.
- **A summary of one is not a summary.** A run of a single tool renders as that tool's own row, never a headline wrapping it: "Fetched 1 URL" over "Fetched URL" is one sentence twice, and the row names the actual target. Single-line verbosity still shows exactly one line per gap between replies.
- **An external tool is named by the service it called.** `extractToolName` first resolves provider wrappers: Cursor ACP's `mcpToolCall`, Codex's `mcp_tool_call`, and Cursor's `other` + `_toolName` never reach the UI as labels. `parseMcpToolName` then reads the provider wire shapes (`mcp__<server>__<tool>`, OpenCode's repeated `notion_notion-fetch`, and Codex Apps' `linear.list_issues`) and labels them `Notion fetch` or `Linear list issues`. Cursor plugin identifiers collapse to the connected product (`plugin-google-drive-google-drive` → `Google drive`). Wrapper metadata is stripped from expandable Input, leaving only the arguments the agent supplied.
- **Protocol and bookkeeping do not count as work.** MCP discovery (`ToolSearch`, `getMcpToolsToolCall`) disappears when the real external call is the useful event. Internal task-list writes (`TodoWrite`, `TaskCreate`, `TaskUpdate`) disappear too: they change no project file, create no agent, and otherwise produce misleading rows such as "Edited file." Unknown direct provider names degrade to spaced text (`engram_remember` → `Engram remember`) rather than leaking snake_case or camelCase.
- **The stat travels with the target**, not right-aligned into a second column: a transcript is read a row at a time, not compared down a column.
- **Group stats are the true sum of their rows.** `summarizeToolChangeCounts` reads the same per-tool input the expanded rows read, so a headline can never disagree with what it collapses.
- **Exactly one border in the surface:** the hairline around an expanded diff. Rows have no rail, no card, and no hover fill.
- **A JSON result shows its payload, not its envelope.** `formatToolOutput` lifts the string out of a display envelope when exactly one of `text` / `content` / `result` / `output` holds it and every other key is known envelope metadata (`metadata`, `title`, `type`, `url`). That makes escaped newlines real and promotes `title` into the `Output` label's existing meta slot without discarding pagination, status, or other data fields. Data-shaped JSON is pretty-printed intact, non-JSON is untouched, and bash output keeps byte fidelity. Re-serializing an envelope is not an option: `JSON.stringify` escapes the newlines again.
- **Bash expands to Output, not to a triple of itself.** The row already names the short command. Expanding a short call shows only stdout. A heredoc or anything past the 72-char cut opens one full Command block with real newlines. Claude's `description` / `timeout` and Codex's `timeout_ms` are never a reason to dump the input JSON — and when leftover Input does show, it dumps only the leftover keys, never the command again as an escaped string.

### Expanded Diffs

An edit row expands into [FileChangeCard.tsx](../src/renderer/components/FileChangeCard.tsx), flush with the row's left edge. Inside a chat card the shared [DiffBlocks.tsx](../src/renderer/components/DiffBlocks.tsx) loses its table chrome: no `@@` hunk header, no gutter band or divider, and the add/delete wash runs unbroken from the line number into the code. A reserved gutter column carries `+` / `−` so numbers stay in one column whether or not the line changed.

When a row expands to a **single** file, the card header collapses to just its `Open` button, floated in the corner and revealed on hover — the row above already names the file and its stat. A row that expands into **several** cards keeps the full per-file header, since there the card is the only place each path appears. A pure-create card reads as an all-addition diff — same green wash and `+` markers as the added lines of an edit — so a new file and an edited one look like the same kind of object in the transcript.

## Thinking Indicators and Thought Blocks

### Pre-Answer Thinking Indicator
The animated thinking indicator displays during inactive periods while a session is running:
- **Suppressed when:** `session.state !== "running"`, answer text is streaming (a `message.delta` *without* `thinking: true`), a visible tool is executing, a subagent is running (`parent_tool_use_id`), or an interactive card is awaiting user input.
- **One cue per beat:** reasoning arrives as a `message.delta` too, so `liveThoughtOwnsProgress` in [sessionTurnView.ts](../src/renderer/lib/sessionTurnView.ts) decides which element carries progress and both consumers read it. Before the turn has answer text the Thought block owns the beat (expanded, labelled "Thinking") and this indicator stays down; once an answer lands the block goes quiet and the indicator takes over for the rest of the turn's reasoning. Counting reasoning as streaming answer text used to leave a running turn with no cue at all for as long as the model kept reasoning.
- **Timers:** Initial turn start shows immediately; mid-turn silent gaps wait 700 ms. Stays visible for at least 600 ms once shown.
- **A finished message owns its beat for 1800 ms.** The text is the progress cue for that window, so a `message.completed` takes the indicator *down* whether or not it was already up, and it only claims the next silent gap once the window is spent. Suppressing at the source is what makes this provider-shaped: Codex and OpenCode deliver an answer as one atomic `message.completed` with no answer deltas, so nothing later arrived to hide a label already up from the reasoning gap before it, and it sat under the finished answer until `session.state` flipped — roughly a second later, since that flip waits for the provider process to exit. Delaying only the first show fixed the flicker for Claude and Cursor, which stream deltas up to their completion, and left the other two showing a tail.
- **Turn starts on send:** `SessionConversation` marks turn start on `onSendSessionInput` rather than waiting for backend state flips, preventing empty chat delays during provider spawn.

### Extended-Thinking (Thought Blocks)
Model reasoning traces (`payload.thinking === true` from Claude thinking deltas, Codex reasoning, or Cursor stream events) are routed to [ThoughtBlock.tsx](../src/renderer/components/ThoughtBlock.tsx):
- **Live streaming:** Thought blocks expand while active and collapse when answer text begins streaming.
- **Hold open on scroll:** `holdOpen` keeps a block expanded while it is the newest turn to avoid scroll-jumping the viewport mid-stream.
- **Persistence:** [snapshot.ts](../src/renderer/lib/snapshot.ts) and [sessionConversationModel.ts](../src/renderer/lib/sessionConversationModel.ts) preserve thinking deltas during event pruning.

## Context Compaction & Provider Handoff

- **Context compaction:** Provider compaction events (`session.compacting` / `session.compacted`) are collapsed into a single `compaction` render item by [foldConversation.ts](../src/renderer/lib/foldConversation.ts) and rendered by [CompactionNotice.tsx](../src/renderer/components/CompactionNotice.tsx) (`Compacted context · 471k → 10.7k`). Synthetic summary prompts injected by the provider are dropped.
- **Provider handoff:** Changing providers on an idle session creates a `session.provider-changed` marker rendered by [ProviderSwitchNotice.tsx](../src/renderer/components/ProviderSwitchNotice.tsx) (`Cursor → Codex · GPT-5.6 Sol`). Follow-ups restart fresh with the capped transcript.
- **Project handoff:** Moving a session creates a `session.moved` marker rendered by [ProjectMoveNotice.tsx](../src/renderer/components/ProjectMoveNotice.tsx) (`HQ → Argmax · shared checkout`). The destination starts a fresh provider conversation with the capped transcript and checkout path.

## Subagent Activity Panes

Subagent tool calls (Claude `Task`/`Agent`, Codex `spawn_agent`, OpenCode `task`, Cursor `taskToolCall`/ACP `task`) display a launch row in the parent conversation via [AgentLaunchList.tsx](../src/renderer/components/AgentLaunchList.tsx), rendered as a bulleted task list:

```
·  Map chat tool-row rendering  Europa  ›
   Completed
```

- **Line one** is the agent's own `description` (bright) followed by its codename (dim), which is also the label on its tab and activity pane. `agentLaunchLabel` falls back to `Launched <codename>` when the provider gave no description. The `prompt` is never promoted into the title — truncating a multi-paragraph instruction turned every spawn into a path wall.
- **Line two** is the state in words (`Completed` / `Running` / `Failed`), indented to the task rather than the bullet. This replaced the old circle-check and circle-cross glyphs: a finished agent says so, rather than encoding it in a mark.
- **The mark** is the shared working nest (four dots, [WorkingNest.tsx](../src/renderer/components/WorkingNest.tsx)) while the agent runs, and a plain bullet once it settles — rose for a failure. Both marks occupy the same box so the text edge does not shift when an agent lands.
- **Missing Codex launches recover from lineage.** If structured stdout omits `spawn_agent`, the child trace can supply its parent conversation ID. Argmax inserts one deterministic launch row and imports the child activity beneath it. A later real launch reparents the child rows and sends cursor-visible tombstones for the synthetic pair, so an open chat removes the placeholder without showing a duplicate.
- **Spacing** is deliberately looser than the tool rows (`gap: 14px`): delegated work is the coarsest thing in a turn.

Clicking the text opens the activity pane; the trailing chevron expands the raw tool detail inline. The button hugs its text so that chevron sits beside the task instead of against the far edge.

- **Grid isolation:** Clicking the row opens [AgentActivityPane.tsx](../src/renderer/components/AgentActivityPane.tsx) as a dependent grid cell keyed by `parentSessionId` and `parentToolUseId`. Closing the parent session closes its agent panes.
- **Trace imports:** `session:agent-events` fetches and parses trace files on demand. Parsed rows are saved with deterministic IDs (`trace:<provider>:<sessionId>:<parentToolUseId>:<childId>:<seq>:<kind>`) and hidden from the main chat view.

## Chat Verbosity & Single-Line Activity Mode

Configured in Settings → Agents ("Chat detail & verbosity"): a **1–5 scale** (**Minimal / Compact / Balanced / Detailed / Full trace**). In level 1 (Minimal) single-line mode, consecutive tool calls collapse into a single self-updating `ActivitySummaryLine` ("Explored 2 files, edited 1 file") and completed Thought blocks fold away. Higher levels progressively expand tool-call group headers, recent tool inspection rows, and thought history.

## Smooth Answer Reveal & Live Auto-Scroll

- **Paced reveal:** [StreamingMarkdown.tsx](../src/renderer/components/StreamingMarkdown.tsx) paces large visible streaming chunks to avoid abrupt layout jumps. Progress is cached in a module-level map keyed by `revealKey` (session/agent ID + group creation time + group ID) so switching sessions does not restart reveals from scratch.
- **Auto-follow scroll:** [useSmartFollowScroll.ts](../src/renderer/hooks/useSmartFollowScroll.ts) locks viewport to the physical bottom during output. A leftover-viewport spacer after the latest user message sits that message at the top of the pane while the new turn is shorter than the view, so a follow-up is not tucked under a long previous reply. Upward user gestures detach auto-follow and show the scroll-to-bottom button.
- **Tail reserve & resize:** `.conversation-list` maintains constant bottom padding (`--space-8`). A `ResizeObserver` monitors the viewport and composer textarea to adjust scroll offsets dynamically as drafts expand.
- **Workspace card:** [WorkspaceCard.tsx](../src/renderer/components/WorkspaceCard.tsx) floats worktree status and a glanceable subagent roster avatar stack in the right gutter when pane width allows. Docking the review or log panel automatically hides the card.

## Follow-up Queuing & Drafts

- **Mid-turn messages:** Submitting a prompt while an agent is running places the message into a pending queue. Users can delete queued messages or click **Send now** to interrupt the active turn (`providers:send-queued-message-now`).
- **Drafts:** Unsent drafts and screenshots persist in `localStorage` under `argmax.composer.drafts` via [composerDrafts.ts](../src/renderer/lib/composerDrafts.ts), keyed by session ID or `launch-<projectId>`. Changing projects in the launcher transfers text via `carryTextOnRetarget`.
- **Selection annotations:** Highlighted text in the transcript opens [SelectionToolbar.tsx](../src/renderer/components/SelectionToolbar.tsx). "Add to chat" inserts the excerpt as a blockquote annotation in the prompt. Line comments from the review panel and open review tabs append context in the same format. An attached annotation is sendable on its own: with a chip in the lane, send is enabled and Enter works on an empty draft.
- **Side chat & popup:** "Ask in side chat" opens a scratch-workspace session with the selected excerpt. "More details" opens [DetailsPopup.tsx](../src/renderer/components/DetailsPopup.tsx) against an ephemeral popup-kind session.
