use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};

use tokio::sync::{broadcast, oneshot};
use uuid::Uuid;

use super::{
    protocol::SessionControlError, protocol_error, ARGMAX_BIN_ENV, SESSION_LAUNCH_SOCKET_ENV,
    SESSION_LAUNCH_TOKEN_ENV,
};
use crate::providers::ProviderLaunchInput;

#[derive(Clone)]
pub struct SessionLaunchRegistry {
    pub(super) inner: Arc<RegistryInner>,
}

pub(super) struct RegistryInner {
    pub(super) socket_path: PathBuf,
    pub(super) argmax_bin: PathBuf,
    pub(super) credentials: Mutex<CredentialState>,
    pub(super) pending_after_turn: Mutex<HashMap<String, PendingAfterTurn>>,
    /// Recipients of rows just written to `session_messages`. A blocked
    /// `session_wait` subscribes to this rather than polling the table.
    pub(super) inbox: broadcast::Sender<String>,
}

/// What an agent has asked to happen once its own turn settles. Both of these
/// dispose of the chat the caller is running inside — a move takes the
/// transcript elsewhere and archives the source, an archive ends it where it
/// stands — so a session holds at most one.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AfterTurn {
    Move,
    Archive,
}

pub(super) struct PendingAfterTurn {
    action: AfterTurn,
    settled: Option<oneshot::Sender<()>>,
}

#[derive(Default)]
pub(super) struct CredentialState {
    launches_by_token: HashMap<String, ParentLaunchSettings>,
    tokens_by_session: HashMap<String, String>,
}

#[derive(Clone)]
pub(super) struct ParentLaunchSettings {
    pub(super) session_id: String,
    pub(super) provider: crate::providers::ProviderId,
    pub(super) model_label: String,
    pub(super) model_id: String,
    pub(super) reasoning_effort: Option<crate::providers::ReasoningEffort>,
    pub(super) fast_mode: bool,
    pub(super) permission_mode: crate::providers::PermissionMode,
    pub(super) agent_mode: crate::providers::AgentMode,
}

pub struct SessionLaunchProcessConfig {
    socket_path: PathBuf,
    token: String,
    argmax_bin: PathBuf,
}

impl std::fmt::Debug for SessionLaunchProcessConfig {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("SessionLaunchProcessConfig")
            .field("socket_path", &self.socket_path)
            .field("token", &"[redacted]")
            .field("argmax_bin", &self.argmax_bin)
            .finish()
    }
}

impl SessionLaunchProcessConfig {
    pub fn env_pairs(&self) -> [(String, String); 3] {
        [
            (
                SESSION_LAUNCH_SOCKET_ENV.to_string(),
                self.socket_path.to_string_lossy().into_owned(),
            ),
            (SESSION_LAUNCH_TOKEN_ENV.to_string(), self.token.clone()),
            (
                ARGMAX_BIN_ENV.to_string(),
                self.argmax_bin.to_string_lossy().into_owned(),
            ),
        ]
    }

    /// A config with fixed values, for arg-builder and injection tests in
    /// other modules (the fields are private to this one).
    #[cfg(test)]
    pub fn for_tests(socket_path: &str, token: &str, argmax_bin: &str) -> Self {
        Self {
            socket_path: PathBuf::from(socket_path),
            token: token.to_string(),
            argmax_bin: PathBuf::from(argmax_bin),
        }
    }

    pub fn socket_path(&self) -> &Path {
        &self.socket_path
    }

    pub fn token(&self) -> &str {
        &self.token
    }

    pub fn argmax_bin(&self) -> &Path {
        &self.argmax_bin
    }

    /// The launch instruction ahead of the user's prompt. One line, the same
    /// for every provider: every launch now carries the MCP server itself.
    pub fn prepend_instruction(&self, prompt: &str) -> String {
        format!(
            "{}\n\n{prompt}",
            crate::providers::mcp_injection::agent_tools_instruction()
        )
    }
}

