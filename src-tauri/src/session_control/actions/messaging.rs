use std::collections::HashMap;
use std::sync::Arc;

use uuid::Uuid;

use super::super::{
    argmax_protocol_error, invalid_input_error,
    protocol::{
        InboxDelivery, InboxMessage, ListAction, MessageAction, MessageDelivery, ReadAction,
        ReadEntry, ReadItemSlice, SessionControlError, SessionControlResponse,
        SessionControlResult, SessionList, SessionListEntry, SessionMatch, SessionRead,
        SessionStatus, SessionStopped, StatusAction, StopAction,
    },
    protocol_error,
    registry::{ParentLaunchSettings, SessionLaunchRegistry},
    INBOX_READ_BYTE_BUDGET, INBOX_READ_LIMIT, MAX_LAUNCH_DEPTH, READ_ENTRY_MAX_CHARS,
    SESSION_LIST_LIMIT, SESSION_READ_DEFAULT_CHARS, SESSION_READ_MAX_CHARS,
    SESSION_SEARCH_SNIPPET_CHARS, STATUS_ANSWER_CHARS, TOOL_ARGUMENT_MAX_CHARS,
};
use super::resolve_project;
use crate::{
    ipc::{
        inputs::{ProvidersSendInput, ProvidersTerminateInput},
        validation::{Prompt, SessionId},
    },
    persistence::{
        dashboard::DASHBOARD_ROW_LIMIT,
        database::Database,
        events::{
            find_event_by_id, human_referenced_session_ids, latest_agent_message,
            latest_user_message_at, list_session_events_since, TimelineEvent,
            SESSION_EVENT_PAGE_LIMIT,
        },
        learnings::search_session_conversations,
        projects::list_projects,
        session_messages::{
            count_undelivered_messages, insert_session_message, take_undelivered_messages,
            NewSessionMessage, SessionMessage, MESSAGE_KIND,
        },
        sessions::{find_session_by_id, list_sessions_for_dashboard, session_launch_lineage},
        workspaces::{find_workspace_by_id, list_workspaces, WorkspaceSummary},
    },
    providers::session_service::{MessageOrigin, ProviderSessionService},
};

pub(super) async fn list_sessions_action(
    action: ListAction,
    parent: ParentLaunchSettings,
    database: Arc<Database>,
) -> Result<SessionControlResponse, SessionControlError> {
    if action.all && action.project.is_some() {
        return Err(protocol_error(
            "ARGUMENT_INVALID",
            "A session list is scoped either by project or across all of them, not both.",
        ));
    }
    let connection = database.read_connection();
    let all_projects = list_projects(&connection).map_err(argmax_protocol_error)?;
    let parent_project_id = {
        let parent_session =
            find_session_by_id(&connection, &parent.session_id).map_err(argmax_protocol_error)?;
        find_workspace_by_id(&connection, &parent_session.workspace_id)
            .map_err(argmax_protocol_error)?
            .project_id
    };
    let scoped_projects = if action.all {
        all_projects
            .into_iter()
            .filter(|project| project.id != crate::workspaces::SCRATCH_PROJECT_ID)
            .collect::<Vec<_>>()
    } else {
        vec![resolve_project(
            &all_projects,
            action.project.as_deref(),
            &parent_project_id,
        )?]
    };
    let project_names: HashMap<String, String> = scoped_projects
        .iter()
        .map(|project| (project.id.clone(), project.name.clone()))
        .collect();

    let workspaces =
        list_workspaces(&connection, None, DASHBOARD_ROW_LIMIT).map_err(argmax_protocol_error)?;
    let workspaces_by_id: HashMap<String, &WorkspaceSummary> = workspaces
        .iter()
        .map(|workspace| (workspace.id.clone(), workspace))
        .collect();
    let workspace_ids: Vec<String> = workspaces
        .iter()
        .filter(|workspace| {
            project_names.contains_key(&workspace.project_id)
                && !matches!(workspace.state.as_str(), "archiving" | "archived")
        })
        .map(|workspace| workspace.id.clone())
        .collect();

    let sessions =
        list_sessions_for_dashboard(&connection, Some(&workspace_ids), DASHBOARD_ROW_LIMIT)
            .map_err(argmax_protocol_error)?;
    let mut entries: Vec<SessionListEntry> = sessions
        .into_iter()
        .filter(|session| session.id != parent.session_id)
        .filter_map(|session| {
            let workspace = workspaces_by_id.get(&session.workspace_id)?;
            let project_name = project_names.get(&workspace.project_id)?.clone();
            Some(SessionListEntry {
                session_id: session.id,
                project_id: workspace.project_id.clone(),
                project_name,
                task_label: workspace.task_label.clone(),
                provider: session.provider,
                state: session.state,
                attention: session.attention,
                last_activity_at: session.last_activity_at,
                launched_by_session_id: session.launched_by_session_id,
                unreadable: false,
                matched: None,
            })
        })
        .collect();
    entries.sort_by(|left, right| right.last_activity_at.cmp(&left.last_activity_at));
    let caller = ReadCaller::new(&connection, &parent.session_id, &parent_project_id);
    for entry in &mut entries {
        entry.unreadable = !caller.may_read(&connection, &entry.session_id, &entry.project_id);
    }
    if let Some(query) = action
        .query
        .as_deref()
        .map(str::trim)
        .filter(|q| !q.is_empty())
    {
        entries = search_entries(&connection, entries, query)?;
    }
    let truncated = entries.len() > SESSION_LIST_LIMIT;
    entries.truncate(SESSION_LIST_LIMIT);
    Ok(SessionControlResponse::new(SessionControlResult::Listed(
        SessionList {
            sessions: entries,
            truncated,
        },
    )))
}

