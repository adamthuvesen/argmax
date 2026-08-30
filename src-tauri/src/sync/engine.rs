//! The sync sweep: import newly-discovered provider sessions, extend the ones
//! already imported, and prune what the current settings no longer cover.
//!
//! Every step is idempotent. Timeline event ids are derived from
//! `(provider, external id, line number)` rather than generated, so re-reading
//! a transcript — after a crash, a settings change, or a plain re-run — never
//! duplicates a bubble.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use uuid::Uuid;

use super::{claude, DiscoveredSession, SyncConfig};
use crate::error::ArgmaxResult;
use crate::persistence::events::persist_timeline_event_if_absent;
use crate::persistence::projects::list_projects;
use crate::persistence::sessions::{
    delete_session, persist_imported_session, touch_imported_session, PersistImportedSessionInput,
};
use crate::persistence::synced::{
    known_conversation_ids, list_synced_sessions, prunable_session_ids, upsert_synced_session,
    SyncedSessionRecord,
};
use crate::persistence::Database;
use crate::providers::normalizer::{
    normalize_provider_event, NormalizerSessionContext, ProviderOutputEvent, ProviderOutputStream,
};
use crate::workspaces::WorkspaceService;

/// Providers whose transcript format Argmax can read today.
pub const SUPPORTED_PROVIDERS: [&str; 1] = ["claude"];

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SyncOutcome {
    pub imported: u32,
    pub extended: u32,
    pub pruned: u32,
}

/// One full sweep across every supported provider.
pub fn run_sync(
    database: &Database,
    workspaces: &Arc<WorkspaceService>,
    config: &SyncConfig,
    home: &Path,
    now_ms: i64,
) -> ArgmaxResult<SyncOutcome> {
    let mut outcome = SyncOutcome::default();
    let cutoff_ms = now_ms - i64::from(config.window_hours) * 3_600_000;
    let cutoff_iso = iso_from_ms(cutoff_ms);

    for provider in SUPPORTED_PROVIDERS {
        if !config.enabled_for(provider) {
            // Off means gone: every import the user never continued is
            // disposable, and the provider's own files still hold it.
            outcome.pruned += prune(database, workspaces, provider, None)?;
            continue;
        }
        // Shrinking the window prunes what fell outside it, so the setting
        // always describes what the sidebar shows.
        outcome.pruned += prune(database, workspaces, provider, Some(&cutoff_iso))?;
        let discovered = claude::discover(home, cutoff_ms);
        let swept = sweep_provider(database, workspaces, provider, discovered)?;
        outcome.imported += swept.imported;
        outcome.extended += swept.extended;
        outcome.pruned += swept.pruned;
    }
    Ok(outcome)
}

fn sweep_provider(
    database: &Database,
    workspaces: &Arc<WorkspaceService>,
    provider: &str,
    discovered: Vec<DiscoveredSession>,
) -> ArgmaxResult<SyncOutcome> {
    let mut outcome = SyncOutcome::default();

    // Registered project roots, longest first, so a project nested inside
    // another claims its own sessions.
    let mut project_roots: Vec<(String, PathBuf)> = {
        let connection = database.connection();
        list_projects(&connection)?
            .into_iter()
            .map(|project| (project.id, PathBuf::from(project.repo_path)))
            .collect()
    };
    project_roots.sort_by_key(|(_, path)| std::cmp::Reverse(path.as_os_str().len()));

    let (known_ids, existing) = {
        let connection = database.connection();
        (
            known_conversation_ids(&connection, provider)?,
            list_synced_sessions(&connection, provider)?,
        )
    };
    let existing_by_external: HashMap<&str, &SyncedSessionRecord> = existing
        .iter()
        .map(|record| (record.external_id.as_str(), record))
        .collect();

    for session in discovered {
        let Some(project_id) = owning_project(&project_roots, &session.cwd) else {
            // Sessions outside every registered project are not this app's
            // business — that filter is what keeps the sweep small.
            continue;
        };

        match existing_by_external.get(session.external_id.as_str()) {
            Some(record) => {
                if record.source_mtime_ms >= session.source_mtime_ms {
                    continue;
                }
                if extend(database, workspaces, record, &session)? {
                    outcome.extended += 1;
                }
            }
            None => {
                // A conversation id Argmax already owns is a session it
                // launched itself; importing it would duplicate it.
                if known_ids.contains(&session.external_id) {
                    continue;
                }
                import(database, workspaces, provider, &project_id, &session)?;
                outcome.imported += 1;
            }
        }
    }

    // An import whose transcript disappeared has nothing left to project.
    let mut vanished = Vec::new();
    for record in &existing {
        if !record.adopted && !Path::new(&record.source_path).exists() {
            vanished.push(record.session_id.clone());
        }
    }
    outcome.pruned += delete_sessions(database, workspaces, &vanished)?;
    Ok(outcome)
}

fn owning_project(roots: &[(String, PathBuf)], cwd: &Path) -> Option<String> {
    roots
        .iter()
        .find(|(_, root)| cwd == root || cwd.starts_with(root))
        .map(|(id, _)| id.clone())
}

