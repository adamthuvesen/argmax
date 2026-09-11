use serde::{Deserialize, Serialize};

use super::PROTOCOL_VERSION;
use crate::mcp::browser_bridge::{BrowserOutcome, BrowserRequest};
use crate::sessions::{attention::AttentionState, state::SessionState};

/// One request on the session-control socket.
///
/// This is the whole wire protocol: the `argmax session …` CLI and the
/// `argmax mcp` tools both build a [`SessionControlAction`] and hand it to
/// [`send_session_control`](super::send_session_control), and the socket
/// handler matches on the same enum.
/// Each action carries exactly the fields it uses, so a nonsense combination
/// (a project selector on a message, a prompt on a move) cannot be encoded.
#[derive(Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionControlRequest {
    pub version: u32,
    pub token: String,
    pub action: SessionControlAction,
}

#[derive(Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "kebab-case", deny_unknown_fields)]
pub enum SessionControlAction {
    Launch(LaunchAction),
    Move(MoveAction),
    Archive(ArchiveAction),
    List(ListAction),
    Message(MessageAction),
    /// Drive the in-app browser. The MCP process has no `AppHandle`, so the
    /// tools send the action here and the app runs it — see
    /// [`crate::mcp::browser_bridge`].
    Browser(BrowserRequest),
    Status(StatusAction),
    Read(ReadAction),
    Stop(StopAction),
    Inbox(InboxAction),
    Wait(WaitAction),
    GoalSet(GoalSetAction),
    GoalClear,
    Rename(RenameAction),
    ChecksRun(ChecksRunAction),
    WorkspaceStatus(WorkspaceStatusAction),
    WorkspaceDiff(WorkspaceDiffAction),
    LearningsAdd(LearningsAddAction),
    LearningsSearch(LearningsSearchAction),
    TerminalSpawn(TerminalSpawnAction),
    TerminalRead(TerminalReadAction),
    Projects(ProjectsAction),
    ScheduleFollowup(ScheduleFollowupAction),
    ScheduleList(ScheduleListAction),
    ScheduleCancel(ScheduleCancelAction),
    ScheduleResume(ScheduleResumeAction),
}

/// Which session an inspection is about. Every session-addressable action
/// carries this and nothing else: omitting it means the caller's own session,
/// which is the only one it can name without first listing.
#[derive(Debug, Default, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ChecksRunAction {
    #[serde(default)]
    pub session: Option<String>,
    /// One command to run. Omitted, the project's configured check commands
    /// run in order and the first failure stops the run.
    #[serde(default)]
    pub command: Option<String>,
    #[serde(default)]
    pub timeout_ms: Option<u64>,
}

#[derive(Debug, Default, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkspaceStatusAction {
    #[serde(default)]
    pub session: Option<String>,
}

/// A bounded read of what a workspace has changed. `file_path` narrows it to
/// one file; without it the reply is the changed-file list plus as much of the
/// combined diff as the character budget allows.
#[derive(Debug, Default, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkspaceDiffAction {
    #[serde(default)]
    pub session: Option<String>,
    #[serde(default)]
    pub file_path: Option<String>,
    /// `workingTree` (default), `branch`, or `committed`.
    #[serde(default)]
    pub comparison: Option<crate::review::git_review::ReviewComparison>,
    #[serde(default)]
    pub max_chars: Option<u32>,
}

#[derive(Debug, Default, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LearningsAddAction {
    /// `pitfall`, `convention`, or `command`.
    pub kind: String,
    pub summary: String,
    /// Project to file it under. Defaults to the caller's own project.
    #[serde(default)]
    pub project: Option<String>,
}

#[derive(Debug, Default, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LearningsSearchAction {
    /// Free text. Empty returns the project's most-used learnings instead.
    #[serde(default)]
    pub query: Option<String>,
    #[serde(default)]
    pub project: Option<String>,
    #[serde(default)]
    pub limit: Option<u32>,
}

/// Start a PTY in a workspace that outlives this turn. `command` is typed into
/// the shell, so a dev server keeps running after the turn ends.
#[derive(Debug, Default, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TerminalSpawnAction {
    #[serde(default)]
    pub session: Option<String>,
    #[serde(default)]
    pub command: Option<String>,
}

/// Read a terminal's output, or list what is running in a workspace when no
/// terminal is named.
#[derive(Debug, Default, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TerminalReadAction {
    #[serde(default)]
    pub terminal_id: Option<String>,
    #[serde(default)]
    pub session: Option<String>,
    #[serde(default)]
    pub max_chars: Option<u32>,
}

