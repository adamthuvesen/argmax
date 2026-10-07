use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use specta::Type;

use crate::{
    persistence::routines::RoutineRunTarget, review::git_review::ReviewComparison,
    workspaces::WorkspaceTargetKind,
};

pub use crate::application::validation::{TerminalCols, TerminalRows};
pub use crate::providers::inputs::*;
pub use crate::workspaces::inputs::*;

use super::validation::{
    AttachmentMimeType, Base64ImageData, BranchName, CommandText, DiffContextLines, FileContent,
    GitCommitMessage, NonEmptyString, OpenPath, PermissionMode, ProjectId, Prompt, ProviderId,
    QuestionRequestId, ReasoningEffort, RelativePath, RepoPath, SearchQuery, SessionId,
    StreamChunk, TerminalId, ThemeMode, WorkspaceId,
};

macro_rules! empty_input {
    ($name:ident) => {
        #[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
        #[serde(deny_unknown_fields)]
        pub struct $name {}
    };
}

empty_input!(HealthPingInput);
empty_input!(UsageRemainingInput);
empty_input!(SettingsRoutingInput);
empty_input!(ProjectsListInput);
empty_input!(ProjectsPickFolderInput);
empty_input!(DashboardListInput);
empty_input!(ApprovalsPendingInput);
empty_input!(SystemListDetectedIdesInput);
empty_input!(SystemDiagnosticsInput);
empty_input!(SystemPerformanceStartInput);
empty_input!(SystemPerformanceStopInput);
empty_input!(SystemPerformanceStatusInput);
empty_input!(SystemPerformanceCaptureInput);
empty_input!(SystemVacuumDatabaseInput);
empty_input!(RemoteGetStatusInput);
empty_input!(RemoteTestNotificationInput);
empty_input!(RemotePushTestInput);
empty_input!(RemotePushCapabilityInput);
empty_input!(SystemTestNotificationInput);

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DeleteOldChatsInput {
    pub cleanup_id: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SetBrowserToolsInput {
    pub enabled: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SetRoutingKeyInput {
    pub api_key: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SetProjectCheckInput {
    pub mode: crate::persistence::app_settings::ProjectCheckMode,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProjectsCheckPromptInput {
    /// The project the launcher is aimed at.
    pub project_id: ProjectId,
    pub prompt: Prompt,
    /// The user picked this project by hand for this draft: a check may
    /// suggest another one but never switches away on its own.
    pub picked_by_hand: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProjectsResolveCheckInput {
    pub check_id: NonEmptyString,
    pub outcome: crate::routing::project_check::ProjectCheckOutcome,
    /// The chat the launch started, when it started one.
    pub session_id: Option<SessionId>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SystemDebugSnapshotInput {
    /// Highest log `seq` the caller already holds. `None` asks for the whole
    /// ring; the debug panel sends its cursor so each poll ships only new lines.
    pub after_log_seq: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SystemRendererStallInput {
    pub duration_ms: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RemoteSetConfigInput {
    pub enabled: bool,
    pub port: u16,
    /// Raw topic field from the Settings form: empty clears push, a full
    /// http(s) URL is kept as-is, a bare topic name maps to ntfy.sh.
    pub ntfy_topic: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RemoteRegisterPushDeviceInput {
    /// APNs device token as the native app reports it: hex, no spaces. The
    /// app re-registers on every launch, so an existing token is an update
    /// rather than a second row.
    pub token: String,
    /// Shown in Settings so the user can tell two phones apart.
    pub name: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RemoteUnregisterPushDeviceInput {
    pub token: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RemoteSetApnsConfigInput {
    /// Absolute path to the `.p8` auth key. Empty clears APNs push, which is
    /// how the Settings panel turns it off.
    pub key_path: String,
    pub key_id: String,
    pub team_id: String,
    /// Send to Apple's development host, which is where a debug build of the
    /// phone app's tokens live.
    pub sandbox: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProvidersDiscoverInput {
    /// When true, drop the cached capability reports and re-probe each provider
    /// CLI. Defaults to false so an absent `{}` payload reuses the cache.
    #[serde(default)]
    pub refresh: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProjectSettingsInput {
    pub worktree_location: NonEmptyString,
    pub setup_command: String,
    pub check_commands: Vec<String>,
    /// What a merged PR does to the workspace on its branch. Required rather
    /// than defaulted: a caller that omitted it would silently turn the
    /// setting off on every other save.
    pub merge_cleanup: crate::persistence::projects::MergeCleanup,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProjectsRegisterInput {
    pub repo_path: RepoPath,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProjectsRemoveInput {
    pub project_id: ProjectId,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProjectsUpdateSettingsInput {
    pub project_id: ProjectId,
    pub settings: ProjectSettingsInput,
}

/// Every browser command addresses one tab; the tab id is renderer-assigned
/// and maps 1:1 onto a child-webview label (`browser-<id>`).
macro_rules! browser_tab_input {
    ($name:ident) => {
        #[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        pub struct $name {
            pub tab_id: String,
        }
    };
}

browser_tab_input!(BrowserBackInput);
browser_tab_input!(BrowserForwardInput);
browser_tab_input!(BrowserReloadInput);
browser_tab_input!(BrowserStopInput);
browser_tab_input!(BrowserCloseInput);
browser_tab_input!(BrowserFocusInput);
browser_tab_input!(BrowserFillCredentialsInput);

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BrowserOpenInput {
    pub url: String,
    pub bounds: BrowserBounds,
    pub tab_id: String,
    /// Session that owns the tab. `None` for a tab the user opened, and for
    /// the renderer re-materializing a tab it restored from a previous run —
    /// the registry keeps the owner it already has in that case.
    #[serde(default)]
    pub owner_session_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BrowserNavigateInput {
    pub url: String,
    pub tab_id: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BrowserSetThemeInput {
    pub mode: ThemeMode,
}

/// Logical (CSS-pixel) rect of the renderer placeholder the browser webview
/// is glued to. The main webview fills the whole window, so viewport
/// coordinates map 1:1 onto window coordinates.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BrowserBounds {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BrowserSetBoundsInput {
    pub bounds: BrowserBounds,
    /// False while a renderer overlay (dialog, palette) is open — the native
    /// webview always paints above the DOM, so it must yield instead. Also
    /// false for tabs behind the active one.
    pub visible: bool,
    pub tab_id: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BrowserScreenshotInput {
    /// Names a tab directly, or leaves it to `session_id`.
    #[serde(default)]
    pub tab_id: Option<String>,
    /// Captures the session's current tab. Ignored when `tab_id` is given.
    #[serde(default)]
    pub session_id: Option<String>,
    /// Crop, in the page's own CSS pixels from the top-left of the visible
    /// view. Omitted captures the whole view.
    #[serde(default)]
    pub rect: Option<BrowserBounds>,
    /// Crop to one element from a snapshot instead. Scrolls it into view
    /// first, and wins over `rect`.
    #[serde(default, rename = "ref")]
    pub element_ref: Option<String>,
}

// Every agent-facing browser command addresses a tab the same way: by id, or
// by the session whose current tab it is (its most recently used one).

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BrowserListTabsInput {
    /// Only this session's tabs. Omitted lists every live tab.
    #[serde(default)]
    pub session_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BrowserOpenForSessionInput {
    pub url: String,
    pub session_id: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BrowserSnapshotInput {
    #[serde(default)]
    pub tab_id: Option<String>,
    #[serde(default)]
    pub session_id: Option<String>,
    /// Drops plain text and non-heading structure, leaving only what can be
    /// clicked or typed into.
    #[serde(default)]
    pub interactive_only: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BrowserFindInput {
    #[serde(default)]
    pub tab_id: Option<String>,
    #[serde(default)]
    pub session_id: Option<String>,
    /// Case-insensitive substring over role, name, value and text.
    pub query: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BrowserGetTextInput {
    #[serde(default)]
    pub tab_id: Option<String>,
    #[serde(default)]
    pub session_id: Option<String>,
    /// Defaults to 20 000 characters.
    #[serde(default)]
    pub max_chars: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BrowserExtractInput {
    #[serde(default)]
    pub tab_id: Option<String>,
    #[serde(default)]
    pub session_id: Option<String>,
    /// Character budget for section text. Defaults to 30 000.
    #[serde(default)]
    pub max_chars: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BrowserActInput {
    #[serde(default)]
    pub tab_id: Option<String>,
    #[serde(default)]
    pub session_id: Option<String>,
    pub action: crate::browser::automation::BrowserAction,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BrowserEvaluateInput {
    pub tab_id: String,
    pub script: String,
    /// Defaults to 5000 ms. A page that never answers must not park the
    /// caller, so the deadline is not optional at the far end.
    pub timeout_ms: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProjectsListBranchesInput {
    pub project_id: ProjectId,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProjectsListCheckoutsInput {
    pub project_id: ProjectId,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProjectsRefreshBranchInput {
    pub project_id: ProjectId,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProjectsSwitchBranchInput {
    pub project_id: ProjectId,
    pub branch: BranchName,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Type)]
#[serde(transparent)]
pub struct Limit200(u16);

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Type)]
#[serde(transparent)]
pub struct NullableExpectedMtimeMs(Option<f64>);

impl NullableExpectedMtimeMs {
    pub fn into_inner(self) -> Option<f64> {
        self.0
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Type)]
#[serde(transparent)]
pub struct WorkspaceTargetId(String);

impl WorkspaceTargetId {
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Type)]
#[serde(transparent)]
pub struct SessionSearchQuery(String);

impl SessionSearchQuery {
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl Limit200 {
    pub fn get(self) -> u16 {
        self.0
    }
}

impl<'de> Deserialize<'de> for Limit200 {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        let value = u16::deserialize(deserializer)?;
        if (1..=200).contains(&value) {
            Ok(Self(value))
        } else {
            Err(serde::de::Error::custom("limit must be in 1..=200"))
        }
    }
}

impl<'de> Deserialize<'de> for NullableExpectedMtimeMs {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        let value = Option::<f64>::deserialize(deserializer)?;
        if value.is_some_and(|mtime| mtime.is_sign_negative()) {
            Err(serde::de::Error::custom(
                "expectedMtimeMs must be nonnegative",
            ))
        } else {
            Ok(Self(value))
        }
    }
}

impl<'de> Deserialize<'de> for WorkspaceTargetId {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        let value = String::deserialize(deserializer)?;
        if value.is_empty() {
            Err(serde::de::Error::custom("id must not be empty"))
        } else if value.len() > 128 {
            Err(serde::de::Error::custom("id must not exceed 128 bytes"))
        } else {
            Ok(Self(value))
        }
    }
}

impl<'de> Deserialize<'de> for SessionSearchQuery {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        let value = String::deserialize(deserializer)?;
        if value.is_empty() {
            Err(serde::de::Error::custom("query must not be empty"))
        } else if value.len() > 200 {
            Err(serde::de::Error::custom("query must not exceed 200 bytes"))
        } else {
            Ok(Self(value))
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AttachmentsSaveImageInput {
    pub session_id: SessionId,
    pub mime_type: AttachmentMimeType,
    pub data_base64: Base64ImageData,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TerminalSpawnInput {
    pub workspace_id: WorkspaceId,
    pub cols: TerminalCols,
    pub rows: TerminalRows,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TerminalWriteInput {
    pub terminal_id: TerminalId,
    pub data: StreamChunk,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TerminalResizeInput {
    pub terminal_id: TerminalId,
    pub cols: TerminalCols,
    pub rows: TerminalRows,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TerminalTerminateInput {
    pub terminal_id: TerminalId,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ApprovalsResolveInput {
    pub approval_id: super::validation::ApprovalId,
    pub status: ApprovalResolution,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "lowercase")]
pub enum ApprovalResolution {
    Approved,
    Rejected,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct QuestionsResolveInput {
    pub session_id: SessionId,
    pub request_id: QuestionRequestId,
    pub answers: std::collections::BTreeMap<String, Vec<String>>,
    #[serde(default)]
    pub dismissed: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionEventsSinceInput {
    pub session_id: SessionId,
    pub event_cursor: Option<u64>,
    pub raw_output_cursor: Option<u64>,
    pub change_cursor: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionAgentEventsInput {
    pub session_id: SessionId,
    pub parent_tool_use_id: NonEmptyString,
    #[serde(default)]
    pub provider_parent_conversation_id: Option<NonEmptyString>,
    #[serde(default)]
    pub provider_child_session_id: Option<NonEmptyString>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionSuggestFollowUpInput {
    pub session_id: SessionId,
    pub provider: ProviderId,
    pub model_id: NonEmptyString,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionForkInput {
    pub session_id: SessionId,
    /// The user message that started the finished turn to fork at. Omitted
    /// forks the whole chat as it is now.
    #[serde(default)]
    pub boundary_event_id: Option<NonEmptyString>,
    /// Where the fork works: the source's checkout, or an isolated worktree
    /// that starts from the source's current files. Defaults to `shared`.
    #[serde(default)]
    pub workspace: Option<ForkWorkspaceMode>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionForkLineageInput {
    pub session_id: SessionId,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionForkMergePreviewInput {
    /// The fork whose findings would come back.
    pub session_id: SessionId,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionForkMergeInput {
    /// The fork whose findings come back to its source.
    pub session_id: SessionId,
    /// The fork position the preview showed.
    pub through_event_id: NonEmptyString,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "kebab-case")]
pub enum ForkWorkspaceMode {
    Shared,
    Isolated,
}

/// Dispatch a multitask from a chat: a sibling session that runs alongside the
/// turn already in flight, sharing this chat's checkout unless `worktree` asks
/// for its own.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionMultitaskInput {
    pub session_id: SessionId,
    pub prompt: Prompt,
    /// When dispatching a queued follow-up, claim and remove this row as part
    /// of the same operation so it cannot later drain as a duplicate turn.
    #[serde(default)]
    pub pending_message_id: Option<NonEmptyString>,
    /// Defaults to false: the point of a multitask is a fix on the side of the
    /// work you are already doing, in the tree you are already in.
    #[serde(default)]
    pub worktree: bool,
    /// Sidebar label for the new chat. Falls back to the prompt's first line.
    pub task_label: Option<NonEmptyString>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReviewListChangedFilesInput {
    pub kind: WorkspaceTargetKind,
    pub id: WorkspaceTargetId,
    #[serde(default)]
    pub comparison: ReviewComparison,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReviewLoadDiffInput {
    pub kind: WorkspaceTargetKind,
    pub id: WorkspaceTargetId,
    pub file_path: Option<RelativePath>,
    #[serde(default)]
    pub comparison: ReviewComparison,
    /// Only honored for a single-file request. The whole-workspace diff keeps
    /// git's default context so opening the review panel never pays for it.
    #[serde(default)]
    pub context_lines: Option<DiffContextLines>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkspaceListFilesInput {
    pub kind: WorkspaceTargetKind,
    pub id: WorkspaceTargetId,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkspaceReadFileInput {
    pub kind: WorkspaceTargetKind,
    pub id: WorkspaceTargetId,
    pub file_path: RelativePath,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkspaceWriteFileInput {
    pub kind: WorkspaceTargetKind,
    pub id: WorkspaceTargetId,
    pub file_path: RelativePath,
    pub content: FileContent,
    pub expected_mtime_ms: NullableExpectedMtimeMs,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkspaceStatFileInput {
    pub kind: WorkspaceTargetKind,
    pub id: WorkspaceTargetId,
    pub file_path: RelativePath,
}

/// A file outside every workspace. `OpenPath` already rejects `..`, null
/// bytes, and a leading dash.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkspaceExternalFileInput {
    pub path: OpenPath,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkspaceGrepContentInput {
    pub kind: WorkspaceTargetKind,
    pub id: WorkspaceTargetId,
    pub query: SearchQuery,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ChecksRunInput {
    pub workspace_id: WorkspaceId,
    pub command: CommandText,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SkillsListInput {
    pub provider: ProviderId,
    pub workspace_id: Option<WorkspaceId>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConnectionsListInput {
    pub provider: ProviderId,
    pub workspace_id: Option<WorkspaceId>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SystemOpenPathInput {
    pub path: OpenPath,
    pub cwd: Option<NonEmptyString>,
}

/// Where `system:open-file-in` hands a file: Finder reveals it, the editors
/// open it. Terminal apps are left out on purpose — `open -a Terminal <file>`
/// runs the file as a script.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "lowercase")]
pub enum OpenFileApp {
    Finder,
    Vscode,
    Cursor,
    Windsurf,
    Zed,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SystemOpenFileInInput {
    pub path: OpenPath,
    /// Root the path must stay inside; relative paths resolve against it.
    pub cwd: NonEmptyString,
    pub app: OpenFileApp,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SystemSetThemeInput {
    pub mode: ThemeMode,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SystemSetNotificationsEnabledInput {
    pub enabled: bool,
}

/// The renderer's "keep computer awake" preference. Only arms or disarms the
/// service; the assertion itself is driven by active session states.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SystemSetKeepAwakeInput {
    pub enabled: bool,
}

/// The app-wide default agent (Settings → Agents), including per-provider
/// permission modes. The renderer mirrors it here for autonomous launches.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SystemSetDefaultAgentInput {
    /// Absent, together with the model fields, when the caller is updating
    /// permission modes and the model already on disk should stay.
    #[serde(default)]
    pub provider: Option<ProviderId>,
    pub permission_mode: Option<PermissionMode>,
    pub permission_modes: Option<HashMap<ProviderId, PermissionMode>>,
    #[serde(default)]
    pub model_label: Option<String>,
    #[serde(default)]
    pub model_id: Option<String>,
    /// Absent for a fast model that has no effort control at all.
    pub reasoning_effort: Option<ReasoningEffort>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionCostSummaryInput {
    pub session_id: SessionId,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LearningsListInput {
    pub project_id: ProjectId,
    pub limit: Option<Limit200>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LearningsUpdateInput {
    pub id: NonEmptyString,
    pub summary: Option<NonEmptyString>,
    pub verified: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LearningsDeleteInput {
    pub id: NonEmptyString,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionSearchInput {
    pub query: SessionSearchQuery,
    pub limit: Option<Limit200>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PrsListForSessionInput {
    pub session_id: SessionId,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PrsRefreshInput {
    pub session_id: SessionId,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PrsSetPrimaryInput {
    pub session_id: SessionId,
    pub pr_number: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PrsDismissInput {
    pub session_id: SessionId,
    pub pr_number: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PrsCleanupInput {
    pub session_id: SessionId,
    pub pr_number: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GitCommitInput {
    pub workspace_id: WorkspaceId,
    pub message: GitCommitMessage,
    pub selected_files: Option<Vec<RelativePath>>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GitPushInput {
    pub workspace_id: WorkspaceId,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GitCreateBranchInput {
    pub workspace_id: WorkspaceId,
    pub branch: BranchName,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GitViewOrCreatePrInput {
    pub session_id: SessionId,
    pub expected_branch: Option<BranchName>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn launch_provider_rejects_unknown_fields_and_accepts_multiline_prompt_and_goal() {
        let unknown = serde_json::json!({
            "workspaceId": "w1",
            "provider": "codex",
            "prompt": "hello",
            "modelLabel": "GPT-5.5",
            "modelId": "gpt-5.5",
            "cols": 80,
            "rows": 24,
            "surprise": true
        });
        assert!(serde_json::from_value::<ProvidersLaunchInput>(unknown).is_err());

        let multiline_prompt = serde_json::json!({
            "workspaceId": "w1",
            "provider": "codex",
            "prompt": "- hello\nthere",
            "modelLabel": "GPT-5.5",
            "modelId": "gpt-5.5",
            "cols": 80,
            "rows": 24,
            "goalCondition": "the tests pass",
            "goalMaxTurns": 12
        });
        let input = serde_json::from_value::<ProvidersLaunchInput>(multiline_prompt)
            .expect("launch input with a goal");
        assert_eq!(input.goal_condition.as_deref(), Some("the tests pass"));
        assert_eq!(input.goal_max_turns, Some(12));
    }

    #[test]
    fn default_agent_permission_map_validates_provider_keys() {
        let valid = serde_json::json!({
            "provider": "codex",
            "permissionModes": {
                "claude": "ask-each-time",
                "codex": "provider-defaults"
            },
            "modelLabel": "GPT-5.6 Sol",
            "modelId": "gpt-5.6-sol"
        });
        let input = serde_json::from_value::<SystemSetDefaultAgentInput>(valid)
            .expect("known provider keys accepted");
        assert_eq!(
            input
                .permission_modes
                .expect("permission map")
                .get(&ProviderId::Codex),
            Some(&PermissionMode::ProviderDefaults)
        );

        let invalid = serde_json::json!({
            "provider": "codex",
            "permissionModes": { "gemini": "auto-approve" },
            "modelLabel": "GPT-5.6 Sol",
            "modelId": "gpt-5.6-sol"
        });
        assert!(serde_json::from_value::<SystemSetDefaultAgentInput>(invalid).is_err());

        let invalid = serde_json::json!({
            "provider": "codex",
            "permissionModes": { "codex": "always-approve" },
            "modelLabel": "GPT-5.6 Sol",
            "modelId": "gpt-5.6-sol"
        });
        assert!(serde_json::from_value::<SystemSetDefaultAgentInput>(invalid).is_err());
    }

    #[test]
    fn every_explicit_input_struct_denies_unknown_fields() {
        let source = include_str!("inputs.rs");
        let lines = source.lines().collect::<Vec<_>>();
        let mut missing = Vec::new();

        for (index, line) in lines.iter().enumerate() {
            let trimmed = line.trim();
            let Some(rest) = trimmed.strip_prefix("pub struct ") else {
                continue;
            };
            let name = rest
                .split(|ch: char| ch.is_whitespace() || ch == '{' || ch == '(')
                .next()
                .unwrap_or_default();
            if !name.ends_with("Input") {
                continue;
            }

            let start = index.saturating_sub(4);
            let attrs = lines[start..index].join("\n");
            if !attrs.contains("deny_unknown_fields") {
                missing.push(name.to_string());
            }
        }

        assert!(
            missing.is_empty(),
            "input structs missing #[serde(deny_unknown_fields)]: {}",
            missing.join(", ")
        );
    }

    #[test]
    fn write_file_rejects_traversal_and_oversized_utf8() {
        let traversal = serde_json::json!({
            "workspaceId": "w1",
            "filePath": "../secret",
            "content": "ok",
            "expectedMtimeMs": null
        });
        assert!(serde_json::from_value::<WorkspaceWriteFileInput>(traversal).is_err());

        let too_large = serde_json::json!({
            "workspaceId": "w1",
            "filePath": "src/main.rs",
            "content": "x".repeat(super::super::validation::MAX_FILE_CONTENT_BYTES + 1),
            "expectedMtimeMs": null
        });
        assert!(serde_json::from_value::<WorkspaceWriteFileInput>(too_large).is_err());
    }

    #[test]
    fn branch_inputs_reject_argument_injection() {
        let bad = serde_json::json!({
            "workspaceId": "w1",
            "branch": "-bad"
        });
        assert!(serde_json::from_value::<GitCreateBranchInput>(bad).is_err());
    }

    #[test]
    fn project_and_attachment_paths_reject_relative_values() {
        let project = serde_json::json!({ "repoPath": "relative/repo" });
        assert!(serde_json::from_value::<ProjectsRegisterInput>(project).is_err());

        let launch = serde_json::json!({
            "workspaceId": "w1",
            "provider": "codex",
            "prompt": "hello",
            "modelLabel": "GPT-5.5",
            "modelId": "gpt-5.5",
            "cols": 80,
            "rows": 24,
            "attachments": [{
                "filePath": "tmp/image.png",
                "mimeType": "image/png",
                "sizeBytes": 512
            }]
        });
        assert!(serde_json::from_value::<ProvidersLaunchInput>(launch).is_err());
    }

    #[test]
    fn bounded_inputs_reject_oversized_values() {
        let search = serde_json::json!({
            "query": "x".repeat(201),
            "limit": 25
        });
        assert!(serde_json::from_value::<SessionSearchInput>(search).is_err());

        let learnings = serde_json::json!({
            "projectId": "p1",
            "limit": 201
        });
        assert!(serde_json::from_value::<LearningsListInput>(learnings).is_err());

        let stale_write = serde_json::json!({
            "workspaceId": "w1",
            "filePath": "src/main.rs",
            "content": "ok",
            "expectedMtimeMs": -1
        });
        assert!(serde_json::from_value::<WorkspaceWriteFileInput>(stale_write).is_err());
    }
}

/// Settings → Agents → Session sync. Mirrors `SyncConfig`; the handler
/// normalizes (window clamped, unreadable providers forced off).
#[derive(Debug, Clone, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SyncSetConfigInput {
    pub claude: bool,
    pub codex: bool,
    pub cursor: bool,
    pub opencode: bool,
    pub grok: bool,
    pub window_hours: u32,
}

// Scheduled tasks ("routines"): a stored prompt plus schedule the in-app
// scheduler launches as a top-level session. See routines/scheduler.rs.
empty_input!(RoutinesListInput);

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RoutinesUpsertInput {
    pub id: NonEmptyString,
    pub name: NonEmptyString,
    pub project_id: ProjectId,
    pub prompt: Prompt,
    pub provider: ProviderId,
    pub model_label: NonEmptyString,
    pub model_id: NonEmptyString,
    pub worktree: bool,
    /// Where a run lands: a fresh chat, the same chat every time, or an
    /// isolated worktree. `None` keeps older renderers working and falls back
    /// to the `worktree` boolean.
    #[serde(default)]
    pub run_target: Option<RoutineRunTarget>,
    /// The Arc an `ArcCoordinator` target sends runs to. Required exactly
    /// when `run_target` is `ArcCoordinator`; ignored otherwise.
    #[serde(default)]
    pub arc_id: Option<String>,
    pub cron_expr: Option<String>,
    pub run_once_at: Option<String>,
    pub enabled: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RoutinesDeleteInput {
    pub id: NonEmptyString,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RoutinesSetEnabledInput {
    pub id: NonEmptyString,
    pub enabled: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RoutinesRunNowInput {
    pub id: NonEmptyString,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RoutinesResetSessionInput {
    pub id: NonEmptyString,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ActivitySummaryInput {
    pub window: crate::activity::ActivityWindow,
    /// Narrow the totals, series, streaks, cadence, pull requests and reviews
    /// to one project. `repositories` and `heatmap` always cover every
    /// repository, so the page can still offer the others.
    #[serde(default)]
    pub project_id: Option<ProjectId>,
    /// IANA zone name, e.g. `Europe/Stockholm`. Every day, week, and hour
    /// bucket is cut on it, and the handler rejects a name it cannot resolve.
    pub time_zone: NonEmptyString,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UsageSummaryInput {
    pub window: crate::usage::UsageWindow,
    /// IANA zone name, e.g. `Europe/Stockholm`. Day buckets follow it.
    pub time_zone: NonEmptyString,
    /// Narrow the totals, chart, and breakdowns to one provider. The
    /// per-provider rows always cover every provider, so the page can still
    /// offer the others.
    #[serde(default)]
    pub provider: Option<crate::ipc::validation::ProviderId>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UsageRouterCostInput {
    pub window: crate::usage::UsageWindow,
}
