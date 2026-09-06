use super::runtime::sqlite_error;
use crate::{
    error::{ArgmaxError, ArgmaxResult},
    ipc::inputs::AgentReference,
    persistence::events::has_current_native_agent_identity,
    providers::cursor_acp::is_acp_model_id,
};
use rusqlite::OptionalExtension;

const FOLLOW_UP_CONTEXT_MAX_MESSAGES: usize = 12;
const FOLLOW_UP_CONTEXT_MAX_CHARS: usize = 12_000;

pub(super) fn ensure_agent_references_supported(
    provider: &str,
    model_id: &str,
    references: &[AgentReference],
) -> ArgmaxResult<()> {
    if references.is_empty() {
        return Ok(());
    }
    if provider == "cursor" && is_acp_model_id(model_id) {
        return Err(ArgmaxError::service(
            "AGENT_REFERENCE_UNAVAILABLE",
            "Cursor Composer 2.5 does not support persistent native agent references.",
        ));
    }
    Ok(())
}

/// Resolve dock names against the current native conversation at delivery time.
/// The visible user message stays unchanged, including when it was queued.
pub(super) fn agent_reference_prompt(
    connection: &rusqlite::Connection,
    session_id: &str,
    prompt: &str,
    references: &[AgentReference],
) -> ArgmaxResult<String> {
    if references.is_empty() {
        return Ok(prompt.to_string());
    }
    let mut resolved = std::collections::BTreeMap::new();
    for reference in references {
        if !has_current_native_agent_identity(
            connection,
            session_id,
            reference.provider_parent_conversation_id.as_str(),
            reference.provider_child_session_id.as_str(),
        )? {
            return Err(ArgmaxError::service("AGENT_REFERENCE_UNAVAILABLE", format!(
                "{} is not available in this provider conversation. Continue it from its original chat.",
                reference.name.as_str()
            )));
        }
        if let Some(previous) = resolved.insert(
            reference.name.as_str(),
            reference.provider_child_session_id.as_str(),
        ) {
            if previous != reference.provider_child_session_id.as_str() {
                return Err(ArgmaxError::service(
                    "AGENT_REFERENCE_UNAVAILABLE",
                    format!(
                        "More than one subagent is named {}. Refer to its assignment instead.",
                        reference.name.as_str()
                    ),
                ));
            }
        }
    }
    let roster = serde_json::to_string(&resolved)
        .map_err(|error| ArgmaxError::service("AGENT_REFERENCES", error.to_string()))?;
    let (provider, model_id): (String, String) = connection
        .query_row(
            "SELECT provider, model_id FROM sessions WHERE id = ?",
            (session_id,),
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .map_err(sqlite_error)?;
    ensure_agent_references_supported(&provider, &model_id, references)?;
    let guidance = match provider.as_str() {
        "claude" => "Use SendMessage to continue a referenced agent when its existing context is relevant.",
        "codex" => "Use send_input to continue the referenced native child with its existing context, using resume_agent first if the child is no longer active. Wait for the child's terminal status and answer. A successful delivery or pending_init status does not mean the child has completed.",
        "opencode" => "Use the task tool with the referenced native task_id to continue it with its existing context. Verify the returned task id matches the referenced id before treating it as a continuation. Wait for the task result and answer. Do not use direct dock input.",
        "cursor" => "Use the Task tool with `resume` set to the referenced native agent ID. Wait for its task result and answer. Do not use direct dock input.",
        _ => return Err(ArgmaxError::service("AGENT_REFERENCE_UNAVAILABLE", "This provider does not support native agent references.")),
    };
    Ok(format!(
        "Argmax dock names for this {provider} conversation (JSON name to native agent ID): {roster}\n{guidance} If native continuation fails, report that failure before proposing a fresh agent.\n\n{prompt}"
    ))
}

/// The prompt a follow-up turn launches with. `native_resume` says the provider
/// is being handed its own conversation id, which is the difference between
/// continuing a conversation and rebuilding one.
pub(super) fn compose_follow_up_prompt(
    connection: &rusqlite::Connection,
    session_id: &str,
    message: &str,
    native_resume: bool,
) -> ArgmaxResult<String> {
    let handoff = pending_project_handoff(connection, session_id)?;
    // A native resume replays the provider's own rollout, so the transcript
    // below would hand it turns it already holds in full — capped at 12
    // messages and retold in a voice that is not its own. Only the handoff
    // note survives: no rollout records that the checkout moved.
    if native_resume {
        return Ok(handoff_prompt(handoff.as_deref(), message));
    }

    // Child-agent rows are hidden from the visible transcript, so they must
    // not resurface here: Claude child prose carries `parent_tool_use_id`,
    // trace-imported Codex/Cursor rows carry `traceImported`, and live Codex
    // child messages are `agent_message` payloads with thread linkage.
    let mut statement = connection
        .prepare(
            r#"
            SELECT type, message
            FROM events
            WHERE session_id = ?
              AND type IN ('user.message', 'message.completed', 'error')
              AND trim(message) <> ''
              AND rowid > COALESCE((
                SELECT MAX(rowid) FROM events cleared
                WHERE cleared.session_id = events.session_id
                  AND cleared.type = 'session.cleared'
              ), 0)
              AND json_extract(payload_json, '$.parent_tool_use_id') IS NULL
              AND json_extract(payload_json, '$.traceImported') IS NULL
              AND NOT (
                (json_extract(payload_json, '$.item_type') = 'agent_message'
                  OR json_extract(payload_json, '$.item.type') = 'agent_message')
                AND (json_extract(payload_json, '$.thread_id') IS NOT NULL
                  OR json_extract(payload_json, '$.sender_thread_id') IS NOT NULL
                  OR json_extract(payload_json, '$.item.thread_id') IS NOT NULL
                  OR json_extract(payload_json, '$.item.sender_thread_id') IS NOT NULL)
              )
            ORDER BY rowid DESC
            LIMIT ?
            "#,
        )
        .map_err(sqlite_error)?;
    let rows = statement
        .query_map((session_id, FOLLOW_UP_CONTEXT_MAX_MESSAGES as i64), |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(sqlite_error)?;
    let mut transcript = rows
        .collect::<Result<Vec<_>, _>>()
        .map_err(sqlite_error)?
        .into_iter()
        .filter_map(|(event_type, text)| {
            let speaker = match event_type.as_str() {
                "user.message" => "User",
                "message.completed" => "Assistant",
                "error" => "System",
                _ => return None,
            };
            let text = text.trim();
            if text.is_empty() {
                None
            } else {
                Some(format!("{speaker}: {}", clamp_context_text(text)))
            }
        })
        .collect::<Vec<_>>();
    transcript.reverse();

    if transcript.is_empty() {
        return Ok(handoff_prompt(handoff.as_deref(), message));
    }

    let mut transcript_chars = transcript.iter().map(|line| line.len()).sum::<usize>()
        + transcript.len().saturating_sub(1);
    while transcript_chars > FOLLOW_UP_CONTEXT_MAX_CHARS && transcript.len() > 1 {
        transcript_chars = transcript_chars.saturating_sub(transcript[0].len() + 1);
        transcript.remove(0);
    }

    let handoff = handoff
        .map(|note| format!("\n\nProject handoff:\n{note}"))
        .unwrap_or_default();
    Ok(format!(
        "The user is continuing this Argmax chat session. Use the visible conversation transcript below as context for the new message. Continue naturally.{handoff}\n\nConversation so far:\n{}\n\nNew user message:\n{}",
        transcript.join("\n"),
        message
    ))
}

/// The prompt when no transcript is carried: the message alone, or the message
/// behind the one-time project handoff note.
fn handoff_prompt(handoff: Option<&str>, message: &str) -> String {
    handoff.map_or_else(
        || message.to_string(),
        |note| format!("Project handoff:\n{note}\n\nNew user message:\n{message}"),
    )
}

fn pending_project_handoff(
    connection: &rusqlite::Connection,
    session_id: &str,
) -> ArgmaxResult<Option<String>> {
    connection
        .query_row(
            r#"
            SELECT
              json_extract(moved.payload_json, '$.sourceProjectName'),
              json_extract(moved.payload_json, '$.destinationProjectName'),
              json_extract(moved.payload_json, '$.destinationPath'),
              json_extract(moved.payload_json, '$.checkoutMode')
            FROM events moved
            WHERE moved.session_id = ?
              AND moved.type = 'session.moved'
              AND json_extract(moved.payload_json, '$.direction') = 'destination'
              AND NOT EXISTS (
                SELECT 1
                FROM events later
                WHERE later.session_id = moved.session_id
                  AND later.rowid > moved.rowid
                  AND later.type = 'user.message'
              )
            ORDER BY moved.rowid DESC
            LIMIT 1
            "#,
            [session_id],
            |row| {
                let source: String = row.get(0)?;
                let destination: String = row.get(1)?;
                let path: String = row.get(2)?;
                let checkout_mode: Option<String> = row.get(3)?;
                // A checkout move stays in one project, so naming it twice
                // would read "moved from Argmax to Argmax" on the one move
                // where the directory is the whole point.
                Ok(if checkout_mode.as_deref() == Some("attached") {
                    format!("This chat moved to another checkout of {destination}. Work in it at {path}.")
                } else {
                    format!(
                        "This chat moved from {source} to {destination}. Work in the destination checkout at {path}."
                    )
                })
            },
        )
        .optional()
        .map_err(sqlite_error)
}

fn clamp_context_text(text: &str) -> String {
    const MAX_LINE_CHARS: usize = 4_000;
    if text.len() <= MAX_LINE_CHARS {
        return text.to_string();
    }

    let mut end = 0;
    for (index, _) in text.char_indices() {
        if index > MAX_LINE_CHARS {
            break;
        }
        end = index;
    }
    format!("{}...", text[..end].trim_end())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::persistence::{
        database::Database,
        events::{persist_timeline_event, PersistTimelineEventInput},
    };
    use serde_json::{json, Value};

    #[test]
    fn follow_up_prompt_reads_latest_messages_only() {
        let database = Database::open_in_memory().expect("open db");
        let connection = database.connection();
        seed_session(&connection);
        for index in 0..20 {
            persist_timeline_event(
                &connection,
                &PersistTimelineEventInput {
                    id: format!("event-{index}"),
                    session_id: "s1".to_string(),
                    r#type: "user.message".to_string(),
                    message: format!("message {index}"),
                    payload: json!({}),
                    created_at: Some(format!("2026-05-24T10:00:{index:02}.000Z")),
                },
            )
            .expect("insert event");
        }

        let prompt = compose_follow_up_prompt(&connection, "s1", "next", false).expect("prompt");

        assert!(!prompt.contains("message 7"));
        assert!(prompt.contains("message 8"));
        assert!(prompt.contains("message 19"));
        assert!(prompt.contains("New user message:\nnext"));
    }

    #[test]
    fn follow_up_prompt_keeps_newest_lines_under_char_budget() {
        let database = Database::open_in_memory().expect("open db");
        let connection = database.connection();
        seed_session(&connection);
        for index in 0..4 {
            persist_timeline_event(
                &connection,
                &PersistTimelineEventInput {
                    id: format!("large-{index}"),
                    session_id: "s1".to_string(),
                    r#type: "message.completed".to_string(),
                    message: format!("large {index} {}", "x".repeat(4_000)),
                    payload: json!({}),
                    created_at: Some(format!("2026-05-24T10:00:{index:02}.000Z")),
                },
            )
            .expect("insert event");
        }

        let prompt = compose_follow_up_prompt(&connection, "s1", "next", false).expect("prompt");

        assert!(!prompt.contains("large 0"));
        assert!(!prompt.contains("large 1"));
        assert!(prompt.contains("large 2"));
        assert!(prompt.contains("large 3"));
    }

    #[test]
    fn follow_up_prompt_excludes_child_agent_rows() {
        let database = Database::open_in_memory().expect("open db");
        let connection = database.connection();
        seed_session(&connection);
        let rows: [(&str, &str, Value); 5] = [
            ("user.message", "real question", json!({})),
            (
                "message.completed",
                "claude child prose",
                json!({ "parent_tool_use_id": "toolu_1" }),
            ),
            (
                "message.completed",
                "imported child message",
                json!({ "parent_tool_use_id": "toolu_1", "traceImported": true }),
            ),
            (
                "message.completed",
                "codex child message",
                json!({ "item_type": "agent_message", "thread_id": "thread-child" }),
            ),
            ("message.completed", "real answer", json!({})),
        ];
        for (index, (event_type, message, payload)) in rows.into_iter().enumerate() {
            persist_timeline_event(
                &connection,
                &PersistTimelineEventInput {
                    id: format!("event-{index}"),
                    session_id: "s1".to_string(),
                    r#type: event_type.to_string(),
                    message: message.to_string(),
                    payload,
                    created_at: Some(format!("2026-05-24T10:00:{index:02}.000Z")),
                },
            )
            .expect("insert event");
        }

        let prompt = compose_follow_up_prompt(&connection, "s1", "next", false).expect("prompt");

        assert!(prompt.contains("User: real question"));
        assert!(prompt.contains("Assistant: real answer"));
        assert!(!prompt.contains("claude child prose"));
        assert!(!prompt.contains("imported child message"));
        assert!(!prompt.contains("codex child message"));
    }

    #[test]
    fn follow_up_prompt_drops_transcript_before_a_clear() {
        let database = Database::open_in_memory().expect("open db");
        let connection = database.connection();
        seed_session(&connection);
        persist_timeline_event(
            &connection,
            &PersistTimelineEventInput {
                id: "old-user".to_string(),
                session_id: "s1".to_string(),
                r#type: "user.message".to_string(),
                message: "secret prior turn".to_string(),
                payload: json!({}),
                created_at: Some("2026-05-24T10:00:00.000Z".to_string()),
            },
        )
        .expect("old user");
        persist_timeline_event(
            &connection,
            &PersistTimelineEventInput {
                id: "old-assistant".to_string(),
                session_id: "s1".to_string(),
                r#type: "message.completed".to_string(),
                message: "secret prior answer".to_string(),
                payload: json!({}),
                created_at: Some("2026-05-24T10:00:01.000Z".to_string()),
            },
        )
        .expect("old assistant");
        persist_timeline_event(
            &connection,
            &PersistTimelineEventInput {
                id: "clear".to_string(),
                session_id: "s1".to_string(),
                r#type: "session.cleared".to_string(),
                message: "Cleared conversation.".to_string(),
                payload: json!({}),
                created_at: Some("2026-05-24T10:00:02.000Z".to_string()),
            },
        )
        .expect("clear");

        let prompt =
            compose_follow_up_prompt(&connection, "s1", "fresh start", false).expect("prompt");

        assert!(!prompt.contains("secret prior"));
        assert!(!prompt.contains("Conversation so far:"));
        assert_eq!(prompt, "fresh start");
    }

    #[test]
    fn project_handoff_is_injected_once_before_the_first_destination_turn() {
        let database = Database::open_in_memory().expect("open db");
        let connection = database.connection();
        seed_session(&connection);
        persist_timeline_event(
            &connection,
            &PersistTimelineEventInput {
                id: "move".to_string(),
                session_id: "s1".to_string(),
                r#type: "session.moved".to_string(),
                message: "Moved from HQ to Argmax.".to_string(),
                payload: json!({
                    "direction": "destination",
                    "sourceProjectName": "HQ",
                    "destinationProjectName": "Argmax",
                    "destinationPath": "/tmp/argmax",
                }),
                created_at: None,
            },
        )
        .expect("move event");

        let first =
            compose_follow_up_prompt(&connection, "s1", "continue", false).expect("first prompt");
        assert!(first.contains("Project handoff:"));
        assert!(first.contains("This chat moved from HQ to Argmax."));
        assert!(first.contains("/tmp/argmax"));

        persist_timeline_event(
            &connection,
            &PersistTimelineEventInput {
                id: "destination-user-message".to_string(),
                session_id: "s1".to_string(),
                r#type: "user.message".to_string(),
                message: "continue".to_string(),
                payload: json!({}),
                created_at: None,
            },
        )
        .expect("destination user message");
        let later =
            compose_follow_up_prompt(&connection, "s1", "again", false).expect("later prompt");
        assert!(!later.contains("Project handoff:"));
    }

    #[test]
    fn native_resume_prompt_carries_the_message_alone() {
        let database = Database::open_in_memory().expect("open db");
        let connection = database.connection();
        seed_session(&connection);
        for (index, (event_type, message)) in [
            ("user.message", "earlier question"),
            ("message.completed", "earlier answer"),
        ]
        .into_iter()
        .enumerate()
        {
            persist_timeline_event(
                &connection,
                &PersistTimelineEventInput {
                    id: format!("event-{index}"),
                    session_id: "s1".to_string(),
                    r#type: event_type.to_string(),
                    message: message.to_string(),
                    payload: json!({}),
                    created_at: Some(format!("2026-05-24T10:00:{index:02}.000Z")),
                },
            )
            .expect("insert event");
        }

        let prompt = compose_follow_up_prompt(&connection, "s1", "next", true).expect("prompt");

        assert_eq!(prompt, "next");
    }

    #[test]
    fn dock_references_resolve_only_in_their_current_native_conversation() {
        for provider in ["claude", "codex", "cursor", "opencode"] {
            let database = Database::open_in_memory().expect("open db");
            let connection = database.connection();
            seed_session(&connection);
            connection
            .execute(
                "UPDATE sessions SET provider = ?, provider_conversation_id = 'parent-1' WHERE id = 's1'",
                (provider,),
            )
            .expect("native parent");
            persist_timeline_event(
                &connection,
                &PersistTimelineEventInput {
                    id: "agent-start".to_string(),
                    session_id: "s1".to_string(),
                    r#type: "agent.started".to_string(),
                    message: "Research".to_string(),
                    payload: json!({
                        "providerChildSessionId": "child-1",
                        "providerParentConversationId": "parent-1",
                        "agentRunId": "task-1"
                    }),
                    created_at: None,
                },
            )
            .expect("agent identity");
            let references: Vec<AgentReference> = serde_json::from_value(json!([{
                "name": "Gauss",
                "providerChildSessionId": "child-1",
                "providerParentConversationId": "parent-1"
            }]))
            .expect("reference");
            let prompt = agent_reference_prompt(&connection, "s1", "Ask Gauss again", &references)
                .expect("mapped prompt");
            assert!(prompt.contains(r#"{"Gauss":"child-1"}"#));
            assert!(prompt.ends_with("Ask Gauss again"));
            assert!(prompt.contains(&format!("this {provider} conversation")));
            if provider == "opencode" {
                assert!(prompt.contains("task_id"));
            }
            if provider == "cursor" {
                assert!(prompt.contains("`resume`"));
            }
            connection
            .execute(
                "UPDATE sessions SET provider = 'cursor', model_id = 'composer-2.5' WHERE id = 's1'",
                [],
            )
            .expect("unsupported Cursor model");
            assert!(
                agent_reference_prompt(&connection, "s1", "Ask Gauss again", &references).is_err()
            );
            connection
            .execute(
                "UPDATE sessions SET provider = ?, model_id = 'claude-sonnet-5' WHERE id = 's1'",
                    (provider,),
                )
                .expect("restore provider");
            connection
                .execute("UPDATE sessions SET resume_fork = 1 WHERE id = 's1'", [])
                .expect("fork boundary");
            assert!(
                agent_reference_prompt(&connection, "s1", "Ask Gauss again", &references).is_err()
            );
            connection
                .execute("UPDATE sessions SET resume_fork = 0 WHERE id = 's1'", [])
                .expect("restore parent");
            persist_timeline_event(
                &connection,
                &PersistTimelineEventInput {
                    id: "clear-reference".to_string(),
                    session_id: "s1".to_string(),
                    r#type: "session.cleared".to_string(),
                    message: "Cleared".to_string(),
                    payload: json!({}),
                    created_at: None,
                },
            )
            .expect("clear boundary");
            assert!(
                agent_reference_prompt(&connection, "s1", "Ask Gauss again", &references).is_err()
            );
            assert_eq!(
                agent_reference_prompt(&connection, "s1", "An unrelated question", &[])
                    .expect("no references"),
                "An unrelated question"
            );
        }
    }

    #[test]
    fn native_resume_prompt_still_carries_the_project_handoff() {
        let database = Database::open_in_memory().expect("open db");
        let connection = database.connection();
        seed_session(&connection);
        persist_timeline_event(
            &connection,
            &PersistTimelineEventInput {
                id: "move".to_string(),
                session_id: "s1".to_string(),
                r#type: "session.moved".to_string(),
                message: "Moved from HQ to Argmax.".to_string(),
                payload: json!({
                    "direction": "destination",
                    "sourceProjectName": "HQ",
                    "destinationProjectName": "Argmax",
                    "destinationPath": "/tmp/argmax",
                }),
                created_at: None,
            },
        )
        .expect("move event");

        let prompt = compose_follow_up_prompt(&connection, "s1", "continue", true).expect("prompt");

        assert!(prompt.contains("This chat moved from HQ to Argmax."));
        assert!(prompt.contains("New user message:\ncontinue"));
        assert!(!prompt.contains("Conversation so far:"));
    }

    fn seed_session(connection: &rusqlite::Connection) {
        connection
            .execute(
                "INSERT INTO projects (id, name, repo_path, current_branch, worktree_location, created_at, updated_at) VALUES ('p1', 'p1', '/tmp/p1', 'main', '~/.argmax', '2026-05-24T10:00:00.000Z', '2026-05-24T10:00:00.000Z')",
                [],
            )
            .expect("insert project");
        connection
            .execute(
                "INSERT INTO workspaces (id, project_id, task_label, branch, base_ref, path, state, last_activity_at, created_at, updated_at) VALUES ('w1', 'p1', 'task', 'branch', 'main', '/tmp/w1', 'running', '2026-05-24T10:00:00.000Z', '2026-05-24T10:00:00.000Z', '2026-05-24T10:00:00.000Z')",
                [],
            )
            .expect("insert workspace");
        connection
            .execute(
                "INSERT INTO sessions (id, workspace_id, provider, model_label, model_id, reasoning_effort, permission_mode, agent_mode, prompt, state, attention, started_at, last_activity_at) VALUES ('s1', 'w1', 'claude', 'Sonnet', 'claude-sonnet-5', NULL, 'auto-approve', 'auto', 'prompt', 'complete', 'none', '2026-05-24T10:00:00.000Z', '2026-05-24T10:00:00.000Z')",
                [],
            )
            .expect("insert session");
    }
}
