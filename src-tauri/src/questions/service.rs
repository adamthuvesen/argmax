//! Keeps Codex blocking questions connected to their live JSON-RPC responders.
//!
//! The question card itself is a durable timeline tool event. Answers stay in
//! memory and travel only to the waiting provider request, including secret
//! answers.

use std::{
    collections::{BTreeMap, HashMap, HashSet},
    sync::{Arc, Mutex},
};

use serde::Serialize;
use serde_json::{json, Value};
use specta::Type;
use tokio::sync::oneshot;
use uuid::Uuid;

use crate::error::{ArgmaxError, ArgmaxResult};
use crate::persistence::approvals::list_approvals_for_session;
use crate::persistence::database::Database;
use crate::persistence::events::{persist_timeline_event, PersistTimelineEventInput};
use crate::persistence::sessions::{find_session_by_id, update_session_state, SessionStateInput};
use crate::providers::flush_queue::DashboardDelta;
use crate::providers::runtime::DeltaPublisher;
use crate::sessions::state::SessionState;
use crate::util::sync::LockOrRecover;

const MAX_QUESTIONS: usize = 3;
const MAX_OPTIONS: usize = 4;
const MAX_TEXT_BYTES: usize = 8 * 1024;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct QuestionResolveResult {
    pub session_id: String,
    pub request_id: String,
    pub status: QuestionResolveStatus,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "lowercase")]
pub enum QuestionResolveStatus {
    Answered,
    Dismissed,
}

#[derive(Debug, Clone)]
struct QuestionDefinition {
    id: String,
    is_secret: bool,
}

struct PendingQuestion {
    invocation_id: String,
    request_id: String,
    provider_request_id: String,
    item_id: String,
    questions: Vec<QuestionDefinition>,
    sender: oneshot::Sender<Value>,
}

pub struct QuestionService {
    database: Arc<Database>,
    publish_delta: DeltaPublisher,
    pending: Mutex<HashMap<(String, String), PendingQuestion>>,
}

impl QuestionService {
    pub fn new(database: Arc<Database>) -> Arc<Self> {
        Self::with_publisher(database, |_| {})
    }

    pub fn with_publisher(
        database: Arc<Database>,
        publisher: impl Fn(DashboardDelta) + Send + Sync + 'static,
    ) -> Arc<Self> {
        Arc::new(Self {
            database,
            publish_delta: Arc::new(publisher),
            pending: Mutex::new(HashMap::new()),
        })
    }

    pub async fn request_native(
        &self,
        session_id: &str,
        invocation_id: &str,
        request_id: &str,
        params: &Value,
    ) -> ArgmaxResult<Value> {
        let receiver = self.register_native(session_id, invocation_id, request_id, params)?;
        receiver.await.map_err(|_| {
            ArgmaxError::service(
                "QUESTION_CANCELLED",
                "This question is no longer connected to a running provider",
            )
        })
    }

