//! Multitask: a second chat the user dispatches from the one they are watching,
//! to run alongside the turn already in flight.
//!
//! It is a sibling session, not a second turn. Every runtime map in
//! [`crate::providers::session_service`] is keyed by session id — one provider
//! handle, one live `provider_invocation_id`, one `state` scalar, one
//! `provider_conversation_id` — so two turns under one session id would be a
//! rewrite with nothing to show for it. A sibling costs one workspace row and
//! reuses the launch path agents already use, while the parent's turn keeps
//! running untouched.
//!
//! Two things separate it from the sessions an agent launches for itself:
//!
//! * It runs in the **same checkout** by default. The point is a small fix on
//!   the side of the work you are already doing, on the branch you are already
//!   on — not an isolated experiment. `worktree: true` is there for when you
//!   know the two will collide.
//! * Its finish is **passive**. A launched agent's completion notice wakes its
//!   launcher as a turn, which is right when the launcher is waiting on an
//!   answer and wrong here: waking a Claude parent costs a `--resume` relaunch
//!   to produce a turn that says "noted". The result lands in the parent's
//!   timeline and its inbox, and rides along as a preamble on the next thing
//!   the person actually types.
//!
//! See `docs/multitask.md` and
//! `docs/adr/0006-a-multitask-is-a-sibling-session.md`.

use std::sync::Arc;

use serde::Serialize;
use serde_json::json;
use specta::Type;
use uuid::Uuid;

use crate::arcs::member_preamble;
use crate::error::{ArgmaxError, ArgmaxResult};
use crate::persistence::arcs;
use crate::persistence::authorship::PromptAuthor;
use crate::persistence::events::{
    latest_agent_message, persist_timeline_event, without_chat_link_brackets,
    PersistTimelineEventInput, TimelineEvent,
};
use crate::persistence::session_messages::{
    insert_session_message, list_undelivered_messages_of_kind, mark_message_delivered,
    NewSessionMessage,
};
use crate::persistence::sessions::{
    find_session_by_id, record_session_launch, LAUNCH_KIND_MULTITASK,
};
use crate::persistence::workspaces::find_workspace_by_id;
use crate::persistence::Database;
use crate::providers::flush_queue::{DashboardDelta, PendingMessage};
use crate::providers::session_service::ProviderSessionService;
use crate::providers::ProviderId;
use crate::session_control::{launch_with_spec, task_label, AlongsideCheckout, LaunchSpec};
use crate::sessions::state::SessionState;
use crate::workspaces::orchestration::WorkspaceService;

/// Written into the parent's timeline the moment a multitask is dispatched.
/// The card the chat renders hangs off this row, which is why it is persisted
/// rather than pushed as a transient delta: reopening the chat tomorrow still
/// shows what was run alongside.
pub const LAUNCHED_EVENT: &str = "multitask.launched";
/// Written into the parent's timeline when the multitask's turn ends.
pub const FINISHED_EVENT: &str = "multitask.finished";
/// `session_messages.kind` for a multitask result. Deliberately not
/// `COMPLETION_KIND`: that kind is delivered as a turn, and this one is not.
pub const MULTITASK_KIND: &str = "multitask";

/// How much of the multitask's final answer rides into the parent's next
/// prompt. Enough to say what happened, short enough that three of them do not
/// crowd out what the person typed.
const ANSWER_PREAMBLE_CHARS: usize = 1200;

pub struct MultitaskRequest {
    pub parent_session_id: String,
    pub prompt: String,
    /// Isolate in a fresh worktree instead of sharing the parent's checkout.
    /// The escape hatch for work you expect to collide.
    pub worktree: bool,
    pub task_label: Option<String>,
    /// What a promoted queued follow-up was queued to run under. `None` for a
    /// multitask typed as a prompt, which runs as the parent does.
    pub queued_settings: Option<QueuedRunSettings>,
}

/// The provider, model, effort and fast-mode choice a queued follow-up
/// carries. Each part left unset falls back to the parent chat's. A model and
/// its effort travel together: an effort picked for one model means nothing on
/// another, so the parent's effort is never mixed with a row's model.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct QueuedRunSettings {
    pub provider: Option<ProviderId>,
    pub model_label: Option<String>,
    pub model_id: Option<String>,
    pub reasoning_effort: Option<String>,
    pub fast_mode: bool,
}

