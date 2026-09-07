use std::collections::{HashMap, VecDeque};

use rusqlite::{Connection, Row, Transaction};
use serde::de::DeserializeOwned;

use super::{bool_to_i64, json_error, sqlite_error, time::now_iso};
use crate::{
    error::{ArgmaxError, ArgmaxResult},
    providers::flush_queue::PendingMessage,
};

pub const RECOVERED_UNSENT: &str = "unsent";
pub const RECOVERED_DELIVERY_UNKNOWN: &str = "delivery-unknown";

const STATE_PENDING: &str = "pending";
const STATE_RECOVERED: &str = "recovered";
const STATE_LAUNCHING: &str = "launching";
const STATE_DELIVERY_UNKNOWN: &str = "delivery_unknown";

/// Restore the pending-message journal on startup without starting work.
///
/// Even messages that were definitely pending are paused after a restart. A
/// later ordinary turn may finish before the user has reviewed the recovered
/// queue, and silently draining at that point would turn startup recovery into
/// an implicit send. A row already marked `launching` is more conservative:
/// the provider may have accepted it before the process stopped, so the UI
/// tells the user to inspect the chat before explicitly sending it again.
pub fn recover_pending_messages(
    connection: &mut Connection,
) -> ArgmaxResult<HashMap<String, VecDeque<PendingMessage>>> {
    let transaction = connection.transaction().map_err(sqlite_error)?;
    transaction
        .execute(
            r#"
            UPDATE pending_messages
            SET delivery_state = CASE
                    WHEN delivery_state IN ('launching', 'delivery_unknown')
                        THEN 'delivery_unknown'
                    ELSE 'recovered'
                END,
                updated_at = ?
            "#,
            [now_iso()],
        )
        .map_err(sqlite_error)?;
    let messages = list_pending_messages_from(&transaction)?;
    transaction.commit().map_err(sqlite_error)?;
    Ok(group_by_session(messages))
}

pub fn list_pending_messages(connection: &Connection) -> ArgmaxResult<Vec<PendingMessage>> {
    list_pending_messages_from(connection)
}

pub fn list_session_pending_messages(
    connection: &Connection,
    session_id: &str,
) -> ArgmaxResult<VecDeque<PendingMessage>> {
    let mut statement = connection
        .prepare_cached(
            r#"
            SELECT id, session_id, content, agent_mode, model_label, model_id,
                   reasoning_effort, fast_mode, attachments_json,
                   agent_references_json, origin_json, queued_at, delivery_state
            FROM pending_messages
            WHERE session_id = ? AND delivery_state <> 'launching'
            ORDER BY position
            "#,
        )
        .map_err(sqlite_error)?;
    let messages = statement
        .query_map([session_id], row_to_pending_message)
        .map_err(sqlite_error)?
        .collect::<Result<VecDeque<_>, _>>()
        .map_err(sqlite_error)?;
    Ok(messages)
}

/// Replace one session's visible journal in exactly the order shown by the
/// composer. Rows already marked `launching` are kept in their prior slots:
/// they have left memory while dispatch awaits, but a simultaneous enqueue or
/// cancellation must not erase the only record of that ambiguous launch.
pub fn replace_session_queue(
    connection: &mut Connection,
    session_id: &str,
    messages: &VecDeque<PendingMessage>,
) -> ArgmaxResult<()> {
    let transaction = connection.transaction().map_err(sqlite_error)?;
    let launching_positions = {
        let mut statement = transaction
            .prepare_cached(
                "SELECT position FROM pending_messages WHERE session_id = ? AND delivery_state = 'launching' ORDER BY position",
            )
            .map_err(sqlite_error)?;
        let positions = statement
            .query_map([session_id], |row| row.get::<_, usize>(0))
            .map_err(sqlite_error)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(sqlite_error)?;
        positions
    };
    transaction
        .execute(
            "DELETE FROM pending_messages WHERE session_id = ? AND delivery_state <> 'launching'",
            [session_id],
        )
        .map_err(sqlite_error)?;
    let mut position = 0usize;
    for message in messages {
        while launching_positions.binary_search(&position).is_ok() {
            position += 1;
        }
        insert_message(&transaction, message, position)?;
        position += 1;
    }
    transaction.commit().map_err(sqlite_error)
}

