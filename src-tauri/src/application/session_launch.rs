//! Shared application operation for launching a top-level session.
//! Transports resolve their project selector before calling this module.

use std::sync::Arc;

use crate::{
    application::validation::{
        BaseRef, NonEmptyString, ProjectId, Prompt, TaskLabel, TerminalCols, TerminalRows,
        WorkspaceId,
    },
    error::{ArgmaxError, ArgmaxResult},
    persistence::{
        authorship::PromptAuthor, database::Database, launch_receipts, projects::ProjectSummary,
    },
    providers::{inputs::ProvidersLaunchInput, session_service::ProviderSessionService},
    workspaces::{
        inputs::{
            WorkspacesArchiveInput, WorkspacesCreateCurrentInput, WorkspacesCreateIsolatedInput,
        },
        orchestration::{resolve_registered_checkout, WorkspacesCreateAlongsideInput},
        WorkspaceService,
    },
};

pub(crate) const DEFAULT_TASK_LABEL: &str = "Local agent task";
pub(crate) const MAX_TASK_LABEL_CHARS: usize = 64;
pub(crate) const MAX_TASK_LABEL_BYTES: usize = 200;

pub(crate) struct LaunchSpec {
    /// Run in the dispatching chat's checkout. An isolated worktree takes precedence.
    pub alongside: Option<AlongsideCheckout>,
    /// Existing checkout of the target project, from `git worktree list`.
    pub path: Option<String>,
    /// Ref for a new worktree, or the expected branch of an existing checkout.
    pub branch: Option<String>,
    pub prompt: String,
    pub worktree: bool,
    pub provider: crate::providers::ProviderId,
    pub model_label: String,
    pub model_id: String,
    pub reasoning_effort: Option<crate::providers::ReasoningEffort>,
    pub fast_mode: bool,
    pub permission_mode: crate::providers::PermissionMode,
    pub agent_mode: crate::providers::AgentMode,
    pub task_label: Option<String>,
    pub arc_id: Option<String>,
    pub arc_is_coordinator_launch: bool,
    /// Who wrote `prompt`. A person only for a multitask typed into the
    /// composer; MCP launches, routines and coordinators are unattested, so
    /// their chat references grant nothing.
    pub author: PromptAuthor,
}

pub(crate) struct ValidatedLaunchSpec {
    spec: LaunchSpec,
    prompt: Prompt,
    task_label: TaskLabel,
    model_label: NonEmptyString,
    model_id: NonEmptyString,
    cols: TerminalCols,
    rows: TerminalRows,
}

impl LaunchSpec {
    /// Reject invalid input before project registration or workspace creation.
    pub(crate) fn validate(self) -> ArgmaxResult<ValidatedLaunchSpec> {
        let prompt = Prompt::try_from(self.prompt.clone()).map_err(ArgmaxError::invalid)?;
        let label = self
            .task_label
            .as_deref()
            .map(task_label)
            .unwrap_or_else(|| task_label(prompt.as_str()));
        let task_label = TaskLabel::try_from(label).map_err(ArgmaxError::invalid)?;
        let model_label =
            NonEmptyString::try_from(self.model_label.clone()).map_err(ArgmaxError::invalid)?;
        let model_id =
            NonEmptyString::try_from(self.model_id.clone()).map_err(ArgmaxError::invalid)?;
        let cols: TerminalCols =
            serde_json::from_value(serde_json::json!(120)).map_err(|error| {
                ArgmaxError::service(
                    "INTERNAL_INPUT_INVALID",
                    format!("Could not prepare terminal columns: {error}"),
                )
            })?;
        let rows: TerminalRows =
            serde_json::from_value(serde_json::json!(32)).map_err(|error| {
                ArgmaxError::service(
                    "INTERNAL_INPUT_INVALID",
                    format!("Could not prepare terminal rows: {error}"),
                )
            })?;
        if self.worktree && self.path.is_some() {
            return Err(ArgmaxError::service("LAUNCH_WORKTREE_WITH_PATH", "worktree creates a new worktree; path launches into one that exists. Pass only one."));
        }
        if self.branch.is_some() && !self.worktree && self.path.is_none() {
            return Err(ArgmaxError::service("LAUNCH_BRANCH_NEEDS_DESTINATION", "Pass worktree to fork an isolated worktree from this branch, or path to a checkout that already has it. Launch will not switch another checkout's branch."));
        }
        if let Some(branch) = self.branch.as_ref().filter(|_| self.worktree) {
            BaseRef::try_from(branch.clone()).map_err(ArgmaxError::invalid)?;
        }
        Ok(ValidatedLaunchSpec {
            spec: self,
            prompt,
            task_label,
            model_label,
            model_id,
            cols,
            rows,
        })
    }
}

