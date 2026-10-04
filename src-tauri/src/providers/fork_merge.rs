//! Bringing a fork's findings back to the chat it came from
//! (docs/workspaces.md#bringing-findings-back).
//!
//! The merge is context, never a git merge and never a file restore: the
//! visible messages the fork added since the fork point (or since its last
//! merge) are sent to the source as its next message. A running source queues
//! it through the ordinary follow-up queue, never as steering.
//!
//! A merge claims a range in `fork_merges` before it sends. The unique
//! `(fork, through event)` key makes a repeated click a no-op, and a claim
//! whose outcome is unknown still counts as merged, so an uncertain delivery is
//! never repeated on its own. A claim whose message never became a source
//! message (refused, or the queued message was deleted) is withdrawn the next
//! time the fork is read for a merge, and its range is offered again, even when
//! later ranges were claimed after it.
//!
//! Positions are the fork's *visible* messages (the same rows a provider
//! handoff reads), not its newest row of any kind: trace rows are rewritten
//! after the fact and must never be a cursor.

use std::{
    collections::HashSet,
    sync::{Arc, LazyLock, Mutex},
};

use rusqlite::Connection;
use serde::Serialize;
use specta::Type;

use super::{
    follow_up::{is_visible_event, newest_visible_event, visible_messages_after},
    inputs::ProvidersSendInput,
    session_service::{MessageOrigin, ProviderSessionService, SendInputResult},
};
use crate::{
    application::validation::{Prompt, SessionId},
    error::{ArgmaxError, ArgmaxResult},
    persistence::{
        continuity::{
            event_rowid, fork_for_child, latest_merge, list_merges, mark_merge_sent,
            merge_delivery_target, release_merge, reserve_merge, ForkMerge, ForkRecord,
            MergeOutcome,
        },
        database::Database,
        sessions::find_session_by_id,
        sqlite_error,
        workspaces::find_workspace_by_id,
    },
};

const MERGE_MAX_MESSAGES: usize = 40;
/// Visible characters a merge carries. Older lines drop first and the message
/// points at the fork for the rest.
const MERGE_MAX_CHARS: usize = 24_000;

/// Merges whose send is running in this process. Everything else that is still
/// `sending` was left by a crash or is waiting in the source's queue.
static IN_FLIGHT: LazyLock<Mutex<HashSet<String>>> = LazyLock::new(Mutex::default);

/// Keeps a claim out of reconciliation while its send runs.
#[derive(Debug)]
pub struct InFlight(String);

impl InFlight {
    /// Keyed by the marker, not the row id: a claim copied onto a moved fork has
    /// a new row id and the same marker, and the send is the same send.
    fn begin(marker_id: &str) -> Self {
        IN_FLIGHT
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .insert(marker_id.to_string());
        Self(marker_id.to_string())
    }
}

impl Drop for InFlight {
    fn drop(&mut self) {
        IN_FLIGHT
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .remove(&self.0);
    }
}

fn is_in_flight(marker_id: &str) -> bool {
    IN_FLIGHT
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .contains(marker_id)
}

#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ForkMergePreview {
    pub fork_id: String,
    pub child_session_id: String,
    pub source_session_id: String,
    pub child_label: String,
    pub source_label: String,
    /// The user message the fork started from, shortened. `None` for a fork of
    /// the whole chat.
    pub boundary_excerpt: Option<String>,
    /// The fork message this merge reaches. Pass it back to confirm.
    pub through_event_id: Option<String>,
    /// Visible messages the fork added that no merge has carried yet.
    pub new_message_count: i64,
    pub shown_message_count: usize,
    pub truncated: bool,
    /// What the source would receive, minus the footer naming the merge.
    pub text: String,
    pub nothing_new: bool,
    /// The fork is still working, so its findings are incomplete.
    pub child_active: bool,
    /// The source is mid-turn; the message waits in its queue.
    pub source_busy: bool,
    /// A merge whose delivery is not confirmed yet.
    pub unconfirmed_merge_id: Option<String>,
    pub last_merged_through_event_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ForkMergeResult {
    /// False when this range was already merged and nothing was sent.
    pub merged: bool,
    pub queued: bool,
    pub merge_id: Option<String>,
    pub through_event_id: String,
}

#[derive(Debug)]
struct MergeRange {
    from_event_id: Option<String>,
    from_rowid: i64,
    through_event_id: String,
    through_rowid: i64,
}

fn is_active(state: &str) -> bool {
    matches!(state, "running" | "waiting" | "blocked")
}

fn merge_marker(merge_id: &str) -> String {
    format!("Argmax fork merge {merge_id}")
}

fn fork_of(connection: &Connection, child_session_id: &str) -> ArgmaxResult<ForkRecord> {
    fork_for_child(connection, child_session_id)?.ok_or_else(|| {
        ArgmaxError::service(
            "FORK_NOT_FOUND",
            "This chat was not forked from another chat.",
        )
    })
}

fn source_of(fork: &ForkRecord) -> ArgmaxResult<&str> {
    fork.source_session_id.as_deref().ok_or_else(|| {
        ArgmaxError::service(
            "FORK_SOURCE_GONE",
            "The chat this one was forked from no longer exists.",
        )
    })
}

/// Where a marker stands in the source: delivered as a message, waiting in its
/// queue, or nowhere.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Standing {
    Delivered,
    Queued,
    Absent,
}

