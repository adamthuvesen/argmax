//! Native provider continuity: what a follow-up launch resumes, and what it
//! has to retell. docs/providers.md#native-continuity-and-forks has the rules.
//!
//! - **Return (A -> B -> A):** a provider switch parks the old provider's
//!   conversation as a binding. Switching back resumes that conversation and
//!   sends only the visible messages after the binding's delivered boundary.
//! - **Fork first turn:** a fork child holds no provider conversation until its
//!   first message. This module decides then whether the source conversation
//!   can be continued exactly (Codex `thread/fork` through a recorded turn) or
//!   the child starts fresh from the copied visible prefix.
//! - **Fresh retry:** when a provider definitely rejects a resume or fork
//!   before admitting the turn, the launch runs once more as a fresh
//!   conversation. An ambiguous failure is never retried.

use std::path::Path;

use rusqlite::Connection;
use serde_json::Value;
use uuid::Uuid;

use super::{LaunchContinuity, ProviderId, ProviderLaunchInput};
use crate::{
    error::{ArgmaxError, ArgmaxResult},
    persistence::{
        continuity::{
            binding_turn, clear_fork_native_plan, clear_pending_since, config_identity,
            event_rowid, find_binding, find_parked, forget_active_pointer, fork_for_child,
            has_any_binding, invalidate_binding, record_binding_turn, set_pending_since,
            BindingState, ForkRecord, NativeMode,
        },
        sessions::{
            find_session_by_id, session_resume_fork, update_session_provider_conversation_id,
            SessionSummary,
        },
    },
};

/// The sub code a runtime raises when the provider answered the resume or fork
/// request with a refusal before any turn was admitted.
pub const RESUME_REJECTED: &str = "PROVIDER_RESUME_REJECTED";

/// What the follow-up send hands the provider launch.
#[derive(Debug, Default)]
pub struct LaunchPlan {
    pub resume_conversation_id: Option<String>,
    pub resume_fork: bool,
    /// Newest event a returning native conversation already holds. Set only
    /// when the session switched back to a parked binding.
    pub since_event_id: Option<String>,
    pub continuity: LaunchContinuity,
    /// The launch continues a native conversation that a definite rejection
    /// can send back to a fresh start, so it needs a fallback prompt.
    pub needs_fallback_prompt: bool,
}

pub fn plan_launch(
    connection: &Connection,
    session: &mut SessionSummary,
    provider: ProviderId,
    workspace_path: &Path,
    switched_provider: bool,
) -> ArgmaxResult<LaunchPlan> {
    let mut plan = LaunchPlan::default();
    if switched_provider {
        restore_parked_binding(connection, session, provider, workspace_path)?;
    }
    // On the switching send and on every resend until the provider answers.
    if let Some(since) = owed_since(connection, session, provider)? {
        plan.since_event_id = Some(since);
        plan.needs_fallback_prompt = true;
    }
    plan.resume_conversation_id = session.provider_conversation_id.clone();
    plan.resume_fork =
        plan.resume_conversation_id.is_some() && session_resume_fork(connection, &session.id)?;

    if let Some(fork) = fork_for_child(connection, &session.id)? {
        plan_fork_first_turn(connection, session, provider, &fork, &mut plan)?;
    }

    // Claude refuses `--session-id` for an id whose transcript exists, and
    // Argmax's own session id is spent by the first conversation. A fresh
    // launch therefore names a new id. It is not saved here: the pointer moves
    // to it when Claude reports it at `system/init`, so a launch that fails
    // before init leaves the pointer empty and the next send starts fresh
    // again instead of resuming a conversation that was never created.
    // Grok's ACP runtime mints its own id on `session/new` and reports it at
    // init, so seeding one would point the session at a conversation Grok never
    // saw.
    if plan.resume_conversation_id.is_none() && provider == ProviderId::Claude {
        plan.continuity.fresh_native_id = Some(Uuid::new_v4().to_string());
    }
    Ok(plan)
}

/// Resume the conversation the session parked with `provider`, if it is still
/// the same account, config and directory. Returns the event the provider
/// last saw.
fn restore_parked_binding(
    connection: &Connection,
    session: &mut SessionSummary,
    provider: ProviderId,
    workspace_path: &Path,
) -> ArgmaxResult<Option<String>> {
    let Some(binding) = find_parked(connection, &session.id, provider.as_str())? else {
        return Ok(None);
    };
    let usable = Path::new(&binding.working_dir) == workspace_path
        && (binding.config_identity.is_empty()
            || binding.config_identity == config_identity(provider.as_str()));
    // A boundary that no longer resolves means the transcript changed under
    // the binding; retelling the whole chat is safer than guessing.
    let Some(boundary) = binding
        .delivered_through_event_id
        .clone()
        .filter(|event_id| usable && event_rowid(connection, event_id).ok().flatten().is_some())
    else {
        invalidate_binding(
            connection,
            &session.id,
            provider.as_str(),
            &binding.conversation_id,
            "incompatible",
        )?;
        return Ok(None);
    };
    *session =
        update_session_provider_conversation_id(connection, &session.id, &binding.conversation_id)?;
    // Owed until the provider shows output: a launch that fails before it
    // admits anything must not lose these messages for the next send.
    set_pending_since(
        connection,
        &session.id,
        provider.as_str(),
        &binding.conversation_id,
        &boundary,
    )?;
    Ok(Some(boundary))
}