pub(crate) struct AlongsideCheckout {
    pub path: String,
    pub branch: String,
    pub base_ref: String,
}

pub(crate) struct LaunchOutcome {
    pub session_id: String,
    pub workspace_id: String,
    pub project_id: String,
    pub project_name: String,
    pub path: String,
    pub branch: String,
}

/// The receipt of a retryable launch. The launch starts the session under the
/// id the receipt already holds and writes the checkout onto it before the
/// provider starts, so a crash leaves a record that names both.
pub(crate) struct LaunchReceiptTicket {
    pub database: Arc<Database>,
    pub caller_session_id: String,
    pub client_request_id: String,
    pub session_id: String,
}

/// Resolve a checkout, create its workspace, and start the provider. The caller
/// owns project selection and any protocol-specific launch budget.
pub(crate) async fn launch(
    validated: ValidatedLaunchSpec,
    project: ProjectSummary,
    workspaces: Arc<WorkspaceService>,
    providers: Arc<ProviderSessionService>,
) -> ArgmaxResult<LaunchOutcome> {
    launch_with_receipt(validated, project, workspaces, providers, None).await
}

pub(crate) async fn launch_with_receipt(
    validated: ValidatedLaunchSpec,
    project: ProjectSummary,
    workspaces: Arc<WorkspaceService>,
    providers: Arc<ProviderSessionService>,
    receipt: Option<LaunchReceiptTicket>,
) -> ArgmaxResult<LaunchOutcome> {
    let ValidatedLaunchSpec {
        spec,
        prompt,
        task_label,
        model_label,
        model_id,
        cols,
        rows,
    } = validated;
    let project_id = ProjectId::try_from(project.id.clone()).map_err(ArgmaxError::invalid)?;

    let workspace = if spec.worktree {
        let base_ref = match spec.branch.as_deref() {
            Some(branch) => {
                Some(BaseRef::try_from(branch.to_string()).map_err(ArgmaxError::invalid)?)
            }
            None => Some(
                BaseRef::try_from(project.current_branch.clone()).map_err(ArgmaxError::invalid)?,
            ),
        };
        workspaces
            .create_isolated(WorkspacesCreateIsolatedInput {
                project_id,
                task_label,
                base_ref,
            })
            .await
    } else if let Some(requested) = spec.path.as_deref() {
        let (path, branch) = resolve_registered_checkout(&project.repo_path, requested).await?;
        if let Some(expected) = spec.branch.as_deref() {
            if expected != branch {
                return Err(ArgmaxError::service("LAUNCH_BRANCH_MISMATCH", format!("{path} is on '{branch}', not '{expected}'. Check out that branch there first, or omit branch to use '{branch}'.")));
            }
        }
        workspaces.create_alongside(WorkspacesCreateAlongsideInput {
            project_id,
            task_label,
            path,
            branch,
            base_ref: project
                .default_branch
                .clone()
                .unwrap_or_else(|| project.current_branch.clone()),
        })
    } else if let Some(checkout) = spec.alongside {
        workspaces.create_alongside(WorkspacesCreateAlongsideInput {
            project_id,
            task_label,
            path: checkout.path,
            branch: checkout.branch,
            base_ref: checkout.base_ref,
        })
    } else {
        workspaces.create_current(WorkspacesCreateCurrentInput {
            project_id,
            task_label,
        })
    }?;

    if let Some(ticket) = &receipt {
        let recorded = launch_receipts::record_workspace(
            &ticket.database.connection(),
            &ticket.caller_session_id,
            &ticket.client_request_id,
            &workspace.id,
        );
        if let Err(error) = recorded {
            discard_workspace(&workspaces, &workspace.id).await;
            return Err(error);
        }
    }
    let workspace_id = WorkspaceId::try_from(workspace.id.clone()).map_err(ArgmaxError::invalid)?;
    let launch_result = providers
        .launch_with_session_id(
            ProvidersLaunchInput {
                workspace_id,
                provider: spec.provider,
                prompt,
                model_label,
                model_id,
                reasoning_effort: spec.reasoning_effort,
                fast_mode: spec.fast_mode,
                agent_mode: Some(spec.agent_mode),
                permission_mode: Some(spec.permission_mode),
                cols,
                rows,
                attachments: None,
                goal_condition: None,
                goal_max_turns: None,
                arc_id: spec.arc_id,
                arc_is_coordinator_launch: spec.arc_is_coordinator_launch,
                auto_tier: None,
            },
            receipt.map(|ticket| ticket.session_id),
            spec.author,
        )
        .await;
    let session = match launch_result {
        Ok(session) => session,
        Err(error) => {
            discard_workspace(&workspaces, &workspace.id).await;
            return Err(error);
        }
    };
    Ok(LaunchOutcome {
        session_id: session.id,
        workspace_id: workspace.id,
        project_id: project.id,
        project_name: project.name,
        path: workspace.path,
        branch: workspace.branch,
    })
}

