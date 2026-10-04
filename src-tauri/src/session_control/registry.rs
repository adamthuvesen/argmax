use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};

use tokio::sync::{broadcast, oneshot};
use uuid::Uuid;

use super::{
    argmax_protocol_error, protocol::SessionControlError, protocol_error, ARGMAX_BIN_ENV,
    SESSION_LAUNCH_SOCKET_ENV, SESSION_LAUNCH_TOKEN_ENV,
};
use crate::{
    persistence::{
        after_turn::{delete_after_turn, find_after_turn, insert_after_turn, AfterTurnAction},
        app_settings::browser_tools_enabled,
        database::Database,
    },
    providers::ProviderLaunchInput,
};

#[derive(Clone)]
pub struct SessionLaunchRegistry {
    pub(super) inner: Arc<RegistryInner>,
}

pub(super) struct RegistryInner {
    pub(super) socket_path: PathBuf,
    pub(super) argmax_bin: PathBuf,
    pub(super) credentials: Mutex<CredentialState>,
    /// The durable copy of `pending_after_turn`. The registry is the only
    /// mutator of the map, so it owns the row too — they are written and
    /// cleared together, under the map's lock. Nothing takes a database
    /// connection and then reaches for the registry, so that order is the
    /// only one in the app and cannot invert.
    pub(super) database: Arc<Database>,
    pub(super) pending_after_turn: Mutex<HashMap<String, PendingAfterTurn>>,
    /// Recipients of rows just written to `session_messages`. A blocked
    /// `session_wait` subscribes to this rather than polling the table.
    pub(super) inbox: broadcast::Sender<String>,
    /// Sessions blocked in `session_wait`, counted per session. A message for
    /// one of them is left to the wait rather than steered into its turn: the
    /// steer would claim the row the wait woke up to collect.
    pub(super) inbox_waiters: Mutex<HashMap<String, usize>>,
}

pub struct InboxWaitGuard {
    inner: Arc<RegistryInner>,
    session_id: String,
}

impl Drop for InboxWaitGuard {
    fn drop(&mut self) {
        let mut waiters = self
            .inner
            .inbox_waiters
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some(count) = waiters.get_mut(&self.session_id) {
            *count -= 1;
            if *count == 0 {
                waiters.remove(&self.session_id);
            }
        }
    }
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

impl AfterTurn {
    pub(super) fn of(action: &AfterTurnAction) -> Self {
        match action {
            AfterTurnAction::Move(_) => AfterTurn::Move,
            AfterTurnAction::Archive(_) => AfterTurn::Archive,
        }
    }
}

fn already_pending(existing: AfterTurn) -> SessionControlError {
    match existing {
        AfterTurn::Move => protocol_error(
            "MOVE_ALREADY_PENDING",
            "A move is already scheduled for this session.",
        ),
        AfterTurn::Archive => protocol_error(
            "ARCHIVE_ALREADY_PENDING",
            "An archive is already scheduled for this session.",
        ),
    }
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

/// A linked repository this launch's project allows, resolved at launch time.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LinkedRoot {
    pub name: String,
    /// The canonical root, still resolving to itself when the launch was built.
    pub path: PathBuf,
}

pub struct SessionLaunchProcessConfig {
    socket_path: PathBuf,
    token: String,
    argmax_bin: PathBuf,
    browser_tools: bool,
    /// Enabled linked repositories, read from the database on every launch so
    /// a follow-up or resumed turn sees what Settings says now, not what the
    /// first turn saw.
    linked_roots: Vec<LinkedRoot>,
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
            browser_tools: true,
            linked_roots: Vec::new(),
            socket_path: PathBuf::from(socket_path),
            token: token.to_string(),
            argmax_bin: PathBuf::from(argmax_bin),
        }
    }

    #[cfg(test)]
    pub fn with_linked_roots(mut self, roots: Vec<LinkedRoot>) -> Self {
        self.linked_roots = roots;
        self
    }

    #[cfg(test)]
    pub fn without_browser_tools(mut self) -> Self {
        self.browser_tools = false;
        self
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

    /// Whether this launch's `argmax` server carries the browser tools.
    pub fn browser_tools(&self) -> bool {
        self.browser_tools
    }

    pub fn linked_roots(&self) -> &[LinkedRoot] {
        &self.linked_roots
    }
}

