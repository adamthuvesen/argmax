//! The session tools: list, launch, message, move.
//!
//! Every tool builds a [`SessionControlAction`] and sends it over the
//! session-control socket with the token the launcher put in this process's
//! environment. The socket handler owns the policy — the launch caps, the
//! self-message rejection, the project resolution — so a tool here is a thin,
//! well-described face on one wire action and nothing more.

use rmcp::{
    handler::server::{router::tool::ToolRouter, wrapper::Parameters},
    model::{CallToolResult, ContentBlock},
    schemars, tool, tool_router, ErrorData,
};
use serde::Deserialize;

use crate::session_control::{
    ArchiveAction, ChecksRunAction, GoalSetAction, InboxAction, LaunchAction, LearningsAddAction,
    LearningsSearchAction, ListAction, MessageAction, MoveAction, ProjectsAction, ReadAction,
    RenameAction, ScheduleCancelAction, ScheduleFollowupAction, ScheduleListAction,
    ScheduleResumeAction, SessionControlAction, StatusAction, StopAction, TerminalReadAction,
    TerminalSpawnAction, WaitAction, WorkspaceDiffAction, WorkspaceStatusAction,
};

#[derive(Clone)]
pub struct ArgmaxTools {
    pub(super) tool_router: ToolRouter<Self>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct SessionListParams {
    /// Registered project to list, by name or absolute repo path. Defaults to
    /// this session's own project.
    pub project: Option<String>,
    /// List sessions across every registered project instead of one.
    #[serde(default)]
    pub all: bool,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct SessionLaunchParams {
    /// The first prompt the new session runs. Write it as a standalone task:
    /// the new session starts with no memory of this conversation.
    pub prompt: String,
    /// Registered project to launch in, by name or absolute repo path.
    /// Defaults to this session's own project.
    pub project: Option<String>,
    /// Provider to run: claude, codex, cursor, opencode, or grok. Defaults to
    /// the provider running this session.
    pub provider: Option<String>,
    /// Model id for that provider, as listed in Argmax's model picker (for
    /// example claude-opus-5 or gpt-5.6-sol). Defaults to this session's model.
    pub model: Option<String>,
    /// Give the new session its own git worktree instead of sharing the
    /// project's checkout. Use it when the work would collide with yours.
    /// Mutually exclusive with `path`.
    #[serde(default)]
    pub worktree: bool,
    /// Absolute path of an existing checkout of the target project. Any
    /// directory `git worktree list` reports for it, including the main one.
    /// The new session shares that checkout. Mutually exclusive with `worktree`.
    pub path: Option<String>,
    /// Git ref the new session should work from. With `worktree`, the isolated
    /// worktree forks from this ref instead of the project's current branch.
    /// With `path`, the checkout must already be on this branch. Pass `worktree`
    /// or `path` as well. This does not switch another checkout's branch.
    pub branch: Option<String>,
    /// Sidebar label for the new session. Defaults to the prompt's first line.
    pub task_label: Option<String>,
    /// Thinking effort: low, medium, high, xhigh, max, or ultra. Not every
    /// model takes every level. Defaults to this session's own.
    pub reasoning: Option<String>,
    /// How the new session answers permission prompts: auto-approve,
    /// ask-each-time, or provider-defaults. Defaults to this session's own,
    /// which is auto-approve unless the user changed it. Use ask-each-time
    /// when the work touches something you would want a person to see first.
    #[serde(rename = "permissionMode", alias = "permission_mode")]
    pub permission_mode: Option<String>,
}

#[derive(Debug, Default, Deserialize, schemars::JsonSchema)]
pub struct ChecksRunParams {
    /// Session whose workspace to check. Defaults to your own.
    pub session: Option<String>,
    /// One shell command to run in that checkout. Omit it to run the
    /// project's configured check commands in order.
    pub command: Option<String>,
    /// Wall-clock cap for the whole command sequence, in milliseconds.
    /// Defaults to five minutes and is capped at 30 minutes.
    pub timeout_ms: Option<u64>,
}

#[derive(Debug, Default, Deserialize, schemars::JsonSchema)]
pub struct WorkspaceStatusParams {
    /// Session whose workspace to describe. Defaults to your own.
    pub session: Option<String>,
}

#[derive(Debug, Default, Deserialize, schemars::JsonSchema)]
pub struct WorkspaceDiffParams {
    /// Session whose workspace to diff. Defaults to your own.
    pub session: Option<String>,
    /// Narrow the diff to one path, relative to the checkout root.
    pub file_path: Option<String>,
    /// `workingTree` (default) is uncommitted work; `branch` is everything
    /// different from the base branch; `committed` is only what has landed as
    /// commits.
    pub comparison: Option<String>,
    /// Character budget for the diff. Defaults to 16000, capped at 40000.
    pub max_chars: Option<u32>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct LearningsAddParams {
    /// `pitfall` for a trap to avoid, `convention` for how this repo does
    /// things, `command` for an invocation worth reusing.
    pub kind: String,
    /// One sentence the next agent can act on, specific enough to be wrong.
    pub summary: String,
    /// Project to file it under, by name, id, or absolute repo path. Defaults
    /// to your own.
    pub project: Option<String>,
}

#[derive(Debug, Default, Deserialize, schemars::JsonSchema)]
pub struct LearningsSearchParams {
    /// Free text. Omit it to get the project's most-used learnings.
    pub query: Option<String>,
    /// Project to search, by name, id, or absolute repo path. Defaults to your
    /// own.
    pub project: Option<String>,
    /// How many to return. Defaults to 10, capped at 40.
    pub limit: Option<u32>,
}

#[derive(Debug, Default, Deserialize, schemars::JsonSchema)]
pub struct TerminalSpawnParams {
    /// Session whose workspace the terminal opens in. Defaults to your own.
    pub session: Option<String>,
    /// A command line to type into the shell, run as if the user typed it.
    pub command: Option<String>,
}

#[derive(Debug, Default, Deserialize, schemars::JsonSchema)]
pub struct TerminalReadParams {
    /// Terminal to read, from terminal_spawn. Omit it to list what a
    /// workspace has running instead.
    pub terminal_id: Option<String>,
    /// Session whose workspace to list. Defaults to your own. Ignored when
    /// terminal_id is given.
    pub session: Option<String>,
    /// Characters from the newest output to return, in chronological order.
    /// Defaults to 8000, capped at 40000.
    pub max_chars: Option<u32>,
}

#[derive(Debug, Default, Deserialize, schemars::JsonSchema)]
pub struct ProjectListParams {}

#[derive(Debug, Default, Deserialize, schemars::JsonSchema)]
pub struct ScheduleFollowupParams {
    /// The turn this chat runs when it wakes. Write it to stand on its own —
    /// your transcript is there, but say what to check and what to do about it.
    pub prompt: String,
    /// Seconds from now. Give this or `at`, not both. Rounded up to 30
    /// seconds, which is how often the scheduler looks.
    pub in_seconds: Option<u64>,
    /// An RFC 3339 instant. Give this or `in_seconds`, not both.
    pub at: Option<String>,
    /// Name for the row in Scheduled Tasks. Defaults to the prompt's first line.
    pub name: Option<String>,
}

#[derive(Debug, Default, Deserialize, schemars::JsonSchema)]
pub struct ScheduleListParams {
    /// Project name, id, or path. Defaults to this chat's own project.
    pub project: Option<String>,
}

#[derive(Debug, Default, Deserialize, schemars::JsonSchema)]
pub struct ScheduleCancelParams {
    /// Id of the scheduled task, from schedule_list or schedule_followup.
    pub schedule_id: String,
    /// Pause it instead of deleting it. The task keeps its prompt and its
    /// schedule and stops firing; schedule_resume switches it back on.
    pub disable: Option<bool>,
}

#[derive(Debug, Default, Deserialize, schemars::JsonSchema)]
pub struct ScheduleResumeParams {
    /// Id of the paused scheduled task, from schedule_list.
    pub schedule_id: String,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct SessionMessageParams {
    /// Id of the session to message, from session_list or session_launch.
    pub session: String,
    /// The message to deliver. It arrives as a user turn in that session.
    pub message: String,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct SessionMoveParams {
    /// The registered project to move to, by name or absolute repo path. It
    /// must be a different project from the current one. Pass exactly one of
    /// project or path.
    #[serde(default)]
    pub project: Option<String>,
    /// Absolute path of an existing checkout of the project you are already
    /// in — any directory `git worktree list` reports for it, including its
    /// main one. Use this instead of `cd` when the work belongs in another
    /// worktree: `cd` only moves your shell, so the workspace, its diff, and
    /// its commit and pull-request actions would keep targeting the checkout
    /// you started in.
    #[serde(default)]
    pub path: Option<String>,
    /// What to do once you are there. It becomes your first turn in the
    /// destination. Write it to stand on its own: unless the conversation
    /// travels with you, the CLI starts cold there and sees only the last few
    /// turns of this transcript.
    pub prompt: String,
    /// Create an isolated worktree in the destination instead of using its
    /// shared checkout.
    #[serde(default)]
    pub worktree: bool,
    /// Keep the source workspace open instead of archiving it after the move.
    #[serde(default)]
    pub keep_source: bool,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct SessionStatusParams {
    /// Id of the session to inspect, from session_list or session_launch.
    pub session: String,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct SessionReadParams {
    /// Id of the session to read, from session_list or session_launch.
    pub session: String,
    /// The `nextCursor` a previous read returned. Omit it to read from the
    /// start of the transcript.
    pub cursor: Option<i64>,
    /// Byte budget for this page. Defaults to 16000, capped at 40000; a page
    /// cut short comes back with `truncated: true` and a cursor to resume from.
    pub max_chars: Option<u32>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct SessionStopParams {
    /// Id of the session whose turn should be stopped.
    pub session: String,
}

#[derive(Debug, Default, Deserialize, schemars::JsonSchema)]
pub struct InboxReadParams {}

#[derive(Debug, Default, Deserialize, schemars::JsonSchema)]
pub struct WorkspaceArchiveParams {}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct GoalSetParams {
    /// The completion condition, in your own words. Write something this
    /// session's own output can demonstrate — the evaluator reads the
    /// transcript and cannot run commands or open files itself.
    pub condition: String,
    /// Turns to spend before giving up. Defaults to the user's setting.
    pub max_turns: Option<u32>,
}

#[derive(Debug, Default, Deserialize, schemars::JsonSchema)]
pub struct GoalClearParams {}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct SessionRenameParams {
    /// Sidebar label for this chat. The first line is used, trimmed and capped
    /// like a launch label. Pass the name once you know what the work is.
    pub task_label: String,
}

#[derive(Debug, Default, Deserialize, schemars::JsonSchema)]
pub struct SessionWaitParams {
    /// Session ids to watch. Omit it to watch every session you launched.
    pub sessions: Option<Vec<String>>,
    /// Seconds to block before giving up. Defaults to 120, capped at 600.
    pub timeout_s: Option<u64>,
}

#[tool_router(router = tool_router)]
impl ArgmaxTools {
    pub fn new() -> Self {
        Self {
            tool_router: Self::tool_router(),
        }
    }

    #[tool(
        name = "session_list",
        description = "List the other Argmax sessions the user has open. Returns each session's id, \
project, task label, provider, state, last activity, and which session launched it, newest \
activity first. Use it when the user names another session or when coordination with an \
independently running session is part of the task. These are the user's top-level sidebar sessions, \
not subagents."
    )]
    async fn session_list(
        &self,
        Parameters(params): Parameters<SessionListParams>,
    ) -> Result<CallToolResult, ErrorData> {
        call(SessionControlAction::List(ListAction {
            project: params.project,
            all: params.all,
        }))
        .await
    }

    #[tool(
        name = "session_launch",
        description = "Start a new Argmax session for an independent task and return its id. Use this \
when the user explicitly asks for a separate session or when the work needs its own independent, \
durable lifecycle that remains visible and steerable after your turn, such as a separate repository \
investigation or a long-running build. Keep bounded research, review, and implementation in the \
current chat using your provider's native subagents. The user-facing multitask flow is for work that \
should run alongside the chat. Do not use this merely for parallelism, fresh context, model choice, \
or context relief. A new session starts cold, so put everything it needs in the prompt. It is a \
top-level sidebar session, not a subagent. It is visible to the user, spends real tokens, and outlives \
your turn. Launches are capped at two levels deep and ten per session. Pass `project` for another \
registered project, `path` for an existing checkout of that project, and `worktree` plus optional \
`branch` to fork an isolated worktree from that ref."
    )]
    async fn session_launch(
        &self,
        Parameters(params): Parameters<SessionLaunchParams>,
    ) -> Result<CallToolResult, ErrorData> {
        let provider = match params.provider.as_deref().map(parse_provider).transpose() {
            Ok(provider) => provider,
            Err(message) => return Ok(CallToolResult::error(vec![ContentBlock::text(message)])),
        };
        let reasoning = match params.reasoning.as_deref().map(parse_reasoning).transpose() {
            Ok(reasoning) => reasoning,
            Err(message) => return Ok(CallToolResult::error(vec![ContentBlock::text(message)])),
        };
        let permission_mode = match params
            .permission_mode
            .as_deref()
            .map(parse_permission_mode)
            .transpose()
        {
            Ok(mode) => mode,
            Err(message) => return Ok(CallToolResult::error(vec![ContentBlock::text(message)])),
        };
        call(SessionControlAction::Launch(LaunchAction {
            prompt: params.prompt,
            project: params.project,
            worktree: params.worktree,
            path: params.path,
            branch: params.branch,
            provider,
            model: params.model,
            task_label: params.task_label,
            reasoning,
            permission_mode,
        }))
        .await
    }

    #[tool(
        name = "checks_run",
        description = "Run a workspace's check commands and return each one's status, exit code, \
and output tail. With no `command` it runs the project's configured checks in order and stops at \
the first failure. Takes an optional `session`, so you can check a workspace another session is \
working in as well as your own. Use it to make \"is this done\" evidence rather than prose — \
before reporting work finished, before deciding a session you launched has really landed its \
change, and before a goal claims a suite passes. A destructive command is refused outright."
    )]
    async fn checks_run(
        &self,
        Parameters(params): Parameters<ChecksRunParams>,
    ) -> Result<CallToolResult, ErrorData> {
        call(SessionControlAction::ChecksRun(ChecksRunAction {
            session: params.session,
            command: params.command,
            timeout_ms: params.timeout_ms,
        }))
        .await
    }

    #[tool(
        name = "workspace_status",
        description = "What Argmax knows about a checkout that a shell in it cannot say: whether \
it is an isolated worktree or a checkout the user also works in, the branch and the base it came \
from, how many files have changed, any pull request attributed to it with its check rollup, and \
whether archiving it would dispose of a worktree or only close the chat. Takes an optional \
`session`, which is the point: for your own tree `git status` already works, so reach for this to \
read a peer's workspace before you message, wait for, or duplicate its work."
    )]
    async fn workspace_status(
        &self,
        Parameters(params): Parameters<WorkspaceStatusParams>,
    ) -> Result<CallToolResult, ErrorData> {
        call(SessionControlAction::WorkspaceStatus(
            WorkspaceStatusAction {
                session: params.session,
            },
        ))
        .await
    }