    fn register_native(
        &self,
        session_id: &str,
        invocation_id: &str,
        request_id: &str,
        params: &Value,
    ) -> ArgmaxResult<oneshot::Receiver<Value>> {
        let parsed = parse_request(params)?;
        let public_request_id = Uuid::new_v4().to_string();
        let key = (session_id.to_string(), public_request_id.clone());
        let mut pending = self.pending.lock_or_recover("native questions");
        if pending.contains_key(&key) {
            return Err(ArgmaxError::service(
                "QUESTION_DUPLICATE",
                "This provider question is already waiting for an answer",
            ));
        }

        let connection = self.database.connection();
        let transaction = connection
            .unchecked_transaction()
            .map_err(|error| ArgmaxError::service("SQLITE", error.to_string()))?;
        let current = find_session_by_id(&transaction, session_id)?;
        if !matches!(current.state, SessionState::Running | SessionState::Waiting) {
            return Err(ArgmaxError::service(
                "QUESTION_CANCELLED",
                "The provider turn has ended",
            ));
        }
        if has_durable_request(&transaction, session_id, invocation_id, request_id)? {
            return Err(ArgmaxError::service(
                "QUESTION_DUPLICATE",
                "This provider question was already received",
            ));
        }

        let event = persist_timeline_event(
            &transaction,
            &PersistTimelineEventInput {
                id: Uuid::new_v4().to_string(),
                session_id: session_id.to_string(),
                r#type: "command.started".to_string(),
                message: "AskUserQuestion".to_string(),
                payload: question_started_payload(
                    &parsed,
                    invocation_id,
                    &public_request_id,
                    request_id,
                ),
                created_at: None,
            },
        )?;
        let has_pending_approval =
            !list_approvals_for_session(&transaction, session_id, "pending")?.is_empty();
        let waiting_state = SessionStateInput::transition(SessionState::Waiting);
        let session = update_session_state(
            &transaction,
            session_id,
            &if has_pending_approval {
                waiting_state.with_pending_approval()
            } else {
                waiting_state.with_blocking_question()
            },
        )?;
        transaction
            .commit()
            .map_err(|error| ArgmaxError::service("SQLITE", error.to_string()))?;

        let (sender, receiver) = oneshot::channel();
        pending.insert(
            key,
            PendingQuestion {
                invocation_id: invocation_id.to_string(),
                request_id: public_request_id,
                provider_request_id: request_id.to_string(),
                item_id: parsed.item_id,
                questions: parsed.questions,
                sender,
            },
        );
        drop(connection);
        drop(pending);
        self.publish(DashboardDelta {
            sessions: vec![session],
            events: vec![event],
            ..DashboardDelta::default()
        });
        Ok(receiver)
    }

    pub fn resolve(
        &self,
        session_id: &str,
        request_id: &str,
        answers: BTreeMap<String, Vec<String>>,
        dismissed: bool,
    ) -> ArgmaxResult<QuestionResolveResult> {
        let key = (session_id.to_string(), request_id.to_string());
        let mut pending = self.pending.lock_or_recover("native questions");
        let request = pending.get(&key).ok_or_else(|| {
            ArgmaxError::service(
                "QUESTION_NOT_PENDING",
                "This question is no longer waiting for an answer",
            )
        })?;
        if request.sender.is_closed() {
            return Err(ArgmaxError::service(
                "QUESTION_CANCELLED",
                "This question is no longer connected to a running provider",
            ));
        }
        validate_answers(&request.questions, &answers, dismissed)?;

        let connection = self.database.connection();
        let transaction = connection
            .unchecked_transaction()
            .map_err(|error| ArgmaxError::service("SQLITE", error.to_string()))?;
        let current = find_session_by_id(&transaction, session_id)?;
        if !matches!(current.state, SessionState::Running | SessionState::Waiting) {
            return Err(ArgmaxError::service(
                "QUESTION_CANCELLED",
                "The provider turn has ended",
            ));
        }
        let event = persist_timeline_event(
            &transaction,
            &PersistTimelineEventInput {
                id: Uuid::new_v4().to_string(),
                session_id: session_id.to_string(),
                r#type: "command.completed".to_string(),
                message: "AskUserQuestion".to_string(),
                payload: question_completed_payload(
                    request,
                    if dismissed { "dismissed" } else { "completed" },
                ),
                created_at: None,
            },
        )?;
        let has_other_question = pending
            .keys()
            .any(|other| other != &key && other.0 == session_id);
        let has_approval =
            !list_approvals_for_session(&transaction, session_id, "pending")?.is_empty();
        let updated_session =
            if current.state == SessionState::Waiting && !has_other_question && !has_approval {
                Some(update_session_state(
                    &transaction,
                    session_id,
                    &SessionStateInput::transition(SessionState::Running),
                )?)
            } else {
                None
            };
        transaction
            .commit()
            .map_err(|error| ArgmaxError::service("SQLITE", error.to_string()))?;

        let request = pending
            .remove(&key)
            .expect("pending question disappeared while locked");
        let provider_answers = if dismissed {
            json!({})
        } else {
            Value::Object(
                answers
                    .into_iter()
                    .map(|(id, answers)| (id, json!({ "answers": answers })))
                    .collect(),
            )
        };
        let _ = request.sender.send(json!({ "answers": provider_answers }));
        drop(connection);
        drop(pending);
        self.publish(DashboardDelta {
            sessions: updated_session.into_iter().collect(),
            events: vec![event],
            ..DashboardDelta::default()
        });
        Ok(QuestionResolveResult {
            session_id: session_id.to_string(),
            request_id: request_id.to_string(),
            status: if dismissed {
                QuestionResolveStatus::Dismissed
            } else {
                QuestionResolveStatus::Answered
            },
        })
    }

