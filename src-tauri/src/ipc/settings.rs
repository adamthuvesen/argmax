use chrono::{Duration, SecondsFormat, Utc};
use serde::Serialize;
use specta::Type;
use std::collections::HashSet;
use std::time::Duration as StdDuration;
use tauri::State;
use uuid::Uuid;

use super::{
    inputs::{
        DeleteOldChatsInput, SetBrowserToolsInput, SetProjectCheckInput, SetRoutingKeyInput,
        SettingsRoutingInput,
    },
    live_database, read_off_main,
};
use crate::error::{ArgmaxError, ArgmaxResult};
use crate::ipc::validation::SessionId;
use crate::persistence::app_settings::{
    browser_tools_enabled, project_check_mode, set_browser_tools_enabled, set_project_check_mode,
    ProjectCheckMode,
};
use crate::persistence::chat_cleanup::{
    candidate_workspace_ids, delete_old_chats, eligible_session_ids, ChatCleanupPlan,
};
use crate::state::AppState;
use crate::util::sync::LockOrRecover;
use crate::workspaces::lifecycle::ArchiveOutcome;

const CHAT_HISTORY_DAYS: i64 = 7;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ChatCleanupPreview {
    pub cleanup_id: String,
    pub cutoff_at: String,
    pub chat_count: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct DeleteOldChatsResult {
    pub deleted_chat_count: u32,
    pub skipped_recent_count: u32,
    pub skipped_running_count: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AgentToolsSettings {
    pub browser_tools: bool,
}

/// Auto routing is on exactly when a Jev API key is saved. `key_hint` names
/// the saved key by its last four characters. Project check uses the same key,
/// so its mode travels with it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RoutingSettings {
    pub enabled: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub key_hint: Option<String>,
    pub project_check: ProjectCheckMode,
}

fn routing_settings(state: &AppState, api_key: Option<String>) -> ArgmaxResult<RoutingSettings> {
    let database = live_database(state)?;
    let project_check = project_check_mode(&database.read_connection());
    Ok(RoutingSettings {
        enabled: api_key.is_some(),
        key_hint: api_key.as_deref().map(crate::routing::api_key::key_hint),
        project_check,
    })
}

#[tauri::command(rename = "settings:routing")]
#[specta::specta]
pub async fn settings_routing(
    state: State<'_, AppState>,
    _input: SettingsRoutingInput,
) -> ArgmaxResult<RoutingSettings> {
    settings_routing_impl(&state).await
}

pub(crate) async fn settings_routing_impl(state: &AppState) -> ArgmaxResult<RoutingSettings> {
    // The first read spawns `security`, so it stays off the main thread.
    let api_key = read_off_main(|| Ok(crate::routing::api_key::stored_key())).await?;
    routing_settings(state, api_key)
}

#[tauri::command(rename = "settings:set-project-check")]
#[specta::specta]
pub async fn settings_set_project_check(
    state: State<'_, AppState>,
    input: SetProjectCheckInput,
) -> ArgmaxResult<RoutingSettings> {
    let database = live_database(&state)?;
    read_off_main(move || set_project_check_mode(&database.connection(), input.mode)).await?;
    settings_routing_impl(&state).await
}

/// Saves a Jev API key after proving it works with one live classification,
/// so a typo is reported here rather than on the next Auto launch.
#[tauri::command(rename = "settings:set-routing-key")]
#[specta::specta]
pub async fn settings_set_routing_key(
    state: State<'_, AppState>,
    input: SetRoutingKeyInput,
) -> ArgmaxResult<RoutingSettings> {
    let api_key = crate::routing::api_key::validate_format(&input.api_key)?.to_string();
    crate::routing::jev::classify("Reply with ok.", &api_key, false)
        .await
        .map_err(|error| match error {
            ArgmaxError::ServiceError { ref sub_code, .. } if sub_code == "ROUTING_KEY_INVALID" => {
                error
            }
            other => ArgmaxError::service(
                "ROUTING_KEY_UNVERIFIED",
                format!("Could not check the key with Jev, so it was not saved: {other}"),
            ),
        })?;
    let api_key = read_off_main(move || {
        crate::routing::api_key::store_key(&api_key)?;
        Ok(api_key)
    })
    .await?;
    routing_settings(&state, Some(api_key))
}

#[tauri::command(rename = "settings:clear-routing-key")]
#[specta::specta]
pub async fn settings_clear_routing_key(
    state: State<'_, AppState>,
) -> ArgmaxResult<RoutingSettings> {
    read_off_main(crate::routing::api_key::clear_key).await?;
    routing_settings(&state, None)
}

#[tauri::command(rename = "settings:agent-tools")]
#[specta::specta]
pub async fn settings_agent_tools(state: State<'_, AppState>) -> ArgmaxResult<AgentToolsSettings> {
    settings_agent_tools_impl(&state).await
}

pub(crate) async fn settings_agent_tools_impl(
    state: &AppState,
) -> ArgmaxResult<AgentToolsSettings> {
    let database = live_database(state)?;
    let browser_tools =
        read_off_main(move || Ok(browser_tools_enabled(&database.read_connection()))).await?;
    Ok(AgentToolsSettings { browser_tools })
}

/// Takes effect on the next launch. A running turn keeps the surface it
/// started with — its provider read the tool list once, at startup, and no
/// CLI re-reads it mid-conversation.
#[tauri::command(rename = "settings:set-browser-tools")]
#[specta::specta]
pub async fn settings_set_browser_tools(
    state: State<'_, AppState>,
    input: SetBrowserToolsInput,
) -> ArgmaxResult<AgentToolsSettings> {
    settings_set_browser_tools_impl(&state, input).await
}

pub(crate) async fn settings_set_browser_tools_impl(
    state: &AppState,
    input: SetBrowserToolsInput,
) -> ArgmaxResult<AgentToolsSettings> {
    let database = live_database(state)?;
    read_off_main(move || {
        set_browser_tools_enabled(&database.connection(), input.enabled)?;
        Ok(())
    })
    .await?;
    Ok(AgentToolsSettings {
        browser_tools: input.enabled,
    })
}

#[tauri::command(rename = "settings:preview-chat-cleanup")]
#[specta::specta]
pub async fn settings_preview_chat_cleanup(
    state: State<'_, AppState>,
) -> ArgmaxResult<ChatCleanupPreview> {
    let database = live_database(&state)?;
    let cutoff_at = (Utc::now() - Duration::days(CHAT_HISTORY_DAYS))
        .to_rfc3339_opts(SecondsFormat::Millis, true);
    let query_cutoff = cutoff_at.clone();
    let session_ids = read_off_main(move || {
        let connection = database.read_connection();
        eligible_session_ids(&connection, &query_cutoff)
    })
    .await?;
    let cleanup_id = Uuid::new_v4().to_string();
    let chat_count = session_ids.len() as u32;
    *state
        .chat_cleanup_plan
        .lock_or_recover("chat cleanup preview") = Some(ChatCleanupPlan {
        cleanup_id: cleanup_id.clone(),
        cutoff_at: cutoff_at.clone(),
        session_ids,
    });
    Ok(ChatCleanupPreview {
        cleanup_id,
        cutoff_at,
        chat_count,
    })
}

#[tauri::command(rename = "settings:delete-old-chats")]
#[specta::specta]
pub async fn settings_delete_old_chats(
    state: State<'_, AppState>,
    input: DeleteOldChatsInput,
) -> ArgmaxResult<DeleteOldChatsResult> {
    let database = live_database(&state)?;
    let workspaces = state.workspaces.get().cloned().ok_or_else(|| {
        ArgmaxError::service(
            "CHAT_CLEANUP_NOT_READY",
            "Workspace services are not initialized yet.",
        )
    })?;
    let attachments = state.attachments.get().cloned().ok_or_else(|| {
        ArgmaxError::service(
            "CHAT_CLEANUP_NOT_READY",
            "Attachment storage is not initialized yet.",
        )
    })?;
    let plan = {
        let mut preview = state
            .chat_cleanup_plan
            .lock_or_recover("chat cleanup preview");
        if preview
            .as_ref()
            .is_none_or(|plan| plan.cleanup_id != input.cleanup_id)
        {
            return Err(ArgmaxError::service(
                "CHAT_CLEANUP_PREVIEW_EXPIRED",
                "Chat cleanup preview is no longer current. Check again before deleting.",
            ));
        }
        preview.take().expect("matching preview exists")
    };
    let workspace_ids = {
        let database = database.clone();
        let session_ids = plan.session_ids.clone();
        read_off_main(move || {
            let connection = database.read_connection();
            candidate_workspace_ids(&connection, &session_ids)
        })
        .await?
    };
    let mut cleanup_leases = Vec::new();
    let mut protected_workspace_ids = HashSet::new();
    for workspace_id in workspace_ids {
        match workspaces.begin_chat_cleanup(&workspace_id) {
            Ok(lease) => cleanup_leases.push((workspace_id, lease)),
            Err(_) => {
                protected_workspace_ids.insert(workspace_id);
            }
        }
    }
    // Each admission drain is bounded (~1s) and keyed to its own workspace —
    // draining them one after another turned an N-workspace cleanup into an
    // ~N-second wait for no reason, so wait on all of them concurrently.
    let admissions_drained =
        futures_util::future::join_all(cleanup_leases.iter().map(|(workspace_id, _)| {
            workspaces.wait_for_chat_cleanup_admissions(workspace_id, StdDuration::from_secs(1))
        }))
        .await;
    for ((workspace_id, _), admissions_drained) in cleanup_leases.iter().zip(admissions_drained) {
        if !admissions_drained || workspaces.chat_cleanup_has_live_process(workspace_id) {
            protected_workspace_ids.insert(workspace_id.clone());
        }
    }
    let sync_sweep = state.sync_sweep.clone();
    let deleted_at = Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true);
    let outcome = tauri::async_runtime::spawn_blocking(move || {
        // Serialize with import discovery. Tombstones and session deletion
        // must become visible before another sweep decides an id is unknown.
        let _sync = sync_sweep.lock_or_recover("sync sweep");
        let mut connection = database.connection();
        delete_old_chats(
            &mut connection,
            &plan,
            &deleted_at,
            &protected_workspace_ids,
        )
    })
    .await
    .map_err(|error| ArgmaxError::service("CHAT_CLEANUP_JOIN", error.to_string()))??;

    for (workspace_id, lease) in cleanup_leases {
        if let Some(lease) = lease {
            let deleted = outcome.deleted_workspace_ids.contains(&workspace_id);
            lease.finish(if deleted {
                ArchiveOutcome::Archived
            } else {
                ArchiveOutcome::Reopened
            });
        }
    }
    workspaces.remove_sessions(&outcome.deleted_workspace_ids, &outcome.deleted_session_ids);

    let mut attachment_failures = Vec::new();
    for session_id in &outcome.deleted_session_ids {
        match SessionId::try_from(session_id.clone()) {
            Ok(session_id) => {
                if let Err(error) = attachments.prune_session(&session_id) {
                    attachment_failures.push(error.to_string());
                }
            }
            Err(error) => attachment_failures.push(error.message),
        }
    }
    if !attachment_failures.is_empty() {
        return Err(ArgmaxError::service(
            "CHAT_ATTACHMENT_CLEANUP_FAILED",
            format!(
                "Deleted {} chats, but could not remove attachments for {} of them: {}",
                outcome.deleted_session_ids.len(),
                attachment_failures.len(),
                attachment_failures.join("; ")
            ),
        ));
    }
    Ok(DeleteOldChatsResult {
        deleted_chat_count: outcome.deleted_session_ids.len() as u32,
        skipped_recent_count: outcome.skipped_recent_count,
        skipped_running_count: outcome.skipped_running_count,
    })
}