/// No arguments: every registered project, whether or not it has open chats.
#[derive(Debug, Default, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProjectsAction {}

/// Wake this session with a prompt at a time. One-shot, and always aimed at
/// the caller: a follow-up is how a chat waits for CI without polling.
#[derive(Debug, Default, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ScheduleFollowupAction {
    pub prompt: String,
    /// Seconds from now. Mutually exclusive with `at`.
    #[serde(default)]
    pub in_seconds: Option<u64>,
    /// RFC 3339 instant. Mutually exclusive with `in_seconds`.
    #[serde(default)]
    pub at: Option<String>,
    /// Sidebar name for the scheduled task. Defaults to the prompt's first line.
    #[serde(default)]
    pub name: Option<String>,
}

/// Every scheduled task in one project: the wakes this chat set, and the
/// routines the user wrote by hand. Reading them is how a cancel finds an id.
#[derive(Debug, Default, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ScheduleListAction {
    /// Project name, id, or path. Omitted, the caller's own project.
    #[serde(default)]
    pub project: Option<String>,
}

/// Switch a paused scheduled task back on. Its next run is recomputed from
/// now, so a recurring task resumes at its next occurrence.
#[derive(Debug, Default, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ScheduleResumeAction {
    pub schedule_id: String,
}

/// Stop one scheduled task from firing, by pausing or deleting it.
#[derive(Debug, Default, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ScheduleCancelAction {
    pub schedule_id: String,
    /// Pause rather than delete: the row stays in Scheduled Tasks with its
    /// prompt and schedule intact, and the user can switch it back on.
    #[serde(default)]
    pub disable: bool,
}

/// Start a new top-level session. Provider and model default to the calling
/// session's own, so an agent that names neither gets a peer of itself.
#[derive(Debug, Default, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LaunchAction {
    pub prompt: String,
    #[serde(default)]
    pub project: Option<String>,
    #[serde(default)]
    pub worktree: bool,
    /// Existing checkout of the target project. Any directory
    /// `git worktree list` reports for it, including the main one.
    /// Mutually exclusive with `worktree`.
    #[serde(default)]
    pub path: Option<String>,
    /// Git ref the new session should work from. With `worktree`, the isolated
    /// worktree forks from this ref. With `path`, the checkout must already be
    /// on this branch.
    #[serde(default)]
    pub branch: Option<String>,
    #[serde(default)]
    pub provider: Option<crate::providers::ProviderId>,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub task_label: Option<String>,
    /// Thinking effort for a model that takes one. Defaults to the calling
    /// session's own.
    #[serde(default)]
    pub reasoning: Option<crate::providers::ReasoningEffort>,
    /// How the new session answers permission prompts. Defaults to the
    /// calling session's own, which is auto-approve unless the user changed it.
    #[serde(default)]
    pub permission_mode: Option<crate::providers::PermissionMode>,
}

#[derive(Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MoveAction {
    /// Another registered project to move to. Mutually exclusive with `path`.
    #[serde(default)]
    pub project: Option<String>,
    /// An existing checkout of the current project to move to — any directory
    /// `git worktree list` reports for it. Mutually exclusive with `project`.
    #[serde(default)]
    pub path: Option<String>,
    /// The turn the destination chat opens with. A move relocates work in
    /// progress, so the destination has to be told what to pick up there.
    pub prompt: String,
    #[serde(default)]
    pub worktree: bool,
    #[serde(default)]
    pub keep_source: bool,
}

/// No arguments: a session may only archive the workspace it is running in.
/// Archiving someone else's checkout out from under them is not an agent's
/// call, and the caller's own is the one it can reason about.
#[derive(Debug, Default, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ArchiveAction {}

#[derive(Debug, Default, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ListAction {
    #[serde(default)]
    pub project: Option<String>,
    #[serde(default)]
    pub all: bool,
}

#[derive(Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MessageAction {
    pub session_id: String,
    pub message: String,
}

/// What one session looks like right now, without reading its transcript.
#[derive(Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StatusAction {
    pub session_id: String,
}

/// The normalized timeline since a cursor. `cursor` is the `nextCursor` a
/// previous read returned; omitting it starts from the beginning.
#[derive(Debug, Default, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReadAction {
    pub session_id: String,
    #[serde(default)]
    pub cursor: Option<i64>,
    #[serde(default)]
    pub max_chars: Option<u32>,
}