impl QueuedRunSettings {
    fn from_pending_message(message: &PendingMessage) -> Self {
        Self {
            provider: message.provider,
            model_label: message.model_label.clone(),
            model_id: message.model_id.clone(),
            reasoning_effort: message.reasoning_effort.clone(),
            fast_mode: message.fast_mode,
        }
    }
}

/// The chat the multitask runs in, handed straight back to the composer so it
/// can show the card without waiting for the dashboard delta.
#[derive(Debug, Clone, PartialEq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct MultitaskLaunched {
    pub session_id: String,
    pub workspace_id: String,
    pub task_label: String,
}

/// Launch the multitask and record it in the parent's timeline.
///
/// The parent is read but never written to beyond the timeline row: its turn,
/// its queue and its provider process are not touched, which is the whole
/// point of the feature.
pub async fn dispatch(
    request: MultitaskRequest,
    author: PromptAuthor,
    database: Arc<Database>,
    workspaces: Arc<WorkspaceService>,
    providers: Arc<ProviderSessionService>,
) -> ArgmaxResult<MultitaskLaunched> {
    let (parent, parent_workspace, parent_arc) = {
        let connection = database.connection();
        let parent = find_session_by_id(&connection, &request.parent_session_id)?;
        let workspace = find_workspace_by_id(&connection, &parent.workspace_id)?;
        let parent_arc = match parent.arc_id.as_deref() {
            Some(arc_id) => Some(arcs::get_arc(&connection, arc_id)?),
            None => None,
        };
        (parent, workspace, parent_arc)
    };
    if matches!(
        parent_workspace.state.as_str(),
        "archiving" | "archive-failed" | "archived"
    ) {
        return Err(ArgmaxError::service(
            "MULTITASK_WORKSPACE_ARCHIVED",
            "This chat's workspace is archived, so there is no checkout to run alongside it.",
        ));
    }

    let label = task_label(request.task_label.as_deref().unwrap_or(&request.prompt));
    let parent_provider = parse_json_enum(Some(parent.provider.as_str())).ok_or_else(|| {
        ArgmaxError::service(
            "MULTITASK_PROVIDER_UNKNOWN",
            format!(
                "Unknown provider on the parent session: {}",
                parent.provider
            ),
        )
    })?;
    let queued = request.queued_settings.as_ref();
    let provider = queued
        .and_then(|settings| settings.provider)
        .unwrap_or(parent_provider);
    let (model_label, model_id, reasoning_effort) = match queued {
        Some(QueuedRunSettings {
            model_label: Some(label),
            model_id: Some(id),
            reasoning_effort,
            ..
        }) => (
            label.clone(),
            id.clone(),
            parse_json_enum(reasoning_effort.as_deref()),
        ),
        Some(QueuedRunSettings {
            reasoning_effort: Some(effort),
            ..
        }) => (
            parent.model_label.clone(),
            parent.model_id.clone(),
            parse_json_enum(Some(effort.as_str())),
        ),
        _ => (
            parent.model_label.clone(),
            parent.model_id.clone(),
            parse_json_enum(parent.reasoning_effort.as_deref()),
        ),
    };

    // A multitask dispatched from inside an Arc is Arc work too: it gets the
    // same member preamble an agent-launched session would, ahead of the
    // shared-checkout guardrails.
    let prompt = prompt_with_preamble(
        &request,
        &parent_workspace.task_label,
        &parent_workspace.branch,
    );
    let prompt = match &parent_arc {
        Some(arc) => format!("{}\n\n{}", member_preamble(arc), prompt),
        None => prompt,
    };
    let outcome = launch_with_spec(
        LaunchSpec {
            // The chat this was dispatched from owns the checkout the person is
            // looking at. Its workspace is the project root only when that chat
            // is not in a worktree, and the guardrail preamble below names its
            // branch — so the tree has to match what the preamble claims.
            alongside: Some(AlongsideCheckout {
                path: parent_workspace.path.clone(),
                branch: parent_workspace.branch.clone(),
                base_ref: parent_workspace.base_ref.clone(),
            }),
            path: None,
            branch: None,
            prompt,
            worktree: request.worktree,
            provider,
            model_label,
            model_id,
            reasoning_effort,
            // Fast mode is a per-launch choice the composer makes. A typed
            // multitask is a side fix, not where you spend it; a queued row
            // keeps the choice it was queued with.
            fast_mode: queued.is_some_and(|settings| settings.fast_mode),
            permission_mode: parse_json_enum(Some(parent.permission_mode.as_str()))
                .unwrap_or(crate::providers::PermissionMode::ProviderDefaults),
            agent_mode: parse_json_enum(parent.agent_mode.as_deref())
                .unwrap_or(crate::providers::AgentMode::Auto),
            task_label: Some(label.clone()),
            arc_id: parent_arc.as_ref().map(|arc| arc.id.clone()),
            arc_is_coordinator_launch: false,
            author,
        },
        None,
        Arc::clone(&database),
        workspaces,
        Arc::clone(&providers),
        &parent_workspace.project_id,
    )
    .await
    // The launch path speaks the socket protocol's error shape; carry its code
    // through so a failure reads the same in the chat as it does to an agent.
    .map_err(|error| ArgmaxError::service(error.code, error.message))?;

    let connection = database.connection();
    // Launch depth exists to stop an agent from launching agents without end.
    // A multitask is a person asking for one more chat, so it starts its own
    // lineage at depth 0: a multitask dispatched from a chat two agents deep
    // must not inherit a budget that leaves it unable to launch anything. The
    // parent id is still recorded, so both chats keep the link back.
    record_session_launch(
        &connection,
        &outcome.session_id,
        &request.parent_session_id,
        0,
        LAUNCH_KIND_MULTITASK,
    )?;
    let event = persist_timeline_event(
        &connection,
        &PersistTimelineEventInput {
            id: Uuid::new_v4().to_string(),
            session_id: request.parent_session_id.clone(),
            r#type: LAUNCHED_EVENT.to_string(),
            message: format!("Running alongside: {label}"),
            payload: json!({
                "childSessionId": outcome.session_id,
                "childWorkspaceId": outcome.workspace_id,
                "taskLabel": label,
                "prompt": request.prompt,
                "worktree": request.worktree,
            }),
            created_at: None,
        },
    )?;
    drop(connection);
    // The launch publishes the child before its lineage and the parent's
    // notice exist. Notify both readers after those writes are committed.
    providers.publish(DashboardDelta {
        events: vec![event],
        dashboard_changed: true,
        ..DashboardDelta::default()
    });

    Ok(MultitaskLaunched {
        session_id: outcome.session_id,
        workspace_id: outcome.workspace_id,
        task_label: label,
    })
}

