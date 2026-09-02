use serde::{Deserialize, Serialize};
use specta::Type;

use crate::{review::git_review::ReviewComparison, workspaces::WorkspaceTargetKind};

use super::validation::{
    AgentMode, AttachmentMimeType, AttachmentPath, Base64ImageData, BaseRef, BranchName,
    CommandText, DiffContextLines, FileContent, GitCommitMessage, NonEmptyString, OpenPath,
    PermissionMode, ProjectId, Prompt, ProviderId, ReasoningEffort, RelativePath, RepoPath,
    SearchQuery, SessionId, StreamChunk, TaskLabel, TerminalId, ThemeMode, WorkspaceId,
    ATTACHMENT_BYTE_CAP,
};

macro_rules! empty_input {
    ($name:ident) => {
        #[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
        #[serde(deny_unknown_fields)]
        pub struct $name {}
    };
}

empty_input!(HealthPingInput);
empty_input!(ProjectsListInput);
empty_input!(ProjectsPickFolderInput);
empty_input!(DashboardListInput);
empty_input!(ApprovalsPendingInput);
empty_input!(SystemListDetectedIdesInput);
empty_input!(SystemDiagnosticsInput);
empty_input!(SystemVacuumDatabaseInput);
empty_input!(RemoteGetStatusInput);
empty_input!(RemoteTestNotificationInput);
empty_input!(SystemTestNotificationInput);

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SystemDebugSnapshotInput {
    /// Highest log `seq` the caller already holds. `None` asks for the whole
    /// ring; the debug panel sends its cursor so each poll ships only new lines.
    pub after_log_seq: Option<u64>,
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
pub struct ProvidersDiscoverInput {
    /// When true, drop the cached capability reports and re-probe each provider
    /// CLI. Defaults to false so an absent `{}` payload reuses the cache.
    #[serde(default)]
    pub refresh: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProjectSettingsInput {
    pub default_provider: ProviderId,
    pub default_model_label: NonEmptyString,
    /// '' keeps "no model chosen": launch paths use the provider default.
    pub default_model_id: String,
    pub worktree_location: NonEmptyString,
    pub setup_command: String,
    pub check_commands: Vec<String>,
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
pub struct ProjectsRefreshBranchInput {
    pub project_id: ProjectId,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProjectsSwitchBranchInput {
    pub project_id: ProjectId,
    pub branch: BranchName,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkspacesCreateIsolatedInput {
    pub project_id: ProjectId,
    pub task_label: TaskLabel,
    pub base_ref: Option<BaseRef>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkspacesCreateCurrentInput {
    pub project_id: ProjectId,
    pub task_label: TaskLabel,
}

/// 'scratch' (the default) is a visible side chat; 'popup' is the ephemeral
/// "More details" mini-session, excluded from the sidebar and prunable.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "lowercase")]
pub enum ScratchWorkspaceKind {
    Scratch,
    Popup,
}

impl ScratchWorkspaceKind {
    pub fn as_str(self) -> &'static str {
        match self {
            ScratchWorkspaceKind::Scratch => "scratch",
            ScratchWorkspaceKind::Popup => "popup",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkspacesCreateScratchInput {
    pub task_label: TaskLabel,
    pub kind: Option<ScratchWorkspaceKind>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkspacesRefreshStatusInput {
    pub workspace_id: WorkspaceId,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkspacesKeepInput {
    pub workspace_id: WorkspaceId,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkspacesArchiveInput {
    pub workspace_id: WorkspaceId,
    pub force: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "lowercase")]
pub enum OpenIdeChoice {
    Default,
    Vscode,
    Cursor,
    Windsurf,
    Zed,
    Terminal,
    Iterm,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkspacesOpenInIdeInput {
    pub workspace_id: WorkspaceId,
    pub ide: OpenIdeChoice,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkspacesAutotitleInput {
    pub workspace_id: WorkspaceId,
    pub provider: ProviderId,
    pub model_id: NonEmptyString,
    pub prompt: Prompt,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkspaceStatusInput {
    pub workspace_ids: Option<Vec<WorkspaceId>>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ComposerAttachmentInput {
    pub file_path: AttachmentPath,
    pub mime_type: AttachmentMimeType,
    pub size_bytes: AttachmentSizeBytes,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Type)]
#[serde(transparent)]
pub struct AttachmentSizeBytes(u64);

impl<'de> Deserialize<'de> for AttachmentSizeBytes {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        let value = u64::deserialize(deserializer)?;
        if value == 0 || value as usize > ATTACHMENT_BYTE_CAP {
            Err(serde::de::Error::custom(format!(
                "sizeBytes must be in 1..={ATTACHMENT_BYTE_CAP}"
            )))
        } else {
            Ok(Self(value))
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Type)]
#[serde(transparent)]
pub struct TerminalCols(u16);

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Type)]
#[serde(transparent)]
pub struct TerminalRows(u16);

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Type)]
#[serde(transparent)]
pub struct Limit200(u16);

impl TerminalCols {
    pub fn get(self) -> u16 {
        self.0
    }
}

impl TerminalRows {
    pub fn get(self) -> u16 {
        self.0
    }
}

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

impl<'de> Deserialize<'de> for TerminalCols {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        let value = u16::deserialize(deserializer)?;
        if (20..=400).contains(&value) {
            Ok(Self(value))
        } else {
            Err(serde::de::Error::custom("cols must be in 20..=400"))
        }
    }
}

impl<'de> Deserialize<'de> for TerminalRows {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        let value = u16::deserialize(deserializer)?;
        if (5..=200).contains(&value) {
            Ok(Self(value))
        } else {
            Err(serde::de::Error::custom("rows must be in 5..=200"))
        }
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
pub struct ProvidersLaunchInput {
    pub workspace_id: WorkspaceId,
    pub provider: ProviderId,
    pub prompt: Prompt,
    pub model_label: NonEmptyString,
    pub model_id: NonEmptyString,
    pub reasoning_effort: Option<ReasoningEffort>,
    #[serde(default)]
    pub fast_mode: bool,
    pub agent_mode: Option<AgentMode>,
    pub permission_mode: Option<PermissionMode>,
    pub cols: TerminalCols,
    pub rows: TerminalRows,
    pub attachments: Option<Vec<ComposerAttachmentInput>>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProvidersSendInput {
    pub session_id: SessionId,
    pub input: Prompt,
    /// Provider override for the next turn. When it differs from the session's
    /// current provider, an idle follow-up relaunches under the new provider and
    /// rebuilds context from the visible transcript — the native resume id is
    /// dropped because Claude/Codex/Cursor ids don't translate. Requires
    /// `model_label`/`model_id` for the new provider. Ignored while a turn runs:
    /// the message queues under the session's current provider and the switch's
    /// model metadata is dropped with it.
    #[serde(default)]
    pub provider: Option<ProviderId>,
    pub model_label: Option<NonEmptyString>,
    pub model_id: Option<NonEmptyString>,
    pub reasoning_effort: Option<ReasoningEffort>,
    #[serde(default)]
    pub fast_mode: bool,
    pub agent_mode: Option<AgentMode>,
    pub attachments: Option<Vec<ComposerAttachmentInput>>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProvidersResizeInput {
    pub session_id: SessionId,
    pub cols: TerminalCols,
    pub rows: TerminalRows,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProvidersTerminateInput {
    pub session_id: SessionId,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProvidersCancelQueuedMessageInput {
    pub session_id: SessionId,
    pub message_id: NonEmptyString,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProvidersSendQueuedMessageNowInput {
    pub session_id: SessionId,
    pub message_id: NonEmptyString,
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
pub struct SessionEventsSinceInput {
    pub session_id: SessionId,
    pub event_cursor: Option<u64>,
    pub raw_output_cursor: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionAgentEventsInput {
    pub session_id: SessionId,
    pub parent_tool_use_id: NonEmptyString,
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
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionClearInput {
    pub session_id: SessionId,
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
pub struct SystemOpenPathInput {
    pub path: OpenPath,
    pub cwd: Option<NonEmptyString>,
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
pub struct WorkspacesSetPinnedInput {
    pub workspace_id: WorkspaceId,
    pub pinned: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkspacesSetPriorityDismissedInput {
    pub workspace_id: WorkspaceId,
    pub dismissed: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkspacesSetPriorityAddedInput {
    pub workspace_id: WorkspaceId,
    pub added: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkspacesSetLabelInput {
    pub workspace_id: WorkspaceId,
    pub task_label: TaskLabel,
}

/// Custom sidebar glyph for a workspace row. Both fields null clears the glyph
/// and returns the row to its live status marker.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkspacesSetIconInput {
    pub workspace_id: WorkspaceId,
    pub icon: Option<SessionIconToken>,
    pub icon_color: Option<SessionIconToken>,
}

/// A picker token (icon name or palette color name). The renderer owns the
/// catalog; Rust only guarantees the value is a short slug so nothing arbitrary
/// lands in the column.
#[derive(Debug, Clone, PartialEq, Serialize, Type)]
#[serde(transparent)]
pub struct SessionIconToken(String);

impl SessionIconToken {
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl<'de> Deserialize<'de> for SessionIconToken {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        let value = String::deserialize(deserializer)?;
        let valid_length = (1..=64).contains(&value.len());
        let valid_charset = value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
        if valid_length && valid_charset {
            Ok(Self(value))
        } else {
            Err(serde::de::Error::custom(
                "icon tokens must be 1..=64 ASCII alphanumeric, hyphen, or underscore characters",
            ))
        }
    }
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
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn launch_provider_rejects_unknown_fields_and_accepts_multiline_prompt() {
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
            "rows": 24
        });
        assert!(serde_json::from_value::<ProvidersLaunchInput>(multiline_prompt).is_ok());
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