    /// Drop live responders and close every durable card for this session.
    /// Reading unmatched starts also closes cards left behind by an app restart.
    pub fn cancel_session_pending(&self, session_id: &str) -> ArgmaxResult<()> {
        let mut pending = self.pending.lock_or_recover("native questions");
        pending.retain(|(pending_session_id, _), _| pending_session_id != session_id);

        let connection = self.database.connection();
        let durable = list_durable_pending(&connection, session_id)?;
        if durable.is_empty() {
            return Ok(());
        }
        let transaction = connection
            .unchecked_transaction()
            .map_err(|error| ArgmaxError::service("SQLITE", error.to_string()))?;
        let mut events = Vec::with_capacity(durable.len());
        for payload in durable {
            events.push(persist_timeline_event(
                &transaction,
                &PersistTimelineEventInput {
                    id: Uuid::new_v4().to_string(),
                    session_id: session_id.to_string(),
                    r#type: "command.completed".to_string(),
                    message: "AskUserQuestion".to_string(),
                    payload: json!({
                        "id": payload.get("id").cloned().unwrap_or(Value::Null),
                        "type": "AskUserQuestion",
                        "name": "AskUserQuestion",
                        "status": "cancelled",
                        "provider": "codex",
                        "requestId": payload.get("requestId").cloned().unwrap_or(Value::Null),
                        "providerRequestId": payload.get("providerRequestId").cloned().unwrap_or(Value::Null),
                        "providerInvocationId": payload.get("providerInvocationId").cloned().unwrap_or(Value::Null),
                    }),
                    created_at: None,
                },
            )?);
        }
        let current = find_session_by_id(&transaction, session_id)?;
        let mut state_input = SessionStateInput::transition(current.state);
        if let Some(completed_at) = current.completed_at.as_ref() {
            state_input = state_input.finished_at(completed_at);
        }
        let session = update_session_state(&transaction, session_id, &state_input)?;
        transaction
            .commit()
            .map_err(|error| ArgmaxError::service("SQLITE", error.to_string()))?;
        drop(connection);
        drop(pending);
        self.publish(DashboardDelta {
            sessions: vec![session],
            events,
            ..DashboardDelta::default()
        });
        Ok(())
    }

    fn publish(&self, delta: DashboardDelta) {
        if !delta.is_empty() {
            (self.publish_delta)(delta);
        }
    }
}

struct ParsedRequest {
    item_id: String,
    thread_id: String,
    turn_id: String,
    normalized_questions: Vec<Value>,
    questions: Vec<QuestionDefinition>,
}

fn parse_request(params: &Value) -> ArgmaxResult<ParsedRequest> {
    if params.get("isBlocking").and_then(Value::as_bool) != Some(true) {
        return Err(invalid_request("Codex question must be blocking"));
    }
    let item_id = required_text(params, "itemId")?;
    let thread_id = required_text(params, "threadId")?;
    let turn_id = required_text(params, "turnId")?;
    let raw_questions = params
        .get("questions")
        .and_then(Value::as_array)
        .filter(|questions| !questions.is_empty() && questions.len() <= MAX_QUESTIONS)
        .ok_or_else(|| {
            invalid_request("Codex question request must contain one to three questions")
        })?;
    let mut ids = HashSet::new();
    let mut normalized_questions = Vec::with_capacity(raw_questions.len());
    let mut questions = Vec::with_capacity(raw_questions.len());
    for raw in raw_questions {
        let id = required_text(raw, "id")?;
        if !ids.insert(id.clone()) {
            return Err(invalid_request("Codex question ids must be unique"));
        }
        let header = required_text(raw, "header")?;
        let question = required_text(raw, "question")?;
        let raw_options = match raw.get("options") {
            None | Some(Value::Null) => &[][..],
            Some(Value::Array(options)) if options.len() <= MAX_OPTIONS => options.as_slice(),
            _ => {
                return Err(invalid_request(
                    "Each Codex question may contain at most four options",
                ))
            }
        };
        let mut options = Vec::with_capacity(raw_options.len());
        for raw_option in raw_options {
            let label = required_text(raw_option, "label")?;
            let description = required_text(raw_option, "description")?;
            options.push(json!({ "label": label, "description": description }));
        }
        let is_other = raw.get("isOther").and_then(Value::as_bool).unwrap_or(false);
        let is_secret = raw
            .get("isSecret")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        normalized_questions.push(json!({
            "id": id,
            "header": header,
            "question": question,
            "options": options,
            "multiSelect": false,
            "isOther": is_other,
            "isSecret": is_secret,
        }));
        questions.push(QuestionDefinition { id, is_secret });
    }
    Ok(ParsedRequest {
        item_id,
        thread_id,
        turn_id,
        normalized_questions,
        questions,
    })
}