    #[tool(
        name = "workspace_diff",
        description = "Read what a workspace has changed: the changed-file list with per-file \
line counts, plus the diff itself, capped in characters. Takes an optional `session` for a peer's \
workspace and an optional `file_path` to narrow it. `comparison` picks the baseline — uncommitted \
work, everything different from the base branch, or only what has been committed. A reply marked \
`truncated` is the cue to name a file, not to ask for more bytes."
    )]
    async fn workspace_diff(
        &self,
        Parameters(params): Parameters<WorkspaceDiffParams>,
    ) -> Result<CallToolResult, ErrorData> {
        let comparison = match params
            .comparison
            .as_deref()
            .map(parse_comparison)
            .transpose()
        {
            Ok(comparison) => comparison,
            Err(message) => return Ok(CallToolResult::error(vec![ContentBlock::text(message)])),
        };
        call(SessionControlAction::WorkspaceDiff(WorkspaceDiffAction {
            session: params.session,
            file_path: params.file_path,
            comparison,
            max_chars: params.max_chars,
        }))
        .await
    }

    #[tool(
        name = "learnings_add",
        description = "File one durable, non-obvious thing you learned about this repository, so \
the next agent in it does not pay for it again: a trap that cost you a failed attempt, a \
convention the code follows without saying so, an invocation that turned out to be the right one. \
It is project memory the user can see and edit, shared across every provider. Write a summary \
specific enough to be wrong. Skip task progress, anything the docs already answer clearly, and \
anything you are guessing at."
    )]
    async fn learnings_add(
        &self,
        Parameters(params): Parameters<LearningsAddParams>,
    ) -> Result<CallToolResult, ErrorData> {
        call(SessionControlAction::LearningsAdd(LearningsAddAction {
            kind: params.kind,
            summary: params.summary,
            project: params.project,
        }))
        .await
    }

    #[tool(
        name = "learnings_search",
        description = "Search this project's filed learnings — the pitfalls, conventions, and \
commands earlier sessions wrote down with learnings_add. Worth a call before you plan work in an \
unfamiliar part of the repo, and after a failure that smells like something someone has hit \
before. With no query it returns the project's most-used entries. Current code and docs win when \
they disagree with a learning; say so and file the correction."
    )]
    async fn learnings_search(
        &self,
        Parameters(params): Parameters<LearningsSearchParams>,
    ) -> Result<CallToolResult, ErrorData> {
        call(SessionControlAction::LearningsSearch(
            LearningsSearchAction {
                query: params.query,
                project: params.project,
                limit: params.limit,
            },
        ))
        .await
    }

    #[tool(
        name = "terminal_spawn",
        description = "Start a terminal in a workspace and optionally type a command into it. \
This is the only process you can start that outlives your turn: your own shell dies when the turn \
ends, so a dev server, a watcher, or a tunnel started from Bash is gone by the time you are asked \
about it. The PTY belongs to Argmax, and the user can see and type in it. Read it back with \
terminal_read; it keeps running until it exits or someone closes it."
    )]
    async fn terminal_spawn(
        &self,
        Parameters(params): Parameters<TerminalSpawnParams>,
    ) -> Result<CallToolResult, ErrorData> {
        call(SessionControlAction::TerminalSpawn(TerminalSpawnAction {
            session: params.session,
            command: params.command,
        }))
        .await
    }

    #[tool(
        name = "terminal_read",
        description = "Read a terminal's captured output, newest last, or — with no terminal_id — \
list what a workspace has running: each terminal's command, whether its shell is still up, and \
how it exited if not. Use the list to answer \"is something already serving here\" before \
starting a second one, and the read to see what a long-running process has logged since you last \
looked."
    )]
    async fn terminal_read(
        &self,
        Parameters(params): Parameters<TerminalReadParams>,
    ) -> Result<CallToolResult, ErrorData> {
        call(SessionControlAction::TerminalRead(TerminalReadAction {
            terminal_id: params.terminal_id,
            session: params.session,
            max_chars: params.max_chars,
        }))
        .await
    }

    #[tool(
        name = "project_list",
        description = "List every repository registered in Argmax, with its path, current and \
default branch, configured check commands, and how many sessions are active in it. session_list \
only reveals projects that already have open chats, so this is how you find out what else you \
could launch into, and which project name or path to pass to session_launch."
    )]
    async fn project_list(
        &self,
        Parameters(_params): Parameters<ProjectListParams>,
    ) -> Result<CallToolResult, ErrorData> {
        call(SessionControlAction::Projects(ProjectsAction {})).await
    }

    #[tool(
        name = "schedule_followup",
        description = "Wake this chat with a prompt at a time, once. Use it instead of blocking on \
session_wait or sleeping in a shell when what you are waiting for takes minutes and belongs to \
someone else: a CI run, a deploy, a review. Your turn ends, the user gets their chat back, and \
the prompt arrives as a fresh turn with this transcript intact. The scheduler looks every 30 \
seconds, so a wake is never early, and it never lands in the middle of a turn: a wake whose time \
passes while this chat is still working waits for it to finish rather than queueing behind what \
the user has typed. It appears in Scheduled Tasks, where the user can see and cancel it."
    )]
    async fn schedule_followup(
        &self,
        Parameters(params): Parameters<ScheduleFollowupParams>,
    ) -> Result<CallToolResult, ErrorData> {
        call(SessionControlAction::ScheduleFollowup(
            ScheduleFollowupAction {
                prompt: params.prompt,
                in_seconds: params.in_seconds,
                at: params.at,
                name: params.name,
            },
        ))
        .await
    }

    #[tool(
        name = "schedule_list",
        description = "Every scheduled task in a project: the wakes chats set with \
schedule_followup and the recurring routines the user wrote by hand, each with its prompt, cron \
expression or one-shot time, whether it is switched on, when it next runs, and how its last run \
went. This is where a schedule_cancel finds its id, and how you tell a task that is failing every \
night from one nobody turned on."
    )]
    async fn schedule_list(
        &self,
        Parameters(params): Parameters<ScheduleListParams>,
    ) -> Result<CallToolResult, ErrorData> {
        call(SessionControlAction::ScheduleList(ScheduleListAction {
            project: params.project,
        }))
        .await
    }

    #[tool(
        name = "schedule_cancel",
        description = "Stop a scheduled task from firing: deleted by default, or paused with \
disable so the user can switch it back on. Use it to drop a follow-up you no longer need — a wake \
you set to watch CI that has already gone green — and to turn off a routine when the user asks. \
Pause rather than delete anything the user wrote themselves unless they asked for it gone: a \
deleted task takes its prompt and its history with it. Only tasks in this chat's project can be \
cancelled."
    )]
    async fn schedule_cancel(
        &self,
        Parameters(params): Parameters<ScheduleCancelParams>,
    ) -> Result<CallToolResult, ErrorData> {
        call(SessionControlAction::ScheduleCancel(ScheduleCancelAction {
            schedule_id: params.schedule_id,
            disable: params.disable.unwrap_or(false),
        }))
        .await
    }

    #[tool(
        name = "schedule_resume",
        description = "Switch a paused scheduled task back on. Its next run is recomputed from \
now, so a recurring task picks up at its next occurrence instead of firing once for every run it \
slept through; a one-shot whose time has already passed runs on the next tick. Only tasks in this \
chat's project can be resumed."
    )]
    async fn schedule_resume(
        &self,
        Parameters(params): Parameters<ScheduleResumeParams>,
    ) -> Result<CallToolResult, ErrorData> {
        call(SessionControlAction::ScheduleResume(ScheduleResumeAction {
            schedule_id: params.schedule_id,
        }))
        .await
    }

    #[tool(
        name = "session_message",
        description = "Send a message into another Argmax session, as if the user had typed it \
        there. An idle session starts a turn on it. One that is mid-turn is flagged at its next \
        tool result and can collect the message mid-turn with inbox_read; otherwise it arrives \
        when that turn ends, which the result's `queued` field reports. You cannot message \
        yourself, and nothing comes back here — read the reply with session_read, or wait for one \
        with session_wait. Message other sessions on your own initiative when coordinating work \
        needs it."
    )]
    async fn session_message(
        &self,
        Parameters(params): Parameters<SessionMessageParams>,
    ) -> Result<CallToolResult, ErrorData> {
        call(SessionControlAction::Message(MessageAction {
            session_id: params.session,
            message: params.message,
        }))
        .await
    }

    #[tool(
        name = "session_status",
        description = "Look at one Argmax session without reading its transcript: its state, how \
many seconds its current turn has been running, its most recent answer (capped), how many messages \
are waiting unread in its inbox, and which session launched it. Use it to check on a session you \
launched before deciding whether to wait, message, or stop it."
    )]
    async fn session_status(
        &self,
        Parameters(params): Parameters<SessionStatusParams>,
    ) -> Result<CallToolResult, ErrorData> {
        call(SessionControlAction::Status(StatusAction {
            session_id: params.session,
        }))
        .await
    }

    #[tool(
        name = "session_read",
        description = "Read another session's conversation: the prompts it was given, the answers \
it gave, and its tool calls as one-line summaries. Returns a page of entries plus a `nextCursor` — \
pass that cursor back to read only what has happened since. A page is capped in bytes and reports \
`truncated` when there is more to fetch. This is how you find out what a session you launched \
actually did."
    )]
    async fn session_read(
        &self,
        Parameters(params): Parameters<SessionReadParams>,
    ) -> Result<CallToolResult, ErrorData> {
        call(SessionControlAction::Read(ReadAction {
            session_id: params.session,
            cursor: params.cursor,
            max_chars: params.max_chars,
        }))
        .await
    }

    #[tool(
        name = "session_stop",
        description = "Stop another session's running turn, the same way the user's Stop button \
does: the provider process is killed and the session goes to `cancelled`. Its transcript and \
workspace stay. Use it when a session you launched is stuck or no longer needed — and to \
interrupt one: a session_message sent after a stop starts a fresh turn straight away instead of \
queueing behind the turn you cut short, so stop then message is how you redirect an agent that is \
working on the wrong thing. The redirected session keeps its transcript, so say what changed \
rather than repeating the whole task. You cannot stop yourself."
    )]
    async fn session_stop(
        &self,
        Parameters(params): Parameters<SessionStopParams>,
    ) -> Result<CallToolResult, ErrorData> {
        call(SessionControlAction::Stop(StopAction {
            session_id: params.session,
        }))
        .await
    }

    #[tool(
        name = "inbox_read",
        description = "Collect the messages other sessions have addressed to you and have not been \
        handed over yet — each with who sent it, whether it is a plain message or the automatic notice that \
        a session you launched has finished, and when it arrived. Reading them marks them collected, so a \
        second call returns only what has arrived since; a batch too large for one reply comes back over \
        several calls. Messages also reach you as ordinary turns when you \
        are idle; this is how you see the ones that landed while you were working. Every other argmax tool \
        result carries an unread-inbox note when something is waiting here, so you can collect mail \
        mid-turn without ending your current turn."
    )]
    async fn inbox_read(
        &self,
        Parameters(_params): Parameters<InboxReadParams>,
    ) -> Result<CallToolResult, ErrorData> {
        call(SessionControlAction::Inbox(InboxAction {})).await
    }

    #[tool(
        name = "goal_set",
        description = "Set the condition this session should keep working toward. After every \
turn a separate model reads the transcript and judges whether the condition holds; while it does \
not, you are handed another turn automatically with its reason as guidance, until it holds, it is \
judged impossible, or the turn budget runs out. Set one when the user describes work with a \
verifiable end state — a suite that must pass, a migration that must finish, a queue that must \
empty — rather than a single edit. Write the condition so your own output can demonstrate it: the \
evaluator has no tools and only sees what you actually showed, so work you claim without evidence \
does not count. Setting a goal replaces any goal already on this session."
    )]
    async fn goal_set(
        &self,
        Parameters(params): Parameters<GoalSetParams>,
    ) -> Result<CallToolResult, ErrorData> {
        call(SessionControlAction::GoalSet(GoalSetAction {
            condition: params.condition,
            max_turns: params.max_turns,
        }))
        .await
    }

    #[tool(
        name = "goal_clear",
        description = "Drop this session's goal, so turns stop being handed to you automatically. \
Use it when the user changes direction, or when you judge the condition no longer worth pursuing. \
It reports the condition it ended, or that there was none."
    )]
    async fn goal_clear(
        &self,
        Parameters(_params): Parameters<GoalClearParams>,
    ) -> Result<CallToolResult, ErrorData> {
        call(SessionControlAction::GoalClear).await
    }

    #[tool(
        name = "session_wait",
        description = "Block until a session you are watching finishes or a message arrives for \
you, then return what happened. With no arguments it watches every session you launched and waits \
up to two minutes. It returns as soon as any watched session reaches complete, failed, or \
cancelled — reporting each one's id and state — and/or with the messages that arrived, which it \
also marks collected. The argument-less form hands you each finish once, so calling it again \
after collecting one child waits for the next one instead of repeating that child; name ids in \
`sessions` to re-read a session you have already been told about. A wait that runs out returns \
`{timed_out: true}`; call it again to keep waiting. This is the tool that makes launching a \
session useful: launch, wait, then session_read its answer."
    )]
    async fn session_wait(
        &self,
        Parameters(params): Parameters<SessionWaitParams>,
    ) -> Result<CallToolResult, ErrorData> {
        call(SessionControlAction::Wait(WaitAction {
            sessions: params.sessions,
            timeout_s: params.timeout_s,
        }))
        .await
    }

    #[tool(
        name = "workspace_archive",
        description = "Close this chat's workspace when the current turn ends: an isolated \
worktree moves into Argmax's archive location with its files and local branch intact, and \
the chat leaves the sidebar. Like session_move it is scheduled rather than immediate, because \
archiving stops every agent in the workspace — including you — so call it as your last action \
and write your report after it. Use it once the work has actually landed, typically after a \
pull request is merged and its branch is deleted; that is what keeps merged worktrees from \
piling up on disk. A workspace with uncommitted changes is kept instead of archived, so say \
the archive is requested rather than done. A shared checkout is never deleted — archiving one \
only ends the chat."
    )]
    async fn workspace_archive(
        &self,
        Parameters(_params): Parameters<WorkspaceArchiveParams>,
    ) -> Result<CallToolResult, ErrorData> {
        call(SessionControlAction::Archive(ArchiveAction {})).await
    }

    #[tool(
        name = "session_rename",
        description = "Rename this session's sidebar label once you know what the work is. The \
row is what the user scans across open chats, so a long opening prompt often makes a poor name. \
Only this chat can be renamed — to name a child session, pass task_label to session_launch \
instead. Returns the label that landed and the one it replaced."
    )]
    async fn session_rename(
        &self,
        Parameters(params): Parameters<SessionRenameParams>,
    ) -> Result<CallToolResult, ErrorData> {
        call(SessionControlAction::Rename(RenameAction {
            task_label: params.task_label,
        }))
        .await
    }

    #[tool(
        name = "session_move",
        description = "Move this session to a different checkout and carry on working there: \
another registered project (`project`), or another worktree of the project you are already in \
(`path`). Pass exactly one. Reach for `path` whenever the work belongs in a different worktree — \
running `cd` instead only moves your shell, so the workspace card, its diff, and its commit and \
pull-request actions all keep pointing at the checkout you started in, and your next turn starts \
back there. The move is scheduled: it runs once the current turn settles, carries the transcript \
over, and archives the source workspace unless keep_source is set. Your `prompt` then starts your \
first turn in the destination, so call this as the last action of a turn."
    )]
    async fn session_move(
        &self,
        Parameters(params): Parameters<SessionMoveParams>,
    ) -> Result<CallToolResult, ErrorData> {
        call(SessionControlAction::Move(MoveAction {
            project: params.project,
            path: params.path,
            prompt: params.prompt,
            worktree: params.worktree,
            keep_source: params.keep_source,
        }))
        .await
    }
}