/// Keep the sessions a `query` names: by task label, or by a line of
/// conversation. Only sessions the caller may read are kept, so every hit can
/// be followed with `session_read`; `all` widens what a plain list shows and
/// never what a search finds.
fn search_entries(
    connection: &rusqlite::Connection,
    entries: Vec<SessionListEntry>,
    query: &str,
) -> Result<Vec<SessionListEntry>, SessionControlError> {
    let needles: Vec<String> = query.split_whitespace().map(str::to_lowercase).collect();
    let (mut kept, rest): (Vec<_>, Vec<_>) = entries
        .into_iter()
        .filter(|entry| !entry.unreadable)
        .partition(|entry| {
            let label = entry.task_label.to_lowercase();
            needles.iter().all(|needle| label.contains(needle))
        });
    for entry in &mut kept {
        entry.matched = Some(SessionMatch {
            source: "title".to_string(),
            item_id: None,
            snippet: None,
        });
    }
    let readable: Vec<String> = rest.iter().map(|entry| entry.session_id.clone()).collect();
    let hits = search_session_conversations(connection, query, &readable, SESSION_LIST_LIMIT + 1)
        .map_err(argmax_protocol_error)?;
    let mut by_session: HashMap<String, SessionListEntry> = rest
        .into_iter()
        .map(|entry| (entry.session_id.clone(), entry))
        .collect();
    // Hits arrive best-first; a session keeps its best line.
    for hit in hits {
        let Some(mut entry) = by_session.remove(&hit.session_id) else {
            continue;
        };
        entry.matched = Some(SessionMatch {
            source: "content".to_string(),
            item_id: Some(hit.event_id),
            snippet: Some(cap_chars(
                hit.snippet.replace("<b>", "").replace("</b>", "").trim(),
                SESSION_SEARCH_SNIPPET_CHARS,
            )),
        });
        kept.push(entry);
    }
    Ok(kept)
}