fn required_text(value: &Value, field: &str) -> ArgmaxResult<String> {
    let text = value
        .get(field)
        .and_then(Value::as_str)
        .filter(|text| !text.trim().is_empty())
        .ok_or_else(|| invalid_request(format!("Codex question has no {field}")))?;
    if text.len() > MAX_TEXT_BYTES || text.contains('\0') {
        return Err(invalid_request(format!(
            "Codex question {field} is invalid"
        )));
    }
    Ok(text.to_string())
}

fn validate_answers(
    questions: &[QuestionDefinition],
    answers: &BTreeMap<String, Vec<String>>,
    dismissed: bool,
) -> ArgmaxResult<()> {
    if dismissed {
        if answers.is_empty() {
            return Ok(());
        }
        return Err(invalid_answer("Dismissed questions cannot include answers"));
    }
    if answers.len() != questions.len() {
        return Err(invalid_answer("Every question requires an answer"));
    }
    for question in questions {
        let values = answers
            .get(&question.id)
            .ok_or_else(|| invalid_answer(format!("Question {} has no answer", question.id)))?;
        if values.is_empty()
            || values.iter().any(|answer| {
                answer.trim().is_empty() || answer.len() > MAX_TEXT_BYTES || answer.contains('\0')
            })
        {
            return Err(invalid_answer(format!(
                "Question {} has an invalid answer",
                question.id
            )));
        }
        if question.is_secret && values.len() != 1 {
            return Err(invalid_answer(
                "Secret questions require exactly one answer",
            ));
        }
    }
    if answers
        .keys()
        .any(|id| !questions.iter().any(|question| &question.id == id))
    {
        return Err(invalid_answer("Answers contain an unknown question id"));
    }
    Ok(())
}

fn question_started_payload(
    request: &ParsedRequest,
    invocation_id: &str,
    request_id: &str,
    provider_request_id: &str,
) -> Value {
    json!({
        "id": request.item_id,
        "type": "AskUserQuestion",
        "name": "AskUserQuestion",
        "status": "running",
        "provider": "codex",
        "requestId": request_id,
        "providerRequestId": provider_request_id,
        "providerInvocationId": invocation_id,
        "threadId": request.thread_id,
        "turnId": request.turn_id,
        "input": {
            "delivery": "blocking",
            "requestId": request_id,
            "questions": request.normalized_questions,
        },
    })
}

fn question_completed_payload(request: &PendingQuestion, status: &str) -> Value {
    json!({
        "id": request.item_id,
        "type": "AskUserQuestion",
        "name": "AskUserQuestion",
        "status": status,
        "provider": "codex",
        "requestId": request.request_id,
        "providerRequestId": request.provider_request_id,
        "providerInvocationId": request.invocation_id,
    })
}

fn has_durable_request(
    connection: &rusqlite::Connection,
    session_id: &str,
    invocation_id: &str,
    request_id: &str,
) -> ArgmaxResult<bool> {
    let count = connection
        .query_row(
            "SELECT COUNT(*) FROM events WHERE session_id = ?1 AND type = 'command.started' AND json_extract(payload_json, '$.input.delivery') = 'blocking' AND json_extract(payload_json, '$.providerInvocationId') = ?2 AND json_extract(payload_json, '$.providerRequestId') = ?3",
            (session_id, invocation_id, request_id),
            |row| row.get::<_, i64>(0),
        )
        .map_err(|error| ArgmaxError::service("SQLITE", error.to_string()))?;
    Ok(count > 0)
}

