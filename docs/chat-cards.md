# Chat Surface and Interactive Cards

The chat surface renders assistant bubbles, tools, and interactive cards: **PlanCard** (Claude Code plan mode) and **QuestionCard** (Claude Code `AskUserQuestion`, Cursor `askQuestionToolCall`).

## Components and Structure

- **Conversation Shell:** [SessionConversation.tsx](../src/renderer/components/SessionConversation.tsx) derives timeline projections, thinking states, turn models, and scroll anchoring.
- **Turns & Cards:** [SessionConversationTurn.tsx](../src/renderer/components/SessionConversationTurn.tsx) renders individual turns, card containers, and card submission handlers via [PlanCard.tsx](../src/renderer/components/PlanCard.tsx) and [QuestionCard.tsx](../src/renderer/components/QuestionCard.tsx).
- **Timeline Logic:** [sessionConversationModel.ts](../src/renderer/lib/sessionConversationModel.ts) handles event filtering, raw transcript suppression checks, tool pairing, and last-significant-event selection.
- **Composer:** [SessionComposer.tsx](../src/renderer/components/SessionComposer.tsx) handles prompt inputs, file attachments, model/mode chips, follow-up queues, send/stop, and `/clear`. The launcher composer in [LaunchSurface.tsx](../src/renderer/components/LaunchSurface.tsx) cycles Auto / Plan / Chat with Tab. Chat launches a scratch workspace with no repository attached, so the project picker hides and no longer offers a Chat row.
- **Actions Menu:** [SessionActionsMenu.tsx](../src/renderer/components/SessionActionsMenu.tsx) handles workspace actions, PR refreshes, git shortcuts, and panel toggles.

## Follow scroll

The conversation list pins to the physical bottom while the reader is attached, and a leftover-viewport spacer after the latest user message makes that pin sit the prompt at the top of the pane until the turn fills it. Logic lives in [useSmartFollowScroll.ts](../src/renderer/hooks/useSmartFollowScroll.ts).

The macOS app is WKWebView, which has no CSS `overflow-anchor`. While attached, JS pinning hides layout shifts. After the reader scrolls up, the next insertion above the viewport would slide older transcript into view, so a detached pass keeps the in-view node still by its content coordinate. The spacer is a follow layout and is frozen while detached: resizing it used to land the reader on the bottom, re-arm follow, grow the spacer back, and jump them to the latest user message. Re-attach only when the reader moves toward the bottom (including trackpad momentum), taps scroll-to-latest, sends a new message, or changes session. Collapse that brings the bottom to them is not a request to follow.

## The Sent Prompt

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
| Chevron | `.tool-call-row-chevron` | Only on rows that expand to something. Hidden until hover; faint at rest on group headlines, which are sometimes a turn's only control |

Rules this surface holds to:

