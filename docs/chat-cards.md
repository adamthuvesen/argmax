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
scroll behavior, and pane chrome. Card rendering and submission handlers live in
[SessionConversationTurn.tsx](../src/renderer/components/SessionConversationTurn.tsx).
Pure timeline plumbing lives in
[sessionConversationModel.ts](../src/renderer/lib/sessionConversationModel.ts):
conversation-event filtering, raw transcript suppression checks, tool-call
pairing, and last-significant-event selection. The prompt box, attachment flow,
model/mode chips, queued follow-ups, stop/send controls, and focus behavior live in
[SessionComposer.tsx](../src/renderer/components/SessionComposer.tsx).
Header actions, PR refresh state, git actions, workspace-card and debug-log
toggling are handled in
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
[sessionTurnView.ts](../src/renderer/lib/sessionTurnView.ts). Each turn renders
through [SessionConversationTurn.tsx](../src/renderer/components/SessionConversationTurn.tsx),
which consumes `buildTurnRenderState` and owns card rendering and submission.

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
- **subagent rows do not count as parent progress**: tool boundaries and prose
  that carry a `parent_tool_use_id` fold under the launch row and never render
  in the parent chat, so neither the visible-tool check nor
  `lastSignificantSessionEvent` sees them (`subAgentToolUseIds` supplies the
  linkage for child completions that omit the marker). While the parent only
  waits on a launched subagent, Thinking stays steady instead of blinking on
  every child heartbeat
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

**A send starts the turn, not the state flip.** Every rule above reads
`session.state`, which the backend flips before it spawns or resumes the
provider. The renderer can still see the new user bubble first, and it can miss
or lag the delta that carries the flip, so a follow-up used to leave the chat
blank for the whole provider start-up. `SessionConversation` wraps
`onSendSessionInput` and remembers the newest agent-response event id at send
time (`lastAgentResponseEvent`, which ignores `user.message`). While that
marker still matches, the pane counts as starting a turn: Thinking shows on the
first beat with no delay, the previous turn's trailing delta is treated as
history rather than live streaming, and a pending mid-turn show delay is
dropped so the new turn is not gated behind the old gap's timer. The marker
releases as soon as the provider emits anything of its own, and also if the
send throws or the session ends up `failed` or `cancelled`. Card submits route
through the same wrapper, so the outstanding-card gate still owns their beat
until the answer's `user.message` lands.

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

Reveal progress is remembered per block, keyed by the `revealKey` its caller
passes (session/agent id + the group's `createdAt` + group id. Group ids alone
only count within one turn). Switching sessions remounts the pane, so without
that memory a live block would type itself out again from nothing every time
the user came back to it. The map lives at module scope in `StreamingMarkdown`,
capped at the 200 most recently revealed blocks. A block with no `revealKey`
still reveals, it just cannot resume.

## Live auto-scroll

The conversation list uses [useSmartFollowScroll.ts](../src/renderer/hooks/useSmartFollowScroll.ts)
to follow live output. `.conversation-list` keeps a constant bottom padding
(`--space-8`) in every state, idle and live alike. That gap is deliberately
*not* toggled per turn: a reserve that only appeared while streaming would be
reclaimed the instant the turn ended, jerking the view up as the last line
settled. The steady gap keeps the latest rendered text clear of the bottom edge
and above the composer without that wobble.

Auto-follow is an explicit two-state model. While attached, every item change
and observed resize sets the exact physical bottom before the browser paints.
The reader detaches as soon as a recorded wheel, touch, pointer, or keyboard
gesture produces measurable upward movement, even inside the near-bottom
tolerance. A
downward wheel at the physical bottom produces no `scroll` event, so input by
itself never disables following. Layout correction and browser scroll anchoring
also cannot strand the viewport because movement without a user gesture is
re-pinned.

Once detached, new output does not move the reader. The scroll-to-latest FAB
appears beyond its visibility threshold and returns the list to attached mode.
Direct children are observed with `ResizeObserver` because smooth text reveal
grows an existing assistant turn without changing the `conversationItems`
array.

**Nothing at the tail may leave the layout.** Following the bottom cannot undo
a shrink: when a row below the fold disappears, the bottom moves up with it and
the pinned view goes with it, so the correction has to be to not shrink. Two
rows used to. The Thought block folding when the answer starts is handled by
`holdOpen` (see below), and the pulsing Thinking line, which leaves at that
same instant, now lives in `.conversation-tail`, a slot that holds the line's
height whether the line is in it or not.