pub(super) async fn message_session(
    action: MessageAction,
    parent: ParentLaunchSettings,
    database: Arc<Database>,
    providers: Arc<ProviderSessionService>,
    registry: Arc<SessionLaunchRegistry>,
) -> Result<SessionControlResponse, SessionControlError> {
    if action.session_id == parent.session_id {
        return Err(protocol_error(
            "MESSAGE_SELF",
            "A session cannot message itself; name another session's id.",
        ));
    }
    if action.fork_findings {
        return super::fork_findings::bring_fork_findings(action, parent, database, providers)
            .await;
    }
    let target = SessionId::try_from(action.session_id.clone()).map_err(invalid_input_error)?;
    let message = Prompt::try_from(action.message.clone()).map_err(invalid_input_error)?;
    // The row goes in before the turn does. It is what `inbox_read` and
    // `session_wait` see, so a recipient that is mid-turn — or one that is
    // deliberately polling instead of taking turns — still collects the
    // message even though the delivery below only queues it.
    let (message_id, label) = {
        let connection = database.connection();
        find_session_by_id(&connection, &action.session_id).map_err(argmax_protocol_error)?;
        let id = Uuid::new_v4().to_string();
        insert_session_message(
            &connection,
            &NewSessionMessage {
                id: id.clone(),
                from_session_id: Some(parent.session_id.clone()),
                to_session_id: action.session_id.clone(),
                body: action.message,
                kind: MESSAGE_KIND.to_string(),
            },
        )
        .map_err(argmax_protocol_error)?;
        (id, session_task_label(&connection, &parent.session_id))
    };
    registry.notify_inbox(&action.session_id);
    let result = providers
        .send_agent_message(
            ProvidersSendInput {
                agent_references: None,
                session_id: target,
                input: message,
                provider: None,
                model_label: None,
                model_id: None,
                reasoning_effort: None,
                fast_mode: false,
                agent_mode: None,
                attachments: None,
            },
            MessageOrigin {
                session_id: parent.session_id.clone(),
                label,
                kind: MESSAGE_KIND.to_string(),
                message_id: Some(message_id.clone()),
            },
        )
        .await
        .map_err(argmax_protocol_error)?;
    // A message that reached the recipient as a turn or as steering has been
    // delivered; one that is still queued has not, and stays collectable from
    // the inbox.
    if !result.queued {
        let connection = database.connection();
        if let Err(error) =
            crate::persistence::session_messages::mark_message_delivered(&connection, &message_id)
        {
            tracing::warn!(?error, "failed to mark a session message delivered");
        }
    }
    Ok(SessionControlResponse::new(SessionControlResult::Messaged(
        MessageDelivery {
            session_id: action.session_id,
            queued: result.queued,
        },
    )))
}

/// A session's sidebar label, falling back to its id when the workspace is
/// gone. Used wherever a message names who sent it.
pub(super) fn session_task_label(connection: &rusqlite::Connection, session_id: &str) -> String {
    find_session_by_id(connection, session_id)
        .and_then(|session| find_workspace_by_id(connection, &session.workspace_id))
        .map(|workspace| workspace.task_label)
        .unwrap_or_else(|_| session_id.to_string())
}

pub(super) fn session_status(
    action: StatusAction,
    parent: ParentLaunchSettings,
    database: Arc<Database>,
) -> Result<SessionControlResponse, SessionControlError> {
    let connection = database.read_connection();
    require_read_access(&connection, &parent.session_id, &action.session_id)?;
    let session =
        find_session_by_id(&connection, &action.session_id).map_err(argmax_protocol_error)?;
    let workspace =
        find_workspace_by_id(&connection, &session.workspace_id).map_err(argmax_protocol_error)?;
    let turn_age_seconds = session
        .state
        .is_active()
        .then(|| {
            latest_user_message_at(&connection, &action.session_id)
                .ok()
                .flatten()
                .or_else(|| Some(session.started_at.clone()))
                .and_then(|at| seconds_since(&at))
        })
        .flatten();
    let last_assistant_text = latest_agent_message(&connection, &action.session_id)
        .map_err(argmax_protocol_error)?
        .map(|text| cap_chars(&text, STATUS_ANSWER_CHARS));
    let unread_inbox = count_undelivered_messages(&connection, &action.session_id)
        .map_err(argmax_protocol_error)?;
    let lineage =
        session_launch_lineage(&connection, &action.session_id).map_err(argmax_protocol_error)?;
    Ok(SessionControlResponse::new(SessionControlResult::Status(
        SessionStatus {
            session_id: session.id,
            task_label: workspace.task_label,
            provider: session.provider,
            model_id: session.model_id,
            state: session.state,
            attention: session.attention,
            turn_age_seconds,
            last_activity_at: session.last_activity_at,
            last_assistant_text,
            unread_inbox,
            launched_by_session_id: session.launched_by_session_id,
            launch_depth: lineage.depth,
        },
    )))
}