/// Promote one queued follow-up into a multitask without leaving a runnable
/// copy behind in the parent. The provider service owns the queue claim while
/// `dispatch` owns the sibling launch; this seam keeps both outcomes paired.
pub async fn dispatch_queued(
    mut request: MultitaskRequest,
    pending_message_id: &str,
    database: Arc<Database>,
    workspaces: Arc<WorkspaceService>,
    providers: Arc<ProviderSessionService>,
) -> ArgmaxResult<MultitaskLaunched> {
    let message = providers
        .claim_queued_message_for_multitask(&request.parent_session_id, pending_message_id)?;
    request.prompt = message.content.clone();
    request.queued_settings = Some(QueuedRunSettings::from_pending_message(&message));
    // The child's opening prompt is the queued text, so it keeps the author the
    // row had: a person's own row stays theirs, an agent's message never becomes
    // one.
    match dispatch(
        request,
        message.author,
        database,
        workspaces,
        Arc::clone(&providers),
    )
    .await
    {
        Ok(launched) => {
            if let Err(error) =
                providers.finish_queued_message_multitask(&message.session_id, &message.id)
            {
                // The child is already running. Keep the claimed row hidden;
                // restoring it here would allow the same prompt to run again.
                tracing::error!(
                    session_id = %message.session_id,
                    message_id = %message.id,
                    ?error,
                    "failed to delete queued follow-up after multitask launch"
                );
            }
            Ok(launched)
        }
        Err(error) => {
            let session_id = message.session_id.clone();
            providers.restore_queued_message_multitask(&session_id, message)?;
            Err(error)
        }
    }
}