/// The messages a rejoined conversation is still owed, whichever send is
/// launching it.
fn owed_since(
    connection: &Connection,
    session: &SessionSummary,
    provider: ProviderId,
) -> ArgmaxResult<Option<String>> {
    let Some(conversation_id) = session.provider_conversation_id.as_deref() else {
        return Ok(None);
    };
    Ok(
        find_binding(connection, &session.id, provider.as_str(), conversation_id)?
            .and_then(|binding| binding.pending_since_event_id),
    )
}

/// Provider output proves the conversation holds everything it was owed.
/// Output is anything the provider produced: not the person's own message, an
/// error, or a lifecycle marker.
pub fn note_provider_output(
    connection: &Connection,
    session_id: &str,
    event_types: impl IntoIterator<Item = impl AsRef<str>>,
) -> ArgmaxResult<()> {
    let produced = event_types.into_iter().any(|kind| {
        let kind = kind.as_ref();
        kind != "user.message" && kind != "error" && !kind.starts_with("session.")
    });
    if produced {
        clear_pending_since(connection, session_id)?;
    }
    Ok(())
}

/// The fork child's first message decides, here, how its provider
/// conversation begins. Nothing was created at fork time.
fn plan_fork_first_turn(
    connection: &Connection,
    session: &mut SessionSummary,
    provider: ProviderId,
    fork: &ForkRecord,
    plan: &mut LaunchPlan,
) -> ArgmaxResult<()> {
    if fork.native_mode == NativeMode::None || !child_untouched(connection, fork)? {
        return Ok(());
    }
    // A deleted source cannot prove the fork is still exact.
    let Some(source_session_id) = fork.source_session_id.as_deref() else {
        drop_native_plan(connection, session, plan)?;
        return Ok(());
    };
    let same_provider = fork.native_provider.as_deref() == Some(provider.as_str());
    let source_idle = !source_is_active(connection, source_session_id)?;
    match fork.native_mode {
        NativeMode::ResumeFork => {
            // `--fork-session` and friends fork the source's newest state. They
            // are exact only while the source has not taken another turn.
            if plan.resume_fork
                && !(same_provider && source_idle && source_at_boundary(connection, fork)?)
            {
                drop_native_plan(connection, session, plan)?;
            } else if plan.resume_fork {
                plan.needs_fallback_prompt = true;
            }
        }
        NativeMode::CodexLastTurn => {
            let (Some(thread_id), Some(turn_id)) = (
                fork.native_conversation_id.as_deref(),
                fork.native_turn_id.as_deref(),
            ) else {
                return Ok(());
            };
            let source_binding = find_binding(connection, source_session_id, "codex", thread_id)?;
            let usable = same_provider
                && source_idle
                && session.provider_conversation_id.is_none()
                && source_binding.is_some_and(|binding| {
                    binding.state != BindingState::Invalid
                        && (binding.config_identity.is_empty()
                            || binding.config_identity == config_identity("codex"))
                });
            if usable {
                plan.resume_conversation_id = Some(thread_id.to_string());
                plan.resume_fork = true;
                plan.continuity.fork_last_turn_id = Some(turn_id.to_string());
                plan.needs_fallback_prompt = true;
            }
        }
        NativeMode::None => {}
    }
    Ok(())
}

/// The fork can no longer continue its source natively: start fresh from the
/// copied history, and never plan a native fork for this child again.
fn drop_native_plan(
    connection: &Connection,
    session: &mut SessionSummary,
    plan: &mut LaunchPlan,
) -> ArgmaxResult<()> {
    if plan.resume_fork {
        forget_active_pointer(connection, &session.id)?;
        *session = find_session_by_id(connection, &session.id)?;
        plan.resume_conversation_id = None;
        plan.resume_fork = false;
    }
    clear_fork_native_plan(connection, &session.id)
}

/// No turn of the child's own exists yet: nothing after the copied prefix.
fn child_untouched(connection: &Connection, fork: &ForkRecord) -> ArgmaxResult<bool> {
    let floor = match &fork.child_base_event_id {
        Some(event_id) => event_rowid(connection, event_id)?.unwrap_or(0),
        None => 0,
    };
    let touched: bool = connection
        .query_row(
            "SELECT EXISTS (SELECT 1 FROM events WHERE session_id = ?1 AND type = 'user.message' \
             AND rowid > ?2)",
            rusqlite::params![fork.child_session_id, floor],
            |row| row.get(0),
        )
        .map_err(crate::persistence::sqlite_error)?;
    Ok(!touched)
}

fn source_is_active(connection: &Connection, source_session_id: &str) -> ArgmaxResult<bool> {
    let state: Option<String> = connection
        .query_row(
            "SELECT state FROM sessions WHERE id = ?",
            [source_session_id],
            |row| row.get(0),
        )
        .ok();
    Ok(state.is_none_or(|state| matches!(state.as_str(), "running" | "waiting" | "blocked")))
}