fn import(
    database: &Database,
    workspaces: &Arc<WorkspaceService>,
    provider: &str,
    project_id: &str,
    session: &DiscoveredSession,
) -> ArgmaxResult<()> {
    // One workspace per imported session, at the project's own checkout —
    // the same shape Argmax uses for its own current-checkout sessions, so
    // the sidebar lists them as ordinary rows.
    let workspace = workspaces.create_current_for_import(project_id, &session.prompt)?;

    let connection = database.connection();
    let summary = persist_imported_session(
        &connection,
        &PersistImportedSessionInput {
            id: Uuid::new_v4().to_string(),
            workspace_id: workspace.id.clone(),
            provider: provider.to_string(),
            model_label: model_label(session, provider),
            model_id: model_id(session, provider),
            provider_conversation_id: session.external_id.clone(),
            prompt: session.prompt.clone(),
            started_at: session.started_at.clone(),
            last_activity_at: session.last_activity_at.clone(),
        },
    )?;
    let written = write_events(&connection, provider, &summary.id, session, 0)?;
    upsert_synced_session(
        &connection,
        &SyncedSessionRecord {
            session_id: summary.id.clone(),
            provider: provider.to_string(),
            external_id: session.external_id.clone(),
            source_path: session.source_path.to_string_lossy().to_string(),
            byte_cursor: written as u64,
            source_mtime_ms: session.source_mtime_ms,
            adopted: false,
            started_at: session.started_at.clone(),
        },
    )?;
    drop(connection);

    workspaces.publish_imported(workspace, summary);
    Ok(())
}

/// Append transcript lines written since the last sweep.
fn extend(
    database: &Database,
    workspaces: &Arc<WorkspaceService>,
    record: &SyncedSessionRecord,
    session: &DiscoveredSession,
) -> ArgmaxResult<bool> {
    let connection = database.connection();
    let written = write_events(
        &connection,
        &record.provider,
        &record.session_id,
        session,
        record.byte_cursor as usize,
    )?;
    let summary =
        touch_imported_session(&connection, &record.session_id, &session.last_activity_at)?;
    upsert_synced_session(
        &connection,
        &SyncedSessionRecord {
            // `write_events` returns an absolute line index, not a count:
            // adding the old cursor to it would make the cursor run away and
            // skip every line after the second sweep.
            byte_cursor: written as u64,
            source_mtime_ms: session.source_mtime_ms,
            source_path: session.source_path.to_string_lossy().to_string(),
            ..record.clone()
        },
    )?;
    drop(connection);

    // The cursor standing still means the file grew with rows this sweep
    // skips (sidechains), so there is nothing new to show.
    if written == record.byte_cursor as usize {
        return Ok(false);
    }
    workspaces.publish_session(summary);
    Ok(true)
}

/// Normalize transcript lines into timeline events. Returns how many lines
/// were consumed, which becomes the next read's starting point.
fn write_events(
    connection: &rusqlite::Connection,
    provider: &str,
    session_id: &str,
    session: &DiscoveredSession,
    from_line: usize,
) -> ArgmaxResult<usize> {
    let provider_id = match provider {
        "claude" => crate::ipc::validation::ProviderId::Claude,
        _ => return Ok(from_line),
    };
    let lines = claude::timeline_lines(&session.source_path, from_line);
    let mut context = NormalizerSessionContext::default();
    let mut highest_line = from_line;

    for (line_number, line) in lines {
        highest_line = line_number + 1;
        let output = ProviderOutputEvent {
            session_id: session_id.to_string(),
            stream: ProviderOutputStream::Stdout,
            message: line,
            created_at: session.last_activity_at.clone(),
        };
        let normalized = normalize_provider_event(provider_id, &output, &mut context);
        for (index, mut event) in normalized.events.into_iter().enumerate() {
            // Deterministic ids: re-reading a transcript must never duplicate
            // a bubble, whatever the cursor says.
            event.id = format!(
                "sync:{provider}:{}:{line_number}:{index}",
                session.external_id
            );
            persist_timeline_event_if_absent(connection, &event)?;
        }
    }
    Ok(highest_line)
}

fn prune(
    database: &Database,
    workspaces: &Arc<WorkspaceService>,
    provider: &str,
    before: Option<&str>,
) -> ArgmaxResult<u32> {
    let ids = {
        let connection = database.connection();
        prunable_session_ids(&connection, provider, before)?
    };
    delete_sessions(database, workspaces, &ids)
}

fn delete_sessions(
    database: &Database,
    workspaces: &Arc<WorkspaceService>,
    session_ids: &[String],
) -> ArgmaxResult<u32> {
    if session_ids.is_empty() {
        return Ok(0);
    }
    let mut removed_workspaces = Vec::new();
    {
        let connection = database.connection();
        for session_id in session_ids {
            if let Ok(summary) =
                crate::persistence::sessions::find_session_by_id(&connection, session_id)
            {
                removed_workspaces.push(summary.workspace_id);
            }
            delete_session(&connection, session_id)?;
        }
        // The workspace exists only to host the import; deleting the session
        // first keeps the cascade from taking an adopted sibling with it.
        for workspace_id in &removed_workspaces {
            crate::persistence::workspaces::delete_workspace(&connection, workspace_id)?;
        }
    }
    // The workspace was created solely to host the import, so it goes too.
    workspaces.remove_imported(&removed_workspaces, session_ids);
    Ok(session_ids.len() as u32)
}

/// Sidebar label for the model the transcript was produced with. Rust has no
/// model catalog (labels live in `src/shared/providerModels.ts`), so the raw
/// id is the honest fallback.
fn model_label(session: &DiscoveredSession, provider: &str) -> String {
    session
        .model_id
        .clone()
        .unwrap_or_else(|| crate::provider_defaults(provider).model_label.to_string())
}

/// The model to resume the imported conversation with. A transcript swept up
/// between the prompt and its first assistant chunk carries no model id yet,
/// and an empty one is not a launchable session — the CLI rejects
/// `--model ''` — so the provider default stands in.
fn model_id(session: &DiscoveredSession, provider: &str) -> String {
    session
        .model_id
        .clone()
        .unwrap_or_else(|| crate::provider_defaults(provider).model_id.to_string())
}

fn iso_from_ms(ms: i64) -> String {
    chrono::DateTime::from_timestamp_millis(ms)
        .map(|time| time.to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
        .unwrap_or_default()
}