#[derive(Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StopAction {
    pub session_id: String,
}

/// No arguments: an inbox read is always the caller's own.
#[derive(Debug, Default, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InboxAction {}

/// Rename the calling session's sidebar label. There is no target argument:
/// only this chat's workspace may be renamed, the same way `ArchiveAction`
/// and `GoalSetAction` are scoped to the caller.
#[derive(Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RenameAction {
    pub task_label: String,
}

/// Block until a watched session settles or a message arrives. With no
/// `sessions`, the watch list is every session this caller has launched.
#[derive(Debug, Default, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WaitAction {
    #[serde(default)]
    pub sessions: Option<Vec<String>>,
    #[serde(default)]
    pub timeout_s: Option<u64>,
}

/// The response to one request. `result` is flattened, so a launch reads
/// `{"version":1,"launched":{…}}`, a list `{"version":1,"listed":{…}}`, and a
/// failure `{"version":1,"error":{…}}`.
#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionControlResponse {
    pub version: u32,
    #[serde(flatten)]
    pub result: SessionControlResult,
    /// How much inbox mail is still undelivered to the calling session once
    /// this action has run. A running agent cannot be pushed into, but it
    /// reads every tool result — this is the one channel that reaches it
    /// mid-turn, so the tool client surfaces it as an extra note pointing at
    /// `inbox_read`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub unread_inbox: Option<i64>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum SessionControlResult {
    Launched(LaunchedSession),
    Scheduled(ScheduledMove),
    Archiving(ScheduledArchive),
    Listed(SessionList),
    Messaged(MessageDelivery),
    Browsed(BrowserOutcome),
    Status(SessionStatus),
    Read(SessionRead),
    Stopped(SessionStopped),
    Inbox(InboxDelivery),
    Waited(WaitOutcome),
    Goal(GoalOutcome),
    Renamed(SessionRenamed),
    Checked(ChecksOutcome),
    WorkspaceStatus(WorkspaceStatusOutcome),
    WorkspaceDiff(WorkspaceDiffOutcome),
    Learned(LearningRecord),
    LearningsFound(LearningsSearchOutcome),
    TerminalStarted(TerminalStarted),
    TerminalOutput(TerminalOutput),
    Projects(ProjectListOutcome),
    Followup(ScheduledFollowup),
    Schedules(ScheduleListOutcome),
    ScheduleCancelled(ScheduleCancelled),
    ScheduleResumed(ScheduleResumed),
    Error(SessionControlError),
}

/// One check command's result, as the runner recorded it.
#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CheckOutcome {
    pub command: String,
    /// `passed`, `failed`, or `cancelled` (which covers a timeout).
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<i64>,
    /// The tail of stdout and stderr, as the checks panel shows it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ChecksOutcome {
    pub session_id: String,
    pub workspace_id: String,
    /// True only when every command ran and passed.
    pub passed: bool,
    pub checks: Vec<CheckOutcome>,
}