- **No icons.** The verb already names the action, and a glyph column competes with the one left edge. Errors tint the verb rose rather than an icon, so a failing row does not shift its left edge.
- **Invocation-scoped identity.** Provider tool IDs can repeat across turns. `buildSessionToolCalls` scopes them with `providerInvocationId` and uses chronological unmatched pairs for historical rows that predate that field, so a tool stays in the turn that ran it.
- **Verb/target contrast is a token step, not an opacity fade.** Fading `--muted` drops the file name to 2.4:1 in the light theme; `--muted-strong` over `--muted` measures 6.9:1 / 3.6:1 (light) and 8.0:1 / 5.1:1 (dark). Pinned by `accentTokens.test.ts`.
- **Transport is never a row.** Codex's `wait`, `close_agent`, and `send_message_to_thread` name no work and carry only internal thread ids, so `foldCodexAgentControlTools` drops them unconditionally. Matching one to a spawn decides only whether its outcome settles that launch. When a name collides with a real tool, the Codex thread ids in the input are what identify the transport. Grok's `get_command_or_subagent_output` is the same poll for a spawned child and is hidden by `isHiddenToolName`. Leaving it visible split the parent sentence around "Get command or subagent output".
- **A summary of one is not a summary.** A run of a single tool renders as that tool's own row, never a headline wrapping it: "Fetched 1 URL" over "Fetched URL" is one sentence twice, and the row names the actual target. Single-line verbosity still shows exactly one line per gap between replies.
- **An external tool is named by the service it called.** `extractToolName` first resolves provider wrappers: Cursor ACP's `mcpToolCall`, Codex's `mcp_tool_call`, and Cursor's `other` + `_toolName` never reach the UI as labels. `parseMcpToolName` then reads the provider wire shapes (`mcp__<server>__<tool>`, OpenCode's repeated `notion_notion-fetch`, and Codex Apps' `linear.list_issues`) and labels them `Notion fetch` or `Linear list issues`. Cursor plugin identifiers collapse to the connected product (`plugin-google-drive-google-drive` → `Google drive`). Wrapper metadata is stripped from expandable Input, leaving only the arguments the agent supplied.
- **Protocol and bookkeeping do not count as work.** MCP discovery (`ToolSearch`, `getMcpToolsToolCall`) disappears when the real external call is the useful event. Internal task-list writes (`TodoWrite`, `TaskCreate`, `TaskUpdate`) disappear too: they change no project file, create no agent, and otherwise produce misleading rows such as "Edited file." Unknown direct provider names degrade to spaced text (`engram_remember` → `Engram remember`) rather than leaking snake_case or camelCase.
- **The stat travels with the target**, not right-aligned into a second column: a transcript is read a row at a time, not compared down a column.
- **Group stats are the true sum of their rows.** `summarizeToolChangeCounts` reads the same per-tool input the expanded rows read, so a headline can never disagree with what it collapses.
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

### Error events and log dumps

Stderr and other `error` timeline events render as [LogBlock.tsx](../src/renderer/components/LogBlock.tsx), not an assistant bubble: the same `--tool-block-surface` fill as an expanded tool payload, labelled Error, with rose on the failure text. Consecutive error events coalesce into one block.

Tracing-style records that leak into assistant markdown (`2026-09-01T07:21:37Z ERROR crate::module: ...`) lift out of the paragraph into the same block. Concatenated records split on the next timestamp, and trailing `key="value"` fields wrap onto their own line so a long `session_id` does not glue two records together. Detection lives in [logDump.ts](../src/renderer/lib/logDump.ts). A date in ordinary prose is not a log. MCP HTTP client crates (`rmcp::`, `codex_rmcp_client::`) are dropped: those lines are session-teardown noise, not a failure the chat can act on. So is `codex_core::util: Custom tool call output is missing`, which Codex logs after a cancelled in-flight custom tool. So is `codex_core::tools::router` apply_patch verification, including the expected-context lines that follow on the PTY. Those records are tool bookkeeping, not a session failure. Codex login errors still show because they use a different crate path. The normalizer classifies tracing-format raw PTY lines the same way so they are not stored as `message.delta`.

## Thinking Indicators and Thought Blocks

