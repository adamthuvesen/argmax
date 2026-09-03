# Argmax

A local desktop app that runs coding agents in parallel against your own repositories. One user, one machine, no cloud. The domain is about *where an agent works*, *what it did*, and *what still needs a human*.

## Language

### Repositories and working locations

**Project**:
A git repository the user has registered with Argmax, plus its defaults (provider, model, worktree location, setup command, check commands). Identified by its `repo_path`, which is unique.
_Avoid_: Repo, folder, directory

**Workspace**:
One unit of assigned work, owned by one project — the thing a sidebar row represents. It is *not* a place on disk: many workspaces routinely point at the same checkout, and nothing constrains them to be distinct. Carries the task label, branch, base ref, dirty state, and lifecycle state.
_Avoid_: Worktree, directory, folder, branch, project

Say "one session per workspace" only about row identity, never about capacity — the word sounds like a location, so as a capacity claim it reads as "one agent per directory," which is false. State the capability directly instead: any number of agents run at once, each in its own workspace, several of which may share one checkout.

**Checkout**:
The directory on disk a workspace's `path` points at. Shared by every workspace that names it, so it is a mutable resource with no owner in the model — concurrent agents see each other's uncommitted edits and can collide. Stage deliberately; never assume the tree holds only your work.
_Avoid_: Workspace, worktree, repo

**Isolated workspace**:
A workspace backed by its own `git worktree`, forked onto `argmax/<slug>-<short-id>`. Archiving one removes the worktree, so archive is destructive and strictly sequenced.
_Avoid_: Worktree workspace, forked workspace

**Shared checkout**:
A workspace pointing at the project's main checkout, shared with every other session doing the same. `shared_workspace = 1`. Archiving one flips state and drains processes but never touches the tree. The sharing is what makes archive non-destructive, which is why the term names it.
_Avoid_: Current workspace, main workspace, non-isolated workspace

Two surfaces still say `current` for this: the `argmax.workspaceMode` value stored in `localStorage` (`worktree` | `current`) and the launcher's "Worktree" toggle. Those are wire and label values, not the domain term — leave them alone and say "shared checkout" everywhere else.

**Scratch workspace**:
A repo-less workspace backed by an app-owned directory under `local-state/side-chats/`, initialized as a minimal git repo so provider CLIs that demand a checkout still run. Surfaced to the user as a **side chat**.
_Avoid_: Chat workspace, temp workspace

**Popup workspace**:
An ephemeral scratch workspace behind the "More details" explainer. One at a time, never in the sidebar, discarded on close.

**Scratch project**:
The hidden singleton project (`scratch-side-chats`) that owns every scratch and popup workspace. It exists to satisfy the foreign key, not to represent a repository — exclude it from repo pickers and per-project grouping.

**Base ref**:
The git ref an isolated workspace forked from, and the merge-base used for a branch-comparison review. Falls back to the project's default branch.

**Task label**:
The human-readable name of a workspace, shown on its sidebar row. Auto-titled from the opening prompt, renameable.
_Avoid_: Title, name, description

**Keep**:
Declining to archive a workspace, leaving its checkout live. The resting state after a dirty archive is refused.

**Archive**:
Ending a workspace: close admission, drain providers, checks, terminals, and pending approvals, then (for an isolated workspace only) remove the worktree.
_Avoid_: Delete, close, clean up

### Agents at work

**Provider**:
A coding-agent CLI Argmax drives — Claude Code, Codex, Cursor, or OpenCode. A provider is the program, not the model it runs.
_Avoid_: Agent, CLI, tool, backend

**Session**:
One agent run inside one workspace: its provider, model, prompt, lifecycle state, token usage, and cost. The unit users think of as "a chat". A workspace holds exactly one — forking, importing, and agent-launched sessions all create a fresh workspace rather than a second session. The schema permits more, but nothing may rely on that. This bounds identity, not parallelism: any number of sessions may run at once, each in its own workspace, including many against the same checkout and branch.
_Avoid_: Conversation, chat, run, thread, agent

The display name for a session is **chat**: the sidebar, menus, and mobile say chat; code and docs say session.

**Provider conversation id**:
The provider CLI's own identifier for the underlying conversation, kept so a session can be resumed. Distinct from the Argmax session id.
_Avoid_: Session id

**Clear**:
Reset a session's provider conversation in place. Drops the native resume id, hides the existing transcript from the chat surface and from the next prompt, and keeps the same workspace (checkout, branch, task label). The next message starts a fresh provider conversation.
_Avoid_: Reset, new session, wipe

**Turn**:
One user message and everything the agent produced in response, up to the next user message. The unit the chat surface renders and groups cards into.

**Launched by**:
The session whose agent started this one with the `argmax` MCP tools, held on the row as `launched_by_session_id` with the chain's depth in `launch_depth`. It names lineage, not hierarchy: a launched session is a top-level sidebar session that outlives its launcher, not a subagent, and it is what the launch caps (two levels deep, ten per session) are counted over.
_Avoid_: Parent session, child session, spawned session, subagent