pub(crate) fn has_durable_pending(
    connection: &rusqlite::Connection,
    session_id: &str,
) -> ArgmaxResult<bool> {
    Ok(!list_durable_pending(connection, session_id)?.is_empty())
}

fn list_durable_pending(
    connection: &rusqlite::Connection,
    session_id: &str,
) -> ArgmaxResult<Vec<Value>> {
    let mut statement = connection
        .prepare_cached(
            r#"
            SELECT requested.payload_json
            FROM events requested
            WHERE requested.session_id = ?1
              AND requested.type = 'command.started'
              AND json_extract(requested.payload_json, '$.input.delivery') = 'blocking'
              AND NOT EXISTS (
                SELECT 1
                FROM events completed
                WHERE completed.session_id = requested.session_id
                  AND completed.type = 'command.completed'
                  AND json_extract(completed.payload_json, '$.id') = json_extract(requested.payload_json, '$.id')
                  AND json_extract(completed.payload_json, '$.providerInvocationId') = json_extract(requested.payload_json, '$.providerInvocationId')
                  AND json_extract(completed.payload_json, '$.providerRequestId') = json_extract(requested.payload_json, '$.providerRequestId')
              )
            "#,
        )
        .map_err(|error| ArgmaxError::service("SQLITE", error.to_string()))?;
    let rows = statement
        .query_map((session_id,), |row| row.get::<_, String>(0))
        .map_err(|error| ArgmaxError::service("SQLITE", error.to_string()))?;
    rows.map(|row| {
        let raw = row.map_err(|error| ArgmaxError::service("SQLITE", error.to_string()))?;
        serde_json::from_str(&raw)
            .map_err(|error| ArgmaxError::service("TIMELINE_PAYLOAD", error.to_string()))
    })
    .collect()
}

fn invalid_request(message: impl Into<String>) -> ArgmaxError {
    ArgmaxError::service("QUESTION_REQUEST_INVALID", message)
}