fn standing(
    connection: &Connection,
    source_session_id: &str,
    marker: &str,
) -> ArgmaxResult<Standing> {
    let delivered: bool = connection
        .query_row(
            "SELECT EXISTS (SELECT 1 FROM events WHERE session_id = ?1 \
             AND type = 'user.message' AND instr(message, ?2) > 0)",
            rusqlite::params![source_session_id, marker],
            |row| row.get(0),
        )
        .map_err(sqlite_error)?;
    if delivered {
        return Ok(Standing::Delivered);
    }
    let queued: bool = connection
        .query_row(
            "SELECT EXISTS (SELECT 1 FROM pending_messages WHERE session_id = ?1 \
             AND instr(content, ?2) > 0)",
            rusqlite::params![source_session_id, marker],
            |row| row.get(0),
        )
        .map_err(sqlite_error)?;
    Ok(if queued {
        Standing::Queued
    } else {
        Standing::Absent
    })
}

/// A claim that still holds its range.
#[derive(Debug)]
struct LiveClaim {
    merge: ForkMerge,
    from_rowid: i64,
    through_rowid: i64,
    /// Not yet a source message.
    sending: bool,
}

/// The claims that still hold ranges. A `sending` claim nobody is sending is
/// settled against the source: delivered ones become `sent`, queued ones stay,
/// and the rest are withdrawn. With `write` false nothing is changed, and a
/// withdrawn claim is only left out of the answer.
fn live_claims(
    connection: &Connection,
    fork: &ForkRecord,
    base_rowid: i64,
    write: bool,
) -> ArgmaxResult<Vec<LiveClaim>> {
    let mut live = Vec::new();
    for merge in list_merges(connection, &fork.id)? {
        let mut sending = merge.outcome == MergeOutcome::Sending;
        if sending && !is_in_flight(&merge.marker_id) {
            if let Some(source) = fork.source_session_id.as_deref() {
                match standing(connection, source, &merge_marker(&merge.marker_id))? {
                    Standing::Delivered => {
                        if write {
                            mark_merge_sent(connection, &merge.id)?;
                        }
                        sending = false;
                    }
                    Standing::Queued => {}
                    Standing::Absent => {
                        if write {
                            release_merge(connection, &merge.id)?;
                        }
                        continue;
                    }
                }
            }
        }
        let from_rowid = match &merge.from_event_id {
            Some(event_id) => event_rowid(connection, event_id)?.unwrap_or(base_rowid),
            None => base_rowid,
        };
        let Some(through_rowid) = event_rowid(connection, &merge.through_event_id)? else {
            continue;
        };
        live.push(LiveClaim {
            merge,
            from_rowid,
            through_rowid,
            sending,
        });
    }
    Ok(live)
}

/// The earliest range no live claim covers: the first gap after the copied
/// prefix, or everything after the last claim. A withdrawn older claim leaves a
/// gap below newer ones, and that gap is offered before anything newer.
fn pending_range(
    connection: &Connection,
    fork: &ForkRecord,
    claims: &[LiveClaim],
) -> ArgmaxResult<Option<MergeRange>> {
    let base_event_id = fork.child_base_event_id.clone();
    let base_rowid = match &base_event_id {
        Some(event_id) => event_rowid(connection, event_id)?.ok_or_else(|| {
            ArgmaxError::service(
                "FORK_CURSOR_MISSING",
                "The fork's merge position no longer exists in its transcript.",
            )
        })?,
        None => 0,
    };
    let mut ordered: Vec<&LiveClaim> = claims.iter().collect();
    ordered.sort_by_key(|claim| (claim.from_rowid, claim.through_rowid));
    let (mut covered, mut covered_event) = (base_rowid, base_event_id);
    for claim in ordered {
        if claim.from_rowid <= covered {
            if claim.through_rowid > covered {
                covered = claim.through_rowid;
                covered_event = Some(claim.merge.through_event_id.clone());
            }
            continue;
        }
        // A hole between the claims: its far end is where the next claim began.
        let Some(next_from) = claim.merge.from_event_id.clone() else {
            continue;
        };
        return Ok(Some(MergeRange {
            from_event_id: covered_event,
            from_rowid: covered,
            through_event_id: next_from,
            through_rowid: claim.from_rowid,
        }));
    }
    let Some((newest_rowid, newest_id)) = newest_visible_event(connection, &fork.child_session_id)?
    else {
        return Ok(None);
    };
    if newest_rowid <= covered {
        return Ok(None);
    }
    Ok(Some(MergeRange {
        from_event_id: covered_event,
        from_rowid: covered,
        through_event_id: newest_id,
        through_rowid: newest_rowid,
    }))
}

struct Draft {
    text: String,
    new_message_count: i64,
    shown: usize,
    truncated: bool,
}

fn excerpt(text: &str) -> String {
    let flat = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if flat.chars().count() <= 80 {
        return flat;
    }
    format!("{}…", flat.chars().take(80).collect::<String>())
}

fn boundary_excerpt(connection: &Connection, fork: &ForkRecord) -> ArgmaxResult<Option<String>> {
    let (Some(boundary), Some(source)) = (&fork.boundary_event_id, &fork.source_session_id) else {
        return Ok(None);
    };
    Ok(connection
        .query_row(
            "SELECT message FROM events WHERE id = ?1 AND session_id = ?2",
            rusqlite::params![boundary, source],
            |row| row.get::<_, String>(0),
        )
        .ok()
        .map(|message| excerpt(&message)))
}