/// What an agent session may read. Ordinary access has three sources, and
/// they are all the same question, whose conversation is this agent's to see:
///
/// - its own project: a scratch Chat has no project to share, so each Chat is
///   its own boundary;
/// - its launch lineage, up or down and across projects: a parent that
///   launched a child into another project must still read it, and the child
///   its launcher;
/// - a chat a person attached to one of its prompts, one session at a time
///   (see [`human_referenced_session_ids`]).
///
/// Nothing here limits the app's own UI, which browses every project.
struct ReadCaller {
    session_id: String,
    project_id: String,
    ancestors: Vec<String>,
    /// Chats the person attached to this session's prompts, read once.
    attached: std::collections::HashSet<String>,
}

impl ReadCaller {
    fn new(connection: &rusqlite::Connection, session_id: &str, project_id: &str) -> Self {
        Self {
            session_id: session_id.to_string(),
            project_id: project_id.to_string(),
            ancestors: launch_ancestors(connection, session_id),
            attached: human_referenced_session_ids(connection, session_id).unwrap_or_default(),
        }
    }

    fn may_read(
        &self,
        connection: &rusqlite::Connection,
        target_session_id: &str,
        target_project_id: &str,
    ) -> bool {
        if target_session_id == self.session_id {
            return true;
        }
        if self.project_id == target_project_id
            && self.project_id != crate::workspaces::SCRATCH_PROJECT_ID
        {
            return true;
        }
        if self.ancestors.iter().any(|id| id == target_session_id) {
            return true;
        }
        if launch_ancestors(connection, target_session_id)
            .iter()
            .any(|id| id == &self.session_id)
        {
            return true;
        }
        self.attached.contains(target_session_id)
    }
}

/// The sessions that launched this one, nearest first. The launch depth cap
/// bounds the walk; a chain that ends at a deleted session just stops.
fn launch_ancestors(connection: &rusqlite::Connection, session_id: &str) -> Vec<String> {
    let mut ancestors = Vec::new();
    let mut current = session_id.to_string();
    for _ in 0..=MAX_LAUNCH_DEPTH {
        let Ok(session) = find_session_by_id(connection, &current) else {
            break;
        };
        let Some(launcher) = session.launched_by_session_id else {
            break;
        };
        ancestors.push(launcher.clone());
        current = launcher;
    }
    ancestors
}

/// [`ReadCaller::may_read`] for one named target, as an error an agent can act on.
fn require_read_access(
    connection: &rusqlite::Connection,
    caller_session_id: &str,
    target_session_id: &str,
) -> Result<(), SessionControlError> {
    let project_of = |session_id: &str| -> Result<String, SessionControlError> {
        let session = find_session_by_id(connection, session_id).map_err(argmax_protocol_error)?;
        Ok(find_workspace_by_id(connection, &session.workspace_id)
            .map_err(argmax_protocol_error)?
            .project_id)
    };
    let target_project_id = project_of(target_session_id)?;
    let caller = ReadCaller::new(
        connection,
        caller_session_id,
        &project_of(caller_session_id)?,
    );
    if caller.may_read(connection, target_session_id, &target_project_id) {
        return Ok(());
    }
    Err(protocol_error(
        "READ_FORBIDDEN",
        "That session is in another project and is not one you launched. You can read your own \
         project's sessions and your launch lineage; ask the user to attach that chat to your \
         prompt to read it.",
    ))
}

