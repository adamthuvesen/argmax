use chrono::{Duration, SecondsFormat, Utc};
use serde::Serialize;
use specta::Type;
use std::collections::HashSet;
use std::time::Duration as StdDuration;
use tauri::State;
use uuid::Uuid;

use super::{inputs::DeleteOldChatsInput, live_database, read_off_main};
use crate::error::{ArgmaxError, ArgmaxResult};
use crate::ipc::validation::SessionId;
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
            Ok(lease) => {
                let admissions_drained = workspaces
                    .wait_for_chat_cleanup_admissions(&workspace_id, StdDuration::from_secs(1))
                    .await;
                if !admissions_drained || workspaces.chat_cleanup_has_live_process(&workspace_id) {
                    protected_workspace_ids.insert(workspace_id.clone());
                }
                cleanup_leases.push((workspace_id, lease));
            }
            Err(_) => {
                protected_workspace_ids.insert(workspace_id);
            }
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