impl Default for ArgmaxTools {
    fn default() -> Self {
        Self::new()
    }
}

fn parse_provider(value: &str) -> Result<crate::providers::ProviderId, String> {
    serde_json::from_value(serde_json::json!(value)).map_err(|_| {
        format!(
            "'{value}' is not an Argmax provider. Use claude, codex, cursor, opencode, or grok."
        )
    })
}

fn parse_reasoning(value: &str) -> Result<crate::providers::ReasoningEffort, String> {
    serde_json::from_value(serde_json::json!(value)).map_err(|_| {
        format!("'{value}' is not a reasoning level. Use low, medium, high, xhigh, max, or ultra.")
    })
}

fn parse_permission_mode(value: &str) -> Result<crate::providers::PermissionMode, String> {
    serde_json::from_value(serde_json::json!(value)).map_err(|_| {
        format!(
            "'{value}' is not a permission mode. Use auto-approve, ask-each-time, or provider-defaults."
        )
    })
}

fn parse_comparison(value: &str) -> Result<crate::review::git_review::ReviewComparison, String> {
    serde_json::from_value(serde_json::json!(value)).map_err(|_| {
        format!("'{value}' is not a diff baseline. Use workingTree, branch, or committed.")
    })
}

/// One socket round trip, off the async runtime because the client is
/// blocking, with the response handed back as the JSON the agent reads. When
/// the app flags unread inbox mail, a second content block says so — the one
/// way to reach an agent that is mid-turn, at the tool boundary it is already
/// reading.
#[cfg(unix)]
async fn call(action: SessionControlAction) -> Result<CallToolResult, ErrorData> {
    let outcome = tokio::task::spawn_blocking(move || {
        crate::session_control::send_session_control(action).map(|response| {
            (
                serde_json::to_string(&response.result),
                response.unread_inbox,
            )
        })
    })
    .await
    .map_err(|error| ErrorData::internal_error(format!("the tool call panicked: {error}"), None))?;
    match outcome {
        Ok((Ok(json), unread_inbox)) => {
            let mut blocks = vec![ContentBlock::text(json)];
            if let Some(count) = unread_inbox.filter(|count| *count > 0) {
                blocks.push(ContentBlock::text(inbox_notice(count)));
            }
            Ok(CallToolResult::success(blocks))
        }
        Ok((Err(error), _)) => Err(ErrorData::internal_error(
            format!("could not encode the response: {error}"),
            None,
        )),
        // A refused action (a launch past the depth cap, an unknown project) is
        // the agent's to read and act on, not a transport failure.
        Err(error) => Ok(CallToolResult::error(vec![ContentBlock::text(format!(
            "{}: {}",
            error.code, error.message
        ))])),
    }
}