/// Mark a message in-flight before the runtime is stopped or a provider is
/// launched. The row remains until a durable user turn exists and send_input
/// has returned, leaving restart recovery able to report an ambiguous launch.
pub fn mark_message_launching(
    connection: &Connection,
    session_id: &str,
    message_id: &str,
) -> ArgmaxResult<()> {
    let changed = connection
        .execute(
            r#"
            UPDATE pending_messages
            SET delivery_state = 'launching', updated_at = ?
            WHERE session_id = ? AND id = ?
              AND delivery_state IN ('pending', 'recovered', 'delivery_unknown')
            "#,
            (now_iso(), session_id, message_id),
        )
        .map_err(sqlite_error)?;
    if changed == 0 {
        return Err(ArgmaxError::service(
            "PENDING_MESSAGE_NOT_CLAIMABLE",
            "Pending follow-up no longer exists or is already being sent.",
        ));
    }
    Ok(())
}

/// Put a cleanly failed launch back into its prior durable slot. Reloading the
/// session queue after this update also resolves any concurrent edits around
/// it without relying on the stale in-memory index from before the await.
pub fn restore_launching_message(
    connection: &Connection,
    session_id: &str,
    message_id: &str,
    recovery_status: Option<&str>,
) -> ArgmaxResult<()> {
    let state = match recovery_status {
        Some(RECOVERED_UNSENT) => STATE_RECOVERED,
        Some(RECOVERED_DELIVERY_UNKNOWN) => STATE_DELIVERY_UNKNOWN,
        _ => STATE_PENDING,
    };
    let changed = connection
        .execute(
            "UPDATE pending_messages SET delivery_state = ?, updated_at = ? WHERE session_id = ? AND id = ? AND delivery_state = 'launching'",
            (state, now_iso(), session_id, message_id),
        )
        .map_err(sqlite_error)?;
    if changed == 0 {
        return Err(ArgmaxError::service(
            "PENDING_MESSAGE_NOT_LAUNCHING",
            "Pending follow-up launch could not be restored.",
        ));
    }
    Ok(())
}

pub fn delete_message(
    connection: &Connection,
    session_id: &str,
    message_id: &str,
) -> ArgmaxResult<()> {
    connection
        .execute(
            "DELETE FROM pending_messages WHERE session_id = ? AND id = ?",
            (session_id, message_id),
        )
        .map_err(sqlite_error)?;
    Ok(())
}

pub fn clear_session_queue(connection: &Connection, session_id: &str) -> ArgmaxResult<()> {
    connection
        .execute(
            "DELETE FROM pending_messages WHERE session_id = ?",
            [session_id],
        )
        .map_err(sqlite_error)?;
    Ok(())
}

fn insert_message(
    transaction: &Transaction<'_>,
    message: &PendingMessage,
    position: usize,
) -> ArgmaxResult<()> {
    let attachments_json = serde_json::to_string(&message.attachments).map_err(json_error)?;
    let agent_references_json =
        serde_json::to_string(&message.agent_references).map_err(json_error)?;
    let origin_json = message
        .origin
        .as_ref()
        .map(serde_json::to_string)
        .transpose()
        .map_err(json_error)?;
    let state = match message.recovery_status.as_deref() {
        Some(RECOVERED_UNSENT) => STATE_RECOVERED,
        Some(RECOVERED_DELIVERY_UNKNOWN) => STATE_DELIVERY_UNKNOWN,
        _ => STATE_PENDING,
    };
    transaction
        .execute(
            r#"
            INSERT INTO pending_messages (
                id, session_id, position, content, agent_mode, model_label,
                model_id, reasoning_effort, fast_mode, attachments_json,
                agent_references_json, origin_json, queued_at, delivery_state,
                updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            "#,
            (
                message.id.as_str(),
                message.session_id.as_str(),
                position as i64,
                message.content.as_str(),
                message.agent_mode.as_str(),
                message.model_label.as_deref(),
                message.model_id.as_deref(),
                message.reasoning_effort.as_deref(),
                bool_to_i64(message.fast_mode),
                attachments_json,
                agent_references_json,
                origin_json,
                message.queued_at.as_str(),
                state,
                now_iso(),
            ),
        )
        .map_err(sqlite_error)?;
    Ok(())
}

fn list_pending_messages_from(connection: &Connection) -> ArgmaxResult<Vec<PendingMessage>> {
    let mut statement = connection
        .prepare_cached(
            r#"
            SELECT id, session_id, content, agent_mode, model_label, model_id,
                   reasoning_effort, fast_mode, attachments_json,
                   agent_references_json, origin_json, queued_at, delivery_state
            FROM pending_messages
            ORDER BY session_id, position
            "#,
        )
        .map_err(sqlite_error)?;
    let messages = statement
        .query_map([], row_to_pending_message)
        .map_err(sqlite_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(sqlite_error)?;
    Ok(messages)
}

fn row_to_pending_message(row: &Row<'_>) -> rusqlite::Result<PendingMessage> {
    let attachments_json: String = row.get("attachments_json")?;
    let agent_references_json: String = row.get("agent_references_json")?;
    let origin_json: Option<String> = row.get("origin_json")?;
    let delivery_state: String = row.get("delivery_state")?;
    Ok(PendingMessage {
        id: row.get("id")?,
        session_id: row.get("session_id")?,
        content: row.get("content")?,
        agent_mode: row.get("agent_mode")?,
        model_label: row.get("model_label")?,
        model_id: row.get("model_id")?,
        reasoning_effort: row.get("reasoning_effort")?,
        fast_mode: row.get::<_, i64>("fast_mode")? != 0,
        attachments: parse_json_column(&attachments_json, 8)?,
        agent_references: parse_json_column(&agent_references_json, 9)?,
        origin: origin_json
            .as_deref()
            .map(|value| parse_json_column(value, 10))
            .transpose()?,
        recovery_status: match delivery_state.as_str() {
            STATE_RECOVERED => Some(RECOVERED_UNSENT.to_string()),
            STATE_DELIVERY_UNKNOWN | STATE_LAUNCHING => {
                Some(RECOVERED_DELIVERY_UNKNOWN.to_string())
            }
            _ => None,
        },
        queued_at: row.get("queued_at")?,
    })
}

fn parse_json_column<T: DeserializeOwned>(value: &str, column: usize) -> rusqlite::Result<T> {
    serde_json::from_str(value).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(
            column,
            rusqlite::types::Type::Text,
            Box::new(error),
        )
    })
}