pub(super) fn session_read(
    action: ReadAction,
    parent: ParentLaunchSettings,
    database: Arc<Database>,
) -> Result<SessionControlResponse, SessionControlError> {
    let budget = action
        .max_chars
        .map(|value| (value as usize).min(SESSION_READ_MAX_CHARS))
        .unwrap_or(SESSION_READ_DEFAULT_CHARS);
    let connection = database.read_connection();
    require_read_access(&connection, &parent.session_id, &action.session_id)?;
    if let Some(item_id) = action.item_id.as_deref() {
        let event = find_event_by_id(&connection, item_id)
            .map_err(argmax_protocol_error)?
            .filter(|event| event.session_id == action.session_id);
        drop(connection);
        let slice = read_item_slice(event, item_id, action.offset.unwrap_or(0), budget)?;
        return Ok(SessionControlResponse::new(SessionControlResult::Read(
            SessionRead {
                session_id: action.session_id,
                entries: Vec::new(),
                next_cursor: action.cursor.unwrap_or(0),
                truncated: slice.next_offset.is_some(),
                item: Some(slice),
            },
        )));
    }
    // The same read the chat pane takes. `events` is already the normalized
    // timeline — every provider's output is translated into these rows on the
    // way in — so this summarizes rows rather than re-parsing provider JSON.
    // A read with no cursor starts at the beginning of the transcript. The
    // cursorless read this shares with the chat pane returns the *newest* page,
    // which is right for a surface that scrolls up and wrong for an agent that
    // pages forward from `nextCursor`, so name row 0 rather than leaving it out.
    let cursor = action.cursor.unwrap_or(0);
    let page = list_session_events_since(&connection, &action.session_id, Some(cursor), None)
        .map_err(argmax_protocol_error)?;
    drop(connection);

    let mut entries = Vec::new();
    let mut spent = 0usize;
    // A full page of rows means the row limit, not the byte budget, is what
    // ended this page: there is more to read from `nextCursor`.
    let mut truncated = page.events.len() == SESSION_EVENT_PAGE_LIMIT;
    let mut next_cursor = page.event_cursor;
    for event in page.events {
        let cursor = event.row_cursor.unwrap_or(next_cursor);
        let Some(entry) = read_entry(&event) else {
            continue;
        };
        if spent + entry.text.len() > budget && !entries.is_empty() {
            truncated = true;
            next_cursor = cursor - 1;
            break;
        }
        spent += entry.text.len();
        next_cursor = cursor;
        entries.push(entry);
    }
    Ok(SessionControlResponse::new(SessionControlResult::Read(
        SessionRead {
            session_id: action.session_id,
            entries,
            next_cursor,
            truncated,
            item: None,
        },
    )))
}

/// One entry's whole text, `budget` bytes from `offset`. The offset is a byte
/// offset so a slice's end is exact, and it must sit on a character boundary:
/// `nextOffset` always does, so a client that feeds it back never splits a
/// character, and one that invents an offset is told rather than served
/// mangled text. A slice never ends inside a character either; it stops at
/// the last boundary within the budget.
fn read_item_slice(
    event: Option<TimelineEvent>,
    item_id: &str,
    offset: u32,
    budget: usize,
) -> Result<ReadItemSlice, SessionControlError> {
    let (event, (kind, text)) = event
        .and_then(|event| {
            let full = read_entry_text(&event, Detail::Full)?;
            Some((event, full))
        })
        .ok_or_else(|| {
            protocol_error(
                "ITEM_NOT_FOUND",
                format!("No readable entry {item_id} in that session."),
            )
        })?;
    let total = text.len();
    let start = offset as usize;
    if start > total || !text.is_char_boundary(start) {
        return Err(protocol_error(
            "OFFSET_INVALID",
            format!(
                "Offset {offset} is not a character boundary in an entry of {total} bytes; \
                 use the nextOffset a previous read returned."
            ),
        ));
    }
    let mut end = (start + budget).min(total);
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    // A budget smaller than one character still has to make progress.
    if end == start && start < total {
        end = start + text[start..].chars().next().map_or(0, char::len_utf8);
    }
    Ok(ReadItemSlice {
        id: event.id,
        at: event.created_at,
        kind: kind.to_string(),
        text: text[start..end].to_string(),
        offset,
        next_offset: (end < total).then_some(end as u32),
        total_bytes: total as u32,
    })
}

pub(super) async fn stop_session(
    action: StopAction,
    parent: ParentLaunchSettings,
    database: Arc<Database>,
    providers: Arc<ProviderSessionService>,
) -> Result<SessionControlResponse, SessionControlError> {
    if action.session_id == parent.session_id {
        return Err(protocol_error(
            "STOP_SELF",
            "A session cannot stop its own turn; finish the turn instead.",
        ));
    }
    let session_id = SessionId::try_from(action.session_id.clone()).map_err(invalid_input_error)?;
    providers
        .terminate(ProvidersTerminateInput { session_id })
        .await
        .map_err(argmax_protocol_error)?;
    // The state that actually landed, not the one a stop usually produces: a
    // session whose turn had already ended stays `complete`, and telling the
    // agent it was cancelled would be a lie it then reports to the user.
    let state = {
        let connection = database.read_connection();
        find_session_by_id(&connection, &action.session_id)
            .map_err(argmax_protocol_error)?
            .state
    };
    Ok(SessionControlResponse::new(SessionControlResult::Stopped(
        SessionStopped {
            session_id: action.session_id,
            state,
        },
    )))
}

