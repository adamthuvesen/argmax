# Chat Surface and Interactive Cards

The chat surface renders assistant bubbles, tools, and interactive cards: **PlanCard** (Claude Code plan mode) and **QuestionCard** (Claude Code `AskUserQuestion`, Cursor `askQuestionToolCall`).

## Components and Structure

- **Conversation Shell:** [SessionConversation.tsx](../src/renderer/components/SessionConversation.tsx) derives timeline projections, thinking states, turn models, and scroll anchoring.
- **Turns & Cards:** [SessionConversationTurn.tsx](../src/renderer/components/SessionConversationTurn.tsx) renders individual turns, card containers, and card submission handlers via [PlanCard.tsx](../src/renderer/components/PlanCard.tsx) and [QuestionCard.tsx](../src/renderer/components/QuestionCard.tsx).
- **Timeline Logic:** [canonicalTimeline.ts](../src/renderer/lib/canonicalTimeline.ts) decodes persisted rows into one typed event contract. [sessionConversationModel.ts](../src/renderer/lib/sessionConversationModel.ts) uses that contract for event filtering, raw transcript suppression checks, tool pairing, and last-significant-event selection.
- **Composer:** [SessionComposer.tsx](../src/renderer/components/SessionComposer.tsx) handles prompt inputs, file attachments, model/mode chips, follow-up queues, send/stop, and `/clear`. The launcher composer in [LaunchSurface.tsx](../src/renderer/components/LaunchSurface.tsx) cycles Auto / Plan / Chat with Tab. Chat launches a scratch workspace with no repository attached, so the project picker hides and no longer offers a Chat row. The project chip is the source of truth while composing: Full-view new chat hides the grid without dropping it, and a dashboard delta must not retarget the picker back to that hidden session's repo. The last project the user picked is persisted ([launchProjectPreference.ts](../src/renderer/lib/launchProjectPreference.ts)) and survives leaving new chat to open a session: the next new chat shows that project, not the session they just viewed. Both the project picker and the model picker list recently chosen rows first. Stopping a just-launched chat within 10 seconds restores this composer with the prompt and target kept, and archives the workspace so the cancelled chat does not stay in the sidebar ([earlyStop.ts](../src/renderer/lib/earlyStop.ts)).
- **Actions Menu:** [SessionActionsMenu.tsx](../src/renderer/components/SessionActionsMenu.tsx) handles workspace actions, PR refreshes, git shortcuts, and panel toggles.

## Follow scroll

[useConversationScroll.ts](../src/renderer/hooks/useConversationScroll.ts) owns
scrolling in the chat, a single agent run, and persistent agent history. Each
has one scroll viewport and one content wrapper. The scroll-to-latest button
is an absolute overlay outside the viewport, so its visibility cannot change
the transcript height.

The controller follows the physical bottom until the reader moves upward.
An upward wheel or touch gesture releases following before the browser moves
the viewport. Scroll events record the reading position. Layout reconciliation
owns programmatic scroll writes. Reaching the bottom by scrolling downward,
sending a new message, switching session, or clicking scroll-to-latest resumes
following. A content resize alone cannot resume it.

Returning to the bottom is recognized before layout reconciliation records
the position, even if the native scroll event is still queued. If output
grows in that interval, the controller uses the bottom the reader reached
before growth. This keeps a render from swallowing the return to live output.

While following, the controller retains the measured content height between
reconciliations. Replacing streamed rows can briefly shrink the scroll range
and then grow it again before a callback runs. Reserving the height prevents
that temporary clamp from looking like an upward reader scroll. Each
reconciliation releases the reservation before measuring, so a permanent
collapse still removes excess space.
ResizeObserver watches the viewport and direct transcript rows, then reconciles
before paint. The controller-owned wrapper is excluded so its height changes
cannot feed back into the observer. Deferring correction by a frame lets an
earlier row's reflow briefly move the visible prompt before it is restored.

The chat content has a minimum height that lets the latest user message sit
at the top of the viewport. Output fills that space naturally as the turn
grows. While detached, the content also retains a minimum height from before
the gesture. A folding Thought block below the reader therefore cannot
shorten the scroll range and clamp them upward. This may leave blank space
below a collapsed turn until the reader resumes following.

Detached layout changes preserve the visible anchor. Nested scroll areas use
their outer box so scrolling a diff cannot look like a transcript layout
change. CSS `overflow-anchor: none` keeps browser anchoring from competing
with the controller. ResizeObserver watches the transcript rows and viewport,
including composer, panel, and hidden-tab size changes.

