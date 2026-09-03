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
    InboxAction, LaunchAction, ListAction, MessageAction, MoveAction, ReadAction,
    SessionControlAction, StatusAction, StopAction, WaitAction,
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
    #[serde(default)]
    pub worktree: bool,
    /// Sidebar label for the new session. Defaults to the prompt's first line.
    pub task_label: Option<String>,
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
    /// must be a different project from the current one.
    pub project: String,
    /// What to do once you are there. It becomes your first turn in the
    /// destination, where the CLI starts cold and sees only the last few turns
    /// of this transcript, so write it to stand on its own.
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
activity first. Start here when you need a session id to message. Use it on your own initiative \
whenever the task needs it; these are the user's top-level sidebar sessions, not subagents."
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
        description = "Start a new Argmax session on a task of its own and return its id. Use it to \
parallelize work that does not need your context — a separate investigation, a second repository, \
a long build — then message or list it to follow up. The new session starts cold, so put \
everything it needs in the prompt. Launch on your own initiative when the task calls for it, \
without asking first — but a launched session is a top-level session in the user's sidebar, not a \
subagent: it is visible, it spends real tokens, and it outlives your turn. Launches are capped at \
two levels deep and ten per session."
    )]
    async fn session_launch(
        &self,
        Parameters(params): Parameters<SessionLaunchParams>,
    ) -> Result<CallToolResult, ErrorData> {
        let provider = match params.provider.as_deref().map(parse_provider).transpose() {
            Ok(provider) => provider,
            Err(message) => return Ok(CallToolResult::error(vec![ContentBlock::text(message)])),
        };
        call(SessionControlAction::Launch(LaunchAction {
            prompt: params.prompt,
            project: params.project,
            worktree: params.worktree,
            provider,
            model: params.model,
            task_label: params.task_label,
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
        name = "session_wait",
        description = "Block until a session you are watching finishes or a message arrives for \
you, then return what happened. With no arguments it watches every session you launched and waits \
up to two minutes. It returns as soon as any watched session reaches complete, failed, or \
cancelled — reporting each one's id and state — and/or with the messages that arrived, which it \
also marks collected. A wait that runs out returns `{timed_out: true}`; call it again to keep \
waiting. This is the tool that makes launching a session useful: launch, wait, then session_read \
its answer."
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
        name = "session_move",
        description = "Move this session to a different registered project and carry on working \
there. The move is scheduled: it runs once the current turn settles, carries the transcript over, \
and archives the source workspace unless keep_source is set. Your `prompt` then starts your first \
turn in the destination checkout, so call this as the last action of a turn. Use it when the work \
turns out to belong in another repository."
    )]
    async fn session_move(
        &self,
        Parameters(params): Parameters<SessionMoveParams>,
    ) -> Result<CallToolResult, ErrorData> {
        call(SessionControlAction::Move(MoveAction {
            project: params.project,
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
