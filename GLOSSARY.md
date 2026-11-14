# Argmax

A local desktop app that runs coding agents in parallel against your own repositories. One user, one machine, no cloud. The domain is about *where an agent works*, *what it did*, and *what still needs a human*.

### Where work happens

**Project**: A named collection of local folders that agents use together. One folder (the primary) is the default Git repository for new chats. A project has a stable id independent of its name and paths. _Avoid_: Repo, folder, directory

**Linked repository**: The API name for an additional project folder. Agents may consult and edit it, subject to their provider's permissions. _Avoid_: Linked project, extra root, additional directory

**Workspace**: One unit of assigned work, owned by one project: the thing a sidebar row represents. It is not a place on disk. Many workspaces routinely point at the same checkout. It carries the task label, branch, base ref, dirty state, and lifecycle state. _Avoid_: Worktree, directory, folder, branch, project

**Checkout**: The directory on disk a workspace's `path` points at. Every workspace that names it shares it, so concurrent agents see each other's uncommitted edits and can collide. Stage deliberately; never assume the tree holds only your work. _Avoid_: Workspace, worktree, repo

**Isolated workspace**: A workspace backed by its own `git worktree`, forked onto a branch named by the branch template. Archiving one moves its checkout into recoverable storage, keeping its files for 48 to 72 hours and its branch for good. _Avoid_: Worktree workspace, forked workspace

**Shared checkout**: A workspace pointing at a checkout Argmax did not create (`shared_workspace = 1`), usually the project's main checkout. Archiving one never moves its checkout. The `argmax.workspaceMode` value `current` and the launcher's "Worktree" toggle still use the old wording; they are wire and label values, so leave them alone. _Avoid_: Current workspace, main workspace, non-isolated workspace

**Scratch workspace**: A repo-less workspace in an app-owned directory under `local-state/side-chats/`, initialized as a minimal git repo. The user sees it as a chat labelled **Chat**; older code calls it a side chat. It belongs to the hidden scratch project (`scratch-side-chats`), which exists to satisfy the foreign key: exclude it from repo pickers and per-project grouping. _Avoid_: Chat workspace, temp workspace

### Agents at work

**Provider**: A coding-agent CLI Argmax drives: Claude Code, Codex, Cursor, OpenCode, or Grok Build. A provider is the program, not the model it runs. _Avoid_: Agent, CLI, tool, backend

**OpenCode gateway**: The service OpenCode's models run through (OpenRouter or Vercel AI Gateway). A gateway is not a provider: the provider is still OpenCode. _Avoid_: Backend, OpenCode provider, proxy

**Session**: One agent run inside one workspace: its provider, model, prompt, lifecycle state, token usage, and cost. A workspace holds exactly one by design: forking, importing, and agent-launched sessions each create a fresh workspace. A workspace's chat is its most recently active session (`chatSessionByWorkspace`). This bounds identity, not parallelism: any number of sessions run at once, each in its own workspace, including many against one checkout. The display name is **chat**: the UI says chat, code and docs say session. _Avoid_: Conversation, run, thread, agent

**Provider conversation id**: The provider CLI's own identifier for the underlying conversation, kept so a session can be resumed. Not the Argmax session id. _Avoid_: Session id

**Launched by**: The session whose agent started this one with the `argmax` MCP tools (`launched_by_session_id`, depth in `launch_depth`). It names lineage, not hierarchy: a launched session is a top-level session that outlives its launcher. _Avoid_: Parent session, child session, spawned session, subagent

**Multitask**: A chat dispatched from inside another chat while its agent is mid-turn. It is a sibling session with a fresh context, by default in the same checkout, never a second turn in the chat that started it. It has no sidebar row. _Avoid_: Side task, background task, parallel turn, subagent

**Attention**: Whether a session needs a human, computed from session state, pending approvals, and unanswered questions. Never set directly. Session state says what the agent is doing; attention says whether you have to care (`SessionState`, `AttentionState` in `src-tauri/crates/argmax-contracts/src/sessions/`). _Avoid_: Status, state, urgency

**Inbox**: A session's undelivered mail: the `session_messages` rows addressed to it that no one has collected. A message is recorded here and delivered as a turn; reading with `inbox_read` collects it. _Avoid_: Queue, mailbox, notifications

**Routine**: A stored prompt that Argmax launches on a schedule, against a registered project. The UI and docs say **scheduled task**; code, IPC channels (`routines:*`), and the `routines` table say routine. _Avoid_: Cron job, automation, trigger

### Arcs

**Arc**: A long-lived body of work that outlives any one chat and may span several projects. It is a thin container: the coordinator plans, and Argmax only launches, limits, and wakes it. _Avoid_: Project, mission, workstream, epic, initiative

**Coordinator**: The arc's current planning chat (`arcs.coordinator_session_id`). It is disposable: starting a new one repoints the arc, and the old chat stays as history. _Avoid_: Orchestrator, manager, lead agent, parent

**Member**: A session that belongs to an arc (`sessions.arc_id`). Members read the arc folder but never write to it. A fork leaves the arc. _Avoid_: Child, worker, subagent

### Checks, reviews, PRs, and sync

**Check**: A project-configured command (tests, lint, typecheck) run locally against a workspace. _Avoid_: Test, CI, job

**PR check**: A GitHub CI check on a pull request, polled through `gh`. It runs on GitHub's machines, unlike a check. _Avoid_: Check, CI check

**PR watch**: A persisted request from one session to be woken about one pull request until it merges, closes, or is unwatched. Argmax reports and never merges. _Avoid_: PR subscription, PR monitor, babysitter

**Diff note**: A note the user wrote on a line or range of a diff in the review panel, serialized into the prompt as an `<argmax-diff-note>` block. It is local to this machine and is not a GitHub review comment. _Avoid_: Review comment, line comment, inline comment

**Dashboard delta**: An incremental push after a commit to SQLite. Merging is whole-object replacement per row, so a partial object erases fields. Removals travel as explicit id lists. _Avoid_: Patch, update, diff