A second `ResizeObserver` watches the scroll viewport **and the composer's
textarea**. Everything below the list shares its column: the composer, the
meta-cards row, and the approvals banner. A draft wrapping onto another line
shortens the viewport without touching `scrollHeight` or any smart-follow dep.
`scrollTop` stays put, which drops the reader below the fold: the transcript
jumps while you type into a running session, or the newest line slides under the
composer after the turn ends. The textarea is observed as well as the viewport
because the textarea is the box that actually grows. Its notification lands
whether or not the list's own does.

The observer preserves the same state across viewport changes. Attached readers
stay at the exact bottom when the viewport shrinks. Detached readers keep their
position unless layout clamps them to the exact physical bottom, which
re-attaches the list.

## Type to filter a picker

Composer pickers for projects, branches, and models filter as you type, with no search
box to aim at. [useTypeToFilter.ts](../src/renderer/hooks/useTypeToFilter.ts)
owns it: the list takes focus while open, so plain characters narrow it instead
of landing in the prompt behind it, arrow keys walk the matches, and Enter picks
the highlighted one. Matching runs through `searchFilePaths`, the same
typo-tolerant, left-boundary-strict matcher the command palette uses on paths.

Filtering silently would be the confusing version, so
[PickerFilterRow.tsx](../src/renderer/components/PickerFilterRow.tsx) echoes the
query and a match count at the top of the list. It renders nothing until there
is a query, so a picker at rest carries no search chrome. Escape stays
dismissal rather than "clear the query". `useDismissOnOutsideOrEscape` owns it
on the document, and one key with one meaning beats a stack. Closing resets the
query and returns focus to whatever held it before.

Because an open picker holds focus, anything that refocuses the composer on its
own has to stand down while one is open. See the launcher's auto-focus effect.

## Scroll edge fades

