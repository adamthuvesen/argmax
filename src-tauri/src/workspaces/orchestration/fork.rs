// Forking a chat at a finished turn (docs/workspaces.md#forking-at-a-finished-turn).
//
// A fork is a new sidebar chat that opens with a copy of the source's visible
// history up to the end of one selected turn. Nothing about the provider is
// created here: the child's first message decides which provider continues it,
// and `providers::continuity` decides then whether that can be an exact native
// continuation or a fresh conversation retold from the copied prefix. The
// source row, its events and its provider conversation are never written.
//
// Files are not rewound. A shared fork points at the source's checkout; an
// isolated fork is a new worktree that starts from the source's current HEAD
// plus a copy of its current uncommitted files.

use super::*;
use crate::ipc::inputs::ForkWorkspaceMode;
use crate::persistence::continuity::{insert_fork, ForkRecord, NativeMode};
use crate::persistence::events::persist_copied_event;
use crate::providers::continuity::{latest_turn_starter, recorded_codex_turn};

/// How the fork's first message will continue the provider conversation.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, specta::Type)]
#[serde(rename_all = "kebab-case")]
pub enum ForkContinuation {
    /// Fresh conversation retold from the copied visible prefix.
    Portable,
    /// Codex forks its own thread through the selected turn.
    CodexTurn,
    /// The provider forks the source's latest conversation (only offered while
    /// the selected turn is the source's latest).
    Latest,
}

#[derive(Debug, Clone, serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ForkInfo {
    pub id: String,
    pub source_session_id: String,
    pub boundary_event_id: Option<String>,
    pub workspace: ForkWorkspaceMode,
    pub continuation: ForkContinuation,
}

#[derive(Debug, Clone)]
pub struct ForkRequest {
    pub session_id: String,
    /// The user message that started the selected turn. `None` forks the whole
    /// session as of now.
    pub boundary_event_id: Option<String>,
    pub workspace: ForkWorkspaceMode,
}

/// The slice of the source timeline a fork copies.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ForkSelection {
    pub boundary_event_id: Option<String>,
    /// Rowid of the last copied event.
    pub last_rowid: i64,
    pub last_event_id: Option<String>,
    /// No later turn exists in the source.
    pub is_latest: bool,
}

const ACTIVE_STATES: [&str; 3] = ["running", "waiting", "blocked"];

fn fork_error(message: &str, hint: &str) -> ArgmaxError {
    invalid_workspace(message, hint)
}