/// What Argmax knows about a checkout that `git status` in it cannot say.
#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkspaceStatusOutcome {
    pub session_id: String,
    pub workspace_id: String,
    pub project_id: String,
    pub project_name: String,
    pub task_label: String,
    pub path: String,
    pub branch: String,
    pub base_ref: String,
    /// False for an isolated worktree Argmax created and can archive; true for
    /// a checkout the user also works in, which archiving never deletes.
    pub shared_checkout: bool,
    pub state: String,
    pub dirty: bool,
    pub changed_files: i64,
    /// Whether `workspace_archive` on this workspace would dispose of a
    /// worktree, rather than only closing the chat.
    pub archivable: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pr_number: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pr_state: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pr_check_state: Option<String>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ChangedFile {
    pub path: String,
    pub status: String,
    pub additions: usize,
    pub deletions: usize,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkspaceDiffOutcome {
    pub session_id: String,
    pub workspace_id: String,
    pub comparison: crate::review::git_review::ReviewComparison,
    pub files: Vec<ChangedFile>,
    pub diff: String,
    /// True when the character budget cut the diff short; narrow it with
    /// `file_path` rather than asking for more.
    pub truncated: bool,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LearningRecord {
    pub id: String,
    pub project_id: String,
    pub kind: String,
    pub summary: String,
    pub verified: bool,
    pub hits: i64,
    pub created_at: String,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LearningsSearchOutcome {
    pub project_id: String,
    pub learnings: Vec<LearningRecord>,
    pub truncated: bool,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TerminalStarted {
    pub terminal_id: String,
    pub session_id: String,
    pub workspace_id: String,
    pub path: String,
    /// The command line that was typed into the shell, when one was given.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub command: Option<String>,
}

/// One PTY in a workspace. `running` is false once its shell has exited, which
/// is how "is the dev server still up" is answered.
#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TerminalSummary {
    pub terminal_id: String,
    pub running: bool,
    pub started_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub command: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<i32>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TerminalOutput {
    pub workspace_id: String,
    /// Every terminal this workspace has, newest first.
    pub terminals: Vec<TerminalSummary>,
    /// The terminal `output` came from, when one was read.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub terminal_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output: Option<String>,
    /// True when older output was dropped to fit the budget.
    pub truncated: bool,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProjectEntry {
    pub project_id: String,
    pub name: String,
    pub repo_path: String,
    pub current_branch: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default_branch: Option<String>,
    /// The commands `checks_run` runs when it is given no command.
    pub check_commands: Vec<String>,
    pub active_sessions: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub latest_activity_at: Option<String>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProjectListOutcome {
    pub projects: Vec<ProjectEntry>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ScheduledFollowup {
    pub followup_id: String,
    pub session_id: String,
    pub name: String,
    /// When the prompt lands, RFC 3339. The scheduler ticks every 30 seconds,
    /// so a wake can be that much late but never early.
    pub run_at: String,
}

/// One scheduled task as an agent reads it. `sessionId` is the chat a
/// same-chat task fires into: equal to the caller's own id, this row is a
/// wake that chat set for itself.
#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ScheduleEntry {
    pub schedule_id: String,
    pub name: String,
    pub prompt: String,
    pub enabled: bool,
    /// Exactly one of the two: a cron expression for a recurring task, or an
    /// RFC 3339 instant for a one-shot.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cron_expr: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub run_once_at: Option<String>,
    /// `new_session`, `same_session`, or `worktree`.
    pub run_target: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next_run_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_run_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_error: Option<String>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ScheduleListOutcome {
    pub project_id: String,
    pub schedules: Vec<ScheduleEntry>,
    pub truncated: bool,
}

/// What a cancel left behind. `deleted` separates the two endings: the row is
/// gone, or it is still there and switched off.
#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ScheduleCancelled {
    pub schedule_id: String,
    pub name: String,
    pub deleted: bool,
}

/// What a resume left behind. `nextRunAt` is absent for a recurring schedule
/// with no future occurrence left.
#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ScheduleResumed {
    pub schedule_id: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next_run_at: Option<String>,
}

/// Attach a completion condition to the calling session. The condition is the
/// whole configuration — see [`crate::goals`].
#[derive(Debug, Default, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GoalSetAction {
    pub condition: String,
    #[serde(default)]
    pub max_turns: Option<u32>,
}

/// What a goal tool leaves behind. `condition` is absent when a clear found no
/// goal to end, which is how the caller tells "stopped one" from "there was
/// none".
#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GoalOutcome {
    pub active: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub goal_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub condition: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_turns: Option<u32>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LaunchedSession {
    pub session_id: String,
    pub workspace_id: String,
    pub project_id: String,
    pub project_name: String,
    pub path: String,
    pub branch: String,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ScheduledMove {
    pub scheduled: bool,
    pub source_session_id: String,
    pub project_id: String,
    pub project_name: String,
    /// Set for a checkout move: the directory the chat is headed for.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ScheduledArchive {
    pub scheduled: bool,
    pub session_id: String,
    pub workspace_id: String,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionList {
    pub sessions: Vec<SessionListEntry>,
    pub truncated: bool,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionRenamed {
    pub session_id: String,
    pub workspace_id: String,
    pub task_label: String,
    pub previous_task_label: String,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MessageDelivery {
    pub session_id: String,
    /// True when the target was mid-turn and the message waits for turn end.
    pub queued: bool,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionListEntry {
    pub session_id: String,
    pub project_id: String,
    pub project_name: String,
    pub task_label: String,
    pub provider: String,
    pub state: SessionState,
    /// Whether a person needs to look at this session, and why. Anything but
    /// `normal` is waiting on a human: an approval, an unanswered question, a
    /// failure, or a finished turn nobody has reviewed.
    pub attention: AttentionState,
    pub last_activity_at: String,
    /// The session that launched this one, when an agent did.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub launched_by_session_id: Option<String>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionStatus {
    pub session_id: String,
    pub task_label: String,
    pub provider: String,
    pub model_id: String,
    pub state: SessionState,
    /// Whether a person needs to look at this session, and why — see
    /// [`SessionListEntry::attention`].
    pub attention: AttentionState,
    /// Seconds since the current turn's prompt landed. `None` once the session
    /// has settled — there is no turn running to age.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub turn_age_seconds: Option<i64>,
    pub last_activity_at: String,
    /// The session's most recent visible answer, capped.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_assistant_text: Option<String>,
    /// Messages addressed to this session that no one has collected yet.
    pub unread_inbox: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub launched_by_session_id: Option<String>,
    pub launch_depth: i64,
}

/// One normalized timeline row. `kind` is what the chat shows it as, not the
/// provider's own event name.
#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReadEntry {
    pub at: String,
    pub kind: String,
    pub text: String,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionRead {
    pub session_id: String,
    pub entries: Vec<ReadEntry>,
    /// Feed this back as `cursor` to read only what arrives after these rows.
    pub next_cursor: i64,
    /// True when the byte cap cut the page short; read again from
    /// `next_cursor` for the rest.
    pub truncated: bool,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionStopped {
    pub session_id: String,
    pub state: SessionState,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InboxMessage {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub from_session_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub from_label: Option<String>,
    pub kind: String,
    pub body: String,
    pub created_at: String,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InboxDelivery {
    pub messages: Vec<InboxMessage>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WaitedSession {
    pub session_id: String,
    pub task_label: String,
    pub state: SessionState,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WaitOutcome {
    /// True when nothing happened before the timeout. Both lists are empty.
    pub timed_out: bool,
    /// Watched sessions that have settled.
    pub sessions: Vec<WaitedSession>,
    /// Messages that arrived for the caller, already marked delivered.
    pub messages: Vec<InboxMessage>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionControlError {
    pub code: String,
    pub message: String,
}

impl SessionControlResponse {
    pub(super) fn new(result: SessionControlResult) -> Self {
        Self {
            version: PROTOCOL_VERSION,
            result,
            unread_inbox: None,
        }
    }

    pub(super) fn failure(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self::new(SessionControlResult::Error(SessionControlError {
            code: code.into(),
            message: message.into(),
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::providers::ProviderId;
    use crate::session_control::server::{read_json_line, Frame};
    use crate::session_control::MAX_REQUEST_BYTES;

    #[test]
    fn a_move_action_accepts_either_destination_on_the_wire() {
        // What an agent's `session_move` call actually deserializes into.
        let by_path: MoveAction =
            serde_json::from_str(r#"{"path":"/repo/worktrees/feature","prompt":"Carry on here"}"#)
                .expect("path-only move");
        assert_eq!(by_path.path.as_deref(), Some("/repo/worktrees/feature"));
        assert_eq!(by_path.project, None);

        let by_project: MoveAction =
            serde_json::from_str(r#"{"project":"Other","prompt":"Port the fix"}"#)
                .expect("project-only move");
        assert_eq!(by_project.project.as_deref(), Some("Other"));
        assert_eq!(by_project.path, None);
    }

    #[test]
    fn request_rejects_unknown_fields_and_requires_newline() {
        let with_unknown =
            b"{\"version\":1,\"token\":\"x\",\"action\":{\"list\":{\"all\":true}},\"extra\":true}\n";
        assert_eq!(
            read_json_line::<SessionControlRequest>(
                &mut with_unknown.as_slice(),
                MAX_REQUEST_BYTES,
                Frame::Request
            )
            .unwrap_err()
            .code,
            "REQUEST_INVALID"
        );
        // A field that belongs to another action is rejected with it.
        let wrong_action =
            b"{\"version\":1,\"token\":\"x\",\"action\":{\"list\":{\"keepSource\":true}}}\n";
        assert_eq!(
            read_json_line::<SessionControlRequest>(
                &mut wrong_action.as_slice(),
                MAX_REQUEST_BYTES,
                Frame::Request
            )
            .unwrap_err()
            .code,
            "REQUEST_INVALID"
        );
        let no_newline = br#"{"version":1,"token":"x","action":{"list":{"all":false}}}"#;
        assert_eq!(
            read_json_line::<SessionControlRequest>(
                &mut no_newline.as_slice(),
                MAX_REQUEST_BYTES,
                Frame::Request
            )
            .unwrap_err()
            .code,
            "REQUEST_NOT_TERMINATED"
        );
    }

    #[test]
    fn the_wire_round_trips_every_action_and_result() {
        let request = SessionControlRequest {
            version: PROTOCOL_VERSION,
            token: "t".to_string(),
            action: SessionControlAction::Launch(LaunchAction {
                prompt: "Do it".to_string(),
                project: Some("Argmax".to_string()),
                worktree: true,
                path: None,
                branch: Some("main".to_string()),
                provider: Some(ProviderId::Claude),
                model: Some("claude-opus-5".to_string()),
                task_label: Some("Side quest".to_string()),
                reasoning: Some(crate::providers::ReasoningEffort::High),
                permission_mode: Some(crate::providers::PermissionMode::AskEachTime),
            }),
        };
        let encoded = serde_json::to_value(&request).expect("encode");
        assert_eq!(encoded["action"]["launch"]["provider"], "claude");
        assert_eq!(encoded["action"]["launch"]["reasoning"], "high");
        assert_eq!(encoded["action"]["launch"]["branch"], "main");
        assert_eq!(
            encoded["action"]["launch"]["permissionMode"],
            "ask-each-time"
        );
        assert_eq!(
            serde_json::from_value::<SessionControlRequest>(encoded).expect("decode"),
            request
        );

        for action in [
            SessionControlAction::Move(MoveAction {
                project: Some("Other".to_string()),
                path: None,
                prompt: "Port the fix here".to_string(),
                worktree: false,
                keep_source: true,
            }),
            SessionControlAction::List(ListAction::default()),
            SessionControlAction::Message(MessageAction {
                session_id: "s1".to_string(),
                message: "ping".to_string(),
            }),
            SessionControlAction::Rename(RenameAction {
                task_label: "Ship the fix".to_string(),
            }),
            SessionControlAction::ChecksRun(ChecksRunAction {
                session: Some("s1".to_string()),
                command: Some("npm test".to_string()),
                timeout_ms: None,
            }),
            SessionControlAction::WorkspaceStatus(WorkspaceStatusAction {
                session: Some("s1".to_string()),
            }),
            SessionControlAction::WorkspaceDiff(WorkspaceDiffAction {
                session: None,
                file_path: Some("src/main.rs".to_string()),
                comparison: Some(crate::review::git_review::ReviewComparison::Branch),
                max_chars: Some(4000),
            }),
            SessionControlAction::LearningsAdd(LearningsAddAction {
                kind: "pitfall".to_string(),
                summary: "The bridge check runs before typecheck".to_string(),
                project: None,
            }),
            SessionControlAction::LearningsSearch(LearningsSearchAction {
                query: Some("bridge".to_string()),
                project: None,
                limit: Some(5),
            }),
            SessionControlAction::TerminalSpawn(TerminalSpawnAction {
                session: None,
                command: Some("npm run dev".to_string()),
            }),
            SessionControlAction::TerminalRead(TerminalReadAction {
                terminal_id: Some("t1".to_string()),
                session: None,
                max_chars: None,
            }),
            SessionControlAction::Projects(ProjectsAction {}),
            SessionControlAction::ScheduleFollowup(ScheduleFollowupAction {
                prompt: "Check the CI run".to_string(),
                in_seconds: Some(300),
                at: None,
                name: None,
            }),
            SessionControlAction::ScheduleList(ScheduleListAction { project: None }),
            SessionControlAction::ScheduleCancel(ScheduleCancelAction {
                schedule_id: "routine-1".to_string(),
                disable: true,
            }),
            SessionControlAction::ScheduleResume(ScheduleResumeAction {
                schedule_id: "routine-1".to_string(),
            }),
        ] {
            let encoded = serde_json::to_string(&action).expect("encode");
            assert_eq!(
                serde_json::from_str::<SessionControlAction>(&encoded).expect("decode"),
                action
            );
        }

        // The result is flattened, so an agent reads `{"version":1,"messaged":…}`.
        let response =
            SessionControlResponse::new(SessionControlResult::Messaged(MessageDelivery {
                session_id: "s1".to_string(),
                queued: true,
            }));
        let encoded = serde_json::to_value(&response).expect("encode");
        assert_eq!(encoded["messaged"]["queued"], true);
        assert_eq!(encoded["version"], PROTOCOL_VERSION);
    }
}