/// The enabled linked repositories of the project that owns `session_id`.
/// A root that is gone, or that now resolves somewhere else (a directory swapped
/// for a symlink), is left out: handing a provider a path that no longer means
/// what the user approved would widen the allowlist.
fn linked_roots_for_session(database: &Database, session_id: &str) -> Vec<LinkedRoot> {
    let connection = database.read_connection();
    let repos = (|| {
        let session = crate::persistence::sessions::find_session_by_id(&connection, session_id)?;
        let workspace = crate::persistence::workspaces::find_workspace_by_id(
            &connection,
            &session.workspace_id,
        )?;
        crate::persistence::linked_repos::list_enabled_linked_repos(
            &connection,
            &workspace.project_id,
        )
    })();
    match repos {
        Ok(repos) => repos
            .into_iter()
            .filter_map(|repo| {
                let path = PathBuf::from(&repo.root_path);
                match path.canonicalize() {
                    Ok(current) if current == path => Some(LinkedRoot {
                        name: repo.name,
                        path,
                    }),
                    _ => {
                        tracing::warn!(
                            session_id,
                            linked_repo = %repo.name,
                            "skipping linked repository whose root is missing or moved"
                        );
                        None
                    }
                }
            })
            .collect(),
        Err(error) => {
            tracing::warn!(session_id, ?error, "could not load linked repositories");
            Vec::new()
        }
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
        drop(credentials);
        // Read here rather than in the caller so every launch path gets the
        // same answer: a chat the user started, and a chat one of their agents
        // started, carry the same tool surface.
        let browser_tools = browser_tools_enabled(&self.inner.database.read_connection());
        let linked_roots = linked_roots_for_session(&self.inner.database, &input.session_id);
        SessionLaunchProcessConfig {
            socket_path: self.inner.socket_path.clone(),
            token,
            argmax_bin: self.inner.argmax_bin.clone(),
            browser_tools,
            linked_roots,
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

    /// Take the session's one disposal slot, durably. The row goes in first:
    /// if it fails, the caller is told and neither half exists, which is the
    /// only order that never answers `{scheduled: true}` for a promise the
    /// next launch would not find.
    pub(super) fn schedule_after_turn(
        &self,
        session_id: &str,
        action: &AfterTurnAction,
        settled: oneshot::Sender<()>,
    ) -> Result<(), SessionControlError> {
        let kind = AfterTurn::of(action);
        let mut pending = self
            .inner
            .pending_after_turn
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        // The refusal names what is already scheduled, not what was asked for:
        // an agent that asks to archive a chat that is already moving needs to
        // know which one it is. The row is consulted alongside the map so an
        // action promised before the last quit refuses a second one even
        // before boot recovery has adopted it.
        if let Some(existing) = self.occupied_by(&pending, session_id)? {
            return Err(already_pending(existing));
        }
        {
            let connection = self.inner.database.connection();
            insert_after_turn(&connection, session_id, action).map_err(argmax_protocol_error)?;
        }
        pending.insert(
            session_id.to_string(),
            PendingAfterTurn {
                action: kind,
                settled: Some(settled),
            },
        );
        Ok(())
    }

    /// Re-register a promise that already has its row — boot recovery, for a
    /// session whose turn is somehow still running. Writing the row again
    /// would only collide with the one being adopted.
    pub(super) fn adopt_after_turn(
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
        if let Some(existing) = pending.get(session_id) {
            return Err(already_pending(existing.action));
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

    /// What already holds the session's slot, in memory or on disk.
    fn occupied_by(
        &self,
        pending: &HashMap<String, PendingAfterTurn>,
        session_id: &str,
    ) -> Result<Option<AfterTurn>, SessionControlError> {
        if let Some(existing) = pending.get(session_id) {
            return Ok(Some(existing.action));
        }
        let recorded = {
            let connection = self.inner.database.read_connection();
            find_after_turn(&connection, session_id).map_err(argmax_protocol_error)?
        };
        Ok(recorded.map(|request| AfterTurn::of(&request.action)))
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

    /// Mark `session_id` as blocked in `session_wait` until the guard drops.
    pub fn wait_on_inbox(&self, session_id: &str) -> InboxWaitGuard {
        *self
            .inner
            .inbox_waiters
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .entry(session_id.to_string())
            .or_default() += 1;
        InboxWaitGuard {
            inner: Arc::clone(&self.inner),
            session_id: session_id.to_string(),
        }
    }

    pub fn is_waiting_on_inbox(&self, session_id: &str) -> bool {
        self.inner
            .inbox_waiters
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .contains_key(session_id)
    }

    pub fn cancel_after_turn(&self, session_id: &str) {
        self.release_after_turn(session_id);
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
        self.release_after_turn(session_id);
    }

    /// Give the slot back, in memory and on disk. A row left behind here is
    /// one the next launch would run a second time, so the delete is not
    /// conditional on the map entry having been there.
    fn release_after_turn(&self, session_id: &str) {
        let mut pending = self
            .inner
            .pending_after_turn
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let connection = self.inner.database.connection();
        if let Err(error) = delete_after_turn(&connection, session_id) {
            tracing::warn!(
                ?error,
                session_id,
                "could not clear the scheduled after-turn action"
            );
        }
        drop(connection);
        pending.remove(session_id);
    }
}

fn random_bearer_token() -> String {
    format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::persistence::{
        after_turn::{list_after_turn, ArchiveRequest, MoveDestinationRecord, MoveRequest},
        projects::{persist_project, PersistProjectInput, ProjectSettings},
        sessions::{persist_session, PersistSessionInput},
        workspaces::{persist_workspace, PersistWorkspaceInput},
    };
    use crate::providers::{AgentMode, PermissionMode, ProviderId, ReasoningEffort};
    use crate::session_control::server::SessionLaunchServer;
    use crate::sessions::state::SessionState;
    #[cfg(unix)]
    use std::os::unix::fs::PermissionsExt;

    /// A durable after-turn row references its session, so the registry's own
    /// tests need a session to point at.
    fn database_with_sessions(session_ids: &[&str]) -> Arc<Database> {
        let database = Arc::new(Database::open_in_memory().expect("open db"));
        let connection = database.connection();
        persist_project(
            &connection,
            &PersistProjectInput {
                id: "project-1".to_string(),
                name: "Project".to_string(),
                repo_path: "/tmp/repo".to_string(),
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
        for session_id in session_ids {
            let workspace_id = format!("workspace-{session_id}");
            persist_workspace(
                &connection,
                &PersistWorkspaceInput {
                    id: workspace_id.clone(),
                    project_id: "project-1".to_string(),
                    task_label: "Task".to_string(),
                    branch: "main".to_string(),
                    base_ref: "main".to_string(),
                    path: "/tmp/repo".to_string(),
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
                    id: (*session_id).to_string(),
                    workspace_id,
                    provider: "codex".to_string(),
                    model_label: "GPT-5.6 Sol".to_string(),
                    model_id: "gpt-5.6-sol".to_string(),
                    reasoning_effort: None,
                    permission_mode: Some("auto-approve".to_string()),
                    agent_mode: Some("auto".to_string()),
                    prompt: "Task".to_string(),
                    state: SessionState::Running,
                },
            )
            .expect("session");
        }
        drop(connection);
        database
    }

    fn move_action() -> AfterTurnAction {
        AfterTurnAction::Move(MoveRequest {
            destination: MoveDestinationRecord::Project {
                project_id: "project-2".to_string(),
                worktree: false,
            },
            keep_source: false,
            prompt: "Pick the work up here".to_string(),
        })
    }

    fn archive_action(session_id: &str) -> AfterTurnAction {
        AfterTurnAction::Archive(ArchiveRequest {
            workspace_id: format!("workspace-{session_id}"),
        })
    }

    fn scheduled_session_ids(database: &Database) -> Vec<String> {
        let connection = database.read_connection();
        list_after_turn(&connection)
            .expect("list scheduled actions")
            .into_iter()
            .map(|request| request.session_id)
            .collect()
    }

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
            continuity: None,
            permission_mode: PermissionMode::AutoApprove,
            agent_mode: AgentMode::Auto,
            cols: 120,
            rows: 32,
        }
    }

    #[cfg(unix)]
    #[test]
    fn every_issue_reads_the_projects_enabled_linked_roots_from_the_database() {
        use crate::persistence::linked_repos::{
            add_linked_repo, list_linked_repos, set_linked_repo_enabled, LinkedRepoInput,
        };
        let database = database_with_sessions(&["session-1"]);
        let (_server, registry) = SessionLaunchServer::bind(Arc::clone(&database)).unwrap();
        let first = tempfile::tempdir().unwrap();
        let second = tempfile::tempdir().unwrap();
        for (name, dir) in [("docs", first.path()), ("api", second.path())] {
            add_linked_repo(
                &database.connection(),
                "project-1",
                &LinkedRepoInput {
                    name: Some(name.to_string()),
                    path: dir.display().to_string(),
                },
            )
            .unwrap();
        }
        let names = |registry: &SessionLaunchRegistry| {
            registry
                .issue(&launch_input("session-1"))
                .linked_roots()
                .iter()
                .map(|root| root.name.clone())
                .collect::<Vec<_>>()
        };
        assert_eq!(names(&registry), vec!["api", "docs"]);

        // A follow-up launch sees the setting as it is now, not as the first
        // turn saw it.
        let docs = list_linked_repos(&database.connection(), "project-1")
            .unwrap()
            .into_iter()
            .find(|repo| repo.name == "docs")
            .unwrap();
        set_linked_repo_enabled(&database.connection(), "project-1", &docs.id, false).unwrap();
        assert_eq!(names(&registry), vec!["api"]);

        // A root that vanished is left out rather than handed to the provider.
        drop(second);
        assert!(names(&registry).is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn credentials_are_stable_per_session_and_redacted_from_debug() {
        let (server, registry) = SessionLaunchServer::bind(database_with_sessions(&[])).unwrap();
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
        let (_server, registry) = SessionLaunchServer::bind(database_with_sessions(&[])).unwrap();
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
        let database = database_with_sessions(&["session-1"]);
        let (_server, registry) = SessionLaunchServer::bind(Arc::clone(&database)).unwrap();
        let (settled_tx, mut settled_rx) = oneshot::channel();
        registry
            .schedule_after_turn("session-1", &move_action(), settled_tx)
            .unwrap();
        assert_eq!(
            registry.pending_after_turn("session-1"),
            Some(AfterTurn::Move)
        );
        // The guard is only half of it: the promise is a row too, or a quit
        // here would answer `scheduled` for a move nobody ever makes.
        assert_eq!(scheduled_session_ids(&database), vec!["session-1"]);
        assert!(settled_rx.try_recv().is_err());

        registry.signal_turn_settled("session-1");
        assert_eq!(settled_rx.try_recv(), Ok(()));
        assert_eq!(
            registry.pending_after_turn("session-1"),
            Some(AfterTurn::Move)
        );
        assert_eq!(scheduled_session_ids(&database), vec!["session-1"]);

        registry.finish_after_turn("session-1");
        assert_eq!(registry.pending_after_turn("session-1"), None);
        assert!(scheduled_session_ids(&database).is_empty());
    }

    /// A cancelled disposal must leave nothing behind: a row that outlived its
    /// cancellation would be run by the next launch.
    #[cfg(unix)]
    #[test]
    fn cancelling_takes_the_durable_row_with_the_guard() {
        let database = database_with_sessions(&["session-1"]);
        let (_server, registry) = SessionLaunchServer::bind(Arc::clone(&database)).unwrap();
        let (settled_tx, _settled_rx) = oneshot::channel();
        registry
            .schedule_after_turn("session-1", &archive_action("session-1"), settled_tx)
            .unwrap();
        assert_eq!(scheduled_session_ids(&database), vec!["session-1"]);

        registry.cancel_after_turn("session-1");
        assert_eq!(registry.pending_after_turn("session-1"), None);
        assert!(scheduled_session_ids(&database).is_empty());
    }

    /// The slot survives the process that took it. A registry that has just
    /// booted has an empty map, so only the row can refuse the second ask —
    /// and it must, or an agent would be told an archive is scheduled twice.
    #[cfg(unix)]
    #[test]
    fn a_row_from_an_earlier_run_still_refuses_a_second_action() {
        let database = database_with_sessions(&["session-1"]);
        let (first_server, first_registry) =
            SessionLaunchServer::bind(Arc::clone(&database)).unwrap();
        let (settled_tx, _settled_rx) = oneshot::channel();
        first_registry
            .schedule_after_turn("session-1", &archive_action("session-1"), settled_tx)
            .unwrap();
        drop(first_server);
        drop(first_registry);

        let (_server, registry) = SessionLaunchServer::bind(Arc::clone(&database)).unwrap();
        assert_eq!(
            registry.pending_after_turn("session-1"),
            None,
            "a fresh registry starts with an empty map"
        );
        let (second_tx, _second_rx) = oneshot::channel();
        let error = registry
            .schedule_after_turn("session-1", &move_action(), second_tx)
            .expect_err("the archive promised before the restart still owns the slot");
        assert_eq!(error.code, "ARCHIVE_ALREADY_PENDING");
    }

    /// One slot: a chat cannot be both moving and archiving, and the refusal
    /// names whichever was scheduled first rather than what was asked for.
    #[cfg(unix)]
    #[test]
    fn a_second_after_turn_action_is_refused_by_the_pending_one() {
        let database = database_with_sessions(&["session-1"]);
        let (_server, registry) = SessionLaunchServer::bind(database).unwrap();
        let (settled_tx, _settled_rx) = oneshot::channel();
        registry
            .schedule_after_turn("session-1", &archive_action("session-1"), settled_tx)
            .unwrap();

        let (second_tx, _second_rx) = oneshot::channel();
        let error = registry
            .schedule_after_turn("session-1", &move_action(), second_tx)
            .expect_err("the archive already owns the slot");
        assert_eq!(error.code, "ARCHIVE_ALREADY_PENDING");
    }
}