`.conversation-scroll` wraps the list and paints a `--conversation-edge-fade`
(32px) gradient in `--bg` at its top and bottom, so scrolling content dissolves
into the pane instead of being sliced mid-line under the header and above the
composer. The fades sit on the wrapper, outside the scroller, for two reasons:
they must hold still while content moves under them, and masking the list itself
would fade the sticky scroll-to-latest button along with it (the button's
`z-index: 2` clears the scrims' `1`). The list's head and tail padding both match
the fade height, so at either end of the scroll the gradient covers empty space
and never washes out a real line. The `max-height: 560px` layout reclaims that
padding, so it sets the fade to `0px`.

## Workspace card

[WorkspaceCard.tsx](../src/renderer/components/WorkspaceCard.tsx) floats a
summary of the session's worktree in the conversation's right gutter: the branch
and its base, the diff stat, and one row each for Changes, Files, Terminal,
Commit, and the pull request. Every row hands off to a surface that already
exists: `review.toggleChangesPanel`, `review.openPanelInFilesMode`, the
terminal toggle, the commit dialog, and `git.viewOrCreatePr`. The card is an
index into the pane, never a second place the same state is computed. A clean
worktree disables the Changes row rather than opening an empty panel.

**It yields to whatever docks on the right.** `showWorkspaceCard` in
`SessionConversation.tsx` is `workspaceCardEnabled && !review.isPanelOpen &&
!isLogOpen`: the card is the ambient stand-in for exactly the panel the user just
opened, so the two never share the gutter. Toggling the panel back off brings the
card straight back, because only the user preference persists
(`argmax.workspaceCard.visible`, default on). That preference has three entry
points: Settings → Appearance, the `Workspace card` checkbox in the session
actions menu, and the card's own dismiss. All three write the same
app-level state, so the menu checkbox reports the preference rather than whether
the card happens to be on screen.

**It never covers the transcript.** The card is absolutely positioned inside
`.conversation-scroll`, and `chat-workspace-card.css` keeps it hidden until the
pane is wide enough to hold it beside the measure. The transcript is centered, so
both gutters grow together and the threshold is `--chat-content-width` plus a
card column on each side, with one `@container` rule per `data-chat-width` level,
measured against `.session-multigrid-cell`. Narrow panes (and every cell of a
multi-pane grid) simply have no card. Widen the card and those five thresholds
move with it. Because the gate is pure CSS, enabling the card from the session
actions menu in a too-narrow pane would otherwise be a silent no-op:
`SessionConversation` checks the mounted card's computed display after the
toggle and reports through the composer status line when the pane can't show
it.

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
off and the label settles to "Thought". A manual toggle overrides the auto
behavior (same `userToggle ?? auto` pattern as the turn chip and tool groups)
and survives until the automatic answer itself changes.

**But the body does not fold in place.** `holdOpen` keeps a block that opened
itself while live open for as long as it is the newest turn. Folding it when
`live` ends would take the whole reasoning out of the transcript at the exact
moment the agent starts writing, and a reader pinned to the bottom is pulled up
by that much mid-stream. The scroll never recovers it because the bottom
itself moved. It folds instead when a newer turn starts, where the fold sits
above a viewport already full of the answer, and it opens collapsed on the
session's next visit, per the saved `argmax.thinking.expanded` default from
Settings → Agents → Thinking blocks. An explicit fold from the turn chip still
wins over the hold. The subagent activity pane passes `holdOpen` unconditionally:
it has no turn boundary, so its blocks simply never fold in place.

## Context compaction

When a provider runs out of context it compacts: it summarizes the conversation
so far and continues from that summary. Claude brackets the run with
`system/status status:"compacting"` and a `system/compact_boundary` row carrying
`pre_tokens`/`post_tokens`, then injects the replacement summary as a synthetic
`user` message. That summary is written for the model and routinely runs tens
of KB, so `is_hidden_synthetic_body`
([claude.rs](../src-tauri/src/providers/normalizer/claude.rs)) drops it the same
way it drops an activated skill's `SKILL.md` body, and `compaction_marker` maps
the two bracket rows to `session.compacting` / `session.compacted`.

The same list drops the note Claude emits after reading an image (`[Image:
original 2086x1075, displayed at 2000x1031. Multiply coordinates by 1.04 to map
to original image.]`). It tells the model how to translate coordinates onto a
picture the chat never shows, so on screen it is a stray line between two tool
rows.

The chat shows the seam, not the summary.
[foldConversation.ts](../src/renderer/lib/foldConversation.ts) collapses the
bracket into one `compaction` render item. The finished row replaces the
running one in place, and
[CompactionNotice.tsx](../src/renderer/components/CompactionNotice.tsx) renders
it as a rule with a centered caption (`Compacted context · 471k → 10.7k`). The
seam ends the turn it lands in, so the work after it opens a fresh turn block.

Compaction takes minutes of complete provider silence, so the live marker is the
pane's only progress cue: `SessionConversation` suppresses the generic Thinking
label while `isCompacting(events)` holds, rather than stacking two indicators
that say the same thing less precisely.

## Provider handoff

Changing provider on an idle session is the other seam the chat shows. The new
agent cannot resume the old one's native conversation, so `send_input` drops the
resume id and relaunches from the capped transcript
([follow_up.rs](../src-tauri/src/providers/follow_up.rs)); everything below the
seam was written by an agent that only read a summary of everything above it.

`session.provider-changed` carries `from`, `provider`, and `modelLabel`.
[foldConversation.ts](../src/renderer/lib/foldConversation.ts) turns it into a
`provider-switch` render item that ends the turn it lands in, and
[ProviderSwitchNotice.tsx](../src/renderer/components/ProviderSwitchNotice.tsx)
renders it with the same rule-and-caption treatment as compaction
(`Cursor → Codex · GPT-5.6 Sol`). A row written before the payload carried both
ends falls back to its own message text.

Picking another provider in the session composer does not apply straight away:
[ProviderSwitchDialog.tsx](../src/renderer/components/ProviderSwitchDialog.tsx)
names what the handoff costs and offers a new session as the recommended path.
Taking it moves the composer draft onto the launcher and aims the launcher at
the picked model, so the recommendation costs one click instead of retyping.
Same-provider model changes are unaffected and commit immediately.

## Subagent activity panes

Agent tool rows (`Task`, Codex `spawn_agent`, Cursor `taskToolCall`) open an
in-app activity pane instead of dumping child-agent prose into the parent chat.
The row itself is a split control: clicking the main row opens or focuses the
pane, while the small chevron still expands inline metadata. The parent
projection hides rows with `parent_tool_use_id` and Codex child-thread
`agent_message` rows; the pane projection reads those same persisted events and
shows them as the subagent's own timeline.

**Launch row visual contract.** A launch is one short line: a quiet 2x2 nest
marker, then `Launched <codename>` in `--text`. The prompt and task description
do not appear on the parent row. Clicking the row opens the activity pane, which
owns the full brief. While the launch is running the dots brighten one at a time
in a slow clockwise walk, and a completed or failed launch rests on the static
mark. Only `Running` and `Failed` earn a quiet same-line hint. The accessible
name keeps the existing Started agent contract (matched by
[agentRowName.ts](../src/test/agentRowName.ts)).

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
the earlier unresolved row when a later same-prompt agent has child evidence,
but only once the earlier row is no longer running, since a running row may be
a legitimate parallel agent whose open pane must not be force-closed. Protocol
retries without a child, output, or real `command.completed` are hidden, not
shown as Failed. A launch that completed with a provider error payload stays.
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
// SessionConversationTurn.tsx, handlePlanAccept / handleQuestionAnswer
return sendAfterTerminate(
  sessionId,
  session.state === "running",
  onTerminateSession,
  () => onSendSessionInput(sessionId, message, selectedModel, mode),
  reportSendError
);
```

Main's `sendInput` already relaunches the agent when no live handle exists
(see [session_service.rs](../src-tauri/src/providers/session_service.rs)),
so the terminated session resumes via `--resume <conversationId>` and sends a
capped visible transcript plus the answer as the next user message. The UI
timeline still stores only the raw answer text.

## Mid-turn follow-ups: queue, then optionally send now

While a turn is running the composer shows a single control in the send slot —
**Stop** — so a mid-turn reach for "make it stop" never turns into an
unintended send:

- **Enter** submits the form, which reaches `providers:send-input`. Main sees a
  live handle that is not accepting input and parks the message on the queue, so
  the chip appears in the pending lane and drains when the turn finishes.
- **Stop** calls `providers:terminate` without sending; the draft stays put.

Queued follow-ups appear as full-width rows above the draft. Each row shows its
queued state, a delete action, and **Send now** — the one explicit interrupt
path. Sending a queued follow-up now calls
`providers:send-queued-message-now`. The backend removes that item, interrupts
the current turn, and relaunches with the queued input. Other queued follow-ups
keep their order and drain after the new turn completes. (An earlier design also
put a paper-plane "send now" beside Stop in the composer; it read as two send
buttons and was removed.)

Terminating drops any messages still queued for that session, which is the
existing Stop behavior.

## Unsent drafts

A draft belongs to what it will be sent to, not to the mounted composer.
Switching a pane to another session remounts `SessionComposer`, and a grid
launcher cell remounts when it is retargeted at another repo, so
[composerDrafts.ts](../src/renderer/lib/composerDrafts.ts) keeps drafts in
`localStorage` under `argmax.composer.drafts`. It is a `key → { text, attachments }`
map capped at the 50 most recently edited, restored when the target comes back,
across an app restart too. The key is the session id in `SessionComposer` and
`launcherDraftKey(projectId)` (`launch-<projectId>`) in the new-session
launcher, so each repo keeps its own pending task.
[useComposerDraft.ts](../src/renderer/hooks/useComposerDraft.ts) owns the text
half and [useComposerAttachments.ts](../src/renderer/hooks/useComposerAttachments.ts)
the screenshots.

Screenshots are part of the draft because they are the expensive half: a pasted
or dropped image is already written to the `AttachmentStore`, so the draft only
carries its `{ filePath, mimeType, sizeBytes }` and the chips re-render from
`argmax-attachment://`, with no image bytes in `localStorage`. A draft with only a
screenshot and no text is still remembered.

Clearing the box and removing the last screenshot drops the entry, and so does
a successful send: the send path calls `clearDraft` directly rather than relying
on the state reset, because launching a task unmounts the launcher as the app
moves to the new session. A failed send keeps the draft, matching the retry
behavior above.

Per-target drafts have one exception, `carryTextOnRetarget`, which the launcher
passes and `SessionComposer` does not. Picking another project — or side chat —
from the launcher's context picker is how the user aims a prompt they are still
writing, so the text moves to the new key instead of being left behind, and the
old key keeps only its screenshots. A draft already waiting on the target still
wins: restoring what the user left there beats overwriting it. Changing the
model never touches the text.

## Selection annotations (Add to chat)

Selecting text in the transcript raises a floating toolbar
([SelectionToolbar.tsx](../src/renderer/components/SelectionToolbar.tsx)),
anchored to the selection rect the same way the file-preview popover anchors to
its chip. It listens to `selectionchange` globally but claims only selections
whose range endpoints sit inside its own pane's `.conversation-scroll`, so each
pane in the multi-grid owns its own selections. The toolbar is desktop-only:
coarse-pointer surfaces (the phone companion) drag native selection handles
with no mouse events around them, so it doesn't mount there.

"Add to chat" turns the selection into an annotation chip above the composer.
Annotations are renderer state in `SessionConversation`
([composerAnnotations.ts](../src/renderer/lib/composerAnnotations.ts)), not part
of the persisted draft: they quote the open transcript, so they reset on session
switch and clear on successful send. At send time
`prependAnnotationsToPrompt` serializes them as `>`-quoted blocks ahead of the
typed message — providers see plain prompt text, never a structured annotation.

Review-panel line comments ride the same lane. In the Changes view every
numbered diff line grows a hover "+" over its line-number gutter
([DiffBlocks.tsx](../src/renderer/components/DiffBlocks.tsx)); it opens an
inline form whose submitted comment becomes a `review-comment` annotation
(`file:line — comment` chip). The state still lives in `SessionConversation`;
the sibling `ReviewPanel` reaches it through an annotation sink the
conversation registers with `SessionPane`, so nothing is lifted. At send time
comments serialize as a "Please address this review comment…" block — the
location, the `>`-quoted line, and the note — after any excerpt blocks. The
chat-card diffs (`FileChangeCard`) pass no handler, so they stay read-only.

Files open as review-panel tabs ride along the same way
([openFileContext.ts](../src/renderer/lib/openFileContext.ts)). While the panel
is open with tabs, the composer shows a single dismissible "Open files: …" chip;
at send time the paths append to the prompt as `@path` lines, active tab first,
skipping any the user already @-mentioned. Dismissing the chip skips the
attachment until the set of open tabs changes. Like annotations, this is
renderer-only serialization — providers see plain text.

"Ask in side chat" hands the selection to a fresh repo-less session instead of
the composer: [sideChat.ts](../src/renderer/lib/sideChat.ts) builds the seed
prompt (the newest exchanges from the source transcript, clipped, plus the
`>`-quoted excerpt) and `App.launchSideChat` starts a scratch-workspace
session with it (see [workspaces.md](workspaces.md)). The action renders only
when the pane is given an `onOpenSideChat` handler, so surfaces without the
launch path (the phone companion) simply don't offer it.

"More details" rides the same seed pipeline (`buildDetailsSeed`, an
explanation-flavored instruction) but lands in the
[DetailsPopup](../src/renderer/components/DetailsPopup.tsx): a floating,
corner-resizable panel pinned bottom-right that hosts a full
`SessionConversation` against an ephemeral `popup`-kind scratch session — so
the explanation streams and follow-up questions work like any chat. One popup
exists at a time; opening another disposes the previous one, and closing it
terminates the session and archives its workspace (plus a boot sweep for
strays — see [workspaces.md](workspaces.md)).

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
- "keeps Thinking steady while a launched subagent works and only the child emits events"
- "shows Thinking immediately after a follow-up is sent, before the session flips to running"
- "shows Thinking immediately for a follow-up queued mid-turn, skipping the post-answer grace period"
- "yields the post-send Thinking state to the first visible assistant text"
- "drops the post-send Thinking state when the send itself fails"
- "suppresses the Thinking indicator while AskUserQuestion is outstanding (the card is the ask)"
- "restores Thinking once the user submits and a new user.message arrives"
- "hides assistant text emitted AFTER an ExitPlanMode card so the plan isn't duplicated as a chat bubble"
- "hides hallucinated assistant prose emitted AFTER an AskUserQuestion card"
- "terminates the in-flight probe before sending the QuestionCard answer (no queue wait)"

Drafts are locked in by
[src/renderer/components/SessionComposer.draft.test.tsx](../src/renderer/components/SessionComposer.draft.test.tsx),
[src/renderer/lib/composerDrafts.test.ts](../src/renderer/lib/composerDrafts.test.ts),
and, for the launcher, "brings an unsent launcher prompt and its screenshot
back after a restart" and "clears the launcher draft once the agent starts" in
[src/renderer/App.test.tsx](../src/renderer/App.test.tsx). Retargeting is locked
in by
[src/renderer/components/LaunchSurface.draft.test.tsx](../src/renderer/components/LaunchSurface.draft.test.tsx).

Mid-turn controls are locked in by
[src/renderer/components/SessionComposer.runningControls.test.tsx](../src/renderer/components/SessionComposer.runningControls.test.tsx):

- "queues on Enter instead of interrupting the running turn"
- "stops without sending the draft when Stop is clicked"
- "shows Stop as the only send-slot control while running"

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
  [SessionConversationTurn.tsx](../src/renderer/components/SessionConversationTurn.tsx)
  uses for PlanCard / QuestionCard submits and other card-style flows.