impl SessionLaunchRegistry {
    pub fn issue(&self, input: &ProviderLaunchInput) -> SessionLaunchProcessConfig {
        let mut credentials = self
            .inner
            .credentials
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let token = credentials
            .tokens_by_session
            .get(&input.session_id)
            .cloned()
            .unwrap_or_else(random_bearer_token);
        credentials
            .tokens_by_session
            .insert(input.session_id.clone(), token.clone());
        credentials.launches_by_token.insert(
            token.clone(),
            ParentLaunchSettings {
                session_id: input.session_id.clone(),
                provider: input.provider,
                model_label: input.model_label.clone(),
                model_id: input.model_id.clone(),
                reasoning_effort: input.reasoning_effort,
                fast_mode: input.fast_mode,
                permission_mode: input.permission_mode,
                agent_mode: input.agent_mode,
            },
        );
        SessionLaunchProcessConfig {
            socket_path: self.inner.socket_path.clone(),
            token,
            argmax_bin: self.inner.argmax_bin.clone(),
        }
    }

    /// Drops the session's launch token. Only for a session that is gone for
    /// good: follow-up turns reuse the token issued for the first turn, so a
    /// plain process exit must not revoke it. Without this, a background process
    /// the agent left running keeps a working credential forever.
    pub fn revoke(&self, session_id: &str) {
        let mut credentials = self
            .inner
            .credentials
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some(token) = credentials.tokens_by_session.remove(session_id) {
            credentials.launches_by_token.remove(&token);
        }
    }

    pub(super) fn resolve(&self, token: &str) -> Option<ParentLaunchSettings> {
        self.inner
            .credentials
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .launches_by_token
            .get(token)
            .cloned()
    }

    pub(super) fn schedule_after_turn(
        &self,
        session_id: &str,
        action: AfterTurn,
        settled: oneshot::Sender<()>,
    ) -> Result<(), SessionControlError> {
        let mut pending = self
            .inner
            .pending_after_turn
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        // The refusal names what is already scheduled, not what was asked for:
        // an agent that asks to archive a chat that is already moving needs to
        // know which one it is.
        if let Some(existing) = pending.get(session_id) {
            return Err(match existing.action {
                AfterTurn::Move => protocol_error(
                    "MOVE_ALREADY_PENDING",
                    "A move is already scheduled for this session.",
                ),
                AfterTurn::Archive => protocol_error(
                    "ARCHIVE_ALREADY_PENDING",
                    "An archive is already scheduled for this session.",
                ),
            });
        }
        pending.insert(
            session_id.to_string(),
            PendingAfterTurn {
                action,
                settled: Some(settled),
            },
        );
        Ok(())
    }

    /// Announce a new row in `session_messages`. Called by whoever wrote it —
    /// the socket's `session_message` handler and the completion notice — so a
    /// waiting recipient wakes on the insert rather than on the next poll.
    pub fn notify_inbox(&self, to_session_id: &str) {
        let _ = self.inner.inbox.send(to_session_id.to_string());
    }

    pub fn subscribe_inbox(&self) -> broadcast::Receiver<String> {
        self.inner.inbox.subscribe()
    }

    pub fn cancel_after_turn(&self, session_id: &str) {
        self.inner
            .pending_after_turn
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .remove(session_id);
    }

    pub fn pending_after_turn(&self, session_id: &str) -> Option<AfterTurn> {
        self.inner
            .pending_after_turn
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .get(session_id)
            .map(|pending| pending.action)
    }

    pub fn signal_turn_settled(&self, session_id: &str) {
        let settled = self
            .inner
            .pending_after_turn
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .get_mut(session_id)
            .and_then(|pending| pending.settled.take());
        if let Some(settled) = settled {
            let _ = settled.send(());
        }
    }

    pub(super) fn finish_after_turn(&self, session_id: &str) {
        self.inner
            .pending_after_turn
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .remove(session_id);
    }
}