/// The source has taken no turn past the fork boundary.
fn source_at_boundary(connection: &Connection, fork: &ForkRecord) -> ArgmaxResult<bool> {
    let Some(source_session_id) = fork.source_session_id.as_deref() else {
        return Ok(false);
    };
    let Some(last) = &fork.source_last_event_id else {
        return Ok(true);
    };
    let Some(floor) = event_rowid(connection, last)? else {
        return Ok(false);
    };
    let advanced: bool = connection
        .query_row(
            "SELECT EXISTS (SELECT 1 FROM events WHERE session_id = ?1 AND type = 'user.message' \
             AND rowid > ?2)",
            rusqlite::params![source_session_id, floor],
            |row| row.get(0),
        )
        .map_err(crate::persistence::sqlite_error)?;
    Ok(!advanced)
}

/// The fresh launch to run once if the native one is definitely rejected.
pub fn fresh_retry_input(launch: &ProviderLaunchInput) -> Option<ProviderLaunchInput> {
    let fallback = launch.continuity.as_ref()?.fresh_fallback_prompt.clone()?;
    launch.resume_conversation_id.as_ref()?;
    let mut retry = launch.clone();
    retry.prompt = fallback;
    retry.resume_conversation_id = None;
    retry.resume_fork = false;
    retry.continuity = Some(LaunchContinuity {
        fresh_native_id: (launch.provider == ProviderId::Claude)
            .then(|| Uuid::new_v4().to_string()),
        ..LaunchContinuity::default()
    });
    Some(retry)
}

pub fn is_definite_rejection(error: &ArgmaxError) -> bool {
    matches!(error, ArgmaxError::ServiceError { sub_code, .. } if sub_code == RESUME_REJECTED)
}

/// The provider refused `rejected_conversation_id`: stop trusting it, and
/// leave the pointer empty for the fresh conversation the retry creates.
pub fn record_resume_rejected(
    connection: &Connection,
    retry: &ProviderLaunchInput,
    rejected_conversation_id: &str,
) -> ArgmaxResult<()> {
    invalidate_binding(
        connection,
        &retry.session_id,
        retry.provider.as_str(),
        rejected_conversation_id,
        "resume-rejected",
    )?;
    forget_active_pointer(connection, &retry.session_id)?;
    // The retry's fresh id becomes the pointer at its own `system/init`.
    clear_fork_native_plan(connection, &retry.session_id)
}

/// A legacy Cursor session with no stored id may infer one from its output,
/// unless the session already settled that provider's bindings: an invalidated
/// id must not be resurrected.
pub fn may_infer_cursor_conversation(
    connection: &Connection,
    session_id: &str,
) -> ArgmaxResult<bool> {
    Ok(!has_any_binding(connection, session_id, "cursor")?)
}

/// Record the Codex turn a visible user message started. The runtime reports
/// the turn id on the `thread.started` line it emits once `turn/start`
/// returned, so the id belongs to a turn the provider admitted. A steered
/// message starts no turn and is never the latest non-steer message here.
pub fn observe_provider_line(
    connection: &Connection,
    session_id: &str,
    line: &str,
) -> ArgmaxResult<()> {
    if !line.contains("\"turn_id\"") {
        return Ok(());
    }
    let Ok(value) = serde_json::from_str::<Value>(line.trim()) else {
        return Ok(());
    };
    let (Some("thread.started"), Some(thread_id), Some(turn_id)) = (
        value.get("type").and_then(Value::as_str),
        value.get("thread_id").and_then(Value::as_str),
        value.get("turn_id").and_then(Value::as_str),
    ) else {
        return Ok(());
    };
    // Only Codex reports a turn id on this line; the session's provider is the
    // proof that the id is Codex's.
    if find_session_by_id(connection, session_id)?.provider != "codex" {
        return Ok(());
    }
    let Some(user_event_id) = latest_turn_starter(connection, session_id)? else {
        return Ok(());
    };
    record_binding_turn(
        connection,
        session_id,
        "codex",
        thread_id,
        &user_event_id,
        turn_id,
    )
}

/// The user message that began the newest provider run: the latest message
/// that is not steering into one already running.
pub fn latest_turn_starter(
    connection: &Connection,
    session_id: &str,
) -> ArgmaxResult<Option<String>> {
    use rusqlite::OptionalExtension;
    connection
        .query_row(
            "SELECT id FROM events WHERE session_id = ?1 AND type = 'user.message' \
             AND COALESCE(json_extract(payload_json, '$.delivery'), '') <> 'steer' \
             ORDER BY rowid DESC LIMIT 1",
            [session_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(crate::persistence::sqlite_error)
}

/// The Codex turn id recorded for a user message, when it names a native turn
/// an exact fork can end at.
pub fn recorded_codex_turn(
    connection: &Connection,
    session_id: &str,
    thread_id: &str,
    user_event_id: &str,
) -> ArgmaxResult<Option<String>> {
    binding_turn(connection, session_id, "codex", thread_id, user_event_id)
}