fn group_by_session(messages: Vec<PendingMessage>) -> HashMap<String, VecDeque<PendingMessage>> {
    let mut queues = HashMap::<String, VecDeque<PendingMessage>>::new();
    for message in messages {
        queues
            .entry(message.session_id.clone())
            .or_default()
            .push_back(message);
    }
    queues
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        persistence::{
            database::Database,
            projects::{persist_project, PersistProjectInput, ProjectSettings},
            sessions::{persist_session, PersistSessionInput},
            workspaces::{persist_workspace, PersistWorkspaceInput},
        },
        providers::session_service::MessageOrigin,
        sessions::state::SessionState,
    };
    use serde_json::json;

    fn database_with_session() -> Database {
        let database = Database::open_in_memory().expect("open db");
        let connection = database.connection();
        persist_project(
            &connection,
            &PersistProjectInput {
                id: "project-1".to_string(),
                name: "Project".to_string(),
                repo_path: "/tmp/project".to_string(),
                current_branch: "main".to_string(),
                default_branch: Some("main".to_string()),
                settings: ProjectSettings {
                    worktree_location: "/tmp/worktrees".to_string(),
                    setup_command: String::new(),
                    check_commands: Vec::new(),
                    archive_on_merge: false,
                },
            },
        )
        .expect("project");
        persist_workspace(
            &connection,
            &PersistWorkspaceInput {
                id: "workspace-1".to_string(),
                project_id: "project-1".to_string(),
                task_label: "Task".to_string(),
                branch: "main".to_string(),
                base_ref: "main".to_string(),
                path: "/tmp/project".to_string(),
                state: "running".to_string(),
                shared_workspace: true,
                kind: "git".to_string(),
                dirty: false,
                changed_files: 0,
            },
        )
        .expect("workspace");
        persist_session(
            &connection,
            &PersistSessionInput {
                id: "session-1".to_string(),
                workspace_id: "workspace-1".to_string(),
                provider: "codex".to_string(),
                model_label: "GPT".to_string(),
                model_id: "gpt-5".to_string(),
                reasoning_effort: Some("high".to_string()),
                permission_mode: Some("auto-approve".to_string()),
                agent_mode: Some("auto".to_string()),
                prompt: "Start".to_string(),
                state: SessionState::Running,
            },
        )
        .expect("session");
        drop(connection);
        database
    }

    fn pending(id: &str, content: &str) -> PendingMessage {
        PendingMessage {
            id: id.to_string(),
            session_id: "session-1".to_string(),
            content: content.to_string(),
            agent_mode: "auto".to_string(),
            model_label: Some("GPT".to_string()),
            model_id: Some("gpt-5".to_string()),
            reasoning_effort: Some("high".to_string()),
            fast_mode: true,
            attachments: serde_json::from_value(json!([{
                "filePath": "/tmp/project/screenshot.png",
                "mimeType": "image/png",
                "sizeBytes": 42
            }]))
            .expect("attachment"),
            agent_references: serde_json::from_value(json!([{
                "name": "Gauss",
                "providerChildSessionId": "child-1",
                "providerParentConversationId": "parent-1"
            }]))
            .expect("agent reference"),
            origin: Some(MessageOrigin {
                session_id: "sender-1".to_string(),
                label: "Sender".to_string(),
                kind: "message".to_string(),
                message_id: Some("inbox-1".to_string()),
            }),
            recovery_status: None,
            queued_at: "2026-09-06T10:00:00.000Z".to_string(),
        }
    }

    #[test]
    fn restart_preserves_order_and_metadata_but_pauses_every_message() {
        let database = database_with_session();
        let expected = VecDeque::from([
            pending("pending-1", "first"),
            pending("pending-2", "second"),
        ]);
        {
            let mut connection = database.connection();
            replace_session_queue(&mut connection, "session-1", &expected).expect("persist queue");
            mark_message_launching(&connection, "session-1", "pending-1").expect("claim first");
        }

        let recovered = {
            let mut connection = database.connection();
            recover_pending_messages(&mut connection).expect("recover queue")
        };
        let queue = &recovered["session-1"];
        assert_eq!(
            queue
                .iter()
                .map(|message| message.id.as_str())
                .collect::<Vec<_>>(),
            vec!["pending-1", "pending-2"]
        );
        assert_eq!(
            queue[0].recovery_status.as_deref(),
            Some(RECOVERED_DELIVERY_UNKNOWN)
        );
        assert_eq!(queue[1].recovery_status.as_deref(), Some(RECOVERED_UNSENT));
        assert_eq!(queue[0].attachments, expected[0].attachments);
        assert_eq!(queue[0].agent_references, expected[0].agent_references);
        assert_eq!(queue[0].origin, expected[0].origin);
        assert!(queue[0].fast_mode);
    }

    #[test]
    fn replacement_persists_edit_reorder_and_remove_as_one_queue() {
        let database = database_with_session();
        let mut queue = VecDeque::from([
            pending("pending-1", "first"),
            pending("pending-2", "second"),
            pending("pending-3", "third"),
        ]);
        {
            let mut connection = database.connection();
            replace_session_queue(&mut connection, "session-1", &queue).expect("initial queue");
        }
        queue.remove(0);
        queue[0].content = "edited second".to_string();
        queue.swap(0, 1);
        {
            let mut connection = database.connection();
            replace_session_queue(&mut connection, "session-1", &queue).expect("replace queue");
        }

        let stored = {
            let connection = database.connection();
            list_pending_messages(&connection).expect("list queue")
        };
        assert_eq!(
            stored
                .iter()
                .map(|message| message.id.as_str())
                .collect::<Vec<_>>(),
            vec!["pending-3", "pending-2"]
        );
        assert_eq!(stored[1].content, "edited second");
    }

    #[test]
    fn queue_changes_cannot_erase_a_message_awaiting_launch() {
        let database = database_with_session();
        let initial = VecDeque::from([
            pending("pending-1", "launching"),
            pending("pending-2", "cancel during launch"),
        ]);
        {
            let mut connection = database.connection();
            replace_session_queue(&mut connection, "session-1", &initial).expect("initial queue");
            mark_message_launching(&connection, "session-1", "pending-1").expect("claim launch");
        }

        // This is the in-memory queue while pending-1 awaits send_input. A new
        // enqueue is persisted, then pending-2 is cancelled, through the same
        // replacement path used by the service.
        let mut visible = VecDeque::from([
            pending("pending-2", "cancel during launch"),
            pending("pending-3", "queued during launch"),
        ]);
        {
            let mut connection = database.connection();
            replace_session_queue(&mut connection, "session-1", &visible).expect("enqueue");
        }
        visible.pop_front();
        {
            let mut connection = database.connection();
            replace_session_queue(&mut connection, "session-1", &visible).expect("cancel");
        }

        let recovered = {
            let mut connection = database.connection();
            recover_pending_messages(&mut connection).expect("reopen queue")
        };
        let queue = &recovered["session-1"];
        assert_eq!(
            queue
                .iter()
                .map(|message| message.id.as_str())
                .collect::<Vec<_>>(),
            vec!["pending-1", "pending-3"]
        );
        assert_eq!(
            queue[0].recovery_status.as_deref(),
            Some(RECOVERED_DELIVERY_UNKNOWN)
        );
        assert_eq!(queue[1].recovery_status.as_deref(), Some(RECOVERED_UNSENT));
    }
}