fn draft(
    connection: &Connection,
    fork: &ForkRecord,
    range: &MergeRange,
    child_label: &str,
) -> ArgmaxResult<Draft> {
    let (mut lines, total) = visible_messages_after(
        connection,
        &fork.child_session_id,
        range.from_rowid,
        range.through_rowid,
        MERGE_MAX_MESSAGES,
    )?;
    let mut chars = lines.iter().map(String::len).sum::<usize>();
    while chars > MERGE_MAX_CHARS && lines.len() > 1 {
        chars -= lines[0].len() + 1;
        lines.remove(0);
    }
    let truncated = (lines.len() as i64) < total;
    let origin = match boundary_excerpt(connection, fork)? {
        Some(boundary) => format!("forked from this chat at \"{boundary}\""),
        None => "forked from this chat".to_string(),
    };
    let since = if range.from_event_id.as_deref() == fork.child_base_event_id.as_deref() {
        "since the fork"
    } else {
        "since the last merge"
    };
    let omitted = if truncated {
        format!(
            "\n({} earlier message(s) are not shown. Read them with session_read on session {}.)",
            total - lines.len() as i64,
            fork.child_session_id
        )
    } else {
        String::new()
    };
    let text = format!(
        "Findings from the forked chat \"{child_label}\" ({origin}), {} message(s) {since}:\n\n{}{omitted}",
        lines.len(),
        lines.join("\n")
    );
    Ok(Draft {
        text,
        new_message_count: total,
        shown: lines.len(),
        truncated,
    })
}

/// What a merge click would send, or that there is nothing to send. Reads only:
/// a claim that should be withdrawn is left out of the answer, and withdrawn
/// for real by the next confirm.
pub fn preview(database: &Database, child_session_id: &str) -> ArgmaxResult<ForkMergePreview> {
    let connection = database.read_connection();
    let fork = fork_of(&connection, child_session_id)?;
    let source_session_id = source_of(&fork)?.to_string();
    let child = find_session_by_id(&connection, &fork.child_session_id)?;
    let source = find_session_by_id(&connection, &source_session_id)?;
    let child_label = find_workspace_by_id(&connection, &child.workspace_id)?.task_label;
    let source_label = find_workspace_by_id(&connection, &source.workspace_id)?.task_label;
    let base_rowid = match &fork.child_base_event_id {
        Some(event_id) => event_rowid(&connection, event_id)?.unwrap_or(0),
        None => 0,
    };
    let claims = live_claims(&connection, &fork, base_rowid, false)?;
    let range = pending_range(&connection, &fork, &claims)?;
    let drafted = range
        .as_ref()
        .map(|range| draft(&connection, &fork, range, &child_label))
        .transpose()?;
    let last = latest_merge(&connection, &fork.id)?;
    let unconfirmed = claims
        .iter()
        .find(|claim| claim.sending)
        .map(|claim| claim.merge.id.clone());
    Ok(ForkMergePreview {
        fork_id: fork.id.clone(),
        child_session_id: fork.child_session_id.clone(),
        source_session_id,
        child_label,
        source_label,
        boundary_excerpt: boundary_excerpt(&connection, &fork)?,
        through_event_id: range.map(|range| range.through_event_id),
        new_message_count: drafted.as_ref().map_or(0, |d| d.new_message_count),
        shown_message_count: drafted.as_ref().map_or(0, |d| d.shown),
        truncated: drafted.as_ref().is_some_and(|d| d.truncated),
        nothing_new: drafted.is_none(),
        text: drafted.map(|d| d.text).unwrap_or_default(),
        child_active: is_active(child.state.as_str()),
        source_busy: is_active(source.state.as_str()),
        unconfirmed_merge_id: unconfirmed,
        last_merged_through_event_id: last.map(|merge| merge.through_event_id),
    })
}

/// How a claim differs from the person's click in the app.
#[derive(Debug, Default)]
pub struct ClaimOptions {
    /// Words placed ahead of the findings.
    pub note: Option<String>,
    /// The fork's own agent is asking, mid-turn: its running state is expected.
    pub from_inside_fork: bool,
}

/// What a confirmed merge click turned into.
#[derive(Debug)]
pub enum Claim {
    /// This range was already merged (or nothing is new): send nothing.
    AlreadyMerged,
    Claimed {
        source_session_id: String,
        child_session_id: String,
        child_label: String,
        merge_id: String,
        text: String,
        /// Held until the send settles.
        in_flight: InFlight,
    },
}

/// Reserve the previewed range. `through_event_id` is what the preview showed;
/// the message is rebuilt from the cursor, so it always carries exactly what no
/// earlier merge did, and never reaches past what the person saw.
pub fn claim_range(
    database: &Database,
    child_session_id: &str,
    through_event_id: &str,
    options: &ClaimOptions,
) -> ArgmaxResult<Claim> {
    // The cursor read and the claim happen under one writer lock, so two
    // clicks cannot both claim the same events.
    let connection = database.connection();
    let fork = fork_of(&connection, child_session_id)?;
    let source_session_id = source_of(&fork)?.to_string();
    let child = find_session_by_id(&connection, &fork.child_session_id)?;
    if is_active(child.state.as_str()) && !options.from_inside_fork {
        return Err(ArgmaxError::service(
            "FORK_MERGE_CHILD_ACTIVE",
            "The fork is still working. Wait for it to finish, then bring its findings back.",
        ));
    }
    let child_label = find_workspace_by_id(&connection, &child.workspace_id)?.task_label;
    let base_rowid = match &fork.child_base_event_id {
        Some(event_id) => event_rowid(&connection, event_id)?.unwrap_or(0),
        None => 0,
    };
    let claims = live_claims(&connection, &fork, base_rowid, true)?;
    let Some(mut range) = pending_range(&connection, &fork, &claims)? else {
        return Ok(Claim::AlreadyMerged);
    };
    let requested = event_rowid(&connection, through_event_id)?.ok_or_else(|| {
        ArgmaxError::service(
            "FORK_MERGE_STALE",
            "That fork position is gone. Preview the merge again.",
        )
    })?;
    let in_fork: bool = connection
        .query_row(
            "SELECT EXISTS (SELECT 1 FROM events WHERE id = ?1 AND session_id = ?2)",
            rusqlite::params![through_event_id, fork.child_session_id],
            |row| row.get(0),
        )
        .map_err(sqlite_error)?;
    // Only a visible message is a position a preview can name. A trace row
    // can be rewritten away later, which would withdraw the claim.
    if !in_fork || !is_visible_event(&connection, &fork.child_session_id, through_event_id)? {
        return Err(ArgmaxError::service(
            "FORK_MERGE_STALE",
            "That position is not a message in this fork. Preview the merge again.",
        ));
    }
    if requested <= range.from_rowid {
        return Ok(Claim::AlreadyMerged);
    }
    // Never past what was previewed, and never past the range that is open now
    // (a hole below a newer claim ends where that claim began).
    if requested < range.through_rowid {
        range.through_event_id = through_event_id.to_string();
        range.through_rowid = requested;
    }
    let Some(claim) = reserve_merge(
        &connection,
        &fork.id,
        range.from_event_id.as_deref(),
        &range.through_event_id,
    )?
    else {
        return Ok(Claim::AlreadyMerged);
    };
    let in_flight = InFlight::begin(&claim.marker_id);
    let drafted = draft(&connection, &fork, &range, &child_label)?;
    let findings = format!("{}\n\n— {}", drafted.text, merge_marker(&claim.marker_id));
    Ok(Claim::Claimed {
        source_session_id,
        child_session_id: fork.child_session_id,
        child_label,
        text: match &options.note {
            Some(note) => format!("{note}\n\n{findings}"),
            None => findings,
        },
        merge_id: claim.id,
        in_flight,
    })
}

