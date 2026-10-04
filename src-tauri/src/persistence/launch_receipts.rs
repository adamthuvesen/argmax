// Launch receipts: the durable record that makes a retried `session_launch`
// safe (docs/agent-tools.md#retrying-a-launch). A receipt is written before the
// launch spends anything, so a retry after a timeout, a dropped socket or a
// restart can find out what the first call did instead of doing it again.

use rusqlite::{params, Connection, OptionalExtension, Row};

use super::{sqlite_error, time::now_iso};
use crate::error::ArgmaxResult;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReceiptStatus {
    /// In flight in this process.
    Pending,
    /// The session started; `result_json` is the reply to replay.
    Completed,
    /// No session was started: the launch was refused or failed before the
    /// session was written. Model calls it made first (the router, project
    /// check) are not undone. The key may be tried again.
    Failed,
    /// The process stopped, or the call was dropped, mid-launch. The provider
    /// may already have been paid, so the launch is never repeated for this key.
    Uncertain,
}

impl ReceiptStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::Completed => "completed",
            Self::Failed => "failed",
            Self::Uncertain => "uncertain",
        }
    }

    fn parse(value: &str) -> Option<Self> {
        match value {
            "pending" => Some(Self::Pending),
            "completed" => Some(Self::Completed),
            "failed" => Some(Self::Failed),
            "uncertain" => Some(Self::Uncertain),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LaunchReceipt {
    pub caller_session_id: String,
    pub client_request_id: String,
    /// Digest of the canonical request. A reused key with other arguments is
    /// a caller bug, not a retry.
    pub request_hash: String,
    pub status: ReceiptStatus,
    /// Allocated before the launch so every status can name the session.
    pub session_id: String,
    /// Known once the checkout exists, which is before the provider starts.
    pub workspace_id: Option<String>,
    pub result_json: Option<String>,
    pub error_code: Option<String>,
    pub error_message: Option<String>,
}

#[derive(Debug, PartialEq, Eq)]
pub enum Claim {
    /// This call owns the launch.
    Claimed(LaunchReceipt),
    /// The key was used before. The caller decides from `status`.
    Existing(LaunchReceipt),
}

const COLUMNS: &str = "caller_session_id, client_request_id, request_hash, status, session_id, \
     workspace_id, result_json, error_code, error_message";

fn row_to_receipt(row: &Row<'_>) -> rusqlite::Result<LaunchReceipt> {
    let status: String = row.get(3)?;
    Ok(LaunchReceipt {
        caller_session_id: row.get(0)?,
        client_request_id: row.get(1)?,
        request_hash: row.get(2)?,
        status: ReceiptStatus::parse(&status).ok_or_else(|| {
            rusqlite::Error::FromSqlConversionFailure(
                3,
                rusqlite::types::Type::Text,
                format!("unknown launch receipt status {status}").into(),
            )
        })?,
        session_id: row.get(4)?,
        workspace_id: row.get(5)?,
        result_json: row.get(6)?,
        error_code: row.get(7)?,
        error_message: row.get(8)?,
    })
}

pub fn find_receipt(
    connection: &Connection,
    caller_session_id: &str,
    client_request_id: &str,
) -> ArgmaxResult<Option<LaunchReceipt>> {
    connection
        .prepare_cached(&format!(
            "SELECT {COLUMNS} FROM launch_receipts WHERE caller_session_id = ? AND client_request_id = ?"
        ))
        .map_err(sqlite_error)?
        .query_row(params![caller_session_id, client_request_id], row_to_receipt)
        .optional()
        .map_err(sqlite_error)
}

/// Take the key, or report who has it. One write transaction, so two calls
/// racing on the same key cannot both be told they own it. A `failed` receipt
/// with the same request is reopened: it spent nothing, so trying again is the
/// point of retrying. Every other status stays as it is.
pub fn claim_receipt(
    connection: &mut Connection,
    caller_session_id: &str,
    client_request_id: &str,
    request_hash: &str,
    new_session_id: &str,
) -> ArgmaxResult<Claim> {
    let transaction = connection.transaction().map_err(sqlite_error)?;
    let existing = find_receipt(&transaction, caller_session_id, client_request_id)?;
    let now = now_iso();
    let claim = match existing {
        None => {
            transaction
                .execute(
                    "INSERT INTO launch_receipts (caller_session_id, client_request_id, request_hash, \
                     status, session_id, created_at, updated_at) VALUES (?, ?, ?, 'pending', ?, ?, ?)",
                    params![
                        caller_session_id,
                        client_request_id,
                        request_hash,
                        new_session_id,
                        now,
                        now
                    ],
                )
                .map_err(sqlite_error)?;
            Claim::Claimed(LaunchReceipt {
                caller_session_id: caller_session_id.to_string(),
                client_request_id: client_request_id.to_string(),
                request_hash: request_hash.to_string(),
                status: ReceiptStatus::Pending,
                session_id: new_session_id.to_string(),
                workspace_id: None,
                result_json: None,
                error_code: None,
                error_message: None,
            })
        }
        Some(receipt)
            if receipt.status == ReceiptStatus::Failed && receipt.request_hash == request_hash =>
        {
            transaction
                .execute(
                    "UPDATE launch_receipts SET status = 'pending', session_id = ?, workspace_id = NULL, \
                     error_code = NULL, error_message = NULL, updated_at = ? \
                     WHERE caller_session_id = ? AND client_request_id = ?",
                    params![new_session_id, now, caller_session_id, client_request_id],
                )
                .map_err(sqlite_error)?;
            Claim::Claimed(LaunchReceipt {
                status: ReceiptStatus::Pending,
                session_id: new_session_id.to_string(),
                workspace_id: None,
                error_code: None,
                error_message: None,
                ..receipt
            })
        }
        Some(receipt) => Claim::Existing(receipt),
    };
    transaction.commit().map_err(sqlite_error)?;
    Ok(claim)
}

/// Launch slots the caller has spent that its lineage does not show: a launch
/// that stopped after its session was written but before the lineage was
/// recorded. Only an `uncertain` receipt whose session exists counts. A
/// session is written before its provider starts, so a receipt with no session
/// started nothing and holds no slot. A receipt still `pending` is a launch
/// waiting on the budget lock, which serializes the cap check against the
/// lineage write; counting it would make parallel calls refuse each other.
pub fn count_unrecorded_launches(
    connection: &Connection,
    caller_session_id: &str,
) -> ArgmaxResult<i64> {
    connection
        .prepare_cached(
            "SELECT COUNT(*) FROM launch_receipts r \
             WHERE r.caller_session_id = ?1 AND r.status = 'uncertain' \
               AND EXISTS (SELECT 1 FROM sessions s \
                           WHERE s.id = r.session_id AND s.launched_by_session_id IS NULL)",
        )
        .map_err(sqlite_error)?
        .query_row([caller_session_id], |row| row.get(0))
        .map_err(sqlite_error)
}

/// Give every `uncertain` receipt's session the lineage the interrupted launch
/// never recorded, so its launcher can still read, wait on and count it. The
/// session exists, so nothing is launched again. Returns how many it repaired.
pub fn reconcile_uncertain_lineage(connection: &Connection) -> ArgmaxResult<usize> {
    connection
        .execute(
            "UPDATE sessions SET launched_by_session_id = ( \
                 SELECT r.caller_session_id FROM launch_receipts r \
                 WHERE r.session_id = sessions.id AND r.status = 'uncertain'), \
               launch_depth = COALESCE(( \
                 SELECT c.launch_depth FROM sessions c \
                 JOIN launch_receipts r ON r.caller_session_id = c.id \
                 WHERE r.session_id = sessions.id AND r.status = 'uncertain'), 0) + 1, \
               launch_kind = 'agent' \
             WHERE launched_by_session_id IS NULL AND id IN ( \
                 SELECT session_id FROM launch_receipts WHERE status = 'uncertain')",
            [],
        )
        .map_err(sqlite_error)
}

/// Record the checkout before the provider starts, so an `uncertain` receipt
/// can still say where the work may be running.
pub fn record_workspace(
    connection: &Connection,
    caller_session_id: &str,
    client_request_id: &str,
    workspace_id: &str,
) -> ArgmaxResult<()> {
    connection
        .execute(
            "UPDATE launch_receipts SET workspace_id = ?, updated_at = ? \
             WHERE caller_session_id = ? AND client_request_id = ? AND status = 'pending'",
            params![
                workspace_id,
                now_iso(),
                caller_session_id,
                client_request_id
            ],
        )
        .map_err(sqlite_error)?;
    Ok(())
}

pub fn complete_receipt(
    connection: &Connection,
    caller_session_id: &str,
    client_request_id: &str,
    result_json: &str,
) -> ArgmaxResult<()> {
    settle(
        connection,
        caller_session_id,
        client_request_id,
        ReceiptStatus::Completed,
        Some(result_json),
        None,
    )
}

pub fn fail_receipt(
    connection: &Connection,
    caller_session_id: &str,
    client_request_id: &str,
    error_code: &str,
    error_message: &str,
) -> ArgmaxResult<()> {
    settle(
        connection,
        caller_session_id,
        client_request_id,
        ReceiptStatus::Failed,
        None,
        Some((error_code, error_message)),
    )
}

pub fn mark_receipt_uncertain(
    connection: &Connection,
    caller_session_id: &str,
    client_request_id: &str,
) -> ArgmaxResult<()> {
    settle(
        connection,
        caller_session_id,
        client_request_id,
        ReceiptStatus::Uncertain,
        None,
        None,
    )
}

fn settle(
    connection: &Connection,
    caller_session_id: &str,
    client_request_id: &str,
    status: ReceiptStatus,
    result_json: Option<&str>,
    error: Option<(&str, &str)>,
) -> ArgmaxResult<()> {
    connection
        .execute(
            "UPDATE launch_receipts SET status = ?, result_json = ?, error_code = ?, \
             error_message = ?, updated_at = ? \
             WHERE caller_session_id = ? AND client_request_id = ? AND status = 'pending'",
            params![
                status.as_str(),
                result_json,
                error.map(|(code, _)| code),
                error.map(|(_, message)| message),
                now_iso(),
                caller_session_id,
                client_request_id
            ],
        )
        .map_err(sqlite_error)?;
    Ok(())
}

#[derive(Debug, Default, PartialEq, Eq)]
pub struct RecoveredReceipts {
    /// Receipts whose session was never written: nothing was started.
    pub failed: usize,
    /// Receipts whose session exists: its provider may have started.
    pub uncertain: usize,
    /// Sessions given the lineage the interrupted launch never recorded.
    pub lineage_repaired: usize,
}

/// Boot recovery: a receipt still `pending` belonged to a process that is gone.
/// A session is written, in one transaction, before its provider starts, so a
/// receipt whose session does not exist started nothing and may be retried. One
/// whose session exists may have a running provider, and is never repeated.
pub fn recover_orphaned_receipts(connection: &mut Connection) -> ArgmaxResult<RecoveredReceipts> {
    let transaction = connection.transaction().map_err(sqlite_error)?;
    let now = now_iso();
    let failed = transaction
        .execute(
            "UPDATE launch_receipts SET status = 'failed', error_code = 'LAUNCH_INTERRUPTED', \
             error_message = 'Argmax stopped before the session was created, so nothing was started.', \
             updated_at = ? \
             WHERE status = 'pending' AND NOT EXISTS (SELECT 1 FROM sessions WHERE id = session_id)",
            [&now],
        )
        .map_err(sqlite_error)?;
    let uncertain = transaction
        .execute(
            "UPDATE launch_receipts SET status = 'uncertain', updated_at = ? WHERE status = 'pending'",
            [&now],
        )
        .map_err(sqlite_error)?;
    let lineage_repaired = reconcile_uncertain_lineage(&transaction)?;
    transaction.commit().map_err(sqlite_error)?;
    Ok(RecoveredReceipts {
        failed,
        uncertain,
        lineage_repaired,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::persistence::database::Database;

    fn database_with_caller() -> Database {
        let database = Database::open_in_memory().expect("open db");
        {
            let connection = database.connection();
            connection
                .execute(
                    "INSERT INTO projects (id, name, repo_path, current_branch, worktree_location, created_at, updated_at) VALUES ('p1', 'p1', '/tmp/p1', 'main', '~/.argmax', 't', 't')",
                    [],
                )
                .expect("project");
            connection
                .execute(
                    "INSERT INTO workspaces (id, project_id, task_label, branch, base_ref, path, state, last_activity_at, created_at, updated_at) VALUES ('w1', 'p1', 'task', 'b', 'main', '/tmp/w1', 'running', 't', 't', 't')",
                    [],
                )
                .expect("workspace");
            connection
                .execute(
                    "INSERT INTO sessions (id, workspace_id, provider, model_label, model_id, permission_mode, agent_mode, prompt, state, attention, started_at, last_activity_at) VALUES ('caller', 'w1', 'claude', 'S', 'm', 'auto-approve', 'auto', 'p', 'running', 'none', 't', 't')",
                    [],
                )
                .expect("caller");
        }
        database
    }

    #[test]
    fn the_first_claim_owns_the_key_and_a_second_sees_it_pending() {
        let database = database_with_caller();
        let mut connection = database.connection();
        let first = claim_receipt(&mut connection, "caller", "k1", "hash", "new-1").expect("claim");
        assert!(matches!(&first, Claim::Claimed(r) if r.session_id == "new-1"));
        let second =
            claim_receipt(&mut connection, "caller", "k1", "hash", "new-2").expect("second");
        match second {
            Claim::Existing(receipt) => {
                assert_eq!(receipt.status, ReceiptStatus::Pending);
                assert_eq!(receipt.session_id, "new-1", "the first call's id survives");
            }
            Claim::Claimed(_) => panic!("a second claim must not own the key"),
        }
    }

    #[test]
    fn keys_are_scoped_to_the_calling_session() {
        let database = database_with_caller();
        let mut connection = database.connection();
        connection
            .execute(
                "INSERT INTO sessions (id, workspace_id, provider, model_label, model_id, permission_mode, agent_mode, prompt, state, attention, started_at, last_activity_at) VALUES ('other', 'w1', 'claude', 'S', 'm', 'auto-approve', 'auto', 'p', 'running', 'none', 't', 't')",
                [],
            )
            .expect("other caller");
        claim_receipt(&mut connection, "caller", "k1", "hash", "a").expect("caller claim");
        let other = claim_receipt(&mut connection, "other", "k1", "hash", "b").expect("other");
        assert!(matches!(other, Claim::Claimed(_)));
    }

    #[test]
    fn a_completed_receipt_replays_and_never_reopens() {
        let database = database_with_caller();
        let mut connection = database.connection();
        claim_receipt(&mut connection, "caller", "k1", "hash", "new-1").expect("claim");
        record_workspace(&connection, "caller", "k1", "ws-1").expect("workspace");
        complete_receipt(&connection, "caller", "k1", r#"{"sessionId":"new-1"}"#)
            .expect("complete");
        let Claim::Existing(receipt) =
            claim_receipt(&mut connection, "caller", "k1", "hash", "new-2").expect("retry")
        else {
            panic!("completed receipt must not be claimed again");
        };
        assert_eq!(receipt.status, ReceiptStatus::Completed);
        assert_eq!(receipt.workspace_id.as_deref(), Some("ws-1"));
        assert_eq!(
            receipt.result_json.as_deref(),
            Some(r#"{"sessionId":"new-1"}"#)
        );
    }

    #[test]
    fn a_failed_receipt_is_reopened_for_the_same_request_only() {
        let database = database_with_caller();
        let mut connection = database.connection();
        claim_receipt(&mut connection, "caller", "k1", "hash", "new-1").expect("claim");
        fail_receipt(&connection, "caller", "k1", "LAUNCH_LIMIT_REACHED", "cap").expect("fail");
        let retried =
            claim_receipt(&mut connection, "caller", "k1", "hash", "new-2").expect("retry");
        assert!(matches!(&retried, Claim::Claimed(r) if r.session_id == "new-2"));
        fail_receipt(&connection, "caller", "k1", "X", "y").expect("fail again");
        // Another request under the same key is a mismatch the caller reports.
        let mismatch = claim_receipt(&mut connection, "caller", "k1", "other-hash", "new-3")
            .expect("mismatch");
        assert!(matches!(mismatch, Claim::Existing(r) if r.request_hash == "hash"));
    }

    fn insert_session(connection: &Connection, id: &str, launched_by: Option<&str>) {
        connection
            .execute(
                "INSERT INTO sessions (id, workspace_id, provider, model_label, model_id, permission_mode, agent_mode, prompt, state, attention, started_at, last_activity_at, launched_by_session_id, launch_depth, launch_kind) VALUES (?, 'w1', 'claude', 'S', 'm', 'auto-approve', 'auto', 'p', 'running', 'none', 't', 't', ?, 0, 'user')",
                params![id, launched_by],
            )
            .expect("session");
    }

    #[test]
    fn only_an_uncertain_launch_whose_session_exists_without_lineage_holds_a_slot() {
        let database = database_with_caller();
        let mut connection = database.connection();
        // Waiting on the budget lock: not a slot, the lock serializes the check.
        claim_receipt(&mut connection, "caller", "waiting", "h", "s1").expect("claim");
        // Stopped before its session was written: started nothing, no slot.
        claim_receipt(&mut connection, "caller", "ghost", "h", "s2").expect("claim");
        mark_receipt_uncertain(&connection, "caller", "ghost").expect("uncertain");
        // Stopped after its session was written: the provider may be running.
        claim_receipt(&mut connection, "caller", "lost", "h", "s3").expect("claim");
        mark_receipt_uncertain(&connection, "caller", "lost").expect("uncertain");
        insert_session(&connection, "s3", None);
        claim_receipt(&mut connection, "caller", "done", "h", "s4").expect("claim");
        complete_receipt(&connection, "caller", "done", "{}").expect("complete");
        claim_receipt(&mut connection, "caller", "refused", "h", "s5").expect("claim");
        fail_receipt(&connection, "caller", "refused", "X", "y").expect("fail");

        assert_eq!(count_unrecorded_launches(&connection, "caller").unwrap(), 1);

        // Once the session carries its lineage it is in the caller's own count.
        connection
            .execute(
                "UPDATE sessions SET launched_by_session_id = 'caller' WHERE id = 's3'",
                [],
            )
            .unwrap();
        assert_eq!(count_unrecorded_launches(&connection, "caller").unwrap(), 0);
    }

    #[test]
    fn boot_releases_a_launch_with_no_session_and_keeps_one_that_has_a_session() {
        let database = database_with_caller();
        let mut connection = database.connection();
        claim_receipt(&mut connection, "caller", "ghost", "h", "ghost-session").expect("claim");
        claim_receipt(&mut connection, "caller", "live", "h", "live-session").expect("claim");
        claim_receipt(&mut connection, "caller", "done", "h", "done-session").expect("claim");
        complete_receipt(&connection, "caller", "done", "{}").expect("complete");
        insert_session(&connection, "live-session", None);

        let recovered = recover_orphaned_receipts(&mut connection).expect("recover");
        assert_eq!(
            recovered,
            RecoveredReceipts {
                failed: 1,
                uncertain: 1,
                lineage_repaired: 1
            }
        );

        let ghost = find_receipt(&connection, "caller", "ghost")
            .unwrap()
            .unwrap();
        assert_eq!(ghost.status, ReceiptStatus::Failed);
        assert_eq!(ghost.error_code.as_deref(), Some("LAUNCH_INTERRUPTED"));
        // Nothing was started, so the key is free to try again.
        assert!(matches!(
            claim_receipt(&mut connection, "caller", "ghost", "h", "retry-session").unwrap(),
            Claim::Claimed(_)
        ));
        let live = find_receipt(&connection, "caller", "live")
            .unwrap()
            .unwrap();
        assert_eq!(live.status, ReceiptStatus::Uncertain);
        // An uncertain receipt is final: a retry never reopens it.
        assert!(matches!(
            claim_receipt(&mut connection, "caller", "live", "h", "other").unwrap(),
            Claim::Existing(r) if r.status == ReceiptStatus::Uncertain
        ));
        assert_eq!(count_unrecorded_launches(&connection, "caller").unwrap(), 0);
    }

    #[test]
    fn an_interrupted_launch_keeps_its_lineage_so_the_launcher_can_still_reach_it() {
        let database = database_with_caller();
        let mut connection = database.connection();
        connection
            .execute(
                "UPDATE sessions SET launch_depth = 1 WHERE id = 'caller'",
                [],
            )
            .unwrap();
        // The child lives in another project's checkout; only lineage links it back.
        connection
            .execute(
                "INSERT INTO projects (id, name, repo_path, current_branch, worktree_location, created_at, updated_at) VALUES ('p2', 'p2', '/tmp/p2', 'main', '~/.argmax', 't', 't')",
                [],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO workspaces (id, project_id, task_label, branch, base_ref, path, state, last_activity_at, created_at, updated_at) VALUES ('w2', 'p2', 'other', 'b', 'main', '/tmp/w2', 'running', 't', 't', 't')",
                [],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO sessions (id, workspace_id, provider, model_label, model_id, permission_mode, agent_mode, prompt, state, attention, started_at, last_activity_at) VALUES ('child', 'w2', 'claude', 'S', 'm', 'auto-approve', 'auto', 'p', 'running', 'none', 't', 't')",
                [],
            )
            .unwrap();
        claim_receipt(&mut connection, "caller", "k", "h", "child").expect("claim");

        recover_orphaned_receipts(&mut connection).expect("recover");

        let (launched_by, depth, kind): (String, i64, String) = connection
            .query_row(
                "SELECT launched_by_session_id, launch_depth, launch_kind FROM sessions WHERE id = 'child'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert_eq!(
            (launched_by.as_str(), depth, kind.as_str()),
            ("caller", 2, "agent")
        );
        // Repairing again, or a session that already has lineage, changes nothing.
        assert_eq!(reconcile_uncertain_lineage(&connection).unwrap(), 0);
    }

    #[test]
    fn only_a_pending_receipt_can_settle() {
        let database = database_with_caller();
        let mut connection = database.connection();
        claim_receipt(&mut connection, "caller", "k", "h", "s1").expect("claim");
        complete_receipt(&connection, "caller", "k", "{}").expect("complete");
        // A late guard must not turn a completed launch into an uncertain one.
        mark_receipt_uncertain(&connection, "caller", "k").expect("noop");
        fail_receipt(&connection, "caller", "k", "X", "y").expect("noop");
        let receipt = find_receipt(&connection, "caller", "k").unwrap().unwrap();
        assert_eq!(receipt.status, ReceiptStatus::Completed);
    }
}