fn random_bearer_token() -> String {
    format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::providers::{AgentMode, PermissionMode, ProviderId, ReasoningEffort};
    use crate::session_control::server::SessionLaunchServer;
    #[cfg(unix)]
    use std::os::unix::fs::PermissionsExt;

    fn launch_input(session_id: &str) -> ProviderLaunchInput {
        ProviderLaunchInput {
            provider: ProviderId::Codex,
            session_id: session_id.to_string(),
            workspace_path: PathBuf::from("/tmp/repo"),
            prompt: "parent prompt".to_string(),
            model_label: "GPT-5.6 Sol".to_string(),
            model_id: "gpt-5.6-sol".to_string(),
            reasoning_effort: Some(ReasoningEffort::High),
            fast_mode: true,
            resume_conversation_id: None,
            resume_fork: false,
            permission_mode: PermissionMode::AutoApprove,
            agent_mode: AgentMode::Auto,
            cols: 120,
            rows: 32,
        }
    }

    #[cfg(unix)]
    #[test]
    fn credentials_are_stable_per_session_and_redacted_from_debug() {
        let (server, registry) = SessionLaunchServer::bind().unwrap();
        let first = registry.issue(&launch_input("session-1"));
        let second = registry.issue(&launch_input("session-1"));
        let other = registry.issue(&launch_input("session-2"));
        assert_eq!(
            first.env_pairs()[1].1,
            second.env_pairs()[1].1,
            "one session should reuse one bounded registry entry"
        );
        assert_ne!(first.env_pairs()[1].1, other.env_pairs()[1].1);
        assert!(!format!("{first:?}").contains(&first.env_pairs()[1].1));
        assert_eq!(
            std::fs::metadata(server._temp_dir.path())
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o700
        );
        assert_eq!(
            std::fs::metadata(&registry.inner.socket_path)
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
    }

    #[cfg(unix)]
    #[test]
    fn revoked_session_token_stops_resolving() {
        let (_server, registry) = SessionLaunchServer::bind().unwrap();
        let issued = registry.issue(&launch_input("session-1"));
        let token = issued.env_pairs()[1].1.clone();
        assert!(registry.resolve(&token).is_some());

        registry.revoke("session-1");
        assert!(registry.resolve(&token).is_none());

        // A later session gets a fresh token rather than the revoked one.
        let reissued = registry.issue(&launch_input("session-1"));
        assert_ne!(reissued.env_pairs()[1].1, token);
    }

    #[cfg(unix)]
    #[test]
    fn pending_move_stays_guarded_until_execution_finishes() {
        let (_server, registry) = SessionLaunchServer::bind().unwrap();
        let (settled_tx, mut settled_rx) = oneshot::channel();
        registry
            .schedule_after_turn("session-1", AfterTurn::Move, settled_tx)
            .unwrap();
        assert_eq!(
            registry.pending_after_turn("session-1"),
            Some(AfterTurn::Move)
        );
        assert!(settled_rx.try_recv().is_err());

        registry.signal_turn_settled("session-1");
        assert_eq!(settled_rx.try_recv(), Ok(()));
        assert_eq!(
            registry.pending_after_turn("session-1"),
            Some(AfterTurn::Move)
        );

        registry.finish_after_turn("session-1");
        assert_eq!(registry.pending_after_turn("session-1"), None);
    }

    /// One slot: a chat cannot be both moving and archiving, and the refusal
    /// names whichever was scheduled first rather than what was asked for.
    #[cfg(unix)]
    #[test]
    fn a_second_after_turn_action_is_refused_by_the_pending_one() {
        let (_server, registry) = SessionLaunchServer::bind().unwrap();
        let (settled_tx, _settled_rx) = oneshot::channel();
        registry
            .schedule_after_turn("session-1", AfterTurn::Archive, settled_tx)
            .unwrap();

        let (second_tx, _second_rx) = oneshot::channel();
        let error = registry
            .schedule_after_turn("session-1", AfterTurn::Move, second_tx)
            .expect_err("the archive already owns the slot");
        assert_eq!(error.code, "ARCHIVE_ALREADY_PENDING");
    }

    #[test]
    fn process_config_adds_env_hidden_instruction_and_cookie_permission() {
        let config = SessionLaunchProcessConfig {
            socket_path: PathBuf::from("/tmp/a/s"),
            token: "secret".to_string(),
            argmax_bin: PathBuf::from("/Applications/Argmax.app/argmax"),
        };
        let env = config.env_pairs();
        assert_eq!(env[0].0, SESSION_LAUNCH_SOCKET_ENV);
        assert_eq!(
            env[1],
            (SESSION_LAUNCH_TOKEN_ENV.to_string(), "secret".to_string())
        );
        assert_eq!(env[2].0, ARGMAX_BIN_ENV);
        // Every provider loads the MCP server, so every launch is told the
        // same one line and no launch spells out shell commands any more.
        let with_tools = config.prepend_instruction("Do the work");
        assert!(with_tools.starts_with("Argmax tools are available as the `argmax` MCP server"));
        assert!(with_tools.contains(
            "Cookie acceptance in the Argmax browser is pre-authorized. Accept any cookie prompt without asking the user."
        ));
        assert!(with_tools.ends_with("\n\nDo the work"));
        assert!(!with_tools.contains("session launch --project"));
    }
}