/// The instructions ahead of the user's prompt.
///
/// A multitask shares a working tree with an agent that is mid-edit, and the
/// CLIs give us no way to sandbox it — the prompt is the only lever. The
/// prohibitions are not politeness: a side agent running `git checkout -- .`
/// or `git stash` while the main agent is writing destroys work that was never
/// committed, and a second `npm test` in one checkout fights the first over
/// build output.
fn prompt_with_preamble(request: &MultitaskRequest, parent_label: &str, branch: &str) -> String {
    if request.worktree {
        return request.prompt.clone();
    }
    // The label and branch are set by the parent chat's agent, and this prompt
    // is stored as the person's: neither may carry a chat link.
    let parent_label = without_chat_link_brackets(parent_label);
    let branch = without_chat_link_brackets(branch);
    format!(
        "You are running alongside another agent in this same checkout (branch `{branch}`), \
which is working on: {parent_label}. Both of you are editing the same files on disk right now.\n\
- Touch only what your task needs, and leave files you did not come here to change alone.\n\
- Never run `git stash`, `git checkout`/`git restore`, `git reset`, `git rebase`, `git commit`, \
or anything else that moves or discards working-tree state: it would destroy the other agent's \
uncommitted work.\n\
- Do not run the project's build, test or lint commands unless the task explicitly asks for it \
— the other agent is using the same build output.\n\
- Keep it small and finish. If the task turns out to need broad changes across the tree, say so \
and stop rather than making them here.\n\n\
{}",
        request.prompt
    )
}

/// Record a finished multitask against its parent: a timeline row the chat
/// renders as a tail marker, and an inbox row that rides into the parent's next
/// prompt. Returns the parent's session id and the row it wrote, so the caller
/// can publish exactly that row rather than re-reading the parent's tail.
///
/// Called from the turn-end path in place of a completion notice, and
/// deliberately never delivers a turn.
pub fn record_finished(
    database: &Database,
    session_id: &str,
    state: SessionState,
    completed_at: &str,
) -> ArgmaxResult<Option<(String, TimelineEvent)>> {
    let connection = database.connection();
    let session = find_session_by_id(&connection, session_id)?;
    let Some(parent_id) = session.launched_by_session_id.clone() else {
        return Ok(None);
    };
    if parent_id == session_id {
        return Ok(None);
    }
    let label = find_workspace_by_id(&connection, &session.workspace_id)
        .map(|workspace| workspace.task_label)
        .unwrap_or_else(|_| session_id.to_string());
    let answer = latest_agent_message(&connection, session_id)?
        .filter(|text| !text.trim().is_empty())
        .map(|text| cap_chars(&text, ANSWER_PREAMBLE_CHARS))
        .unwrap_or_else(|| "(no answer)".to_string());

    let message = NewSessionMessage {
        // Deterministic, so a retried turn end writes one row, not two.
        id: format!("multitask:{session_id}:{completed_at}"),
        from_session_id: Some(session_id.to_string()),
        to_session_id: parent_id.clone(),
        body: format!("Multitask \"{label}\" finished with state {state}. Final answer:\n{answer}"),
        kind: MULTITASK_KIND.to_string(),
    };
    if !insert_session_message(&connection, &message)? {
        return Ok(None);
    }
    let event = persist_timeline_event(
        &connection,
        &PersistTimelineEventInput {
            id: Uuid::new_v4().to_string(),
            session_id: parent_id.clone(),
            r#type: FINISHED_EVENT.to_string(),
            message: format!("{label} finished alongside"),
            payload: json!({
                "childSessionId": session_id,
                "taskLabel": label,
                "state": state,
                "answer": answer,
            }),
            created_at: None,
        },
    )?;
    Ok(Some((parent_id, event)))
}

/// At most this many finished multitasks ride into one prompt. Past a handful
/// the person is better served by opening the chats than by a wall of preamble.
const MAX_RESULTS_PER_PROMPT: usize = 5;

/// The results block that goes ahead of the parent's next prompt, plus the ids
/// of the rows it carries — `mark_results_delivered` spends them once the
/// prompt has actually launched.
///
/// This is the passive half of the delivery: the person sees the finish in
/// their timeline the moment it happens, and the *agent* learns about it here,
/// the next time the person says something — which is the first moment the
/// knowledge can matter to it.
pub struct PendingResults {
    pub block: String,
    pub ids: Vec<String>,
}