/// How a claim's send ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Settled {
    /// The source took it as a turn.
    Sent,
    /// It waits in the source's queue; the claim holds until it is delivered or
    /// deleted.
    Queued,
    /// The send reported an error but the message is in the source anyway.
    DeliveredDespiteError,
    /// The source never admitted it, so the range is free again.
    Released,
}

/// Record how the send ended. An error does not mean the message is missing:
/// the source may have persisted it before failing, in which case the range
/// stays merged.
pub fn settle_claim(
    database: &Database,
    merge_id: &str,
    sent: &ArgmaxResult<SendInputResult>,
) -> ArgmaxResult<Settled> {
    let connection = database.connection();
    match sent {
        Ok(result) if !result.queued => {
            mark_merge_sent(&connection, merge_id)?;
            Ok(Settled::Sent)
        }
        Ok(_) => Ok(Settled::Queued),
        Err(_) => {
            let seen = match merge_delivery_target(&connection, merge_id)? {
                Some((source, marker)) => standing(&connection, &source, &merge_marker(&marker))?,
                None => Standing::Absent,
            };
            match seen {
                Standing::Delivered => {
                    mark_merge_sent(&connection, merge_id)?;
                    Ok(Settled::DeliveredDespiteError)
                }
                Standing::Queued => Ok(Settled::Queued),
                Standing::Absent => {
                    release_merge(&connection, merge_id)?;
                    Ok(Settled::Released)
                }
            }
        }
    }
}

/// Send the previewed range to the source as its next message.
pub async fn confirm(
    database: &Arc<Database>,
    providers: &Arc<ProviderSessionService>,
    child_session_id: &str,
    through_event_id: &str,
    options: ClaimOptions,
) -> ArgmaxResult<ForkMergeResult> {
    let claim = {
        let database = Arc::clone(database);
        let (child, through) = (child_session_id.to_string(), through_event_id.to_string());
        tauri::async_runtime::spawn_blocking(move || {
            claim_range(&database, &child, &through, &options)
        })
        .await
        .map_err(|error| ArgmaxError::service("FORK_MERGE_JOIN", error.to_string()))??
    };
    let Claim::Claimed {
        source_session_id,
        child_session_id,
        child_label,
        merge_id,
        text,
        in_flight,
    } = claim
    else {
        return Ok(ForkMergeResult {
            merged: false,
            queued: false,
            merge_id: None,
            through_event_id: through_event_id.to_string(),
        });
    };
    let input = ProvidersSendInput {
        session_id: SessionId::try_from(source_session_id)
            .map_err(|_| ArgmaxError::service("FORK_MERGE_SOURCE", "Invalid source id."))?,
        input: Prompt::try_from(text)
            .map_err(|_| ArgmaxError::service("FORK_MERGE_TEXT", "Invalid merge text."))?,
        provider: None,
        model_label: None,
        model_id: None,
        reasoning_effort: None,
        fast_mode: false,
        agent_mode: None,
        attachments: None,
        agent_references: None,
    };
    // `Queue`, not agent steering: a running source takes this after its turn.
    let sent = providers
        .send_input_with_origin(
            input,
            Some(MessageOrigin {
                session_id: child_session_id,
                label: child_label,
                kind: "message".to_string(),
                message_id: None,
            }),
        )
        .await;
    let settled = settle_claim(database, &merge_id, &sent);
    drop(in_flight);
    finish(sent, settled, merge_id, through_event_id)
}

/// What the click reports. The send's own error is the one to report: a claim
/// that could not be settled is left `sending` and is settled by its marker on
/// the next read, and a message that reached the source despite the error still
/// counts as merged.
fn finish(
    sent: ArgmaxResult<SendInputResult>,
    settled: ArgmaxResult<Settled>,
    merge_id: String,
    through_event_id: &str,
) -> ArgmaxResult<ForkMergeResult> {
    let queued = match sent {
        Ok(result) => result.queued,
        Err(error) => match &settled {
            Err(_) | Ok(Settled::Released) => return Err(error),
            Ok(_) => false,
        },
    };
    if let Err(error) = settled {
        tracing::warn!(?error, "could not record a delivered fork merge");
    }
    Ok(ForkMergeResult {
        merged: true,
        queued,
        merge_id: Some(merge_id),
        through_event_id: through_event_id.to_string(),
    })
}