pub(super) fn inbox_read(
    parent: ParentLaunchSettings,
    database: Arc<Database>,
    providers: Arc<ProviderSessionService>,
) -> Result<SessionControlResponse, SessionControlError> {
    let (messages, collected_message_ids) = {
        let mut connection = database.connection();
        let messages = take_undelivered_messages(
            &mut connection,
            &parent.session_id,
            INBOX_READ_LIMIT,
            INBOX_READ_BYTE_BUDGET,
        )
        .map_err(argmax_protocol_error)?;
        let collected_message_ids = messages
            .iter()
            .map(|message| message.id.clone())
            .collect::<Vec<_>>();
        (
            to_inbox_messages(&connection, messages),
            collected_message_ids,
        )
    };
    // Collection already committed, so cleanup must not replace a valid
    // reply with an error and strand messages the agent was never shown.
    if let Err(error) =
        providers.reconcile_collected_messages(&parent.session_id, &collected_message_ids)
    {
        tracing::warn!(
            session_id = %parent.session_id,
            ?error,
            "failed to remove collected messages from the pending queue"
        );
    }
    Ok(SessionControlResponse::new(SessionControlResult::Inbox(
        InboxDelivery { messages },
    )))
}

pub(super) fn to_inbox_messages(
    connection: &rusqlite::Connection,
    messages: Vec<SessionMessage>,
) -> Vec<InboxMessage> {
    messages
        .into_iter()
        .map(|message| InboxMessage {
            from_label: message
                .from_session_id
                .as_deref()
                .map(|id| session_task_label(connection, id)),
            from_session_id: message.from_session_id,
            kind: message.kind,
            body: message.body,
            created_at: message.created_at,
        })
        .collect()
}

fn seconds_since(at: &str) -> Option<i64> {
    let then = chrono::DateTime::parse_from_rfc3339(at).ok()?;
    Some((chrono::Utc::now() - then.with_timezone(&chrono::Utc)).num_seconds())
}

pub(super) fn cap_chars(text: &str, max_chars: usize) -> String {
    if text.chars().count() <= max_chars {
        return text.to_string();
    }
    let mut out: String = text.chars().take(max_chars).collect();
    out.push_str("...");
    out
}

/// One timeline row as a line an agent can read. Rows the chat itself hides —
/// streaming deltas, subagent traces, lifecycle bookkeeping — return `None`.
fn read_entry(event: &TimelineEvent) -> Option<ReadEntry> {
    let (kind, line) = read_entry_text(event, Detail::Line)?;
    let full_chars = line.trim().chars().count();
    let line = cap_chars(line.trim(), READ_ENTRY_MAX_CHARS);
    // "Clipped" is the signal that `item_id` has more to give. A tool row is
    // one line by design, so it asks the event itself whether the line left
    // something out; building the whole entry for every row of a page would
    // pretty-print every tool input, which can be a whole file.
    let clipped = match kind {
        "tool" => tool_call_clipped(event),
        "tool-result" => tool_result_clipped(event),
        _ => full_chars > READ_ENTRY_MAX_CHARS,
    };
    Some(ReadEntry {
        id: event.id.clone(),
        at: event.created_at.clone(),
        kind: kind.to_string(),
        text: line,
        clipped,
    })
}

/// Whether a tool call's one-line summary dropped part of its input: another
/// argument besides the one shown, or the shown text cut at its cap.
fn tool_call_clipped(event: &TimelineEvent) -> bool {
    let Some(input) = event.payload.get("input") else {
        return false;
    };
    let over_cap = |text: &str| text.trim().chars().count() > TOOL_ARGUMENT_MAX_CHARS;
    match input {
        serde_json::Value::String(text) => over_cap(text),
        serde_json::Value::Object(map) => {
            for key in TOOL_ARGUMENT_KEYS {
                if let Some(value) = map.get(*key).and_then(|value| value.as_str()) {
                    return map.len() > 1 || over_cap(value);
                }
            }
            over_cap(&input.to_string())
        }
        other => over_cap(&other.to_string()),
    }
}