fn invalid_answer(message: impl Into<String>) -> ArgmaxError {
    ArgmaxError::service("QUESTION_ANSWER_INVALID", message)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::persistence::events::{has_outstanding_card_ask, list_session_events_since};
    use crate::persistence::projects::{persist_project, PersistProjectInput, ProjectSettings};
    use crate::persistence::sessions::{persist_session, PersistSessionInput};
    use crate::persistence::workspaces::{persist_workspace, PersistWorkspaceInput};
    use crate::sessions::attention::AttentionState;
    use std::time::Duration;

    fn setup() -> Arc<Database> {
        let database = Arc::new(Database::open_in_memory().unwrap());
        let connection = database.connection();
        persist_project(
            &connection,
            &PersistProjectInput {
                id: "p1".to_string(),
                name: "fixture".to_string(),
                repo_path: "/tmp/argmax-question-fixture".to_string(),
                default_branch: Some("main".to_string()),
                current_branch: "main".to_string(),
                settings: ProjectSettings {
                    archive_on_merge: false,
                    worktree_location: "/tmp/argmax-question-fixture/.worktrees".to_string(),
                    setup_command: String::new(),
                    check_commands: Vec::new(),
                },
            },
        )
        .unwrap();
        persist_workspace(
            &connection,
            &PersistWorkspaceInput {
                id: "w1".to_string(),
                project_id: "p1".to_string(),
                task_label: "questions-test".to_string(),
                branch: "main".to_string(),
                base_ref: "main".to_string(),
                path: "/tmp/argmax-question-fixture".to_string(),
                state: "created".to_string(),
                shared_workspace: true,
                kind: "git".to_string(),
                dirty: false,
                changed_files: 0,
            },
        )
        .unwrap();
        persist_session(
            &connection,
            &PersistSessionInput {
                id: "s1".to_string(),
                workspace_id: "w1".to_string(),
                prompt: "test".to_string(),
                provider: "codex".to_string(),
                model_label: "GPT".to_string(),
                model_id: "gpt-test".to_string(),
                reasoning_effort: None,
                permission_mode: None,
                agent_mode: Some("auto".to_string()),
                state: SessionState::Running,
            },
        )
        .unwrap();
        drop(connection);
        database
    }

    fn request_params(secret: bool) -> Value {
        json!({
            "threadId": "thread-1",
            "turnId": "turn-1",
            "itemId": "ask-1",
            "isBlocking": true,
            "questions": [{
                "id": "target",
                "header": "Target",
                "question": "Where should this run?",
                "options": null,
                "isSecret": secret
            }]
        })
    }

    async fn wait_for_public_request_id(database: &Database) -> String {
        for _ in 0..100 {
            let events = list_session_events_since(&database.connection(), "s1", None, None)
                .unwrap()
                .events;
            if let Some(id) = events.iter().find_map(|event| {
                (event.r#type == "command.started")
                    .then(|| event.payload.get("requestId").and_then(Value::as_str))
                    .flatten()
            }) {
                return id.to_string();
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        panic!("question was not persisted");
    }

    #[tokio::test]
    async fn blocking_question_waits_then_returns_exact_protocol_answer() {
        let database = setup();
        let service = QuestionService::new(Arc::clone(&database));
        let waiter = {
            let service = Arc::clone(&service);
            tokio::spawn(async move {
                service
                    .request_native("s1", "invocation-1", "rpc-1", &request_params(true))
                    .await
            })
        };
        let request_id = wait_for_public_request_id(&database).await;
        let waiting = find_session_by_id(&database.connection(), "s1").unwrap();
        assert_eq!(waiting.state, SessionState::Waiting);
        assert_eq!(waiting.attention, AttentionState::QuestionAsked);
        assert!(has_outstanding_card_ask(&database.connection(), "s1").unwrap());

        let result = service
            .resolve(
                "s1",
                &request_id,
                BTreeMap::from([("target".to_string(), vec!["private value".to_string()])]),
                false,
            )
            .unwrap();
        assert_eq!(result.status, QuestionResolveStatus::Answered);
        assert_eq!(
            waiter.await.unwrap().unwrap(),
            json!({"answers":{"target":{"answers":["private value"]}}})
        );
        let running = find_session_by_id(&database.connection(), "s1").unwrap();
        assert_eq!(running.state, SessionState::Running);
        assert_eq!(running.attention, AttentionState::Normal);
        assert!(!has_outstanding_card_ask(&database.connection(), "s1").unwrap());
        let events = list_session_events_since(&database.connection(), "s1", None, None)
            .unwrap()
            .events;
        assert_eq!(
            events
                .iter()
                .filter(|event| event.r#type == "command.started")
                .count(),
            1
        );
        assert_eq!(
            events
                .iter()
                .filter(|event| event.r#type == "command.completed")
                .count(),
            1
        );
        assert!(!serde_json::to_string(&events)
            .unwrap()
            .contains("private value"));
        let duplicate = service
            .resolve("s1", &request_id, BTreeMap::new(), true)
            .unwrap_err();
        assert!(
            matches!(duplicate, ArgmaxError::ServiceError { sub_code, .. } if sub_code == "QUESTION_NOT_PENDING")
        );
    }

    #[tokio::test]
    async fn terminal_session_cannot_answer_a_stale_live_waiter() {
        let database = setup();
        let service = QuestionService::new(Arc::clone(&database));
        let waiter = {
            let service = Arc::clone(&service);
            tokio::spawn(async move {
                service
                    .request_native("s1", "invocation-1", "rpc-1", &request_params(false))
                    .await
            })
        };
        let request_id = wait_for_public_request_id(&database).await;
        update_session_state(
            &database.connection(),
            "s1",
            &SessionStateInput::transition(SessionState::Complete),
        )
        .unwrap();
        let error = service
            .resolve(
                "s1",
                &request_id,
                BTreeMap::from([("target".to_string(), vec!["Desktop".to_string()])]),
                false,
            )
            .unwrap_err();
        assert!(
            matches!(error, ArgmaxError::ServiceError { sub_code, .. } if sub_code == "QUESTION_CANCELLED")
        );
        service.cancel_session_pending("s1").unwrap();
        assert!(waiter.await.unwrap().is_err());
        let settled = find_session_by_id(&database.connection(), "s1").unwrap();
        assert_eq!(settled.state, SessionState::Complete);
        assert_eq!(settled.attention, AttentionState::ReviewReady);
    }
}
