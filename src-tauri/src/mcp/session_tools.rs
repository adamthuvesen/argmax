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
    LaunchAction, ListAction, MessageAction, MoveAction, SessionControlAction,
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
    /// Create an isolated worktree in the destination instead of using its
    /// shared checkout.
    #[serde(default)]
    pub worktree: bool,
    /// Keep the source workspace open instead of archiving it after the move.
    #[serde(default)]
    pub keep_source: bool,
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
there. An idle session starts a turn on it; one that is mid-turn receives it when that turn ends, \
which the result's `queued` field reports. You cannot message yourself, and nothing comes back \
here — read the reply with session_list and the session's own transcript, or let the user watch it. \
Message other sessions on your own initiative when coordinating work needs it."
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
        name = "session_move",
        description = "Move this session to a different registered project. The move is scheduled: \
it runs once the current turn settles, carries the transcript over, and archives the source \
workspace unless keep_source is set. Use it when the work turns out to belong in another repository."
    )]
    async fn session_move(
        &self,
        Parameters(params): Parameters<SessionMoveParams>,
    ) -> Result<CallToolResult, ErrorData> {
        call(SessionControlAction::Move(MoveAction {
            project: params.project,
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
/// blocking, with the response handed back as the JSON the agent reads.
#[cfg(unix)]
async fn call(action: SessionControlAction) -> Result<CallToolResult, ErrorData> {
    let outcome = tokio::task::spawn_blocking(move || {
        crate::session_control::send_session_control(action)
            .map(|response| serde_json::to_string(&response.result))
    })
    .await
    .map_err(|error| ErrorData::internal_error(format!("the tool call panicked: {error}"), None))?;
    match outcome {
        Ok(Ok(json)) => Ok(CallToolResult::success(vec![ContentBlock::text(json)])),
        Ok(Err(error)) => Err(ErrorData::internal_error(
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

#[cfg(not(unix))]
async fn call(_action: SessionControlAction) -> Result<CallToolResult, ErrorData> {
    Err(ErrorData::internal_error(
        "Argmax session control is not supported on this platform".to_string(),
        None,
    ))
}