/// Archive the checkout of a launch that did not start. Best effort: the launch
/// error is the one the caller needs to see.
async fn discard_workspace(workspaces: &Arc<WorkspaceService>, workspace_id: &str) {
    let Ok(workspace_id) = WorkspaceId::try_from(workspace_id.to_string()) else {
        return;
    };
    let _ = workspaces
        .archive(WorkspacesArchiveInput {
            workspace_id,
            force: Some(false),
        })
        .await;
}

/// The permission mode a session launched by `parent` may run under. A launch
/// can ask for a stricter mode than its parent, never a looser one: a parent
/// that asks before each action cannot spawn a child that does not, and the
/// parent's own mode is the answer to any request above it. Strictest first:
/// ask each time, provider defaults, auto-approve.
pub(crate) fn child_permission_mode(
    parent: crate::providers::PermissionMode,
    requested: Option<crate::providers::PermissionMode>,
) -> crate::providers::PermissionMode {
    use crate::providers::PermissionMode::{AskEachTime, AutoApprove, ProviderDefaults};
    let looseness = |mode| match mode {
        AskEachTime => 0,
        ProviderDefaults => 1,
        AutoApprove => 2,
    };
    match requested {
        Some(requested) if looseness(requested) <= looseness(parent) => requested,
        _ => parent,
    }
}

pub(crate) fn task_label(prompt: &str) -> String {
    const ELLIPSIS: &str = "...";
    let first_line = prompt.lines().next().unwrap_or_default().trim();
    if first_line.is_empty() {
        return DEFAULT_TASK_LABEL.to_string();
    }
    if first_line.chars().count() <= MAX_TASK_LABEL_CHARS
        && first_line.len() <= MAX_TASK_LABEL_BYTES
    {
        return first_line.to_string();
    }
    let max_prefix_chars = MAX_TASK_LABEL_CHARS - ELLIPSIS.chars().count();
    let max_prefix_bytes = MAX_TASK_LABEL_BYTES - ELLIPSIS.len();
    let mut prefix = String::new();
    for character in first_line.chars().take(max_prefix_chars) {
        if prefix.len() + character.len_utf8() > max_prefix_bytes {
            break;
        }
        prefix.push(character);
    }
    format!("{prefix}{ELLIPSIS}")
}

#[cfg(test)]
mod tests {
    use super::child_permission_mode;
    use crate::providers::PermissionMode::{self, AskEachTime, AutoApprove, ProviderDefaults};

    const ALL: [PermissionMode; 3] = [AskEachTime, ProviderDefaults, AutoApprove];

    #[test]
    fn an_ask_parent_only_launches_ask_children() {
        for requested in [
            None,
            Some(AskEachTime),
            Some(ProviderDefaults),
            Some(AutoApprove),
        ] {
            assert_eq!(child_permission_mode(AskEachTime, requested), AskEachTime);
        }
    }

    #[test]
    fn a_defaults_parent_allows_defaults_and_ask_but_never_auto() {
        assert_eq!(
            child_permission_mode(ProviderDefaults, None),
            ProviderDefaults
        );
        assert_eq!(
            child_permission_mode(ProviderDefaults, Some(AskEachTime)),
            AskEachTime
        );
        assert_eq!(
            child_permission_mode(ProviderDefaults, Some(ProviderDefaults)),
            ProviderDefaults
        );
        assert_eq!(
            child_permission_mode(ProviderDefaults, Some(AutoApprove)),
            ProviderDefaults
        );
    }

    #[test]
    fn an_auto_parent_allows_every_mode() {
        assert_eq!(child_permission_mode(AutoApprove, None), AutoApprove);
        for requested in ALL {
            assert_eq!(
                child_permission_mode(AutoApprove, Some(requested)),
                requested
            );
        }
    }

    #[test]
    fn no_request_is_ever_looser_than_the_parent() {
        let looseness = |mode| ALL.iter().position(|candidate| *candidate == mode).unwrap();
        for parent in ALL {
            for requested in ALL.map(Some).into_iter().chain([None]) {
                let child = child_permission_mode(parent, requested);
                assert!(
                    looseness(child) <= looseness(parent),
                    "{parent:?} -> {child:?}"
                );
            }
        }
    }
}
