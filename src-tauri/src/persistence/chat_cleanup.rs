use std::collections::HashSet;

use rusqlite::{Connection, OptionalExtension};

use super::sqlite_error;
use crate::error::ArgmaxResult;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChatCleanupPlan {
    pub cleanup_id: String,
    pub cutoff_at: String,
    pub session_ids: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChatCleanupOutcome {
    pub deleted_session_ids: Vec<String>,
    pub deleted_workspace_ids: Vec<String>,
    pub skipped_recent_count: u32,
    pub skipped_running_count: u32,
}

/// Sessions shown by the confirmation step. A chat with durable work waiting
/// to run is active even while its session row is briefly in a terminal state.
pub fn eligible_session_ids(connection: &Connection, cutoff_at: &str) -> ArgmaxResult<Vec<String>> {
    let mut statement = connection
        .prepare_cached(
            r#"
            SELECT sessions.id
            FROM sessions
            WHERE sessions.last_activity_at < ?
              AND sessions.state NOT IN ('created', 'running', 'waiting', 'blocked')
              AND NOT EXISTS (
                SELECT 1 FROM pending_messages
                WHERE pending_messages.session_id = sessions.id
              )
              AND NOT EXISTS (
                SELECT 1 FROM session_after_turn
                WHERE session_after_turn.session_id = sessions.id
              )
              AND NOT EXISTS (
                SELECT 1 FROM goals
                WHERE goals.session_id = sessions.id AND goals.state = 'active'
              )
            ORDER BY sessions.last_activity_at, sessions.id
            "#,
        )
        .map_err(sqlite_error)?;
    let session_ids = statement
        .query_map([cutoff_at], |row| row.get::<_, String>(0))
        .map_err(sqlite_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(sqlite_error)?;
    Ok(session_ids)
}

pub fn candidate_workspace_ids(
    connection: &Connection,
    session_ids: &[String],
) -> ArgmaxResult<Vec<String>> {
    let mut workspace_ids = Vec::new();
    let mut statement = connection
        .prepare_cached("SELECT workspace_id FROM sessions WHERE id = ?")
        .map_err(sqlite_error)?;
    for session_id in session_ids {
        if let Some(workspace_id) = statement
            .query_row([session_id], |row| row.get::<_, String>(0))
            .optional()
            .map_err(sqlite_error)?
        {
            workspace_ids.push(workspace_id);
        }
    }
    workspace_ids.sort();
    workspace_ids.dedup();
    Ok(workspace_ids)
}

/// Apply one confirmed preview. Candidate ids and cutoff both come from the
/// preview, while each row's activity and protected-work state are checked
/// again inside the deletion transaction.
pub fn delete_old_chats(
    connection: &mut Connection,
    plan: &ChatCleanupPlan,
    deleted_at: &str,
    protected_workspace_ids: &HashSet<String>,
) -> ArgmaxResult<ChatCleanupOutcome> {
    let transaction = connection.transaction().map_err(sqlite_error)?;
    let mut outcome = ChatCleanupOutcome {
        deleted_session_ids: Vec::new(),
        deleted_workspace_ids: Vec::new(),
        skipped_recent_count: 0,
        skipped_running_count: 0,
    };
    let mut affected_workspace_ids = Vec::new();

    for session_id in &plan.session_ids {
        let row = transaction
            .query_row(
                r#"
                SELECT sessions.workspace_id, sessions.last_activity_at,
                       CASE WHEN sessions.state IN ('created', 'running', 'waiting', 'blocked')
                              OR EXISTS (
                                  SELECT 1 FROM pending_messages
                                  WHERE pending_messages.session_id = sessions.id
                              )
                              OR EXISTS (
                                  SELECT 1 FROM session_after_turn
                                  WHERE session_after_turn.session_id = sessions.id
                              )
                              OR EXISTS (
                                  SELECT 1 FROM goals
                                  WHERE goals.session_id = sessions.id AND goals.state = 'active'
                              )
                            THEN 1 ELSE 0 END
                FROM sessions
                WHERE sessions.id = ?
                "#,
                [session_id],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, i64>(2)? != 0,
                    ))
                },
            )
            .optional()
            .map_err(sqlite_error)?;
        let Some((workspace_id, last_activity_at, protected)) = row else {
            continue;
        };
        if last_activity_at.as_str() >= plan.cutoff_at.as_str() {
            outcome.skipped_recent_count += 1;
            continue;
        }
        if protected || protected_workspace_ids.contains(&workspace_id) {
            outcome.skipped_running_count += 1;
            continue;
        }

        // The provider transcript remains on disk. Keep its native id after
        // deleting the sync bookkeeping row so a later sweep cannot recreate
        // a chat the user deliberately removed.
        transaction
            .execute(
                r#"
                INSERT OR IGNORE INTO synced_session_tombstones (
                    provider, external_id, deleted_at
                )
                SELECT provider, provider_conversation_id, ?
                FROM sessions
                WHERE id = ? AND provider_conversation_id IS NOT NULL
                "#,
                (deleted_at, session_id),
            )
            .map_err(sqlite_error)?;
        transaction
            .execute(
                r#"
                INSERT OR IGNORE INTO synced_session_tombstones (
                    provider, external_id, deleted_at
                )
                SELECT provider, external_id, ?
                FROM synced_sessions
                WHERE session_id = ?
                "#,
                (deleted_at, session_id),
            )
            .map_err(sqlite_error)?;
        transaction
            .execute("DELETE FROM sessions WHERE id = ?", [session_id])
            .map_err(sqlite_error)?;
        affected_workspace_ids.push(workspace_id);
        outcome.deleted_session_ids.push(session_id.clone());
    }

    affected_workspace_ids.sort();
    affected_workspace_ids.dedup();
    for workspace_id in affected_workspace_ids {
        let deleted = transaction
            .execute(
                r#"
                DELETE FROM workspaces
                WHERE id = ?
                  AND NOT EXISTS (
                    SELECT 1 FROM sessions WHERE workspace_id = workspaces.id
                  )
                "#,
                [&workspace_id],
            )
            .map_err(sqlite_error)?;
        if deleted > 0 {
            outcome.deleted_workspace_ids.push(workspace_id);
        }
    }

    transaction.commit().map_err(sqlite_error)?;
    Ok(outcome)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::persistence::migrations::run_migrations;
    use crate::persistence::synced::known_conversation_ids;

    const OLD: &str = "2026-09-01T00:00:00.000Z";
    const CUTOFF: &str = "2026-09-04T00:00:00.000Z";
    const RECENT: &str = "2026-09-05T00:00:00.000Z";

    fn database() -> Connection {
        let mut connection = Connection::open_in_memory().expect("open database");
        run_migrations(&mut connection).expect("run migrations");
        connection
            .execute(
                "INSERT INTO projects (id, name, repo_path, current_branch, worktree_location, created_at, updated_at, archive_on_merge) VALUES ('p1', 'Project', '/tmp/project', 'main', '/tmp/worktrees', ?, ?, 0)",
                (OLD, OLD),
            )
            .expect("insert project");
        connection
    }

    fn session(connection: &Connection, id: &str, workspace_id: &str, state: &str, activity: &str) {
        connection
            .execute(
                "INSERT INTO workspaces (id, project_id, task_label, branch, base_ref, path, state, last_activity_at, created_at, updated_at) VALUES (?, 'p1', ?, 'main', 'main', ?, 'complete', ?, ?, ?)",
                (workspace_id, id, format!("/tmp/{workspace_id}"), activity, activity, activity),
            )
            .expect("insert workspace");
        connection
            .execute(
                "INSERT INTO sessions (id, workspace_id, provider, model_label, prompt, state, attention, started_at, last_activity_at) VALUES (?, ?, 'claude', 'Sonnet', 'prompt', ?, 'normal', ?, ?)",
                (id, workspace_id, state, activity, activity),
            )
            .expect("insert session");
    }

    #[test]
    fn preview_excludes_recent_running_and_durably_scheduled_work() {
        let connection = database();
        session(&connection, "old", "w-old", "complete", OLD);
        session(&connection, "recent", "w-recent", "complete", RECENT);
        session(&connection, "running", "w-running", "running", OLD);
        session(&connection, "pending", "w-pending", "complete", OLD);
        session(&connection, "goal", "w-goal", "complete", OLD);
        session(&connection, "after-turn", "w-after-turn", "complete", OLD);
        connection.execute("INSERT INTO pending_messages (id, session_id, content, agent_mode, fast_mode, attachments_json, agent_references_json, position, queued_at, delivery_state, updated_at) VALUES ('m1', 'pending', 'next', 'auto', 0, '[]', '[]', 0, ?, 'pending', ?)", (OLD, OLD)).unwrap();
        connection.execute("INSERT INTO goals (id, workspace_id, session_id, condition, state, turns, max_turns, created_at, updated_at) VALUES ('g1', 'w-goal', 'goal', 'finish', 'active', 0, 5, ?, ?)", (OLD, OLD)).unwrap();
        connection.execute("INSERT INTO session_after_turn (session_id, action, payload_json, requested_at) VALUES ('after-turn', 'archive', '{\"workspaceId\":\"w-after-turn\"}', ?)", [OLD]).unwrap();

        assert_eq!(
            eligible_session_ids(&connection, CUTOFF).unwrap(),
            vec!["old"]
        );
    }

    #[test]
    fn delete_revalidates_activity_and_work_before_removing_empty_workspaces() {
        let mut connection = database();
        session(&connection, "delete", "w-delete", "complete", OLD);
        session(&connection, "recent", "w-recent", "complete", OLD);
        session(&connection, "running", "w-running", "complete", OLD);
        session(&connection, "process", "w-process", "complete", OLD);
        let plan = ChatCleanupPlan {
            cleanup_id: "cleanup".into(),
            cutoff_at: CUTOFF.into(),
            session_ids: vec![
                "delete".into(),
                "recent".into(),
                "running".into(),
                "process".into(),
            ],
        };
        connection
            .execute(
                "UPDATE sessions SET last_activity_at = ? WHERE id = 'recent'",
                [RECENT],
            )
            .unwrap();
        connection
            .execute(
                "UPDATE sessions SET state = 'running' WHERE id = 'running'",
                [],
            )
            .unwrap();

        let protected = HashSet::from(["w-process".to_string()]);
        let outcome = delete_old_chats(&mut connection, &plan, RECENT, &protected).unwrap();

        assert_eq!(outcome.deleted_session_ids, vec!["delete"]);
        assert_eq!(outcome.deleted_workspace_ids, vec!["w-delete"]);
        assert_eq!(outcome.skipped_recent_count, 1);
        assert_eq!(outcome.skipped_running_count, 2);
        let remaining: i64 = connection
            .query_row("SELECT COUNT(*) FROM sessions", [], |row| row.get(0))
            .unwrap();
        assert_eq!(remaining, 3);
    }

    #[test]
    fn deleting_chats_keeps_native_and_imported_provider_ids_tombstoned() {
        let mut connection = database();
        session(&connection, "imported", "w-imported", "complete", OLD);
        session(&connection, "launched", "w-launched", "complete", OLD);
        connection.execute("UPDATE sessions SET imported = 1, provider_conversation_id = 'native-1' WHERE id = 'imported'", []).unwrap();
        connection
            .execute(
                "UPDATE sessions SET provider_conversation_id = 'native-2' WHERE id = 'launched'",
                [],
            )
            .unwrap();
        connection.execute("INSERT INTO synced_sessions (session_id, provider, external_id, source_path, byte_cursor, line_cursor, source_mtime_ms, adopted, started_at, last_synced_at) VALUES ('imported', 'claude', 'native-1', '/tmp/native-1.jsonl', 0, 0, 0, 0, ?, ?)", (OLD, OLD)).unwrap();
        let plan = ChatCleanupPlan {
            cleanup_id: "cleanup".into(),
            cutoff_at: CUTOFF.into(),
            session_ids: vec!["imported".into(), "launched".into()],
        };

        delete_old_chats(&mut connection, &plan, RECENT, &HashSet::new()).unwrap();

        let known = known_conversation_ids(&connection, "claude").unwrap();
        assert!(known.contains("native-1"));
        assert!(known.contains("native-2"));
    }
}
