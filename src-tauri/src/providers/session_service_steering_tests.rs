use super::super::{
    now_iso, AgentMode, HandleEntry, PendingMessage, ProviderSessionService, SendInputResult,
};
use super::{database_with_running_session, CountingFailureLauncher};
use crate::error::{ArgmaxError, ArgmaxResult};
use crate::ipc::inputs::{ProvidersSendQueuedMessageNowInput, QueuedMessageDelivery};
use crate::ipc::validation::{NonEmptyString, SessionId};
use crate::persistence::events::list_session_events_since;
use crate::persistence::pending_messages::{list_session_pending_messages, replace_session_queue};
use crate::persistence::sessions::{find_session_by_id, update_session_state, SessionStateInput};
use crate::providers::runtime::{BoxFuture, ProviderRuntimeHandle};
use crate::sessions::state::SessionState;
use crate::util::sync::LockOrRecover;
use serde_json::json;
use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;

struct SteerHandleConfig {
    supports_steering: bool,
    steer_error: Option<ArgmaxError>,
}

struct SteerRecordingHandle {
    config: SteerHandleConfig,
    steer_calls: AtomicUsize,
    terminate_calls: AtomicUsize,
    disposed: AtomicBool,
}

impl SteerRecordingHandle {
    fn new(config: SteerHandleConfig) -> Arc<Self> {
        Arc::new(Self {
            config,
            steer_calls: AtomicUsize::new(0),
            terminate_calls: AtomicUsize::new(0),
            disposed: AtomicBool::new(false),
        })
    }
}

impl ProviderRuntimeHandle for SteerRecordingHandle {
    fn disposed(&self) -> bool {
        self.disposed.load(Ordering::SeqCst)
    }

    fn accepts_input(&self) -> bool {
        false
    }

    fn supports_steering(&self) -> bool {
        self.config.supports_steering
    }

    fn send_input(&self, _text: &str) {}

    fn resize(&self, _cols: u16, _rows: u16) {}

    fn steer<'a>(&'a self, _prompt: &'a str) -> BoxFuture<'a, ArgmaxResult<()>> {
        self.steer_calls.fetch_add(1, Ordering::SeqCst);
        let error = self.config.steer_error.clone();
        Box::pin(async move {
            if let Some(error) = error {
                Err(error)
            } else {
                Ok(())
            }
        })
    }

    fn terminate<'a>(&'a self) -> BoxFuture<'a, ArgmaxResult<()>> {
        self.terminate_calls.fetch_add(1, Ordering::SeqCst);
        self.disposed.store(true, Ordering::SeqCst);
        Box::pin(async { Ok(()) })
    }
}

fn steer_service(
    config: SteerHandleConfig,
) -> (
    Arc<ProviderSessionService>,
    Arc<SteerRecordingHandle>,
    Arc<CountingFailureLauncher>,
) {
    let database = database_with_running_session();
    let launcher = Arc::new(CountingFailureLauncher::default());
    let service =
        ProviderSessionService::with_launcher(Arc::clone(&database), launcher.clone(), |_| {});
    let handle = SteerRecordingHandle::new(config);
    service.handles.lock_or_recover("handles").insert(
        "session-1".to_string(),
        HandleEntry::Resolved(Arc::clone(&handle) as Arc<dyn ProviderRuntimeHandle>),
    );
    (service, handle, launcher)
}

fn seed_queue(service: &ProviderSessionService, message: PendingMessage) -> String {
    let id = message.id.clone();
    let queue = VecDeque::from([message]);
    {
        let mut connection = service.database.connection();
        replace_session_queue(&mut connection, "session-1", &queue).expect("queue");
    }
    service
        .queues
        .lock_or_recover("queues")
        .insert("session-1".to_string(), queue);
    id
}

fn pending(id: &str, content: &str) -> PendingMessage {
    PendingMessage {
        id: id.to_string(),
        session_id: "session-1".to_string(),
        content: content.to_string(),
        agent_mode: AgentMode::Auto.as_str().to_string(),
        model_label: None,
        model_id: None,
        reasoning_effort: None,
        fast_mode: false,
        attachments: Vec::new(),
        agent_references: Vec::new(),
        origin: None,
        recovery_status: None,
        queued_at: now_iso(),
    }
}

async fn steer_now(
    service: &Arc<ProviderSessionService>,
    message_id: &str,
) -> ArgmaxResult<SendInputResult> {
    service
        .send_queued_message_now(ProvidersSendQueuedMessageNowInput {
            delivery: Some(QueuedMessageDelivery::Steer),
            session_id: SessionId::try_from("session-1".to_string()).unwrap(),
            message_id: NonEmptyString::try_from(message_id.to_string()).unwrap(),
        })
        .await
}

