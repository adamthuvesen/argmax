use serde::{Deserialize, Serialize};
use specta::Type;

use crate::review::git_review::ReviewComparison;

use super::validation::{
    AgentMode, AttachmentMimeType, AttachmentPath, Base64ImageData, BaseRef, BranchName,
    CommandText, FileContent, GitCommitMessage, McpAuthSessionId, NonEmptyString, OpenPath,
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
empty_input!(DashboardLoadInput);
empty_input!(ApprovalsPendingInput);
empty_input!(SystemListDetectedIdesInput);
empty_input!(SystemDiagnosticsInput);
empty_input!(SystemVacuumDatabaseInput);
empty_input!(McpListInput);

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
pub struct GrepTargetId(String);

impl GrepTargetId {
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

impl<'de> Deserialize<'de> for GrepTargetId {
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
pub struct ReviewListChangedFilesInput {
    pub workspace_id: WorkspaceId,
    #[serde(default)]
    pub comparison: ReviewComparison,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReviewLoadDiffInput {
    pub workspace_id: WorkspaceId,
    pub file_path: Option<RelativePath>,
    #[serde(default)]
    pub comparison: ReviewComparison,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReviewListChangedFilesForProjectInput {
    pub project_id: ProjectId,
    #[serde(default)]
    pub comparison: ReviewComparison,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReviewLoadDiffForProjectInput {
    pub project_id: ProjectId,
    pub file_path: Option<RelativePath>,
    #[serde(default)]
    pub comparison: ReviewComparison,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkspaceListFilesInput {
    pub workspace_id: WorkspaceId,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkspaceReadFileInput {
    pub workspace_id: WorkspaceId,
    pub file_path: RelativePath,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkspaceListFilesForProjectInput {
    pub project_id: ProjectId,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkspaceReadFileForProjectInput {
    pub project_id: ProjectId,
    pub file_path: RelativePath,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkspaceWriteFileInput {
    pub workspace_id: WorkspaceId,
    pub file_path: RelativePath,
    pub content: FileContent,
    pub expected_mtime_ms: NullableExpectedMtimeMs,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkspaceStatFileInput {
    pub workspace_id: WorkspaceId,
    pub file_path: RelativePath,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkspaceWriteFileForProjectInput {
    pub project_id: ProjectId,
    pub file_path: RelativePath,
    pub content: FileContent,
    pub expected_mtime_ms: NullableExpectedMtimeMs,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkspaceStatFileForProjectInput {
    pub project_id: ProjectId,
    pub file_path: RelativePath,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "lowercase")]
pub enum WorkspaceGrepKind {
    Workspace,
    Project,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkspaceGrepContentInput {
    pub kind: WorkspaceGrepKind,
    pub id: GrepTargetId,
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
pub struct CheckpointsCreateInput {
    pub workspace_id: WorkspaceId,
    pub label: NonEmptyString,
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
pub struct McpAuthStartInput {
    pub cols: TerminalCols,
    pub rows: TerminalRows,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct McpAuthWriteInput {
    pub session_id: McpAuthSessionId,
    pub data: StreamChunk,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct McpAuthResizeInput {
    pub session_id: McpAuthSessionId,
    pub cols: TerminalCols,
    pub rows: TerminalRows,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct McpAuthTerminateInput {
    pub session_id: McpAuthSessionId,
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
pub struct WorkspacesSetLabelInput {
    pub workspace_id: WorkspaceId,
    pub task_label: TaskLabel,
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
            "modelLabel": "Spark",
            "modelId": "codex-spark",
            "cols": 80,
            "rows": 24,
            "surprise": true
        });
        assert!(serde_json::from_value::<ProvidersLaunchInput>(unknown).is_err());

        let multiline_prompt = serde_json::json!({
            "workspaceId": "w1",
            "provider": "codex",
            "prompt": "- hello\nthere",
            "modelLabel": "Spark",
            "modelId": "codex-spark",
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
            "modelLabel": "Spark",
            "modelId": "codex-spark",
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