**Multitask**:
A chat dispatched from inside another chat while its agent is mid-turn — the small, often unrelated fix you think of halfway through something else. It is a sibling session with a fresh context, running by default in the same checkout, and never a second turn in the chat that started it. It has no sidebar row: it reads as a launch row in the chat that dispatched it and opens in that chat's subagent dock. The result reaches that chat's agent only on the next thing the person types.
_Avoid_: Side task, background task, parallel turn, subagent

**Session state**:
Where a session is in its lifecycle: `created`, `running`, `waiting`, `blocked`, `complete`, `failed`, `cancelled`.

**Attention**:
Whether a session needs a human, derived from session state plus pending approvals: `normal`, `approval-needed`, `blocked`, `failed`, `review-ready`. Never set directly — it is computed. State says what the agent is doing; attention says whether you have to care.
_Avoid_: Status, state, urgency

**Priority**:
The sidebar section holding workspaces that need attention, plus any the user pinned there manually. A dismissal is spent as soon as attention changes again.

**Pending message**:
A follow-up the user composed while the agent was mid-turn. Held in memory only and drained one at a time once the session completes.
_Avoid_: Queued message, draft

**Agent mode**:
Whether the agent may act (`auto`) or must plan first (`plan`). Maps onto each provider's own equivalent flag.
_Avoid_: Mode, plan mode

**Permission mode**:
Whether the agent's commands run unattended (`auto-approve`, the default) or stop for the user (`ask-each-time`).
_Avoid_: Approval mode, safety mode

**Approval support**:
How far a provider can participate in approvals: `respondable` (Argmax can answer the gate), `observable-only` (the request is visible but unanswerable, so the session blocks), or `unsupported` (no detector). Argmax never fakes the answer.

**Inbox**:
A session's undelivered mail — the `session_messages` rows addressed to it that no one has collected yet. A message is recorded here *and* delivered as a turn; the row is what a session that was mid-turn can still read afterwards with `inbox_read`. Reading collects it.
_Avoid_: Queue, mailbox, notifications

**Completion notice**:
The message Argmax writes to a launching session when a session it launched ends a turn: that session's id, label, final state, and last answer. Delivered like any other message, so an idle launcher wakes on a new turn. One per turn end, and only for a session that has a launcher.
_Avoid_: Completion event, done message, callback

### What a session produced

**Timeline event**:
A normalized, provider-independent record of something that happened in a session — a message, a command, an approval, a file change. Visible chat is built from these.
_Avoid_: Message, log line, output

**Raw provider output**:
The provider's unnormalized stdout, stderr, or PTY bytes, kept as a human-readable fallback. Protocol output is not chat and must never be rendered as it.
_Avoid_: Transcript, log, stream

**Interactive card**:
A chat element the user can answer rather than just read — currently a plan card and a question card, mapped from provider tool calls.
_Avoid_: Widget, prompt, dialog

**Check**:
A project-configured command (tests, lint, typecheck) run locally against a workspace, persisted with its exit code and summary. Setup commands run through the same machinery.
_Avoid_: Test, CI, job

**PR check**:
A GitHub CI check on a pull request, polled through `gh`. A different thing from a check — this one runs on GitHub's machines and can trigger an automatic follow-up session when it fails.
_Avoid_: Check, CI check

**Approval**:
A single command a provider asked permission to run, with its risk classification and resolution. Compare-and-set from `pending`, so a replayed request cannot create a second row.

**Review comparison**:
The baseline a diff is taken against: `workingTree` (uncommitted changes vs `HEAD`) or `branch` (the whole delta from the base ref, committed and not).
_Avoid_: Diff mode, comparison

**Checkpoint**:
A saved marker of a workspace's tree at a moment — a git ref, a patch file, or both — so work can be recovered.

**Learning**:
A durable fact extracted from a session and stored against its project: a `pitfall`, a `convention`, or a `command`. Carries the session and event it came from, plus whether the user verified it.
_Avoid_: Memory, note, insight

### The app's own plumbing

**Dashboard snapshot**:
The full set of rows the renderer needs to draw the app: projects, workspaces, sessions, events, raw outputs, approvals, checks.

**Dashboard delta**:
An incremental push after a commit to SQLite. Merging is whole-object replacement per row, so a partial object erases fields; removals travel separately as explicit id lists because replacement cannot express "gone".
_Avoid_: Patch, update, diff

**Bridge**:
`window.argmax`, the single surface through which the renderer reaches Rust. Every request channel is a named Rust command, and channel parity is enforced by a check script.
_Avoid_: API, IPC layer

**Session sync**:
Importing sessions that were started in a provider CLI directly, by reading that CLI's own transcript store. An **imported session** is one that arrived this way rather than being launched here.

**Cell**:
One pane in the session grid. A **session cell** shows a session and a **launcher cell** composes a new one and owns its own project selection. Subagents are not cells: they open as tabs in the session's review panel (its **Agents view**).
_Avoid_: Pane, tile, window