#[tokio::test]
async fn successful_steer_persists_delivery_and_leaves_session_running() {
    let (service, handle, launcher) = steer_service(SteerHandleConfig {
        supports_steering: true,
        steer_error: None,
    });
    let message_id = seed_queue(&service, pending("ok", "adjust course"));
    steer_now(&service, &message_id).await.expect("steer");
    assert_eq!(handle.steer_calls.load(Ordering::SeqCst), 1);
    assert_eq!(handle.terminate_calls.load(Ordering::SeqCst), 0);
    assert_eq!(launcher.launches.load(Ordering::SeqCst), 0);
    assert!(service.pending_messages_snapshot().is_empty());
    let connection = service.database.connection();
    assert!(list_session_pending_messages(&connection, "session-1")
        .unwrap()
        .is_empty());
    let events = list_session_events_since(&connection, "session-1", None, None)
        .unwrap()
        .events;
    let user: Vec<_> = events
        .iter()
        .filter(|event| event.r#type == "user.message")
        .collect();
    assert_eq!(user.len(), 1);
    assert_eq!(user[0].payload["delivery"], json!("steer"));
    assert!(!events.iter().any(|event| {
        matches!(
            event.r#type.as_str(),
            "session.completed" | "session.cancelled" | "error"
        )
    }));
    assert_eq!(
        find_session_by_id(&connection, "session-1").unwrap().state,
        SessionState::Running
    );
}

#[tokio::test]
async fn rejected_steer_restores_unsent_without_side_effects() {
    let (service, handle, launcher) = steer_service(SteerHandleConfig {
        supports_steering: true,
        steer_error: Some(ArgmaxError::service("STEER_REJECTED", "refused")),
    });
    let message_id = seed_queue(&service, pending("rej", "retry"));
    let error = steer_now(&service, &message_id).await.unwrap_err();
    assert!(matches!(
        error,
        ArgmaxError::ServiceError { ref sub_code, .. } if sub_code == "STEER_REJECTED"
    ));
    assert_eq!(handle.steer_calls.load(Ordering::SeqCst), 1);
    assert_eq!(handle.terminate_calls.load(Ordering::SeqCst), 0);
    assert_eq!(launcher.launches.load(Ordering::SeqCst), 0);
    assert!(service.pop_next_undelivered("session-1").unwrap().is_none());
    assert_eq!(
        service.pending_messages_snapshot()["session-1"][0]
            .recovery_status
            .as_deref(),
        Some("unsent")
    );
    let connection = service.database.connection();
    assert_eq!(
        list_session_pending_messages(&connection, "session-1").unwrap()[0]
            .recovery_status
            .as_deref(),
        Some("unsent")
    );
    assert!(
        !list_session_events_since(&connection, "session-1", None, None)
            .unwrap()
            .events
            .iter()
            .any(|event| event.r#type == "user.message")
    );
}

#[tokio::test]
async fn unsupported_not_running_and_settings_mismatch_skip_steer() {
    let (service, handle, _) = steer_service(SteerHandleConfig {
        supports_steering: false,
        steer_error: None,
    });
    let id = seed_queue(&service, pending("u", "x"));
    let error = steer_now(&service, &id).await.unwrap_err();
    assert!(matches!(
        error,
        ArgmaxError::ServiceError { ref sub_code, .. } if sub_code == "STEER_UNSUPPORTED"
    ));
    assert_eq!(handle.steer_calls.load(Ordering::SeqCst), 0);
    assert_eq!(service.pending_messages_snapshot()["session-1"].len(), 1);

    let (service, handle, _) = steer_service(SteerHandleConfig {
        supports_steering: true,
        steer_error: None,
    });
    {
        let connection = service.database.connection();
        update_session_state(
            &connection,
            "session-1",
            &SessionStateInput::transition(SessionState::Complete),
        )
        .unwrap();
    }
    service
        .handles
        .lock_or_recover("handles")
        .remove("session-1");
    let id = seed_queue(&service, pending("nr", "late"));
    let error = steer_now(&service, &id).await.unwrap_err();
    assert!(matches!(
        error,
        ArgmaxError::ServiceError { ref sub_code, .. } if sub_code == "STEER_NOT_RUNNING"
    ));
    assert_eq!(handle.steer_calls.load(Ordering::SeqCst), 0);

    let (service, handle, launcher) = steer_service(SteerHandleConfig {
        supports_steering: true,
        steer_error: None,
    });
    let mut message = pending("set", "model");
    message.model_id = Some("other-model".to_string());
    let id = seed_queue(&service, message);
    let error = steer_now(&service, &id).await.unwrap_err();
    assert!(matches!(
        error,
        ArgmaxError::ServiceError { ref sub_code, .. } if sub_code == "STEER_SETTINGS_CHANGED"
    ));
    assert_eq!(handle.steer_calls.load(Ordering::SeqCst), 0);
    assert_eq!(launcher.launches.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn delivery_unknown_after_accepted_steer_restores_delivery_unknown() {
    let (service, handle, launcher) = steer_service(SteerHandleConfig {
        supports_steering: true,
        steer_error: None,
    });
    let message_id = seed_queue(&service, pending("unk", "guidance"));
    service
        .database
        .connection()
        .execute_batch(
            "CREATE TRIGGER reject_guidance BEFORE INSERT ON events
         WHEN NEW.type = 'user.message'
         BEGIN SELECT RAISE(ABORT, 'simulated disk failure'); END;",
        )
        .unwrap();
    let error = steer_now(&service, &message_id).await.unwrap_err();
    assert!(matches!(
        error,
        ArgmaxError::ServiceError { ref sub_code, .. } if sub_code == "STEER_DELIVERY_UNKNOWN"
    ));
    assert_eq!(handle.steer_calls.load(Ordering::SeqCst), 1);
    assert_eq!(launcher.launches.load(Ordering::SeqCst), 0);
    assert_eq!(
        service.pending_messages_snapshot()["session-1"][0]
            .recovery_status
            .as_deref(),
        Some("delivery-unknown")
    );
    assert!(service.pop_next_undelivered("session-1").unwrap().is_none());
    let connection = service.database.connection();
    assert!(
        !list_session_events_since(&connection, "session-1", None, None)
            .unwrap()
            .events
            .iter()
            .any(|event| event.r#type == "user.message")
    );
}
