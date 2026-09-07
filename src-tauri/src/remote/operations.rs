//! Durable admission and outcomes for remote mutations. An admitted operation
//! is never executed again, including when the host stops before saving its
//! result. That ambiguous case requires inspection, not an automatic retry.

use std::future::Future;
use std::sync::LazyLock;
use std::time::Duration;

use rusqlite::OptionalExtension;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::error::{ArgmaxError, ArgmaxResult};
use crate::persistence::database::Database;
use crate::persistence::sqlite_error;

static RUN_ID: LazyLock<String> = LazyLock::new(|| Uuid::new_v4().to_string());
static READ_CHANNELS: LazyLock<Vec<String>> = LazyLock::new(|| {
    serde_json::from_str(include_str!("../../../src/shared/remoteReadChannels.json"))
        .expect("remote read channel manifest")
});

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OperationId {
    pub client_id: Uuid,
    pub operation_id: Uuid,
}

pub fn is_read(channel: &str) -> bool {
    READ_CHANNELS.iter().any(|read| read == channel)
}

enum Admission {
    Execute,
    Pending,
    Complete(Value),
}

fn admit(
    db: &Database,
    identity: &OperationId,
    channel: &str,
    input: &Value,
    run_id: &str,
) -> ArgmaxResult<Admission> {
    // Keep prompts, file contents, and attachment data out of the journal.
    let digest: String = Sha256::digest(json!([channel, input]).to_string())
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    let connection = db.connection();
    let inserted = connection
        .execute(
            "INSERT OR IGNORE INTO remote_operations
         (client_id, operation_id, request_digest, run_id, created_at)
         VALUES (?1, ?2, ?3, ?4, datetime('now'))",
            (
                identity.client_id.to_string(),
                identity.operation_id.to_string(),
                &digest,
                run_id,
            ),
        )
        .map_err(sqlite_error)?;
    if inserted == 1 {
        return Ok(Admission::Execute);
    }
    let (stored_digest, owner, outcome): (String, String, Option<String>) = connection
        .query_row(
            "SELECT request_digest, run_id, outcome_json FROM remote_operations
         WHERE client_id = ?1 AND operation_id = ?2",
            (
                identity.client_id.to_string(),
                identity.operation_id.to_string(),
            ),
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .map_err(sqlite_error)?;
    if stored_digest != digest {
        return Err(ArgmaxError::service(
            "REMOTE_OPERATION_MISMATCH",
            "This operation ID belongs to a different request",
        ));
    }
    if let Some(outcome) = outcome {
        return Ok(Admission::Complete(decode_outcome(&outcome)?));
    }
    if owner != run_id {
        return Err(unknown_outcome());
    }
    Ok(Admission::Pending)
}

fn decode_outcome(raw: &str) -> ArgmaxResult<Value> {
    serde_json::from_str(raw).map_err(|error| {
        ArgmaxError::service(
            "REMOTE_OPERATION_CORRUPT",
            format!("Cannot read remote operation outcome: {error}"),
        )
    })
}

fn unknown_outcome() -> ArgmaxError {
    ArgmaxError::service(
        "REMOTE_OUTCOME_UNKNOWN",
        "The host stopped before recording this action's outcome. Check the chat or workspace before taking further action. Retrying this request will not execute it again.",
    )
}

pub fn outcome(result: ArgmaxResult<Value>) -> Value {
    match result {
        Ok(value) => json!({"ok": value}),
        Err(error) => json!({"error": error}),
    }
}

pub async fn execute<F, Fut>(
    db: &Database,
    identity: &OperationId,
    channel: &str,
    input: &Value,
    action: F,
) -> ArgmaxResult<Value>
where
    F: FnOnce() -> Fut,
    Fut: Future<Output = ArgmaxResult<Value>>,
{
    match admit(db, identity, channel, input, &RUN_ID)? {
        Admission::Complete(result) => Ok(result),
        Admission::Pending => {
            // Let a live invocation finish without taking another execution
            // slot indefinitely. The client retries this same identity.
            for _ in 0..20 {
                tokio::time::sleep(Duration::from_millis(100)).await;
                let saved: Option<String> = db.read_connection().query_row(
                    "SELECT outcome_json FROM remote_operations WHERE client_id = ?1 AND operation_id = ?2",
                    (identity.client_id.to_string(), identity.operation_id.to_string()),
                    |row| row.get(0),
                ).optional().map_err(sqlite_error)?.flatten();
                if let Some(saved) = saved {
                    return decode_outcome(&saved);
                }
            }
            Err(ArgmaxError::service(
                "REMOTE_OPERATION_PENDING",
                "The original action is still running",
            ))
        }
        Admission::Execute => {
            let result = outcome(action().await);
            let saved = db.connection().execute(
                "UPDATE remote_operations SET outcome_json = ?3 WHERE client_id = ?1 AND operation_id = ?2",
                (identity.client_id.to_string(), identity.operation_id.to_string(), result.to_string()),
            );
            if let Err(error) = saved {
                tracing::error!(%error, "remote action completed but its outcome could not be saved");
                return Err(unknown_outcome());
            }
            Ok(result)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    fn identity() -> OperationId {
        OperationId {
            client_id: Uuid::new_v4(),
            operation_id: Uuid::new_v4(),
        }
    }

    #[tokio::test]
    async fn lost_reply_and_reopened_database_do_not_repeat_the_action() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("operations.sqlite");
        let id = identity();
        let calls = AtomicUsize::new(0);
        {
            let db = Database::open(&path).unwrap();
            let reply = execute(
                &db,
                &id,
                "providers:send-input",
                &json!({"text":"hello"}),
                || async {
                    calls.fetch_add(1, Ordering::SeqCst);
                    Ok(json!({"turn":"created"}))
                },
            )
            .await
            .unwrap();
            assert_eq!(reply["ok"]["turn"], "created");
            // Drop the reply exactly where a disconnected socket loses it.
        }
        let db = Database::open(&path).unwrap();
        let reply = execute(
            &db,
            &id,
            "providers:send-input",
            &json!({"text":"hello"}),
            || async {
                calls.fetch_add(1, Ordering::SeqCst);
                Ok(Value::Null)
            },
        )
        .await
        .unwrap();
        assert_eq!(reply["ok"]["turn"], "created");
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        assert!(execute(
            &db,
            &id,
            "providers:send-input",
            &json!({"text":"different"}),
            || async { Ok(Value::Null) }
        )
        .await
        .is_err());
    }

    #[test]
    fn interrupted_admission_is_unknown_in_a_new_host_process() {
        let db = Database::open_in_memory().unwrap();
        let id = identity();
        assert!(matches!(
            admit(&db, &id, "git:commit", &Value::Null, "old-process").unwrap(),
            Admission::Execute
        ));
        let error = admit(&db, &id, "git:commit", &Value::Null, "new-process")
            .err()
            .unwrap();
        assert!(
            matches!(error, ArgmaxError::ServiceError { sub_code, .. } if sub_code == "REMOTE_OUTCOME_UNKNOWN")
        );
    }

    #[tokio::test]
    async fn concurrent_replays_share_one_execution() {
        let db = Database::open_in_memory().unwrap();
        let id = identity();
        let calls = AtomicUsize::new(0);
        let action = || async {
            calls.fetch_add(1, Ordering::SeqCst);
            tokio::time::sleep(Duration::from_millis(25)).await;
            Ok(json!(42))
        };
        let (first, second) = tokio::join!(
            execute(&db, &id, "git:commit", &Value::Null, action),
            execute(&db, &id, "git:commit", &Value::Null, action)
        );
        assert_eq!(first.unwrap(), second.unwrap());
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }
}