/// Whether a tool result has output the one-line `name -> ok` summary leaves
/// out. A failure shows its first line, so only the rest counts.
fn tool_result_clipped(event: &TimelineEvent) -> bool {
    let body = event.message.trim();
    if body.is_empty() {
        return false;
    }
    if tool_outcome(event) == "ok" {
        return true;
    }
    body.lines().count() > 1
        || body
            .lines()
            .next()
            .is_some_and(|first| first.trim().chars().count() > TOOL_ARGUMENT_MAX_CHARS)
}

/// How much of a row to render: the one line a page lists, or everything an
/// item read serves.
#[derive(Clone, Copy, PartialEq)]
enum Detail {
    Line,
    Full,
}

/// The kind and text of a readable row. A page takes the line; an item read
/// takes the whole row and slices it.
fn read_entry_text(event: &TimelineEvent, detail: Detail) -> Option<(&'static str, String)> {
    if event.payload.get("parent_tool_use_id").is_some()
        || event.payload.get("traceImported").is_some()
    {
        return None;
    }
    let (kind, text) = match event.r#type.as_str() {
        "user.message" => {
            let from = event
                .payload
                .pointer("/origin/label")
                .and_then(|value| value.as_str());
            let text = match from {
                Some(label) => format!("[from {label}] {}", event.message),
                None => event.message.clone(),
            };
            ("user", text)
        }
        "message.completed" if !event.message.trim().is_empty() => {
            ("assistant", event.message.clone())
        }
        "command.started" => (
            "tool",
            format!("{} {}", event.message, tool_arguments(event, detail)),
        ),
        "command.completed" => {
            let head = format!("{} -> {}", tool_name(event), tool_outcome(event));
            let body = event.message.trim();
            // The result's text is what a page leaves out: its first line
            // rides in the outcome of a failure, and nothing else does.
            if detail == Detail::Full && !body.is_empty() {
                ("tool-result", format!("{head}\n{body}"))
            } else {
                ("tool-result", head)
            }
        }
        "error" if !event.message.trim().is_empty() => ("error", event.message.clone()),
        // Argmax speaking about the chat itself — the move or archive it
        // resumed or dropped. It read as an `error` line until these rows got
        // their own kind, and a reader that misses it cannot tell why the
        // disposal it was promised never happened.
        "session.note" if !event.message.trim().is_empty() => ("note", event.message.clone()),
        "session.completed" => ("state", "session finished".to_string()),
        "session.cancelled" => ("state", "session cancelled".to_string()),
        _ => return None,
    };
    Some((kind, text))
}

fn tool_name(event: &TimelineEvent) -> String {
    event
        .payload
        .get("toolName")
        .and_then(|value| value.as_str())
        .unwrap_or(if event.message.trim().is_empty() {
            "tool"
        } else {
            event.message.trim()
        })
        .to_string()
}

/// The input keys a tool call's one-line summary prefers, in order.
const TOOL_ARGUMENT_KEYS: &[&str] = &[
    "command",
    "file_path",
    "target_file",
    "path",
    "pattern",
    "query",
    "url",
    "prompt",
];

/// The one argument worth a line: whichever of the common input keys the
/// provider filled in, otherwise the compact JSON of the whole input.
fn tool_arguments(event: &TimelineEvent, detail: Detail) -> String {
    let Some(input) = event.payload.get("input") else {
        return String::new();
    };
    if detail == Detail::Full {
        return match input {
            serde_json::Value::String(text) => text.clone(),
            other => serde_json::to_string_pretty(other).unwrap_or_else(|_| other.to_string()),
        };
    }
    for key in TOOL_ARGUMENT_KEYS {
        if let Some(value) = input.get(*key).and_then(|value| value.as_str()) {
            return cap_chars(value.trim(), TOOL_ARGUMENT_MAX_CHARS);
        }
    }
    cap_chars(&input.to_string(), TOOL_ARGUMENT_MAX_CHARS)
}

fn tool_outcome(event: &TimelineEvent) -> String {
    let failed = matches!(
        event
            .payload
            .get("is_error")
            .or(event.payload.get("isError")),
        Some(serde_json::Value::Bool(true))
    );
    if !failed {
        return "ok".to_string();
    }
    let detail = event.message.lines().next().unwrap_or_default().trim();
    if detail.is_empty() {
        "error".to_string()
    } else {
        format!("error: {}", cap_chars(detail, TOOL_ARGUMENT_MAX_CHARS))
    }
}