pub fn results_preamble(
    connection: &rusqlite::Connection,
    session_id: &str,
) -> ArgmaxResult<Option<PendingResults>> {
    let pending = list_undelivered_messages_of_kind(
        connection,
        session_id,
        MULTITASK_KIND,
        MAX_RESULTS_PER_PROMPT,
    )?;
    if pending.is_empty() {
        return Ok(None);
    }
    let mut block = String::from(
        "While you were working, these ran alongside you in this same checkout and finished:\n",
    );
    let mut ids = Vec::with_capacity(pending.len());
    for message in &pending {
        block.push('\n');
        block.push_str(&message.body);
        block.push('\n');
        ids.push(message.id.clone());
    }
    block.push_str(
        "\nTheir edits are already in the working tree. Take them into account, but do not redo \
them.",
    );
    Ok(Some(PendingResults { block, ids }))
}

/// Mark the results this preamble carried as delivered.
///
/// Called only once the prompt carrying them has actually started a turn: a
/// launch that fails never reaches the agent, and marking on the way out would
/// spend the results on a prompt that was never sent — the parent would never
/// hear about those multitasks again, on this turn or any later one.
pub fn mark_results_delivered(
    connection: &rusqlite::Connection,
    ids: &[String],
) -> ArgmaxResult<()> {
    for id in ids {
        mark_message_delivered(connection, id)?;
    }
    Ok(())
}

fn cap_chars(value: &str, max: usize) -> String {
    if value.chars().count() <= max {
        return value.to_string();
    }
    let kept: String = value.chars().take(max).collect();
    format!("{kept}\n\n(truncated)")
}

/// The wire strings the validation enums deserialize from are the same ones
/// SQLite stores, so serde is the conversion — no second spelling to drift.
fn parse_json_enum<T: serde::de::DeserializeOwned>(value: Option<&str>) -> Option<T> {
    serde_json::from_value(json!(value?)).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(prompt: &str, worktree: bool) -> MultitaskRequest {
        MultitaskRequest {
            parent_session_id: "parent".to_string(),
            prompt: prompt.to_string(),
            worktree,
            task_label: None,
            queued_settings: None,
        }
    }

    #[test]
    fn shared_checkout_prompt_carries_the_guardrails_and_the_ask() {
        let prompt = prompt_with_preamble(
            &request("Fix the README typo", false),
            "Rewrite auth",
            "main",
        );
        assert!(prompt.contains("branch `main`"));
        assert!(prompt.contains("Rewrite auth"));
        assert!(prompt.contains("git stash"));
        assert!(prompt.ends_with("Fix the README typo"));
    }

    #[test]
    fn the_preamble_cannot_carry_a_chat_link_but_the_typed_prompt_keeps_its_own() {
        use crate::persistence::events::chat_reference_ids;

        let typed = "compare with [Billing](argmax://chat/chat-y?v=1)";
        let prompt = prompt_with_preamble(
            &request(typed, false),
            "[x](argmax://chat/chat-x)",
            "feature/[y](argmax://chat/chat-z)",
        );
        // Only the person's chip is left, and the typed text is exact.
        assert_eq!(chat_reference_ids(&prompt), vec!["chat-y".to_string()]);
        assert!(prompt.ends_with(typed));
        assert!(prompt.contains("(x)(argmax://chat/chat-x)"));
    }

    #[test]
    fn an_isolated_multitask_gets_the_prompt_unchanged() {
        // Its own worktree means nothing to collide with, so the warnings
        // would only be noise in the agent's context.
        let prompt = prompt_with_preamble(
            &request("Fix the README typo", true),
            "Rewrite auth",
            "main",
        );
        assert_eq!(prompt, "Fix the README typo");
    }

    #[test]
    fn a_long_answer_is_capped_for_the_parents_next_prompt() {
        let capped = cap_chars(
            &"x".repeat(ANSWER_PREAMBLE_CHARS + 50),
            ANSWER_PREAMBLE_CHARS,
        );
        assert!(capped.ends_with("(truncated)"));
        assert_eq!(
            capped.chars().count(),
            ANSWER_PREAMBLE_CHARS + "\n\n(truncated)".chars().count()
        );
        assert_eq!(cap_chars("short", ANSWER_PREAMBLE_CHARS), "short");
    }
}