/// Resolve which events a fork copies, or why it cannot be made. A boundary
/// must be the user message that started a finished turn the person can see:
/// not steering into a running turn, not a child agent's row, not hidden by
/// `/clear`, and not inside a turn that is still working.
pub fn select_fork_range(
    connection: &rusqlite::Connection,
    source: &SessionSummary,
    boundary_event_id: Option<&str>,
) -> ArgmaxResult<ForkSelection> {
    use crate::persistence::sqlite_error;
    use rusqlite::OptionalExtension;

    let source_active = ACTIVE_STATES.contains(&source.state.as_str());
    let last_event: Option<(i64, String)> = connection
        .query_row(
            "SELECT rowid, id FROM events WHERE session_id = ? ORDER BY rowid DESC LIMIT 1",
            [&source.id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(sqlite_error)?;
    let Some(boundary_event_id) = boundary_event_id else {
        // Whole-session fork: the same refusal the single-click Fork always had.
        if source_active {
            return Err(fork_error(
                "This chat is still working; forking mid-turn would copy a partial transcript.",
                "Wait for the turn to finish, or fork from an earlier finished turn.",
            ));
        }
        let boundary = latest_turn_starter(connection, &source.id)?;
        return Ok(ForkSelection {
            boundary_event_id: boundary,
            last_rowid: last_event.as_ref().map_or(0, |(rowid, _)| *rowid),
            last_event_id: last_event.map(|(_, id)| id),
            is_latest: true,
        });
    };

    let boundary: Option<(i64, String, String)> = connection
        .query_row(
            "SELECT rowid, type, payload_json FROM events WHERE id = ? AND session_id = ?",
            [boundary_event_id, source.id.as_str()],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()
        .map_err(sqlite_error)?;
    let Some((boundary_rowid, boundary_type, payload)) = boundary else {
        return Err(fork_error(
            "That turn is not in this chat.",
            "Pick a message from this chat's transcript.",
        ));
    };
    let payload: serde_json::Value = serde_json::from_str(&payload).unwrap_or_default();
    let steered = payload.get("delivery").and_then(|v| v.as_str()) == Some("steer");
    let child_row = payload
        .get("parent_tool_use_id")
        .is_some_and(|v| !v.is_null());
    if boundary_type != "user.message" || steered || child_row {
        return Err(fork_error(
            "A fork starts from a message that began a turn.",
            "Pick the message that started the turn, not guidance sent into a running one.",
        ));
    }
    let cleared_at: i64 = connection
        .query_row(
            "SELECT COALESCE(MAX(rowid), 0) FROM events WHERE session_id = ? AND type = 'session.cleared'",
            [&source.id],
            |row| row.get(0),
        )
        .map_err(sqlite_error)?;
    if boundary_rowid < cleared_at {
        return Err(fork_error(
            "That turn was cleared from this chat.",
            "Fork from a turn after the last /clear.",
        ));
    }

    let next_turn_rowid: Option<i64> = connection
        .query_row(
            "SELECT rowid FROM events WHERE session_id = ?1 AND type = 'user.message' \
             AND rowid > ?2 AND COALESCE(json_extract(payload_json, '$.delivery'), '') <> 'steer' \
             AND json_extract(payload_json, '$.parent_tool_use_id') IS NULL \
             ORDER BY rowid LIMIT 1",
            rusqlite::params![source.id, boundary_rowid],
            |row| row.get(0),
        )
        .optional()
        .map_err(sqlite_error)?;
    let is_latest = next_turn_rowid.is_none();
    if is_latest && source_active {
        return Err(fork_error(
            "That turn is still working.",
            "Wait for it to finish, or fork from an earlier finished turn.",
        ));
    }
    let end: (i64, String) = connection
        .query_row(
            "SELECT rowid, id FROM events WHERE session_id = ?1 AND rowid < ?2 \
             ORDER BY rowid DESC LIMIT 1",
            rusqlite::params![source.id, next_turn_rowid.unwrap_or(i64::MAX)],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .map_err(sqlite_error)?;
    Ok(ForkSelection {
        boundary_event_id: Some(boundary_event_id.to_string()),
        last_rowid: end.0,
        last_event_id: Some(end.1),
        is_latest,
    })
}

/// How the child's first message may continue the source's provider
/// conversation. Nothing but Codex can end a native fork at an earlier turn:
/// every other provider forks only its latest state, and "latest" is offered
/// only when the selection is the latest.
fn native_plan(
    connection: &rusqlite::Connection,
    source: &SessionSummary,
    selection: &ForkSelection,
    workspace: ForkWorkspaceMode,
) -> ArgmaxResult<(NativeMode, Option<String>)> {
    let Some(conversation) = source.provider_conversation_id.as_deref() else {
        return Ok((NativeMode::None, None));
    };
    // A source that has not launched yet holds an id it only borrowed from the
    // chat it was forked or moved from. That conversation is not the source's
    // to fork: its newest state belongs to someone else's turns.
    if crate::persistence::sessions::session_resume_fork(connection, &source.id)? {
        return Ok((NativeMode::None, None));
    }
    if ACTIVE_STATES.contains(&source.state.as_str()) {
        return Ok((NativeMode::None, None));
    }
    if source.provider == "codex" {
        if let Some(turn) = selection
            .boundary_event_id
            .as_deref()
            .map(|event_id| recorded_codex_turn(connection, &source.id, conversation, event_id))
            .transpose()?
            .flatten()
        {
            return Ok((NativeMode::CodexLastTurn, Some(turn)));
        }
    }
    let provider = crate::providers::runtime::parse_provider(&source.provider).ok();
    let carries = provider.is_some_and(|provider| {
        let definition = crate::providers::adapters::get_provider_definition(provider);
        provider != crate::providers::ProviderId::Cursor
            // An isolated checkout needs a provider whose resume follows the
            // new directory.
            && (workspace == ForkWorkspaceMode::Shared || definition.move_carries_conversation)
    });
    if selection.is_latest && carries {
        return Ok((NativeMode::ResumeFork, None));
    }
    Ok((NativeMode::None, None))
}

/// The source's current uncommitted state as a patch, so an isolated fork
/// starts from the files the person sees now.
async fn current_files_patch(source_path: &Path) -> ArgmaxResult<Option<PathBuf>> {
    use crate::git::exec::{run_git_text_with_options, GitExecOptions};
    let scratch = tempfile::tempdir().map_err(|error| {
        ArgmaxError::service(
            "FORK_SCRATCH",
            format!("could not create scratch space: {error}"),
        )
    })?;
    let index = scratch.path().join("index");
    let options = || {
        let mut options = GitExecOptions::default().with_env("GIT_INDEX_FILE", &index);
        options.timeout = Duration::from_secs(60);
        options.stdout_cap_bytes = 64 * 1024 * 1024;
        options
    };
    run_git_text_with_options(source_path, ["read-tree", "HEAD"], options()).await?;
    run_git_text_with_options(source_path, ["add", "--all"], options()).await?;
    let patch = run_git_text_with_options(
        source_path,
        ["diff", "--cached", "--binary", "--no-color", "HEAD"],
        options(),
    )
    .await?;
    if patch.trim().is_empty() {
        return Ok(None);
    }
    let path = std::env::temp_dir().join(format!("argmax-fork-{}.patch", Uuid::new_v4()));
    tokio::fs::write(&path, patch).await.map_err(|error| {
        ArgmaxError::service(
            "FORK_SCRATCH",
            format!("could not write the file patch: {error}"),
        )
    })?;
    Ok(Some(path))
}

/// A chat that moves keeps being a fork: the destination gets its own lineage
/// row, pointing at the same source and boundary, and the merge claims are
/// remapped onto the events the move copied. Without it the moved child would
/// lose merge-back and the exactness guard on its native plan.
/// `copied` pairs each source event id with the id its copy was given.
pub(crate) fn carry_lineage_on_move(
    connection: &rusqlite::Connection,
    moved_session_id: &str,
    destination_session_id: &str,
    copied: &[(String, String)],
) -> ArgmaxResult<()> {
    use crate::persistence::continuity::{fork_for_child, insert_merge, list_merges};
    let Some(fork) = fork_for_child(connection, moved_session_id)? else {
        return Ok(());
    };
    let remap = |event_id: &Option<String>| -> Option<String> {
        let event_id = event_id.as_deref()?;
        copied
            .iter()
            .find(|(from, _)| from == event_id)
            .map(|(_, to)| to.clone())
    };
    let carried = ForkRecord {
        id: Uuid::new_v4().to_string(),
        child_session_id: destination_session_id.to_string(),
        child_base_event_id: remap(&fork.child_base_event_id),
        ..fork.clone()
    };
    insert_fork(connection, &carried)?;
    for merge in list_merges(connection, &fork.id)? {
        // A claim whose events were not copied cannot be located again.
        let Some(through_event_id) = remap(&Some(merge.through_event_id.clone())) else {
            continue;
        };
        insert_merge(
            connection,
            &crate::persistence::continuity::ForkMerge {
                id: Uuid::new_v4().to_string(),
                fork_id: carried.id.clone(),
                from_event_id: remap(&merge.from_event_id),
                through_event_id,
                ..merge
            },
        )?;
    }
    Ok(())
}

impl WorkspaceService {
    /// Fork a chat at a finished turn. See the module comment for the model.
    pub async fn fork_session_at(
        self: &Arc<Self>,
        request: ForkRequest,
    ) -> ArgmaxResult<SessionForkResult> {
        let (source_session, source_workspace, selection) = {
            let connection = self.database.connection();
            let source_session = find_session_by_id(&connection, &request.session_id)?;
            let source_workspace = find_workspace_by_id(&connection, &source_session.workspace_id)?;
            let selection = select_fork_range(
                &connection,
                &source_session,
                request.boundary_event_id.as_deref(),
            )?;
            (source_session, source_workspace, selection)
        };
        if request.workspace == ForkWorkspaceMode::Isolated && source_workspace.kind != "git" {
            return Err(fork_error(
                "Only a git checkout can fork into an isolated checkout.",
                "Fork into the same checkout instead.",
            ));
        }

        // The isolated checkout starts from what the person sees now, not from
        // the turn: the patch is read before the worktree exists so a repo too
        // large to copy fails early.
        let (workspace, patch) = match request.workspace {
            ForkWorkspaceMode::Shared => (None, None),
            ForkWorkspaceMode::Isolated => {
                let source_path = PathBuf::from(&source_workspace.path);
                let head = run_git_text(&source_path, ["rev-parse", "HEAD"], GIT_DEFAULT_TIMEOUT)
                    .await?
                    .trim()
                    .to_string();
                let patch = current_files_patch(&source_path).await?;
                let created = self
                    .create_isolated(WorkspacesCreateIsolatedInput {
                        project_id: source_workspace.project_id.clone().try_into().map_err(
                            |_| {
                                fork_error(
                                    "The project id is not valid.",
                                    "Reopen the project and retry.",
                                )
                            },
                        )?,
                        task_label: format!("{} (fork)", source_workspace.task_label)
                            .try_into()
                            .map_err(|_| {
                                fork_error(
                                    "The chat title is not valid for a fork.",
                                    "Rename it and retry.",
                                )
                            })?,
                        base_ref: Some(head.try_into().map_err(|_| {
                            fork_error("HEAD is not a usable base.", "Commit once and retry.")
                        })?),
                    })
                    .await?;
                (Some(created), patch)
            }
        };
        if let (Some(created), Some(patch)) = (&workspace, &patch) {
            let applied = run_git_text(
                Path::new(&created.path),
                [
                    "apply",
                    "--binary",
                    "--whitespace=nowarn",
                    &patch.display().to_string(),
                ],
                GIT_DEFAULT_TIMEOUT,
            )
            .await;
            let _ = tokio::fs::remove_file(patch).await;
            if let Err(error) = applied {
                let _ = self
                    .archive(WorkspacesArchiveInput {
                        workspace_id: created.id.clone().try_into().expect("stored workspace id"),
                        force: Some(true),
                    })
                    .await;
                return Err(fork_error(
                    &format!(
                        "Could not copy the current files into the isolated checkout. {error}"
                    ),
                    "Fork into the same checkout, or commit or stash the changes first.",
                ));
            }
        }

        // The copy is a row per event on the single writer connection: off the
        // async workers, like the single-click fork always was.
        let persisted = {
            let service = Arc::clone(self);
            let (request, source_session, source_workspace, isolated) = (
                request.clone(),
                source_session.clone(),
                source_workspace.clone(),
                workspace.clone(),
            );
            let selection = selection.clone();
            tokio::task::spawn_blocking(move || {
                service.persist_fork(
                    &request,
                    &source_session,
                    &source_workspace,
                    isolated,
                    &selection,
                )
            })
            .await
            .map_err(|error| ArgmaxError::service("SESSION_FORK_JOIN", error.to_string()))?
        };
        match persisted {
            Ok(done) => Ok(done),
            Err(error) => {
                if let Some(created) = workspace {
                    let _ = self
                        .archive(WorkspacesArchiveInput {
                            workspace_id: created.id.try_into().expect("stored workspace id"),
                            force: Some(true),
                        })
                        .await;
                }
                Err(error)
            }
        }
    }

    fn persist_fork(
        self: &Arc<Self>,
        request: &ForkRequest,
        source_session: &SessionSummary,
        source_workspace: &WorkspaceSummary,
        isolated: Option<WorkspaceSummary>,
        selection: &ForkSelection,
    ) -> ArgmaxResult<SessionForkResult> {
        let connection = self.database.connection();
        // The source may have moved on while an isolated checkout was built.
        let source_now = find_session_by_id(&connection, &source_session.id)?;
        let (native_mode, native_turn) =
            native_plan(&connection, &source_now, selection, request.workspace)?;
        // One transaction: a transcript copy is a row per event, and a failure
        // halfway must not leave a workspace with a truncated history.
        let transaction = connection
            .unchecked_transaction()
            .map_err(crate::persistence::sqlite_error)?;
        let workspace = match isolated {
            Some(created) => created,
            None => persist_workspace(
                &transaction,
                &PersistWorkspaceInput {
                    id: Uuid::new_v4().to_string(),
                    project_id: source_workspace.project_id.clone(),
                    task_label: format!("{} (fork)", source_workspace.task_label),
                    branch: source_workspace.branch.clone(),
                    base_ref: source_workspace.base_ref.clone(),
                    path: source_workspace.path.clone(),
                    state: "complete".to_string(),
                    shared_workspace: true,
                    kind: source_workspace.kind.clone(),
                    dirty: source_workspace.dirty,
                    changed_files: source_workspace.changed_files,
                },
            )?,
        };
        let mut session = persist_session(
            &transaction,
            &PersistSessionInput {
                id: Uuid::new_v4().to_string(),
                workspace_id: workspace.id.clone(),
                provider: source_now.provider.clone(),
                model_label: source_now.model_label.clone(),
                model_id: source_now.model_id.clone(),
                reasoning_effort: source_now.reasoning_effort.clone(),
                permission_mode: Some(source_now.permission_mode.clone()),
                agent_mode: source_now.agent_mode.clone(),
                prompt: source_now.prompt.clone(),
                state: SessionState::Complete,
            },
        )?;
        // Only the latest-state fork carries the provider id, flagged so the
        // child's first launch diverges. An earlier turn leaves it empty: the
        // lineage row below is the only place a native source is named.
        if native_mode == NativeMode::ResumeFork {
            if let Some(conversation_id) = source_now.provider_conversation_id.as_deref() {
                session = update_session_provider_conversation_id(
                    &transaction,
                    &session.id,
                    conversation_id,
                )?;
                set_session_resume_fork(&transaction, &session.id)?;
            }
        }
        // The visible prefix only. Raw provider output and usage stay with the
        // source: they describe work the fork did not perform.
        for event in list_all_session_events(&transaction, &source_session.id)?
            .into_iter()
            .take_while(|event| {
                event
                    .row_cursor
                    .is_some_and(|cursor| cursor <= selection.last_rowid)
            })
        {
            persist_copied_event(
                &transaction,
                &PersistTimelineEventInput {
                    id: Uuid::new_v4().to_string(),
                    session_id: session.id.clone(),
                    r#type: event.r#type,
                    message: event.message,
                    payload: event.payload,
                    created_at: Some(event.created_at),
                },
                &event.id,
            )?;
        }
        // Merge-back counts from the fork's newest *visible* message: trace rows
        // are rewritten after the fact and must never be the cursor.
        let child_base_event_id =
            crate::providers::follow_up::newest_visible_event(&transaction, &session.id)?
                .map(|(_, event_id)| event_id);
        let fork = ForkRecord {
            id: Uuid::new_v4().to_string(),
            source_session_id: Some(source_session.id.clone()),
            child_session_id: session.id.clone(),
            boundary_event_id: selection.boundary_event_id.clone(),
            source_last_event_id: selection.last_event_id.clone(),
            child_base_event_id,
            workspace_mode: match request.workspace {
                ForkWorkspaceMode::Shared => "shared",
                ForkWorkspaceMode::Isolated => "isolated",
            }
            .to_string(),
            native_mode,
            native_provider: (native_mode != NativeMode::None).then(|| source_now.provider.clone()),
            native_conversation_id: (native_mode == NativeMode::CodexLastTurn)
                .then(|| source_now.provider_conversation_id.clone())
                .flatten(),
            native_turn_id: native_turn,
            created_at: crate::persistence::time::now_iso(),
        };
        insert_fork(&transaction, &fork)?;
        transaction
            .commit()
            .map_err(crate::persistence::sqlite_error)?;
        self.publish(DashboardDelta {
            projects: list_projects(&connection)?,
            workspaces: vec![workspace.clone()],
            sessions: vec![session.clone()],
            ..DashboardDelta::default()
        });
        drop(connection);
        if let Err(error) = self.watch(&workspace.id) {
            tracing::warn!(workspace_id = %workspace.id, ?error, "workspace watcher failed to start");
        }
        let info = ForkInfo {
            id: fork.id,
            source_session_id: source_session.id.clone(),
            boundary_event_id: fork.boundary_event_id,
            workspace: request.workspace,
            continuation: match native_mode {
                NativeMode::None => ForkContinuation::Portable,
                NativeMode::CodexLastTurn => ForkContinuation::CodexTurn,
                NativeMode::ResumeFork => ForkContinuation::Latest,
            },
        };
        Ok(SessionForkResult {
            workspace,
            session,
            fork: info,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::persistence::continuity::{binding_turn, fork_for_child, record_binding_turn};
    use crate::persistence::database::Database;
    use crate::persistence::sessions::{session_resume_fork, SessionProviderInput};
    use crate::providers::continuity::plan_launch;
    use crate::providers::continuity_tests::{event, event_with, seed_session};
    use crate::providers::ProviderId;
    use serde_json::json;

    fn service() -> (Arc<Database>, Arc<WorkspaceService>) {
        let database = Arc::new(Database::open_in_memory().expect("database"));
        let service = WorkspaceService::new(Arc::clone(&database));
        (database, service)
    }

    /// Three finished turns: u1/a1, u2/a2, u3/a3.
    fn three_turns(database: &Database, provider: &str, conversation: &str) {
        let connection = database.connection();
        seed_session(&connection, provider);
        for turn in 1..=3 {
            event(
                &connection,
                "s1",
                &format!("u{turn}"),
                "user.message",
                &format!("ask {turn}"),
            );
            event(
                &connection,
                "s1",
                &format!("a{turn}"),
                "message.completed",
                &format!("answer {turn}"),
            );
        }
        update_session_provider_conversation_id(&connection, "s1", conversation).unwrap();
        connection
            .execute(
                "INSERT INTO raw_outputs (id, session_id, stream, content, created_at) VALUES ('r1', 's1', 'stdout', 'raw', '2026-05-24T10:00:00.000Z')",
                [],
            )
            .unwrap();
    }

    fn request(boundary: Option<&str>) -> ForkRequest {
        ForkRequest {
            session_id: "s1".to_string(),
            boundary_event_id: boundary.map(str::to_string),
            workspace: ForkWorkspaceMode::Shared,
        }
    }

    fn child_messages(database: &Database, session_id: &str) -> Vec<String> {
        let connection = database.connection();
        list_all_session_events(&connection, session_id)
            .unwrap()
            .into_iter()
            .map(|event| event.message)
            .collect()
    }

    #[tokio::test]
    async fn a_fork_at_an_earlier_turn_copies_only_that_visible_prefix() {
        let (database, service) = service();
        three_turns(&database, "claude", "claude-conv");
        let before = {
            let connection = database.connection();
            (
                serde_json::to_value(find_session_by_id(&connection, "s1").unwrap()).unwrap(),
                list_all_session_events(&connection, "s1").unwrap().len(),
            )
        };

        let forked = service.fork_session_at(request(Some("u2"))).await.unwrap();

        assert_eq!(
            child_messages(&database, &forked.session.id),
            ["ask 1", "answer 1", "ask 2", "answer 2"]
        );
        // Nothing of the provider conversation is created, claimed or copied.
        assert_eq!(forked.session.provider_conversation_id, None);
        assert_eq!(forked.fork.continuation, ForkContinuation::Portable);
        assert_eq!(forked.fork.boundary_event_id.as_deref(), Some("u2"));
        // Raw output and usage describe work the fork did not perform.
        let connection = database.connection();
        let raw: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM raw_outputs WHERE session_id = ?",
                [&forked.session.id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(raw, 0);
        // The source is byte-for-byte what it was.
        let after = (
            serde_json::to_value(find_session_by_id(&connection, "s1").unwrap()).unwrap(),
            list_all_session_events(&connection, "s1").unwrap().len(),
        );
        assert_eq!(before, after);
        let lineage = fork_for_child(&connection, &forked.session.id)
            .unwrap()
            .unwrap();
        assert_eq!(lineage.source_session_id.as_deref(), Some("s1"));
        assert_eq!(lineage.source_last_event_id.as_deref(), Some("a2"));
        // Same checkout: the fork opens in the source's directory.
        assert_eq!(forked.workspace.path, "/tmp/w1");
        assert!(forked.workspace.shared_workspace);
    }

    #[tokio::test]
    async fn the_first_message_of_a_portable_fork_starts_fresh_from_the_prefix() {
        let (database, service) = service();
        three_turns(&database, "claude", "claude-conv");
        let forked = service.fork_session_at(request(Some("u1"))).await.unwrap();

        let connection = database.connection();
        let mut child = find_session_by_id(&connection, &forked.session.id).unwrap();
        let plan = plan_launch(
            &connection,
            &mut child,
            ProviderId::Claude,
            Path::new("/tmp/w1"),
            false,
        )
        .unwrap();
        assert_eq!(plan.resume_conversation_id, None);
        assert!(!plan.resume_fork);
        assert_ne!(
            plan.continuity.fresh_native_id.as_deref(),
            Some("claude-conv")
        );
        let prompt = crate::providers::follow_up::compose_follow_up_prompt(
            &connection,
            &forked.session.id,
            "go on",
            false,
        )
        .unwrap();
        assert!(prompt.contains("User: ask 1"));
        assert!(!prompt.contains("ask 2"));
    }

    #[tokio::test]
    async fn a_fork_at_the_latest_turn_continues_natively_only_while_the_source_stands_still() {
        let (database, service) = service();
        three_turns(&database, "claude", "claude-conv");
        let forked = service.fork_session_at(request(Some("u3"))).await.unwrap();
        assert_eq!(forked.fork.continuation, ForkContinuation::Latest);
        assert_eq!(
            forked.session.provider_conversation_id.as_deref(),
            Some("claude-conv")
        );

        let connection = database.connection();
        assert!(session_resume_fork(&connection, &forked.session.id).unwrap());
        let mut child = find_session_by_id(&connection, &forked.session.id).unwrap();
        let exact = plan_launch(
            &connection,
            &mut child,
            ProviderId::Claude,
            Path::new("/tmp/w1"),
            false,
        )
        .unwrap();
        assert_eq!(exact.resume_conversation_id.as_deref(), Some("claude-conv"));
        assert!(exact.resume_fork);

        // The source moved on before the child said anything: `--fork-session`
        // would now fork the wrong state, so the child starts fresh instead.
        event(&connection, "s1", "u4", "user.message", "a later ask");
        let mut child = find_session_by_id(&connection, &forked.session.id).unwrap();
        let stale = plan_launch(
            &connection,
            &mut child,
            ProviderId::Claude,
            Path::new("/tmp/w1"),
            false,
        )
        .unwrap();
        assert_eq!(stale.resume_conversation_id, None);
        assert!(!stale.resume_fork);
        assert!(!session_resume_fork(&connection, &forked.session.id).unwrap());
    }

    #[tokio::test]
    async fn codex_forks_natively_at_a_recorded_turn_and_names_it() {
        let (database, service) = service();
        three_turns(&database, "codex", "thread-src");
        {
            let connection = database.connection();
            record_binding_turn(&connection, "s1", "codex", "thread-src", "u1", "turn-1").unwrap();
            record_binding_turn(&connection, "s1", "codex", "thread-src", "u2", "turn-2").unwrap();
        }
        let forked = service.fork_session_at(request(Some("u1"))).await.unwrap();
        assert_eq!(forked.fork.continuation, ForkContinuation::CodexTurn);
        // The earlier-turn fork must not reach the adapters through the
        // latest-fork fields.
        assert_eq!(forked.session.provider_conversation_id, None);

        let connection = database.connection();
        assert!(!session_resume_fork(&connection, &forked.session.id).unwrap());
        let mut child = find_session_by_id(&connection, &forked.session.id).unwrap();
        let plan = plan_launch(
            &connection,
            &mut child,
            ProviderId::Codex,
            Path::new("/tmp/w1"),
            false,
        )
        .unwrap();
        assert_eq!(plan.resume_conversation_id.as_deref(), Some("thread-src"));
        assert!(plan.resume_fork);
        assert_eq!(plan.continuity.fork_last_turn_id.as_deref(), Some("turn-1"));
        assert!(plan.needs_fallback_prompt);
        assert_eq!(
            binding_turn(&connection, "s1", "codex", "thread-src", "u1")
                .unwrap()
                .as_deref(),
            Some("turn-1")
        );
    }

    #[tokio::test]
    async fn codex_turns_without_a_recorded_id_fork_portable() {
        let (database, service) = service();
        three_turns(&database, "codex", "thread-src");
        // Turns from before ids were recorded have nothing to name.
        let forked = service.fork_session_at(request(Some("u2"))).await.unwrap();
        assert_eq!(forked.fork.continuation, ForkContinuation::Portable);
        let connection = database.connection();
        let mut child = find_session_by_id(&connection, &forked.session.id).unwrap();
        let plan = plan_launch(
            &connection,
            &mut child,
            ProviderId::Codex,
            Path::new("/tmp/w1"),
            false,
        )
        .unwrap();
        assert_eq!(plan.resume_conversation_id, None);
        assert_eq!(plan.continuity.fork_last_turn_id, None);
    }

    #[tokio::test]
    async fn choosing_another_provider_at_the_first_message_drops_the_native_plan() {
        let (database, service) = service();
        three_turns(&database, "codex", "thread-src");
        {
            let connection = database.connection();
            record_binding_turn(&connection, "s1", "codex", "thread-src", "u1", "turn-1").unwrap();
        }
        let forked = service.fork_session_at(request(Some("u1"))).await.unwrap();
        let connection = database.connection();
        crate::persistence::sessions::update_session_provider(
            &connection,
            &forked.session.id,
            &SessionProviderInput {
                provider: "claude".to_string(),
                model_label: "Model".to_string(),
                model_id: "claude-model".to_string(),
                reasoning_effort: None,
            },
        )
        .unwrap();
        let mut child = find_session_by_id(&connection, &forked.session.id).unwrap();
        let plan = plan_launch(
            &connection,
            &mut child,
            ProviderId::Claude,
            Path::new("/tmp/w1"),
            true,
        )
        .unwrap();
        assert_eq!(plan.resume_conversation_id, None);
        assert_eq!(plan.continuity.fork_last_turn_id, None);
    }

    #[tokio::test]
    async fn only_a_finished_visible_turn_start_can_be_a_boundary() {
        let (database, service) = service();
        three_turns(&database, "claude", "claude-conv");
        {
            let connection = database.connection();
            event_with(
                &connection,
                "s1",
                "steer",
                "user.message",
                "guidance",
                json!({"delivery": "steer"}),
            );
        }
        let steered = service
            .fork_session_at(request(Some("steer")))
            .await
            .unwrap_err();
        assert!(steered.to_string().contains("began a turn"), "{steered}");
        let reply = service
            .fork_session_at(request(Some("a1")))
            .await
            .unwrap_err();
        assert!(reply.to_string().contains("began a turn"), "{reply}");
        let unknown = service
            .fork_session_at(request(Some("nope")))
            .await
            .unwrap_err();
        assert!(
            unknown.to_string().contains("not in this chat"),
            "{unknown}"
        );

        // /clear hides everything before it.
        {
            let connection = database.connection();
            event(
                &connection,
                "s1",
                "clear",
                "session.cleared",
                "Cleared conversation.",
            );
            event(&connection, "s1", "u4", "user.message", "after clear");
            event(&connection, "s1", "a4", "message.completed", "answer 4");
        }
        let cleared = service
            .fork_session_at(request(Some("u2")))
            .await
            .unwrap_err();
        assert!(cleared.to_string().contains("cleared"), "{cleared}");
        service.fork_session_at(request(Some("u4"))).await.unwrap();
    }

    #[tokio::test]
    async fn a_turn_that_is_still_working_cannot_be_forked_but_an_earlier_one_can() {
        let (database, service) = service();
        three_turns(&database, "claude", "claude-conv");
        database
            .connection()
            .execute("UPDATE sessions SET state = 'running' WHERE id = 's1'", [])
            .unwrap();

        let latest = service
            .fork_session_at(request(Some("u3")))
            .await
            .unwrap_err();
        assert!(latest.to_string().contains("still working"), "{latest}");
        let whole = service.fork_session_at(request(None)).await.unwrap_err();
        assert!(whole.to_string().contains("still working"), "{whole}");

        // An earlier finished turn is history; it never touches the live turn.
        let earlier = service.fork_session_at(request(Some("u1"))).await.unwrap();
        assert_eq!(earlier.fork.continuation, ForkContinuation::Portable);
    }

    #[tokio::test]
    async fn a_fork_of_an_unlaunched_fork_starts_fresh_instead_of_forking_the_borrowed_id() {
        let (database, service) = service();
        three_turns(&database, "claude", "claude-conv");
        // C1 forks S at its latest turn and holds S's id, flagged to fork it.
        let c1 = service.fork_session_at(request(Some("u3"))).await.unwrap();
        assert_eq!(c1.fork.continuation, ForkContinuation::Latest);

        // C2 forks C1 before C1 says anything. C1's id is borrowed from S.
        let c2 = service
            .fork_session_at(ForkRequest {
                session_id: c1.session.id.clone(),
                boundary_event_id: None,
                workspace: ForkWorkspaceMode::Shared,
            })
            .await
            .unwrap();
        assert_eq!(c2.fork.continuation, ForkContinuation::Portable);
        assert_eq!(c2.session.provider_conversation_id, None);

        // S moves on. C2 must not inherit that turn through `--fork-session`.
        let connection = database.connection();
        event(&connection, "s1", "u4", "user.message", "a later ask");
        let mut child = find_session_by_id(&connection, &c2.session.id).unwrap();
        let plan = plan_launch(
            &connection,
            &mut child,
            ProviderId::Claude,
            Path::new("/tmp/w1"),
            false,
        )
        .unwrap();
        assert_eq!(plan.resume_conversation_id, None);
        assert!(!plan.resume_fork);
    }

    #[tokio::test]
    async fn a_fork_of_a_fork_that_has_launched_may_continue_its_own_conversation() {
        let (database, service) = service();
        three_turns(&database, "claude", "claude-conv");
        let c1 = service.fork_session_at(request(Some("u3"))).await.unwrap();
        {
            // C1 launched: it now owns a conversation of its own.
            let connection = database.connection();
            update_session_provider_conversation_id(&connection, &c1.session.id, "c1-own").unwrap();
            event(
                &connection,
                &c1.session.id,
                "c1-u",
                "user.message",
                "c1 ask",
            );
            event(
                &connection,
                &c1.session.id,
                "c1-a",
                "message.completed",
                "c1 answer",
            );
        }
        let c2 = service
            .fork_session_at(ForkRequest {
                session_id: c1.session.id.clone(),
                boundary_event_id: Some("c1-u".to_string()),
                workspace: ForkWorkspaceMode::Shared,
            })
            .await
            .unwrap();
        assert_eq!(c2.fork.continuation, ForkContinuation::Latest);
        assert_eq!(
            c2.session.provider_conversation_id.as_deref(),
            Some("c1-own")
        );
    }

    #[tokio::test]
    async fn a_fork_whose_source_was_deleted_never_continues_natively() {
        let (database, service) = service();
        three_turns(&database, "claude", "claude-conv");
        let forked = service.fork_session_at(request(Some("u3"))).await.unwrap();
        assert_eq!(forked.fork.continuation, ForkContinuation::Latest);

        let connection = database.connection();
        connection
            .execute("DELETE FROM sessions WHERE id = 's1'", [])
            .unwrap();
        // The child keeps its history and its lineage row, minus the source.
        let lineage = fork_for_child(&connection, &forked.session.id)
            .unwrap()
            .unwrap();
        assert_eq!(lineage.source_session_id, None);
        assert_eq!(child_messages_in(&connection, &forked.session.id).len(), 6);

        // Nothing can show the source still stands at the boundary, so the
        // child starts fresh instead of forking whatever the id now names.
        let mut child = find_session_by_id(&connection, &forked.session.id).unwrap();
        let plan = plan_launch(
            &connection,
            &mut child,
            ProviderId::Claude,
            Path::new("/tmp/w1"),
            false,
        )
        .unwrap();
        assert_eq!(plan.resume_conversation_id, None);
        assert!(!plan.resume_fork);
    }

    #[tokio::test]
    async fn the_merge_cursor_is_the_forks_newest_visible_message() {
        let (database, service) = service();
        three_turns(&database, "claude", "claude-conv");
        {
            // The last copied row is a trace row: never a cursor.
            let connection = database.connection();
            event_with(
                &connection,
                "s1",
                "trace",
                "tool.completed",
                "trace",
                json!({"traceImported": true}),
            );
        }
        let forked = service.fork_session_at(request(None)).await.unwrap();
        let connection = database.connection();
        let lineage = fork_for_child(&connection, &forked.session.id)
            .unwrap()
            .unwrap();
        let base = lineage.child_base_event_id.expect("a base");
        let kind: String = connection
            .query_row("SELECT type FROM events WHERE id = ?", [&base], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(kind, "message.completed");
    }

    fn child_messages_in(connection: &rusqlite::Connection, session_id: &str) -> Vec<String> {
        list_all_session_events(connection, session_id)
            .unwrap()
            .into_iter()
            .map(|event| event.message)
            .collect()
    }

    #[tokio::test]
    async fn cursor_forks_portably_instead_of_being_refused() {
        let (database, service) = service();
        three_turns(&database, "cursor", "cursor-conv");
        let forked = service.fork_session_at(request(None)).await.unwrap();
        assert_eq!(forked.fork.continuation, ForkContinuation::Portable);
        assert_eq!(forked.session.provider_conversation_id, None);
        assert_eq!(child_messages(&database, &forked.session.id).len(), 6);
    }

    #[tokio::test]
    async fn a_failed_or_interrupted_turn_is_a_valid_boundary() {
        let (database, service) = service();
        three_turns(&database, "claude", "claude-conv");
        {
            let connection = database.connection();
            event(&connection, "s1", "u4", "user.message", "ask 4");
            event(&connection, "s1", "e4", "error", "provider crashed");
            event(&connection, "s1", "x4", "session.cancelled", "Stopped.");
            event(&connection, "s1", "u5", "user.message", "ask 5");
        }
        let forked = service.fork_session_at(request(Some("u4"))).await.unwrap();
        let messages = child_messages(&database, &forked.session.id);
        assert!(messages.contains(&"provider crashed".to_string()));
        assert!(!messages.contains(&"ask 5".to_string()));
    }
}
