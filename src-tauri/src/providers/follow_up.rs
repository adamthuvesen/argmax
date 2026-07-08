use super::runtime::sqlite_error;
use crate::error::ArgmaxResult;

const FOLLOW_UP_CONTEXT_MAX_MESSAGES: usize = 12;
const FOLLOW_UP_CONTEXT_MAX_CHARS: usize = 12_000;

pub(super) fn compose_follow_up_prompt(
    connection: &rusqlite::Connection,
    session_id: &str,
    message: &str,
) -> ArgmaxResult<String> {
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
        return Ok(message.to_string());
    }

    let mut transcript_chars = transcript.iter().map(|line| line.len()).sum::<usize>()
        + transcript.len().saturating_sub(1);
    while transcript_chars > FOLLOW_UP_CONTEXT_MAX_CHARS && transcript.len() > 1 {
        transcript_chars = transcript_chars.saturating_sub(transcript[0].len() + 1);
        transcript.remove(0);
    }

    Ok(format!(
        "The user is continuing this Argmax chat session. Use the visible conversation transcript below as context for the new message. Continue naturally.\n\nConversation so far:\n{}\n\nNew user message:\n{}",
        transcript.join("\n"),
        message
    ))
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

        let prompt = compose_follow_up_prompt(&connection, "s1", "next").expect("prompt");

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

        let prompt = compose_follow_up_prompt(&connection, "s1", "next").expect("prompt");

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

        let prompt = compose_follow_up_prompt(&connection, "s1", "next").expect("prompt");

        assert!(prompt.contains("User: real question"));
        assert!(prompt.contains("Assistant: real answer"));
        assert!(!prompt.contains("claude child prose"));
        assert!(!prompt.contains("imported child message"));
        assert!(!prompt.contains("codex child message"));
    }

    fn seed_session(connection: &rusqlite::Connection) {
        connection
            .execute(
                "INSERT INTO projects (id, name, repo_path, current_branch, default_provider, default_model_label, worktree_location, created_at, updated_at) VALUES ('p1', 'p1', '/tmp/p1', 'main', 'claude', 'Sonnet', '~/.argmax', '2026-05-24T10:00:00.000Z', '2026-05-24T10:00:00.000Z')",
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