The design draws on [use-stick-to-bottom](https://github.com/stackblitz-labs/use-stick-to-bottom)'s
immediate wheel cancellation. Its shrink-triggered reattachment near the
bottom conflicts with the detached-reading contract here, so Argmax owns this
controller rather than adapting a second follow state machine around it.

## The Sent Prompt

Sending an idle follow-up clears the composer text and shows its user bubble
alongside Thinking immediately, before the send request returns. The local
bubble stays until its persisted `user.message` arrives, then gives way to that
row without a duplicate. A rejected send removes the local bubble and restores
the draft for retry. Follow-ups sent mid-turn still use the pending-message queue.

A user bubble shows the text that was typed, not markdown: `SessionConversationUserMessage` renders it into a `<p>` with `white-space: pre-wrap` so a pasted snippet keeps its own line breaks and a `**bold**` stays two asterisks. Two things are marked up on top of that plain text, both in `markUserMessage`.

- **`/skill` invocations** keep the tint the composer gave them while they were typed ([slashHighlight.ts](../src/renderer/lib/slashHighlight.ts)). A leading invocation names the whole message and gets the icon chip; a token further in is only tinted. Shape is the whole guard — the transcript has no skills list to check against.
- **Pasted URLs become links** ([messageLinks.ts](../src/renderer/lib/messageLinks.ts)). Assistant prose gets this free from `remark-gfm`, and a bubble that is deliberately not markdown had no way to click a URL the user had just pasted. The match is `http(s)` runs only: no `www.`, no bare domains, no `mailto:`. Guessing a scheme in text the user did not write as a link is how a sentence ending in "menti.com." becomes a broken one. Trailing sentence punctuation goes back to the sentence, and a closing bracket is kept only when the URL opened it, so a Wikipedia path survives being wrapped in prose parens.
- **Links resolve before skill tokens,** so the path segments in `https://host/plan` are not read as invocations.

Every `http(s)` link in the surface is one component, [WebLink.tsx](../src/renderer/components/WebLink.tsx), shared with the assistant markdown anchor. It owns the whole routing decision: plain click follows the Settings → General link target, ⌘/Ctrl-click opens the other one, and the system browser needs an explicit `system:open-path` because the Tauri webview swallows `target="_blank"`. Over the remote bridge both desktop routes stand down and the anchor's own target carries the link into the reader's browser.

### A prompt from another session

An agent using the `argmax` tools can send a turn into another session, and
Argmax itself sends one when a launched session finishes
([agent-tools.md](agent-tools.md)). Those turns are ordinary `user.message`
rows carrying an `origin` block on the payload — `{sessionId, label, kind}`,
where `kind` is `message` or `completion` — and the bubble reads differently
because of it: a quiet "From `<label>`" header whose label opens the sending
chat, and `aria-label="Message from another chat"` on the group, so a reader
never mistakes a machine's prompt for one the user typed. A malformed or
missing `origin` falls back to the plain bubble rather than failing.

## Card Architecture

In headless structured mode (`-p --output-format stream-json`), tools like `ExitPlanMode` and `AskUserQuestion` return tool results with status errors to signal pause for input. Argmax extracts the structured payload (`input.plan` or `input.questions`) and displays it as an interactive card instead of a failed tool call.

`SendUserMessage` carries plain user-facing text, so it is normalized directly into `message.completed` rather than a card.

### Card Detection Rules

Defined in [turnInteractiveCards.ts](../src/renderer/lib/turnInteractiveCards.ts) and [sessionTurnView.ts](../src/renderer/lib/sessionTurnView.ts):

| Rule | Target | Behavior |
|---|---|---|
| **First valid wins** | `AskUserQuestion` | Pins card key to the first valid tool call to preserve user selections across retry loops. |
| **Tool row hidden** | `ExitPlanMode`, ask-question tools | Hides matching raw tool IDs from the rendered conversation. |
| **Hide card tools** | ask-question tools | Card-producing calls are removed before adjacent visible activity is grouped. |
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
| Verb (`Edited`, `Read`) | `splitLeadingVerb` in [toolCalls.ts](../src/renderer/lib/toolCalls.ts) | `--muted-strong`, UI font |
| Target (file name, headline remainder) | `.tool-call-row-target`, `.tool-call-group-eyebrow-detail` | `--muted`, UI font; `--font-code` only for `data-tool-type="bash"` |
| Line stat | [ActivityStat.tsx](../src/renderer/components/ActivityStat.tsx) | `--diff-add-gutter-fg` / `--diff-del-gutter-fg`, tabular |
| Chevron | `.tool-call-row-chevron` | Only on rows that expand to something. Hidden until hover; faint at rest on group headlines, which are sometimes a turn's only control |

Rules this surface holds to:

- **Service marks identify integrations.** MCP rows carry the server's brand mark, or a plug for an unknown server. Web tools use a globe. Shell rows can use personal command icon rules described below. Summary verbs stay neutral even when tools fail. Collapsed groups omit failure counts, and failures do not automatically expand rows. Error labels and details remain available inside expanded tool rows.
- **Invocation-scoped identity.** Provider tool IDs can repeat across turns. `buildSessionToolCalls` scopes them with `providerInvocationId` and uses chronological unmatched pairs for historical rows that predate that field, so a tool stays in the turn that ran it.
- **Verb/target contrast is a token step, not an opacity fade.** Fading `--muted` drops the file name to 2.4:1 in the light theme; `--muted-strong` over `--muted` measures 6.9:1 / 3.6:1 (light) and 8.0:1 / 5.1:1 (dark). Pinned by `accentTokens.test.ts`.
- **Transport is never a row.** Codex's `wait`, `close_agent`, and `send_message_to_thread` name no work and carry only internal thread ids, so `foldCodexAgentControlTools` drops them unconditionally. Matching one to a spawn decides only whether its outcome settles that launch. When a name collides with a real tool, the Codex thread ids in the input are what identify the transport. Grok's `get_command_or_subagent_output` is the same poll for a spawned child and is hidden by `isHiddenToolName`. Leaving it visible split the parent sentence around "Get command or subagent output".
- **Single calls respect the verbosity.** Compact keeps even a single call behind a short summary such as "Ran a command", so a long command cannot dominate the conversation. Other levels show a single call as its target row.
- **An external tool is named by the service it called.** `extractToolName` first resolves provider wrappers: Cursor ACP's `mcpToolCall`, Codex's `mcp_tool_call`, and Cursor's `other` + `_toolName` never reach the UI as labels. `parseMcpToolName` then reads the provider wire shapes (`mcp__<server>__<tool>`, OpenCode's `<server>_<tool>` such as `engram_memory_stats` alongside the repeated `notion_notion-fetch`, and Codex Apps' `linear.list_issues`) and labels them `Notion fetch` or `Linear list issues`. Cursor plugin identifiers collapse to the connected product (`plugin-google-drive-google-drive` → `Google drive`). Wrapper metadata is stripped from expandable Input, leaving only the arguments the agent supplied.
- **Protocol and bookkeeping do not count as work.** MCP discovery (`ToolSearch`, `getMcpToolsToolCall`) disappears when the real external call is the useful event. Internal task-list writes (`TodoWrite`, `TaskCreate`, `TaskUpdate`) disappear too: they change no project file, create no agent, and otherwise produce misleading rows such as "Edited file." Unknown direct provider names degrade to spaced text (`custom_mcp_tool` → `Custom mcp tool`) rather than leaking snake_case or camelCase.
- **The stat travels with the target**, not right-aligned into a second column: a transcript is read a row at a time, not compared down a column.
- **Group edit totals stay at the far right of the headline, and working owns that slot first.** While the group's status is `running` the end of the line holds the working nest; the total takes over when the last call settles, fading in where the nest was. Rendering both parked a live animation in the middle of the row — each claimed `margin-left: auto` and split the gap — and gave a still-growing count the finality of a result. `summarizeToolChangeCounts` sums reported additions and deletions across completed edits in the group, deduplicated by tool invocation id. Reads and commands do not reset the totals. Repeated edits to one file accumulate, so these are activity totals, not the final net Git diff. Failed, running, and inferred completions do not contribute. Whole-file deletes without line counts and edits without diff payloads do not invent numbers. Individual rows use the same completion gate, and the group header omits the file count to stay compact.
- **Exactly one border in the surface:** the hairline around an expanded diff. Rows have no rail, no card, and no hover fill, and the expanded detail is a fill rather than a frame.
- **A JSON result shows its payload, not its envelope.** `formatToolOutput` lifts the string out of a display envelope when exactly one of `text` / `content` / `result` / `output` holds it and every other key is known envelope metadata (`metadata`, `title`, `type`, `url`). That makes escaped newlines real and promotes `title` onto the block's footer line without discarding pagination, status, or other data fields. Data-shaped JSON is pretty-printed intact, non-JSON is untouched, and bash output keeps byte fidelity. Re-serializing an envelope is not an option: `JSON.stringify` escapes the newlines again.
- **A row that expands to nothing is not a control.** `toolCallHasExpandableDetail` is the same gate the detail uses. The chevron and button appear only when expanding would reveal output, leftover arguments, an error, a file, a heredoc, or nested activity. A bash command that printed nothing is the row itself. Whitespace-only stdout counts as nothing.
- **Bash never restates itself.** The row *is* the command: expanding a bash row unwraps its target to the full text instead of clipping it, so the block holds only stdout. A heredoc is the one exception — a row cannot carry newlines — and it opens one payload with real ones. Claude's `description` / `timeout` and Codex's `timeout_ms` are never a reason to show the input, and the arguments that do show are the leftover keys only, never the command again as an escaped string.

### Expanded Detail

Expanding a row opens **one soft fill**, [ToolCallDetail.tsx](../src/renderer/components/ToolCallDetail.tsx)'s `.tool-call-block`: no border, no rail, one radius, and the fill itself is what says the content is not prose. Before this the detail grew a bordered box per part, each with its own `max-height` and scrollbar, under a floating label — a single call owned four stacked blocks.

| Part | Order | Rule |
|---|---|---|
| Arguments | first | Key/value list ([toolArguments.ts](../src/renderer/lib/toolArguments.ts)), above the payload |
| Payload | middle | Command (heredoc only), `Error`, `Preview`, output |
| Footer | last | Short arguments, envelope title, lines, size, duration, `Show all` |

Rules this shape holds to:

- **Arguments come before the result, because that is the order the call happened in.** The old `+ Input` disclosure printed `JSON.stringify(input, null, 2)` *below* the output, so you read the answer and then clicked to find the question. Six lines of braces for three values.
- **Short scalars ride the footer.** When every leftover argument is a scalar of 32 characters or less, they read as one dim run (`glob *.ts · limit 20`) and the block holds only the payload. Anything longer — a prompt, a body, a filter object — becomes the list at the top. `argumentsFitFooter` owns that split, not the component.
- **No argument the row already stated.** `REDUNDANT_INPUT_KEYS` drops the path keys, and a `Read` whose only input is its file path shows no argument list at all.
- **Position labels the payload; `Error` and `Preview` are the exceptions.** "Output" was a lone dim word over a box, labelling the only thing it could be labelling. A failure keeps its label because rose text alone does not say what the block is when the payload is a plain sentence, and a preview keeps its because it is *input* content that would otherwise read as output.
- **One scroll, and it is the block's body.** `.tool-call-block-body` caps at 16 lines; the payload carries no `max-height` of its own, so the transcript never nests a scroller in a scroller. Truncated output offers `Show all` on the footer instead of a `— showing first 3,000 of 41,208 chars` note.
- **Separators are full-bleed hairlines inside the fill,** so a block with arguments, a payload and a footer still reads as one object rather than three.
- **A row that goes mono turns ligatures off.** Geist Mono fuses a run of `=` into one solid bar, so `echo "=== X ==="` read as struck through in the row while the block under it rendered it cleanly — the row was the one mono surface missing `--code-font-features`.
- **The fill is a token, `--tool-block-surface`, and it moves in opposite directions per theme.** Paper sinks into a well, charcoal lifts out of one: mixing the block from `--code-surface` put the dark version *below* the transcript ground, since dark aliases `--code-surface` to `--panel-sunken`, so a payload read as a hole punched in the page. The diff card body shares the token.
- **The block hugs its content** (`width: fit-content`). A one-word `ok` stretched across the column read as an empty panel with a word in the corner.
- **No payload, no fill.** A read that printed nothing renders its `Open` as a bare footer action on the transcript ground — the old version drew an icon column, a path already in the row, and a bordered button. A fill around a single word is a frame around nothing.
- **The payload reads a notch under the assistant prose** (`--text` 72% toward `--muted-strong`): it is something the transcript reports, not something it says. Mono also sits one type step under the row, since Geist Mono's wider advance makes a block set at the row size read larger than it.
- **A fact that says nothing is not a fact.** `1 line` never shows — the payload is right there — and size only appears past a kilobyte.

### Expanded Diffs

An edit row expands into [FileChangeCard.tsx](../src/renderer/components/FileChangeCard.tsx), flush with the row's left edge. Inside a chat card the shared [DiffBlocks.tsx](../src/renderer/components/DiffBlocks.tsx) loses its table chrome: no `@@` hunk header, no gutter band or divider, and the add/delete wash runs unbroken from the line number into the code. A reserved gutter column carries `+` / `−` so numbers stay in one column whether or not the line changed. The diff carries no padding inside the card body: a padded one let the body's own fill show above and below the wash, so a created file read as a green slab with dark corners instead of one object.

When a row expands to a **single** file, the card header collapses to just its `Open` button, floated in the corner and revealed on hover — the row above already names the file and its stat. A row that expands into **several** cards keeps the full per-file header, since there the card is the only place each path appears. A pure-create card reads as an all-addition diff — same green wash and `+` markers as the added lines of an edit — so a new file and an edited one look like the same kind of object in the transcript.

### Changed Files Card

A finished turn that wrote files ends with [TurnChangesCard.tsx](../src/renderer/components/TurnChangesCard.tsx), rendered by `TurnBlock` under the turn body and above the hover footer.

- **One row per path, not per write.** `collectTurnFileChanges` in [turnFileChanges.ts](../src/renderer/lib/turnFileChanges.ts) folds a turn's writes by path and reads the same tool input the activity rows read, so the card can never disagree with them. A file created and later edited stays a create; a delete decides the turn's verdict on the file.
- **Where the `+N −N` comes from.** Provider content when the provider sends any: Claude's `old_string`/`new_string`, a unified diff, a created file's body. When the provider names a path and says nothing else — Codex's `file_change` is the case — the diff is the one Argmax measured from git at the turn's own boundaries and wrote back onto that tool row ([measured_diffs.rs](../src-tauri/src/providers/measured_diffs.rs), and [providers.md](providers.md#measured-file-change-diffs)). Anything else carries no stat at all: a whole-file delete, a diff over the cap, a workspace with no git. An absent number is honest, and a number measured against the wrong baseline is not, so nothing here is ever inferred from the workspace's total diff.
- **The name is the row.** File names take the UI font, like every other activity-row target — mono is reserved for bash, and a path set in mono turns `run_family_serving.py` into a wall of even-width glyphs. The directory is dropped entirely and lives in the row's `title` and accessible name, where it settles the rare two-files-one-basename case. Each family gets a differently *shaped* glyph (a hash, braces, a flask), not one file outline recolored seven ways, and the add/delete stats sit in their own subgrid columns so digits line up down the card.
- **A row opens that file's diff**, through the review hook's own `openFile`, which selects the path and switches the panel to Changes in one call. The question a changed-files row raises is "what changed", so the file-tree preview (`openInFilesView`) is the wrong destination and is kept only as `onOpenFile`, the fallback for a host with no Changes view. Paths are handed over workspace-relative; the agent's own are absolute. The header's **Review** opens the panel on Changes via `openChangesPanel`, which — unlike `toggleChangesPanel` — never closes an already-open panel: "Review" is a request to see the changes.
- **The header toggles the list.** Which state a turn starts in is a setting, `argmax.turnChanges.expanded`, exposed as "Changed files expanded" in Agents settings and threaded down as `defaultTurnChangesExpanded`. It defaults on: the list is the point of the card, and a turn that wrote files is usually a turn you want to look at.
- **Only settled turns get one.** A live turn's count is a moving number, so `TurnBlock` renders the card only once `running` is false — the same gate the hover footer uses.
- **The one card with chrome in the activity surface**, and the one place a glyph column is worth it: family ink is what makes a stylesheet and a component tell apart at a glance. `fileFamily` in [fileFamily.ts](../src/renderer/lib/fileFamily.ts) maps a path to one of seven families, each reusing an existing syntax token — no new palette. A test file reads as a test whatever its extension.
- **The card pins its own line-height.** It sits inside the conversation's prose leading (1.55–1.74); inherited, that stretches every row ~4px past what the card is drawn for.

### PR milestone celebration

Appearance → **Celebrate PR milestones** is off by default. When enabled, a confirmed PR creation or merge sends one full-width sweep of accent pixels along the bottom of the chat. Ordinary completed turns do not animate.

`usePrMilestone` reads the workspace's GitHub PR number, state, and source timestamps. It only celebrates milestones newer than the current chat/branch watch start. Existing PRs discovered after a delayed refresh, historical merges, branch navigation, and enabling the setting do not replay old celebrations. If a refresh discovers both creation and merge, only the merge plays. Each milestone plays once while the chat remains mounted. The canvas sits outside the transcript scroller, so it also plays while the chat is empty or waiting for assistant output.

The GitHub poller supplies these confirmations, including PRs created by agents through `gh`. The animation may wait until the next PR refresh. It never uses assistant prose or a turn's success state as evidence. Reduced motion and hidden documents skip the sweep.

### Error events and log dumps

Stderr and other `error` timeline events render as [LogBlock.tsx](../src/renderer/components/LogBlock.tsx), not an assistant bubble: the same `--tool-block-surface` fill as an expanded tool payload, labelled Error, with rose on the failure text. Consecutive error events coalesce into one block.

The kind is a claim about the row, so a notice is no longer written as one. Backend lines that merely report — the after-turn notes above — go in as `session.note` and read as notices; `error` is reserved for something that actually failed. Rows written before that split keep their `error` kind and still render rose, `operation` payload and all.

Tracing-style records that leak into assistant markdown (`2026-09-01T07:21:37Z ERROR crate::module: ...`) lift out of the paragraph into the same block. Concatenated records split on the next timestamp, and trailing `key="value"` fields wrap onto their own line so a long `session_id` does not glue two records together. Detection lives in [logDump.ts](../src/renderer/lib/logDump.ts). A date in ordinary prose is not a log. MCP HTTP client crates (`rmcp::`, `codex_rmcp_client::`) are dropped: those lines are session-teardown noise, not a failure the chat can act on. So is `codex_core::util: Custom tool call output is missing`, which Codex logs after a cancelled in-flight custom tool. So is `codex_core::tools::router` apply_patch verification, including the expected-context lines that follow on the PTY. Those records are tool bookkeeping, not a session failure. Codex login errors still show because they use a different crate path. The normalizer classifies tracing-format raw PTY lines the same way so they are not stored as `message.delta`.

## Thinking Indicators and Thought Blocks

### Pre-Answer Thinking Indicator
The animated thinking indicator displays during inactive periods while a session is running:
- **Suppressed when:** `session.state !== "running"`, answer text is streaming (a `message.delta` *without* `thinking: true`), a visible top-level tool is executing, or an interactive card is awaiting user input.
- **Only a row the reader can watch counts as progress.** A subagent's own calls (those carrying a `parent_tool_use_id`) never suppress it, and neither does the launch row of a backgrounded agent — Claude answers an async `Agent` in about 100 ms with a receipt rather than a result, and the row is re-marked running to say the child is still out there. No completion for it ever arrives, since the child reports back as a `<task-notification>` prompt the normalizer does not parse, so counting it as an executing tool silenced the cue for the whole rest of the session, later turns included. `backgroundLaunch` on the `ToolCall` ([toolCalls.ts](../src/renderer/lib/toolCalls.ts)) marks those rows; they keep their nest and lose their vote.
- **The pre-answer window is a floor, not another case.** Between a send and the provider's first visible event the indicator shows outright and consults none of the rules above. Every one of them exists to stop this line doubling up with another live cue, and before the provider has spoken there is none on screen to double up with — so weighing them there only created ways for the pane to sit silent through the ten to thirty seconds a relaunched provider takes to answer. A stranded `session.compacting` marker, left by an app quit mid-compaction, used to silence it for the rest of the session.
- **One cue per beat:** reasoning arrives as a `message.delta` too, so `liveThoughtOwnsProgress` in [sessionTurnView.ts](../src/renderer/lib/sessionTurnView.ts) decides which element carries progress and both consumers read it. Before the turn has answer text the Thought block owns the beat (expanded, labelled "Thinking") and this indicator stays down; once an answer lands the block goes quiet and the indicator takes over for the rest of the turn's reasoning. Counting reasoning as streaming answer text used to leave a running turn with no cue at all for as long as the model kept reasoning.
- **Timers:** Initial turn start shows immediately; mid-turn silent gaps wait 700 ms. Stays visible for at least 600 ms once shown. Both this wait and the 1800 ms window below count from the last significant event's `createdAt`, not from the pane's mount: a session reopened mid-turn serves only what is left of the delay, which is usually nothing, so switching back to a running chat shows the cue at once instead of replaying a wait it already sat through.
- **A finished message owns its beat for 1800 ms.** The text is the progress cue for that window, so a `message.completed` takes the indicator *down* whether or not it was already up, and it only claims the next silent gap once the window is spent. Suppressing at the source is what makes this provider-shaped: Codex and OpenCode deliver an answer as one atomic `message.completed` with no answer deltas, so nothing later arrived to hide a label already up from the reasoning gap before it, and it sat under the finished answer until `session.state` flipped — roughly a second later, since that flip waits for the provider process to exit. Delaying only the first show fixed the flicker for Claude and Cursor, which stream deltas up to their completion, and left the other two showing a tail.
- **Turn starts on send:** `SessionConversation` marks turn start on `onSendSessionInput` rather than waiting for backend state flips, preventing empty chat delays during provider spawn. The baseline records the session's state at send time, because a relaunching follow-up is sent *from* a terminal state: reading a session that is already `failed` — an orphan the app adopted back after a restart — as a turn that cannot start dropped the cue half a second after the send. Only a terminal state the session falls into *after* the send ends the beat.
- **The wait names its own length.** Past three seconds the label grows an elapsed count ("Distilling 14s"), driven by the shared [liveTimer](../src/renderer/lib/liveTimer.ts) rather than React state so the number stays with paint while the chat reconciles. It counts from the moment the label mounted, which is the honest figure — how long *this* silent beat has had nothing to show, not how long the turn has run — and a static word is what makes a twenty-second relaunch read as a frozen pane.
- **Transitions are logged.** Each time the cue appears or disappears, `recordChatCue` writes a breadcrumb naming the rule that holds it down; read them in Debug → Logs under scope `renderer::chat`. See [debugging.md](debugging.md).

### Extended-Thinking (Thought Blocks)
Model reasoning traces (`content: "thinking"` in the canonical timeline event from Claude thinking deltas, Codex reasoning, or Cursor stream events) are routed to [ThoughtBlock.tsx](../src/renderer/components/ThoughtBlock.tsx):
- **Live streaming:** the block that owns the beat renders expanded and labelled "Thinking".
- **One burst at a time.** A tool boundary flushes the thinking buffer into a fresh group, so a turn that reasons between calls without narrating holds one group per call — hundreds of them for a model like Gemini through Cursor. Read turn-wide, `live` opened all of them: replaying one such session put 114k characters of reasoning on screen across 131 expanded blocks, against 262 characters in one block after. `liveThoughtOwnsProgress` still decides whether the turn's reasoning owns the beat at all; `lastThinkingGroupId` ([sessionTurnView.ts](../src/renderer/lib/sessionTurnView.ts)) decides which block carries it. Everything behind the newest burst is settled history and folds to its `Thought 12s` header. Claude reaches the same shape by narrating before each tool; this is what gets a silent reasoner there too.
- **Hold open on scroll:** `holdOpen` keeps the newest burst expanded while it is the newest turn, so the answer lands under an open block instead of yanking a bottom-pinned viewport by the block's whole height. It is keyed on that group rather than on `live`, because the hold has to outlast live to do its job — and because a block that opened while live holds itself open afterwards (`openedLive`), so a turn-wide hold would keep every superseded block open and narrowing `live` alone would change nothing.
- **Persistence:** [snapshot.ts](../src/renderer/lib/snapshot.ts) and [sessionConversationModel.ts](../src/renderer/lib/sessionConversationModel.ts) preserve thinking deltas during event pruning.

## Context Compaction & Provider Handoff

- **Context compaction:** Provider compaction events (`session.compacting` / `session.compacted`) are collapsed into a single `compaction` render item by [foldConversation.ts](../src/renderer/lib/foldConversation.ts) and rendered by [CompactionNotice.tsx](../src/renderer/components/CompactionNotice.tsx) (`Compacted context · 471k → 10.7k`). Claude repeats the opening row — `system/status status:"compacting"` is a heartbeat every 30s for as long as the run takes — so the collapse folds consecutive running markers too, not just the start/end pair, and the seam keeps the first row's id. Synthetic summary prompts injected by the provider are dropped.
- **Provider handoff:** Changing providers on an idle session creates a `session.provider-changed` marker rendered by [ProviderSwitchNotice.tsx](../src/renderer/components/ProviderSwitchNotice.tsx) (`Cursor → Codex · GPT-5.6 Sol`). Follow-ups restart fresh with the capped transcript.
- **Project handoff:** Moving a session creates a `session.moved` marker rendered by [ProjectMoveNotice.tsx](../src/renderer/components/ProjectMoveNotice.tsx) (`HQ → Argmax · shared checkout`). The destination starts a fresh provider conversation with the capped transcript and checkout path.
- **Session notes:** What Argmax did to the chat itself — resuming a move or archive promised before the last quit, or dropping one the turn never earned — is a `session.note` row carrying the `operation` (`session.move` or `workspace.archive`), rendered by [SessionNote.tsx](../src/renderer/components/SessionNote.tsx) as one muted centered line. It is not a seam: nothing changed hands, so it has no rules on either side, and [foldConversation.ts](../src/renderer/lib/foldConversation.ts) lets it follow the turn it landed in rather than ending that turn and splitting one answer across two blocks. The failure that may have caused it is its own `error` row.

## Multitask Rows

A multitask dispatched from the composer writes `multitask.launched` into this chat and `multitask.finished` when the sibling chat's turn ends. Both fold into one notice associated with the dispatch turn, then [SessionConversation.tsx](../src/renderer/components/SessionConversation.tsx) draws it above the composer with [MultitaskRow.tsx](../src/renderer/components/MultitaskRow.tsx) (`Fix the changelog date  Multitask` / `Completed`).

- **It stays above the composer.** The row remains visible after the parent turn finishes and while the dispatch point scrolls away. Its content aligns with the input card, and a capped lane scrolls before repeated rows can crowd out the transcript.
- **One row per multitask.** The finish row merges into the row the dispatch opened, keyed by child session id, while the rows keep launch order.
- **A finished row carries one line of the answer** on the status line (`Completed · Corrected the 0.4 heading to 2026.`), markdown stripped and cut at 120 characters. The full answer stays in the dock tab.
- **The mark names it.** A running multitask shares the subagents' working nest, because at that moment they are doing the same thing; a settled one carries the Split glyph its dock tab uses. The status words are the launch row's own (`Running` / `Completed` / `Failed`), plus `Stopped` — the one thing a person can do to a multitask that a subagent has no equivalent for.
- **Stop rides the row**, revealed on hover or focus. It stops that chat only: the early-stop launcher restore and archive are pane behaviour and a multitask has no pane.
- **Clicking opens the dock, not another chat.** A multitask has no sidebar row; it opens as a tab in this pane's Agents view beside the subagents, carrying its own chat. See [multitask.md](multitask.md).

## Subagent Activity Panes

Subagent tool calls (Claude `Task`/`Agent`, Codex `spawn_agent`, OpenCode `task`, Cursor `taskToolCall`/ACP `task`) display a launch row in the parent conversation via [AgentLaunchList.tsx](../src/renderer/components/AgentLaunchList.tsx), rendered as a bulleted task list:

```
✿  Map chat tool-row rendering  Noether  ›
   Completed
```

- **Line one** is the agent's own `description` (bright) followed by its codename (dim), which is also the label on its tab and activity pane. Codenames are surnames of physicists, mathematicians and computer scientists from `agentNames.ts`, hashed from the spawn id and kept unique within a session; the first spawn always draws from the ten headline names. `agentLaunchLabel` falls back to `Launched <codename>` when the provider gave no description. The `prompt` is never promoted into the title — truncating a multi-paragraph instruction turned every spawn into a path wall.
- **Line two** is the state in words (`Completed` / `Running` / `Failed`), indented to the task rather than the bullet. This replaced the old circle-check and circle-cross glyphs: a finished agent says so, rather than encoding it in a mark.
- **The mark** is the shared working nest (four dots, [WorkingNest.tsx](../src/renderer/components/WorkingNest.tsx)) while the agent runs, and the agent's **emblem** once it settles. Both occupy the same box so the text edge does not shift when an agent lands.
- **The emblem is the codename's face.** `emblemForCodename` ([agentEmblems.ts](../src/renderer/lib/agentEmblems.ts)) gives each of the 100 names one of twelve radially symmetric shapes in one of the nine `--session-icon-*` hues, drawn by [AgentEmblem.tsx](../src/renderer/components/AgentEmblem.tsx). Binding it to the name rather than the spawn is what makes it worth learning: Gauss is the same mark in every session and every project, and a session's spawns are distinct for free because the codenames already are. The nest wears the same hue while the agent runs, so the landing ends in the colour the emblem is about to take. A failed agent keeps its shape, greys to `--muted`, and takes a small `--rose` corner dot — the hue says *who*, never *how it went*. The set and its rules live in [docs/design/agent-emblems](design/agent-emblems).
- **The nest lands before the emblem takes over.** On the running → finished edge the four dots gather into one, pulse once in `--accent-deep`, and open back out to the settled 2x2. The swap waits `WORKING_NEST_SETTLE_MS` for it ([useSettleHold.ts](../src/renderer/hooks/useSettleHold.ts)) — without that hold the nest unmounts on the frame it would have started settling, which is why the settled state was unreachable in the shipped app until the hook existed. The hook catches the flip *during render*, not in an effect: an effect runs after the commit, so the bullet would already have painted once and taken the nest with it. An agent that errored skips the landing entirely, and so does a mark that mounts already finished — a landing means "this just happened".
- **Missing Codex launches recover from lineage.** If structured stdout omits `spawn_agent`, the child trace can supply its parent conversation ID. Argmax inserts one deterministic launch row and imports the child activity beneath it. A later real launch reparents the child rows and sends cursor-visible tombstones for the synthetic pair, so an open chat removes the placeholder without showing a duplicate.
- **Grok children are imported from disk.** The parent stream only carries the `spawn_subagent` receipt, so the pane used to open on that JSON envelope and an empty-state notice. The child's `chat_history.jsonl` is the activity; the receipt is hidden as launch metadata.
- **Spacing** is deliberately looser than the tool rows (`gap: 14px`): delegated work is the coarsest thing in a turn.

Clicking the text opens the activity pane; the trailing chevron expands the raw tool detail inline. The button hugs its text so that chevron sits beside the task instead of against the far edge. That detail follows the *row* level, not the group level — it opens by default from Detailed up, so Balanced keeps the launch a two-line row. What the chevron reveals is the launch receipt, which for a backgrounded agent is a wall of internal instructions to the parent, and the delegated work itself lives one click away in the pane.

- **The right dock, not a grid column:** Clicking the row opens the subagent in that session's review panel — a third mode beside Changes and Files ([AgentsView.tsx](../src/renderer/components/AgentsView.tsx)), so delegated work reads next to the work it came from. Each open subagent is a tab in the same strip Files mode uses; the transcript itself is [AgentActivity.tsx](../src/renderer/components/AgentActivity.tsx) and carries no chrome of its own. Every tab stays mounted, so a backgrounded subagent keeps polling. ⌘W closes the active tab, as it does for a file. A subagent's tab is marked with its emblem at 13px; a multitask's keeps the Split glyph, which is what says it is a chat of its own. The pane opens on a fixed masthead: the task the agent was given as the title, and one muted line with its codename, role, and reported model and effort (`Gauss · Reviewer · Opus 5 · Extra High`). Its mark is the working nest while the run is live and the emblem at 18px once it lands, in a tile tinted from the same hue — left on `--accent-soft` it put a green tile behind a pink agent. The masthead's nest is held still (`WorkingNest`'s `still`): here the mark is the run's identity above a transcript that is already streaming, so it keeps the live colour and drops the relay. The brief folds behind an "Instructions" chip in the same row style as the run's "Worked for" chip. A tab whose launch row leaves the timeline (a superseded Codex spawn) is dropped.
- **A subagent run is one turn, read at the chat's own verbosity.** The pane attaches child tools with `foldTurnToolItems`, interleaves individual calls with prose, then groups adjacent activity with the same `foldToolRunsToSummaries` pass as the transcript, and wraps them in the same [TurnBlock.tsx](../src/renderer/components/TurnBlock.tsx): the `Worked for Xs` chip is one control over every tool group and Thought block below it. Where it starts comes from the chat-verbosity setting, not from a separate one — a pane that opened wide while the chat beside it read as single lines was two settings for one reader. The run is always its pane's latest turn, so it never collapses on age the way an older chat turn does. At Minimal the pane keeps only its result panel until the chip is opened, and unlike a chat turn it hides *all* pre-tool narration: the run's answer is the result panel, so there is no last prose group standing in for one. Claude native `SendMessage` continuations appear as separate runs in the same stable dock tab. `task_started` and `task_notification` identify the run lifecycle, while the message delivered to the parent remains its own event.
- **Native Claude, Codex, OpenCode, and one-shot Cursor identity is parent-scoped.** A dock reference resolves only when its parent native conversation id and child session id match the current conversation. Clearing, switching provider, or forking invalidates inherited resumability, even though the old timeline rows remain readable history. References use the current parent-mediated follow-up, so the child does not become an independent session. Codex assignments start with `spawn_agent` or `send_input`. OpenCode continuations call `task` with the existing `task_id`. Cursor continuations use the authoritative `taskToolCall.result.success.agentId`; Composer 2.5 is excluded from this path. Delivery and `pending_init` do not complete an assignment. Its terminal child state does.
- **Independent sessions stay independent.** An ordinary session launched from the app keeps its own session and dock behavior. The persistent multi-run behavior applies to native Claude, Codex, OpenCode, and one-shot Cursor children. OpenCode exposes the child result in the parent tool row, without a separate child trace stream.
- **Inputs to a busy Codex child stay in its active assignment.** A follow-up after completion opens a new run. Delivering more instructions while the child is active does not create another running entry.
- **Trace imports:** `session:agent-events` fetches and parses trace files on demand. Parsed rows are saved with deterministic IDs (`trace:<provider>:<sessionId>:<parentToolUseId>:<childId>:<seq>:<kind>`) and hidden from the main chat view.

## Chat Verbosity & Single-Line Activity Mode

Configured in Settings → Agents ("Chat detail & verbosity"): a **1–5 scale** (**Minimal / Compact / Balanced / Detailed / Full trace**). Compact is the default when no preference is saved. Existing saved levels and legacy preferences keep their equivalent disclosure settings.

Every level starts from the same chronological activity. `foldConversationItems` carries individual messages and tools, and `foldTurnToolItems` attaches subagent children. The renderer interleaves those calls with prose, cards, and agent launches before `foldToolRunsToSummaries` groups adjacent routine work for display. A group can mix reads, searches, edits, and commands, but cannot cross a visible message. An agent launch is never one of them: at every level, Compact included, it keeps its own row and ends the run. A summary line reading "started an agent" hid the launch row that names the delegated work, carries the codename and emblem, and opens the subagent's pane, leaving a whole child agent to read like a file read. Hidden Minimal narration remains a grouping boundary so collapsing a turn cannot combine work from separate parts of the conversation.

[ToolCallGroupBubble.tsx](../src/renderer/components/ToolCallGroupBubble.tsx) owns all activity disclosure. Compact gives single calls a short summary too. Other levels show their targets directly. Multiple calls show natural summaries such as "Edited a file, read files, ran commands". Opening the headline reveals compact rows, and opening a row reveals its output or diff. The group keeps its first tool's identity as calls arrive and preserves the reader's expansion choice through growth and completion. Failed calls add an explicit "N failed" suffix and tint the headline, including groups with successful calls.

- **Minimal:** shows activity summaries while working. Finished turns hide successful work and pre-tool narration behind `Worked for`, keeping the answer, changed files, and any failed activity visible. Opening the chip restores narration and activity summaries.
- **Compact:** keeps one short activity summary between commentary messages, with agent launches standing apart from it. Command text, file names, individual calls, and output appear only after expansion. A running indicator reports ongoing work without printing a changing command preview.
- **Balanced:** opens group rows in the latest turn, keeping individual output collapsed until requested.
- **Detailed / Full trace:** opens recent tool details too. Full trace also opens thought history by default. Older turns start with collapsed activity groups.

The turn chip controls disclosure across the turn. Per-group and per-row choices survive incoming output. Expanding a group does not automatically expand every output block. Outside Compact, a running action caption stays visible for at least 600 ms unless replaced by a newer action, while status and results update immediately. Minimal keeps newly finished activity for a 600 ms settling period before hiding it. Interacting with that activity keeps it visible for inspection. Restored history never replays either delay.

## Smooth Answer Reveal & Live Auto-Scroll

- **Paced reveal:** [StreamingMarkdown.tsx](../src/renderer/components/StreamingMarkdown.tsx) types out large visible streaming blocks on a 32 ms tick. The pace adapts to delivery: each newly arrived backlog is spread over ~1.3 s (never slower than 5 characters a tick), because no provider streams at typewriter speed — Claude sends ~130-character chunks every 0.7 s, Codex and OpenCode land the whole answer as one `message.completed`, and Cursor fires word-sized deltas in a burst. A block built from one `message.completed` is as live as a delta group while its turn runs (`coalesceAssistantGroups` marks it `streaming`), so an atomic Codex answer sweeps in instead of popping, and Claude's completion replacing its deltas no longer ends the reveal. When the block does stop streaming, text still unrevealed finishes over the same window at no less than its previous pace instead of snapping to the end; the old fixed cadence left hundreds of characters unrevealed at that moment and dumped them in one block. Progress is cached in a module-level map keyed by `revealKey` (session/agent ID + group creation time + group ID) so a live block the reader already watched resumes instead of restarting. Reopening a session still remounts the pane (`useRestoreWithoutMotion`): every completed group in a running turn is `streaming`, so without that flag they would all type out from nothing at once. Restore paints already-arrived text in full; only growth after the window types. The same snap applies while `document.hidden` — a backgrounded window cannot show the ticks, and pausing them left every finished bubble to replay when the user came back.
- **Streaming Markdown retains document context.** Each revealed message is parsed as one document, so reference links, loose lists, and nested blocks have the same meaning during streaming and after completion. The same render root persists across completion, preserving code-block state. Fence parsing belongs to `react-markdown` and its CommonMark parser.
- **LaTeX & Math Equations:** Mathematical expressions in assistant responses render via `remark-math` and `rehype-katex` with bundled KaTeX stylesheets. Delimiters are normalized via [normalizeMathDelimiters.ts](../src/renderer/lib/normalizeMathDelimiters.ts), supporting LaTeX display equations (`\[ ... \]`), inline math (`\( ... \)`), bare Greek letters (`\tau`), LaTeX environments (`\begin{align}`), and standard markdown `$$...$$` / `$...$`. Single dollar currency amounts (`$50`) are disambiguated and preserved without entering math mode.
- **Mermaid diagrams:** Fenced `mermaid` / `mmd` blocks render as SVG via the `mermaid` package, loaded on first use so the cold-start graph stays lean. [MermaidDiagram.tsx](../src/renderer/components/MermaidDiagram.tsx) draws them as a hugging well on `--tool-block-surface`, themed from live CSS tokens (Light / Dark / accent). A wide flowchart scales to the column. Expand in the toolbar opens the diagram at native size in a window overlay. Escape or the backdrop closes it. Incomplete fences while streaming show a pending status. A finished fence that cannot be parsed falls back to the source and a short error. Copy and Source live in the same hover toolbar.
- **Auto-follow scroll:** [useConversationScroll.ts](../src/renderer/hooks/useConversationScroll.ts) follows output until the reader scrolls upward. The content minimum height reserves space for the latest prompt and protects a detached reader from content collapse. See Follow scroll above.
- **Images in answers:** [MarkdownImage.tsx](../src/renderer/components/MarkdownImage.tsx) renders web images, workspace images through `argmax-asset://`, and saved chat attachments through `argmax-attachment://`. Both protocols enforce their existing filesystem allowlists. A local path that neither handler accepts becomes a file chip after the image request fails, never a broken image box.
- **File links in answers:** Absolute paths inside the active workspace are reduced to workspace-relative paths before opening. [openableFile.ts](../src/renderer/lib/openableFile.ts) also recognizes the same repo-relative suffix when an answer names a file from another checkout. A real absolute path outside the workspace opens through the system instead of sending the Files panel a path it is not allowed to preview.
- **Tail reserve & resize:** `.conversation-list` maintains constant bottom padding (`--space-8`). A `ResizeObserver` monitors the viewport and composer textarea to adjust scroll offsets dynamically as drafts expand. A width-driven reflow (the side review/log panel opening or closing) keeps a reader who was already at the bottom at the bottom instead of leaving the new bottom out of view; height-only growth below a detached reader still leaves them alone.
- **Workspace card:** [WorkspaceCard.tsx](../src/renderer/components/WorkspaceCard.tsx) floats worktree status and a glanceable subagent roster in the right gutter when pane width allows. Clicking the branch name copies its full value, including text hidden by ellipsis, and reports success or failure in the button tooltip. Each chip in that overlapping stack is the agent's emblem on a ring tinted from the same hue — one colour per agent, not a chip colour and a mark colour — and a multitask keeps its initial on its hashed tint. When the review or log panel is open, the card remains visible whenever the conversation column is wide enough to hold it beside the transcript without overlap. The PR row is the number (and merged/closed state when it is not open): clicking it creates a PR or opens the existing one with the same link-target preference as chat links.

## Personal command icons

Create `argmax-icons.local.json` at the checkout root to give shell commands a
brand mark in your own builds. The file is Git-ignored and optional. For example:

```json
[
  { "commandPattern": "^run_only_sql(?:\\s|$)", "server": "snowflake" }
]
```

`commandPattern` is a JavaScript regular expression applied to the full command
after shell launch wrappers such as `zsh -lc` are removed. Anchor it with `^` to
avoid matching incidental mentions in arguments or SQL text. The first matching
rule wins. `server` names an existing mark in
[serverIcons.ts](../src/renderer/lib/serverIcons.ts). Invalid rules raise an
explicit configuration error when the renderer loads. MCP server marks take
precedence over command rules.

Run `npm run tauri:build` after changing the file. Your mappings are bundled into
that build, including its mobile renderer. Builds made without the file have no
command mappings. Installing a public release replaces the customized build, so
rebuild to restore the mappings. This is build customization, not a runtime
Settings preference. Anyone receiving your custom binary also receives its
mappings.

## Follow-up Queuing & Drafts

- **Mid-turn messages:** Submitting a prompt while an agent is running places the message into a pending queue. The queue sits on top of the composer as a tucked tab, slightly narrower and behind the input card. Users can delete queued messages or click **Send now** to interrupt the active turn (`providers:send-queued-message-now`). **Enter** is what queues, so the running composer shows Stop as its only control — except on a touch surface (`pointer: coarse`, the phone companion), where a queue button appears beside Stop once the draft has text: a thumb has no Enter key, and an empty draft still leaves Stop alone there.
- **Suggested follow-up:** once a turn completes, [useFollowUpSuggestion.ts](../src/renderer/hooks/useFollowUpSuggestion.ts) asks `session:suggest-follow-up` for the reply the user would most plausibly send, and shows it as the composer placeholder instead of the static hint. **Tab** drops it into the draft (only while the draft is empty) so **Enter** sends it; agent mode moved to **Shift+Tab** in the session composer, and the launcher takes either. One call per completed turn (keyed on `completedAt`), on the cheap title model; a failure or an empty answer keeps the static placeholder.
- **Drafts:** Unsent drafts and screenshots persist in `localStorage` under `argmax.composer.drafts` via [composerDrafts.ts](../src/renderer/lib/composerDrafts.ts), keyed by session ID or `launch-<projectId>`. Changing projects in the launcher transfers text via `carryTextOnRetarget`. A send drops the stored entry immediately (the on-screen text stays until delivery finishes) so the next NEW CHAT cannot restore a prompt that already launched.
- **Selection annotations:** Highlighted text in the transcript opens [SelectionToolbar.tsx](../src/renderer/components/SelectionToolbar.tsx). "Add to chat" inserts the excerpt as a blockquote annotation in the prompt. Open review tabs append context in the same format. An attached annotation is sendable on its own: with a chip in the lane, send is enabled and Enter works on an empty draft.
- **Diff notes:** The review panel's hover "+" on a diff line opens an inline form, and the note joins the same annotation lane as a chip reading `Diff note · path:line`. [composerAnnotations.ts](../src/renderer/lib/composerAnnotations.ts) serializes it as an `<argmax-diff-note file= line= side= base=>` block under a header that says once that these are notes on the local worktree, not comments on a GitHub pull request — the phrase that otherwise sends an agent off to look for a PR to reply to. `side` travels because a deleted line's number belongs to the pre-change file, and `base` names the review comparison the diff was taken against, since that is the tree the number came from.
- **Side chat & popup:** "Ask in side chat" opens a scratch-workspace session with the selected excerpt. "More details" opens [DetailsPopup.tsx](../src/renderer/components/DetailsPopup.tsx) against an ephemeral popup-kind session.