/// The mid-turn mail flag, as the agent reads it. Every session tool result
/// can carry it; `inbox_read` is how the agent answers it, without waiting
/// for its turn to end.
pub(super) fn inbox_notice(count: i64) -> String {
    let plural = if count == 1 { "" } else { "s" };
    format!(
        "{count} message{plural} from other sessions \
are waiting unread in your Argmax inbox. Call inbox_read to collect \
them mid-turn, without ending your current turn."
    )
}

#[cfg(not(unix))]
async fn call(_action: SessionControlAction) -> Result<CallToolResult, ErrorData> {
    Err(ErrorData::internal_error(
        "Argmax session control is not supported on this platform".to_string(),
        None,
    ))
}

#[cfg(test)]
mod tests {
    use super::SessionLaunchParams;

    #[test]
    fn launch_permission_mode_uses_the_public_camel_case_name() {
        let params: SessionLaunchParams = serde_json::from_value(serde_json::json!({
            "prompt": "Review this",
            "permissionMode": "ask-each-time"
        }))
        .expect("public tool arguments");
        assert_eq!(params.permission_mode.as_deref(), Some("ask-each-time"));

        // Keep accepting the Rust-shaped spelling for old generated clients.
        let compatible: SessionLaunchParams = serde_json::from_value(serde_json::json!({
            "prompt": "Review this",
            "permission_mode": "auto-approve"
        }))
        .expect("legacy tool arguments");
        assert_eq!(compatible.permission_mode.as_deref(), Some("auto-approve"));
    }
}
