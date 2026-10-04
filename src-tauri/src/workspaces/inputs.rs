//! Validated workspace operations shared across transports.

use crate::application::validation::{
    BaseRef, BranchName, NonEmptyString, ProjectId, Prompt, ProviderId, TaskLabel, WorkspaceId,
};
use serde::{Deserialize, Serialize};
use specta::Type;

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

/// A workspace in a checkout that already exists, named by the launcher after
/// the person picked a branch that a worktree has checked out.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkspacesCreateInCheckoutInput {
    pub project_id: ProjectId,
    pub task_label: TaskLabel,
    pub path: NonEmptyString,
    /// The branch the person saw checked out at `path`. The launch is refused
    /// when the checkout has moved to another branch since.
    pub branch: BranchName,
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
pub struct WorkspacesSetPinnedInput {
    pub workspace_id: WorkspaceId,
    pub pinned: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkspaceViewedObservationInput {
    pub workspace_id: WorkspaceId,
    pub observed_activity_at: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkspacesMarkViewedInput {
    pub workspaces: Vec<WorkspaceViewedObservationInput>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkspacesSetPriorityDismissedInput {
    pub workspace_id: WorkspaceId,
    pub dismissed: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkspacesSetSnoozedUntilInput {
    pub workspace_id: WorkspaceId,
    /// RFC 3339 instant in the future, or `null` to unsnooze.
    pub until: Option<String>,
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