### Pre-Answer Thinking Indicator
The animated thinking indicator displays during inactive periods while a session is running:
- **Suppressed when:** `session.state !== "running"`, answer text is streaming (a `message.delta` *without* `thinking: true`), a visible tool is executing, a subagent is running (`parent_tool_use_id`), or an interactive card is awaiting user input.
- **The pre-answer window is a floor, not another case.** Between a send and the provider's first visible event the indicator shows outright and consults none of the rules above. Every one of them exists to stop this line doubling up with another live cue, and before the provider has spoken there is none on screen to double up with — so weighing them there only created ways for the pane to sit silent through the ten to thirty seconds a relaunched provider takes to answer. A stranded `session.compacting` marker, left by an app quit mid-compaction, used to silence it for the rest of the session.
- **One cue per beat:** reasoning arrives as a `message.delta` too, so `liveThoughtOwnsProgress` in [sessionTurnView.ts](../src/renderer/lib/sessionTurnView.ts) decides which element carries progress and both consumers read it. Before the turn has answer text the Thought block owns the beat (expanded, labelled "Thinking") and this indicator stays down; once an answer lands the block goes quiet and the indicator takes over for the rest of the turn's reasoning. Counting reasoning as streaming answer text used to leave a running turn with no cue at all for as long as the model kept reasoning.
- **Timers:** Initial turn start shows immediately; mid-turn silent gaps wait 700 ms. Stays visible for at least 600 ms once shown.
- **A finished message owns its beat for 1800 ms.** The text is the progress cue for that window, so a `message.completed` takes the indicator *down* whether or not it was already up, and it only claims the next silent gap once the window is spent. Suppressing at the source is what makes this provider-shaped: Codex and OpenCode deliver an answer as one atomic `message.completed` with no answer deltas, so nothing later arrived to hide a label already up from the reasoning gap before it, and it sat under the finished answer until `session.state` flipped — roughly a second later, since that flip waits for the provider process to exit. Delaying only the first show fixed the flicker for Claude and Cursor, which stream deltas up to their completion, and left the other two showing a tail.
- **Turn starts on send:** `SessionConversation` marks turn start on `onSendSessionInput` rather than waiting for backend state flips, preventing empty chat delays during provider spawn. The baseline records the session's state at send time, because a relaunching follow-up is sent *from* a terminal state: reading a session that is already `failed` — an orphan the app adopted back after a restart — as a turn that cannot start dropped the cue half a second after the send. Only a terminal state the session falls into *after* the send ends the beat.
- **The wait names its own length.** Past three seconds the label grows an elapsed count ("Distilling 14s"), driven by the shared [liveTimer](../src/renderer/lib/liveTimer.ts) rather than React state so the number stays with paint while the chat reconciles. It counts from the moment the label mounted, which is the honest figure — how long *this* silent beat has had nothing to show, not how long the turn has run — and a static word is what makes a twenty-second relaunch read as a frozen pane.
- **Transitions are logged.** Each time the cue appears or disappears, `recordChatCue` writes a breadcrumb naming the rule that holds it down; read them in Debug → Logs under scope `renderer::chat`. See [debugging.md](debugging.md).

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

- **The right dock, not a grid column:** Clicking the row opens the subagent in that session's review panel — a third mode beside Changes and Files ([AgentsView.tsx](../src/renderer/components/AgentsView.tsx)), so delegated work reads next to the work it came from. Each open subagent is a tab in the same strip Files mode uses; the transcript itself is [AgentActivity.tsx](../src/renderer/components/AgentActivity.tsx) and carries no chrome of its own. Every tab stays mounted, so a backgrounded subagent keeps polling. ⌘W closes the active tab, as it does for a file. The panel's status bar names the state (`Working` / `Done`) and the model the subagent ran on (`Opus 5 · Extra High`); a tab whose launch row leaves the timeline (a superseded Codex spawn) is dropped.
- **Trace imports:** `session:agent-events` fetches and parses trace files on demand. Parsed rows are saved with deterministic IDs (`trace:<provider>:<sessionId>:<parentToolUseId>:<childId>:<seq>:<kind>`) and hidden from the main chat view.

## Chat Verbosity & Single-Line Activity Mode

Configured in Settings → Agents ("Chat detail & verbosity"): a **1–5 scale** (**Minimal / Compact / Balanced / Detailed / Full trace**). In level 1 (Minimal) single-line mode, consecutive tool calls collapse into a single self-updating `ActivitySummaryLine` ("Explored 2 files, edited 1 file") and completed Thought blocks fold away. When the turn finishes, that working block hides too: the chip reads `Worked for Xs` and the body keeps only the answer (and the changed-files card). Pre-tool work narration counts as work, not the answer. Claude, Codex, Grok, and OpenCode emit it as `message.completed` before each tool. Claude and Grok share a timestamp between that text and the following tool because both come from one assistant envelope. Clicking the chip restores the activity lines and that narration. Higher levels progressively expand tool-call group headers, recent tool inspection rows, and thought history.

## Smooth Answer Reveal & Live Auto-Scroll