#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ForkLineage {
    pub fork_id: String,
    pub source_session_id: Option<String>,
    pub boundary_event_id: Option<String>,
    /// `shared` or `isolated`.
    pub workspace: String,
    pub last_merged_through_event_id: Option<String>,
}

/// Where a chat came from, or `None` when it is not a fork. Cheap enough for
/// the renderer to ask whenever a chat opens.
pub fn lineage(database: &Database, session_id: &str) -> ArgmaxResult<Option<ForkLineage>> {
    let connection = database.read_connection();
    let Some(fork) = fork_for_child(&connection, session_id)? else {
        return Ok(None);
    };
    let last = latest_merge(&connection, &fork.id)?;
    Ok(Some(ForkLineage {
        fork_id: fork.id,
        source_session_id: fork.source_session_id,
        boundary_event_id: fork.boundary_event_id,
        workspace: fork.workspace_mode,
        last_merged_through_event_id: last.map(|merge| merge.through_event_id),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::persistence::{
        continuity::{latest_merge, MergeOutcome},
        sessions::update_session_provider_conversation_id,
    };
    use crate::providers::continuity_tests::{event, seed_session};
    use crate::providers::session_service::SendInputResult;
    use crate::workspaces::orchestration::fork::ForkRequest;
    use crate::workspaces::WorkspaceService;

    /// A source with two turns and a fork of it that did new work.
    async fn forked() -> (Arc<Database>, String) {
        let database = Arc::new(Database::open_in_memory().expect("database"));
        {
            let connection = database.connection();
            seed_session(&connection, "claude");
            for turn in 1..=2 {
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
            update_session_provider_conversation_id(&connection, "s1", "claude-conv").unwrap();
        }
        let service = WorkspaceService::new(Arc::clone(&database));
        let forked = service
            .fork_session_at(ForkRequest {
                session_id: "s1".to_string(),
                boundary_event_id: Some("u1".to_string()),
                workspace: crate::ipc::inputs::ForkWorkspaceMode::Shared,
            })
            .await
            .unwrap();
        (database, forked.session.id)
    }

    fn child_work(database: &Database, child: &str, tag: &str) -> String {
        let connection = database.connection();
        let through = format!("{tag}-a");
        event(
            &connection,
            child,
            &format!("{tag}-u"),
            "user.message",
            &format!("explore {tag}"),
        );
        event(
            &connection,
            child,
            &through,
            "message.completed",
            &format!("found {tag}"),
        );
        through
    }

    fn claimed_text(claim: Claim) -> (String, String) {
        match claim {
            Claim::Claimed { text, merge_id, .. } => (text, merge_id),
            Claim::AlreadyMerged => panic!("expected a claim"),
        }
    }

    fn sent() -> ArgmaxResult<SendInputResult> {
        Ok(SendInputResult {
            ok: true,
            queued: false,
        })
    }

    #[tokio::test]
    async fn the_preview_names_the_source_the_boundary_and_only_the_forks_own_work() {
        let (database, child) = forked().await;
        assert!(preview(&database, &child).unwrap().nothing_new);
        let through = child_work(&database, &child, "one");

        let shown = preview(&database, &child).unwrap();
        assert!(!shown.nothing_new);
        assert_eq!(shown.source_session_id, "s1");
        assert_eq!(shown.boundary_excerpt.as_deref(), Some("ask 1"));
        assert_eq!(shown.through_event_id.as_deref(), Some(through.as_str()));
        assert_eq!(shown.new_message_count, 2);
        assert!(shown.text.contains("User: explore one"));
        assert!(shown.text.contains("Assistant: found one"));
        // The copied prefix is the source's own history, not a finding.
        assert!(!shown.text.contains("User: ask 1") && !shown.text.contains("Assistant: answer 1"));
        assert!(shown.text.contains("forked from this chat at \"ask 1\""));
    }

    #[tokio::test]
    async fn confirming_twice_sends_once() {
        let (database, child) = forked().await;
        let through = child_work(&database, &child, "one");

        let (text, merge_id) = claimed_text(
            claim_range(&database, &child, &through, &ClaimOptions::default()).unwrap(),
        );
        assert!(text.contains("found one"));
        assert!(text.ends_with(&format!("— Argmax fork merge {merge_id}")));
        settle_claim(&database, &merge_id, &sent()).unwrap();

        assert!(matches!(
            claim_range(&database, &child, &through, &ClaimOptions::default()).unwrap(),
            Claim::AlreadyMerged
        ));
        // Reading the fork changes nothing; the next merge confirms the claim.
        assert!(preview(&database, &child).unwrap().nothing_new);
        assert!(matches!(
            claim_range(&database, &child, &through, &ClaimOptions::default()).unwrap(),
            Claim::AlreadyMerged
        ));
        let connection = database.connection();
        let fork = fork_for_child(&connection, &child).unwrap().unwrap();
        assert_eq!(
            latest_merge(&connection, &fork.id)
                .unwrap()
                .unwrap()
                .outcome,
            MergeOutcome::Sent
        );
    }

    #[tokio::test]
    async fn a_later_merge_carries_only_the_new_range() {
        let (database, child) = forked().await;
        let first = child_work(&database, &child, "one");
        let (_, first_id) =
            claimed_text(claim_range(&database, &child, &first, &ClaimOptions::default()).unwrap());
        settle_claim(&database, &first_id, &sent()).unwrap();

        let second = child_work(&database, &child, "two");
        let shown = preview(&database, &child).unwrap();
        assert_eq!(shown.new_message_count, 2);
        assert!(shown.text.contains("explore two"));
        assert!(!shown.text.contains("explore one"));
        assert!(shown.text.contains("since the last merge"));
        let (text, second_id) = claimed_text(
            claim_range(&database, &child, &second, &ClaimOptions::default()).unwrap(),
        );
        assert!(text.contains("found two") && !text.contains("found one"));
        settle_claim(&database, &second_id, &sent()).unwrap();
        assert!(preview(&database, &child).unwrap().nothing_new);
    }

    #[tokio::test]
    async fn a_merge_never_reaches_past_the_position_that_was_previewed() {
        let (database, child) = forked().await;
        let previewed = child_work(&database, &child, "one");
        child_work(&database, &child, "two");

        let (text, merge_id) = claimed_text(
            claim_range(&database, &child, &previewed, &ClaimOptions::default()).unwrap(),
        );
        assert!(text.contains("found one") && !text.contains("found two"));
        settle_claim(&database, &merge_id, &sent()).unwrap();
        // The later work is still waiting for its own preview.
        assert!(!preview(&database, &child).unwrap().nothing_new);
    }

    #[tokio::test]
    async fn a_refused_send_frees_the_range_for_another_try() {
        let (database, child) = forked().await;
        let through = child_work(&database, &child, "one");
        let (_, merge_id) = claimed_text(
            claim_range(&database, &child, &through, &ClaimOptions::default()).unwrap(),
        );
        settle_claim(
            &database,
            &merge_id,
            &Err(ArgmaxError::service("PROVIDER_TERMINATING", "gone")),
        )
        .unwrap();

        let (text, _) = claimed_text(
            claim_range(&database, &child, &through, &ClaimOptions::default()).unwrap(),
        );
        assert!(text.contains("found one"));
    }

    #[tokio::test]
    async fn a_queued_merge_holds_its_claim_until_it_is_deleted_from_the_queue() {
        let (database, child) = forked().await;
        let through = child_work(&database, &child, "one");
        let (text, merge_id) = claimed_text(
            claim_range(&database, &child, &through, &ClaimOptions::default()).unwrap(),
        );
        // Queued behind a running source turn: not delivered, not refused.
        settle_claim(
            &database,
            &merge_id,
            &Ok(SendInputResult {
                ok: true,
                queued: true,
            }),
        )
        .unwrap();
        {
            let connection = database.connection();
            connection
                .execute(
                    "INSERT INTO pending_messages (id, session_id, position, content, agent_mode, queued_at, updated_at) VALUES ('pm1', 's1', 0, ?1, 'auto', '2026-05-24T10:00:00.000Z', '2026-05-24T10:00:00.000Z')",
                    [&text],
                )
                .unwrap();
        }
        // While the message waits in the queue the range stays claimed.
        assert!(matches!(
            claim_range(&database, &child, &through, &ClaimOptions::default()).unwrap(),
            Claim::AlreadyMerged
        ));
        assert!(preview(&database, &child)
            .unwrap()
            .unconfirmed_merge_id
            .is_some());

        // The person discards the queued message: the range is theirs again.
        database
            .connection()
            .execute("DELETE FROM pending_messages", [])
            .unwrap();
        let reread = preview(&database, &child).unwrap();
        assert!(!reread.nothing_new);
        assert!(reread.unconfirmed_merge_id.is_none());
        claimed_text(claim_range(&database, &child, &through, &ClaimOptions::default()).unwrap());
    }

    #[tokio::test]
    async fn a_delivered_queued_merge_is_confirmed_by_its_marker() {
        let (database, child) = forked().await;
        let through = child_work(&database, &child, "one");
        let (text, merge_id) = claimed_text(
            claim_range(&database, &child, &through, &ClaimOptions::default()).unwrap(),
        );
        settle_claim(
            &database,
            &merge_id,
            &Ok(SendInputResult {
                ok: true,
                queued: true,
            }),
        )
        .unwrap();
        {
            let connection = database.connection();
            event(&connection, "s1", "merged-in", "user.message", &text);
        }
        // Reading the fork changes nothing; the next merge confirms the claim.
        assert!(preview(&database, &child).unwrap().nothing_new);
        assert!(matches!(
            claim_range(&database, &child, &through, &ClaimOptions::default()).unwrap(),
            Claim::AlreadyMerged
        ));
        let connection = database.connection();
        let fork = fork_for_child(&connection, &child).unwrap().unwrap();
        assert_eq!(
            latest_merge(&connection, &fork.id)
                .unwrap()
                .unwrap()
                .outcome,
            MergeOutcome::Sent
        );
    }

    fn queue_marker(database: &Database, text: &str) {
        database
            .connection()
            .execute(
                "INSERT INTO pending_messages (id, session_id, position, content, agent_mode, queued_at, updated_at) VALUES (lower(hex(randomblob(8))), 's1', (SELECT COUNT(*) FROM pending_messages), ?1, 'auto', '2026-05-24T10:00:00.000Z', '2026-05-24T10:00:00.000Z')",
                [text],
            )
            .unwrap();
    }

    fn queued() -> ArgmaxResult<SendInputResult> {
        Ok(SendInputResult {
            ok: true,
            queued: true,
        })
    }

    #[tokio::test]
    async fn withdrawing_an_older_queued_merge_offers_its_range_again_before_newer_work() {
        let (database, child) = forked().await;
        let first_through = child_work(&database, &child, "one");
        let (first_text, first_id) = claimed_text(
            claim_range(&database, &child, &first_through, &ClaimOptions::default()).unwrap(),
        );
        settle_claim(&database, &first_id, &queued()).unwrap();
        queue_marker(&database, &first_text);

        let second_through = child_work(&database, &child, "two");
        let (second_text, second_id) = claimed_text(
            claim_range(&database, &child, &second_through, &ClaimOptions::default()).unwrap(),
        );
        settle_claim(&database, &second_id, &queued()).unwrap();
        queue_marker(&database, &second_text);
        assert!(preview(&database, &child).unwrap().nothing_new);

        // The person discards the older queued message only.
        database
            .connection()
            .execute(
                "DELETE FROM pending_messages WHERE instr(content, ?1) > 0",
                [&first_id],
            )
            .unwrap();

        // The newer claim must not hide the older, withdrawn range.
        let shown = preview(&database, &child).unwrap();
        assert!(!shown.nothing_new);
        assert!(shown.text.contains("explore one") && shown.text.contains("found one"));
        assert!(!shown.text.contains("explore two"));
        assert_eq!(
            shown.through_event_id.as_deref(),
            Some(first_through.as_str())
        );
        let (again, _) = claimed_text(
            claim_range(&database, &child, &first_through, &ClaimOptions::default()).unwrap(),
        );
        assert!(again.contains("found one") && !again.contains("found two"));
    }

    #[tokio::test]
    async fn previewing_never_withdraws_a_claim() {
        let (database, child) = forked().await;
        let through = child_work(&database, &child, "one");
        let (_, merge_id) = claimed_text(
            claim_range(&database, &child, &through, &ClaimOptions::default()).unwrap(),
        );
        settle_claim(&database, &merge_id, &queued()).unwrap();
        // Queued and then lost: no marker anywhere.
        let rows = |database: &Database| -> i64 {
            database
                .connection()
                .query_row("SELECT COUNT(*) FROM fork_merges", [], |row| row.get(0))
                .unwrap()
        };
        assert!(!preview(&database, &child).unwrap().nothing_new);
        assert_eq!(rows(&database), 1, "a read must not write");
        claimed_text(claim_range(&database, &child, &through, &ClaimOptions::default()).unwrap());
    }

    #[tokio::test]
    async fn an_error_after_the_message_was_persisted_keeps_the_range_merged() {
        let (database, child) = forked().await;
        let through = child_work(&database, &child, "one");
        let (text, merge_id) = claimed_text(
            claim_range(&database, &child, &through, &ClaimOptions::default()).unwrap(),
        );
        // The source stored the message, then the send failed.
        event(
            &database.connection(),
            "s1",
            "stored",
            "user.message",
            &text,
        );
        let settled = settle_claim(
            &database,
            &merge_id,
            &Err(ArgmaxError::service("PROVIDER_TERMINATING", "gone")),
        )
        .unwrap();
        assert_eq!(settled, Settled::DeliveredDespiteError);
        assert!(matches!(
            claim_range(&database, &child, &through, &ClaimOptions::default()).unwrap(),
            Claim::AlreadyMerged
        ));
    }

    #[tokio::test]
    async fn a_claim_whose_send_is_running_is_never_withdrawn_by_another_reader() {
        let (database, child) = forked().await;
        let through = child_work(&database, &child, "one");
        // Held, as `confirm` holds it, while the send waits on a slow checkout.
        let held = claim_range(&database, &child, &through, &ClaimOptions::default()).unwrap();
        assert!(matches!(
            claim_range(&database, &child, &through, &ClaimOptions::default()).unwrap(),
            Claim::AlreadyMerged
        ));
        assert!(preview(&database, &child).unwrap().nothing_new);
        drop(held);
        // The send never reached the source: now it is withdrawn.
        assert!(!preview(&database, &child).unwrap().nothing_new);
    }

    #[tokio::test]
    async fn a_copy_of_a_claim_whose_send_is_running_is_not_withdrawn_either() {
        use crate::persistence::continuity::{insert_merge, ForkMerge, MergeOutcome};
        let (database, child) = forked().await;
        let first = child_work(&database, &child, "one");
        // The send of this merge is running, as `confirm` holds it.
        let held = claim_range(&database, &child, &first, &ClaimOptions::default()).unwrap();
        let Claim::Claimed { ref merge_id, .. } = held else {
            panic!("expected a claim");
        };
        // A move copies the claim: new row id, same marker, still `sending`.
        let second = child_work(&database, &child, "two");
        let fork_id = {
            let connection = database.connection();
            let fork = fork_for_child(&connection, &child).unwrap().unwrap();
            insert_merge(
                &connection,
                &ForkMerge {
                    id: "copied-row".to_string(),
                    marker_id: merge_id.clone(),
                    fork_id: fork.id.clone(),
                    from_event_id: None,
                    through_event_id: second.clone(),
                    outcome: MergeOutcome::Sending,
                    created_at: "2026-05-24T10:00:00.000Z".to_string(),
                },
            )
            .unwrap();
            fork.id
        };
        let rows = |database: &Database| -> i64 {
            database
                .connection()
                .query_row(
                    "SELECT COUNT(*) FROM fork_merges WHERE fork_id = ?",
                    [&fork_id],
                    |row| row.get(0),
                )
                .unwrap()
        };

        // Another window confirms while the original send is still running. The
        // copy shares the running send's marker, so it must stay claimed.
        claim_range(&database, &child, &second, &ClaimOptions::default()).unwrap();
        assert_eq!(
            rows(&database),
            2,
            "the copy was released under a running send"
        );
        assert!(matches!(
            claim_range(&database, &child, &second, &ClaimOptions::default()).unwrap(),
            Claim::AlreadyMerged
        ));

        // Once the send is over and nothing reached the source, both go.
        drop(held);
        claim_range(&database, &child, &second, &ClaimOptions::default()).unwrap();
        assert_eq!(
            rows(&database),
            1,
            "the claims were not withdrawn after the send"
        );
    }

    #[tokio::test]
    async fn trace_rows_are_never_the_merge_cursor_and_never_offer_an_empty_merge() {
        let (database, child) = forked().await;
        let through = child_work(&database, &child, "one");
        let (_, merge_id) = claimed_text(
            claim_range(&database, &child, &through, &ClaimOptions::default()).unwrap(),
        );
        settle_claim(&database, &merge_id, &sent()).unwrap();

        // A subagent trace import lands after the merge, then is rewritten away.
        {
            let connection = database.connection();
            crate::persistence::events::persist_timeline_event(
                &connection,
                &crate::persistence::events::PersistTimelineEventInput {
                    id: "trace-1".to_string(),
                    session_id: child.clone(),
                    r#type: "tool.completed".to_string(),
                    message: "trace".to_string(),
                    payload: serde_json::json!({"traceImported": true}),
                    created_at: None,
                },
            )
            .unwrap();
        }
        assert!(
            preview(&database, &child).unwrap().nothing_new,
            "a trace row is not a finding"
        );
        database
            .connection()
            .execute("DELETE FROM events WHERE id = 'trace-1'", [])
            .unwrap();
        // The cursor was a visible message, so deleting trace rows breaks nothing.
        assert!(preview(&database, &child).unwrap().nothing_new);
    }

    #[tokio::test]
    async fn a_deleted_source_leaves_the_fork_with_its_history_and_nothing_to_merge_into() {
        let (database, child) = forked().await;
        child_work(&database, &child, "one");
        database
            .connection()
            .execute("DELETE FROM sessions WHERE id = 's1'", [])
            .unwrap();
        let connection = database.connection();
        let fork = fork_for_child(&connection, &child).unwrap().unwrap();
        assert_eq!(fork.source_session_id, None);
        drop(connection);
        assert!(preview(&database, &child)
            .unwrap_err()
            .to_string()
            .contains("no longer exists"));
    }

    #[tokio::test]
    async fn the_forks_own_agent_merges_mid_turn_with_a_note_ahead_of_the_findings() {
        let (database, child) = forked().await;
        let through = child_work(&database, &child, "one");
        database
            .connection()
            .execute(
                "UPDATE sessions SET state = 'running' WHERE id = ?",
                [&child],
            )
            .unwrap();
        let options = ClaimOptions {
            note: Some("Please apply these.".to_string()),
            from_inside_fork: true,
        };
        let (text, merge_id) =
            claimed_text(claim_range(&database, &child, &through, &options).unwrap());
        assert!(text.starts_with("Please apply these.\n\nFindings from the forked chat"));
        assert!(text.ends_with(&format!("— Argmax fork merge {merge_id}")));
    }

    #[tokio::test]
    async fn a_fork_that_is_still_working_cannot_be_merged() {
        let (database, child) = forked().await;
        let through = child_work(&database, &child, "one");
        database
            .connection()
            .execute(
                "UPDATE sessions SET state = 'running' WHERE id = ?",
                [&child],
            )
            .unwrap();
        let error = claim_range(&database, &child, &through, &ClaimOptions::default()).unwrap_err();
        assert!(error.to_string().contains("still working"), "{error}");
        assert!(preview(&database, &child).unwrap().child_active);
    }

    #[tokio::test]
    async fn only_a_visible_message_can_be_the_position_of_a_merge() {
        let (database, child) = forked().await;
        child_work(&database, &child, "one");
        crate::persistence::events::persist_timeline_event(
            &database.connection(),
            &crate::persistence::events::PersistTimelineEventInput {
                id: "trace-in-range".to_string(),
                session_id: child.clone(),
                r#type: "tool.completed".to_string(),
                message: "trace".to_string(),
                payload: serde_json::json!({"traceImported": true}),
                created_at: None,
            },
        )
        .unwrap();
        // A trace row can be rewritten away later, which would withdraw the claim.
        let error = claim_range(
            &database,
            &child,
            "trace-in-range",
            &ClaimOptions::default(),
        )
        .unwrap_err();
        assert!(error.to_string().contains("not a message"), "{error}");
        assert_eq!(
            database
                .connection()
                .query_row("SELECT COUNT(*) FROM fork_merges", [], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            0
        );
    }

    #[test]
    fn a_failed_send_reports_its_own_error_even_when_settling_also_fails() {
        let send = || {
            Err(ArgmaxError::service(
                "PROVIDER_TERMINATING",
                "the real cause",
            ))
        };
        let settle_failed = || Err(ArgmaxError::service("FORK_MERGE_STATE", "settle failed"));
        // Neither the settle error nor a clean release hides the send's error.
        for settled in [settle_failed(), Ok(Settled::Released)] {
            let error = finish(send(), settled, "m".into(), "t").unwrap_err();
            assert!(error.to_string().contains("the real cause"), "{error}");
        }
        // A message that reached the source despite the error is merged.
        let kept = finish(send(), Ok(Settled::DeliveredDespiteError), "m".into(), "t").unwrap();
        assert!(kept.merged && !kept.queued);
        // A delivered send whose bookkeeping failed is still merged.
        let ok = finish(
            Ok(SendInputResult {
                ok: true,
                queued: true,
            }),
            settle_failed(),
            "m".into(),
            "t",
        )
        .unwrap();
        assert!(ok.merged && ok.queued);
    }

    #[tokio::test]
    async fn a_chat_that_is_not_a_fork_has_nothing_to_merge() {
        let (database, _) = forked().await;
        assert!(lineage(&database, "s1").unwrap().is_none());
        assert!(preview(&database, "s1").is_err());
    }
}