- **Paced reveal:** [StreamingMarkdown.tsx](../src/renderer/components/StreamingMarkdown.tsx) paces large visible streaming chunks to avoid abrupt layout jumps. Progress is cached in a module-level map keyed by `revealKey` (session/agent ID + group creation time + group ID) so switching sessions does not restart reveals from scratch.
- **LaTeX & Math Equations:** Mathematical expressions in assistant responses render via `remark-math` and `rehype-katex` with bundled KaTeX stylesheets. Delimiters are normalized via [normalizeMathDelimiters.ts](../src/renderer/lib/normalizeMathDelimiters.ts), supporting LaTeX display equations (`\[ ... \]`), inline math (`\( ... \)`), bare Greek letters (`\tau`), LaTeX environments (`\begin{align}`), and standard markdown `$$...$$` / `$...$`. Single dollar currency amounts (`$50`) are disambiguated and preserved without entering math mode.
- **Mermaid diagrams:** Fenced `mermaid` / `mmd` blocks render as SVG via the `mermaid` package, loaded on first use so the cold-start graph stays lean. [MermaidDiagram.tsx](../src/renderer/components/MermaidDiagram.tsx) draws them as a hugging well on `--tool-block-surface`, themed from live CSS tokens (Light / Dark / accent). A wide flowchart scales to the column. Expand in the toolbar opens the diagram at native size in a window overlay. Escape or the backdrop closes it. Incomplete fences while streaming show a pending status. A finished fence that cannot be parsed falls back to the source and a short error. Copy and Source live in the same hover toolbar.
- **Auto-follow scroll:** [useSmartFollowScroll.ts](../src/renderer/hooks/useSmartFollowScroll.ts) locks viewport to the physical bottom during output. A leftover-viewport spacer after the latest user message sits that message at the top of the pane while the new turn is shorter than the view, so a follow-up is not tucked under a long previous reply. Upward user gestures detach auto-follow and show the scroll-to-bottom button.
- **Tail reserve & resize:** `.conversation-list` maintains constant bottom padding (`--space-8`). A `ResizeObserver` monitors the viewport and composer textarea to adjust scroll offsets dynamically as drafts expand.
- **Workspace card:** [WorkspaceCard.tsx](../src/renderer/components/WorkspaceCard.tsx) floats worktree status and a glanceable subagent roster avatar stack in the right gutter when pane width allows. Docking the review or log panel automatically hides the card.

## Follow-up Queuing & Drafts

- **Mid-turn messages:** Submitting a prompt while an agent is running places the message into a pending queue. The queue sits on top of the composer as a tucked tab, slightly narrower and behind the input card. Users can delete queued messages or click **Send now** to interrupt the active turn (`providers:send-queued-message-now`).
- **Suggested follow-up:** once a turn completes, [useFollowUpSuggestion.ts](../src/renderer/hooks/useFollowUpSuggestion.ts) asks `session:suggest-follow-up` for the reply the user would most plausibly send, and shows it as the composer placeholder instead of the static hint. **Tab** drops it into the draft (only while the draft is empty) so **Enter** sends it; agent mode moved to **Shift+Tab** in the session composer, and the launcher takes either. One call per completed turn (keyed on `completedAt`), on the cheap title model; a failure or an empty answer keeps the static placeholder.
- **Drafts:** Unsent drafts and screenshots persist in `localStorage` under `argmax.composer.drafts` via [composerDrafts.ts](../src/renderer/lib/composerDrafts.ts), keyed by session ID or `launch-<projectId>`. Changing projects in the launcher transfers text via `carryTextOnRetarget`. A send drops the stored entry immediately (the on-screen text stays until delivery finishes) so the next NEW CHAT cannot restore a prompt that already launched.
- **Selection annotations:** Highlighted text in the transcript opens [SelectionToolbar.tsx](../src/renderer/components/SelectionToolbar.tsx). "Add to chat" inserts the excerpt as a blockquote annotation in the prompt. Line comments from the review panel and open review tabs append context in the same format. An attached annotation is sendable on its own: with a chip in the lane, send is enabled and Enter works on an empty draft.
- **Side chat & popup:** "Ask in side chat" opens a scratch-workspace session with the selected excerpt. "More details" opens [DetailsPopup.tsx](../src/renderer/components/DetailsPopup.tsx) against an ephemeral popup-kind session.
