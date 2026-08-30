use std::{
    collections::HashMap,
    env,
    ffi::OsString,
    io::{self, BufRead, Read, Write},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};

use serde::{Deserialize, Serialize};
use tempfile::TempDir;
use uuid::Uuid;

use crate::{
    error::ArgmaxError,
    ipc::{
        inputs::{
            ProvidersLaunchInput, TerminalCols, TerminalRows, WorkspacesArchiveInput,
            WorkspacesCreateCurrentInput, WorkspacesCreateIsolatedInput,
        },
        validation::{BaseRef, NonEmptyString, ProjectId, Prompt, TaskLabel, WorkspaceId},
    },
    persistence::{
        database::Database,
        projects::{list_projects, ProjectSummary},
        sessions::find_session_by_id,
        workspaces::find_workspace_by_id,
    },
    providers::{session_service::ProviderSessionService, ProviderLaunchInput},
    workspaces::WorkspaceService,
};

const PROTOCOL_VERSION: u32 = 1;
const MAX_REQUEST_BYTES: usize = 256 * 1024;
const MAX_RESPONSE_BYTES: usize = 64 * 1024;
const SERVER_IO_TIMEOUT: Duration = Duration::from_secs(5);
const CLIENT_IO_TIMEOUT: Duration = Duration::from_secs(75);
const ACCEPT_POLL_INTERVAL: Duration = Duration::from_millis(25);
const DEFAULT_TASK_LABEL: &str = "Local agent task";
const MAX_TASK_LABEL_CHARS: usize = 64;
const MAX_TASK_LABEL_BYTES: usize = 200;
const TASK_LABEL_ELLIPSIS: &str = "...";

pub const SESSION_LAUNCH_SOCKET_ENV: &str = "ARGMAX_SESSION_LAUNCH_SOCKET";
pub const SESSION_LAUNCH_TOKEN_ENV: &str = "ARGMAX_SESSION_LAUNCH_TOKEN";
pub const ARGMAX_BIN_ENV: &str = "ARGMAX_BIN";

// `pub(crate)` so session sync can strip it back off an imported transcript's
// first prompt: Argmax prepends it, so it must not become the session's title.
pub(crate) const SESSION_LAUNCH_INSTRUCTION: &str = r#"Argmax session launching is available only when the user explicitly asks for a separate Argmax session. Use "$ARGMAX_BIN" session launch --project <registered name or absolute repo path> --prompt '<task>'. Omit --project to use this session's project. The default uses the current checkout. Add --worktree for isolation. This creates a top-level sidebar session, not a subagent."#;

#[derive(Debug, thiserror::Error)]
pub enum SessionLaunchError {
    #[error("Argmax session launching is not supported on this platform")]
    Unsupported,
    #[error("could not prepare Argmax session launching: {0}")]
    Setup(#[source] io::Error),
    #[error("Argmax session launch server has already started")]
    AlreadyStarted,
}

#[derive(Clone)]
pub struct SessionLaunchRegistry {
    inner: Arc<RegistryInner>,
}

struct RegistryInner {
    socket_path: PathBuf,
    argmax_bin: PathBuf,
    credentials: Mutex<CredentialState>,
}

#[derive(Default)]
struct CredentialState {
    launches_by_token: HashMap<String, ParentLaunchSettings>,
    tokens_by_session: HashMap<String, String>,
}

#[derive(Clone)]
struct ParentLaunchSettings {
    session_id: String,
    provider: crate::providers::ProviderId,
    model_label: String,
    model_id: String,
    reasoning_effort: Option<crate::providers::ReasoningEffort>,
    fast_mode: bool,
    permission_mode: crate::providers::PermissionMode,
    agent_mode: crate::providers::AgentMode,
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

    pub fn prepend_instruction(&self, prompt: &str) -> String {
        format!("{SESSION_LAUNCH_INSTRUCTION}\n\n{prompt}")
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

    fn resolve(&self, token: &str) -> Option<ParentLaunchSettings> {
        self.inner
            .credentials
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .launches_by_token
            .get(token)
            .cloned()
    }
}

pub struct SessionLaunchServer {
    registry: Arc<SessionLaunchRegistry>,
    _temp_dir: TempDir,
    stop: Arc<AtomicBool>,
    thread: Option<std::thread::JoinHandle<()>>,
    #[cfg(unix)]
    listener: Option<std::os::unix::net::UnixListener>,
}

impl SessionLaunchServer {
    #[cfg(unix)]
    pub fn bind() -> Result<(Self, Arc<SessionLaunchRegistry>), SessionLaunchError> {
        use std::os::unix::fs::PermissionsExt;

        let temp_dir = tempfile::Builder::new()
            .prefix("ax-")
            .tempdir_in("/tmp")
            .map_err(SessionLaunchError::Setup)?;
        std::fs::set_permissions(temp_dir.path(), std::fs::Permissions::from_mode(0o700))
            .map_err(SessionLaunchError::Setup)?;
        let socket_path = temp_dir.path().join("s");
        let listener = std::os::unix::net::UnixListener::bind(&socket_path)
            .map_err(SessionLaunchError::Setup)?;
        std::fs::set_permissions(&socket_path, std::fs::Permissions::from_mode(0o600))
            .map_err(SessionLaunchError::Setup)?;
        listener
            .set_nonblocking(true)
            .map_err(SessionLaunchError::Setup)?;
        let argmax_bin = env::current_exe().map_err(SessionLaunchError::Setup)?;
        let registry = Arc::new(SessionLaunchRegistry {
            inner: Arc::new(RegistryInner {
                socket_path,
                argmax_bin,
                credentials: Mutex::new(CredentialState::default()),
            }),
        });
        Ok((
            Self {
                registry: Arc::clone(&registry),
                _temp_dir: temp_dir,
                stop: Arc::new(AtomicBool::new(false)),
                thread: None,
                listener: Some(listener),
            },
            registry,
        ))
    }

    #[cfg(not(unix))]
    pub fn bind() -> Result<(Self, Arc<SessionLaunchRegistry>), SessionLaunchError> {
        Err(SessionLaunchError::Unsupported)
    }

    #[cfg(unix)]
    pub fn start(
        mut self,
        database: Arc<Database>,
        workspaces: Arc<WorkspaceService>,
        providers: Arc<ProviderSessionService>,
    ) -> Result<Self, SessionLaunchError> {
        let listener = self
            .listener
            .take()
            .ok_or(SessionLaunchError::AlreadyStarted)?;
        let stop = Arc::clone(&self.stop);
        let registry = Arc::clone(&self.registry);
        self.thread = Some(std::thread::spawn(move || {
            while !stop.load(Ordering::Relaxed) {
                match listener.accept() {
                    Ok((stream, _)) => {
                        let database = Arc::clone(&database);
                        let workspaces = Arc::clone(&workspaces);
                        let providers = Arc::clone(&providers);
                        let registry = Arc::clone(&registry);
                        std::thread::spawn(move || {
                            handle_connection(stream, database, workspaces, providers, registry)
                        });
                    }
                    Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                        std::thread::sleep(ACCEPT_POLL_INTERVAL);
                    }
                    Err(error) => {
                        tracing::warn!(?error, "Argmax session launch socket stopped accepting");
                        break;
                    }
                }
            }
        }));
        Ok(self)
    }

    #[cfg(not(unix))]
    pub fn start(
        self,
        _database: Arc<Database>,
        _workspaces: Arc<WorkspaceService>,
        _providers: Arc<ProviderSessionService>,
    ) -> Result<Self, SessionLaunchError> {
        Err(SessionLaunchError::Unsupported)
    }
}

impl Drop for SessionLaunchServer {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SessionLaunchRequest {
    version: u32,
    token: String,
    project: Option<String>,
    prompt: String,
    worktree: bool,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SessionLaunchResponse {
    version: u32,
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    session_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    workspace_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    project_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    project_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<SessionLaunchProtocolError>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionLaunchProtocolError {
    pub(crate) code: String,
    pub(crate) message: String,
}

impl SessionLaunchResponse {
    fn success(
        session_id: String,
        workspace_id: String,
        project_id: String,
        project_name: String,
    ) -> Self {
        Self {
            version: PROTOCOL_VERSION,
            ok: true,
            session_id: Some(session_id),
            workspace_id: Some(workspace_id),
            project_id: Some(project_id),
            project_name: Some(project_name),
            error: None,
        }
    }

    fn failure(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            version: PROTOCOL_VERSION,
            ok: false,
            session_id: None,
            workspace_id: None,
            project_id: None,
            project_name: None,
            error: Some(SessionLaunchProtocolError {
                code: code.into(),
                message: message.into(),
            }),
        }
    }
}

#[cfg(unix)]
fn handle_connection(
    mut stream: std::os::unix::net::UnixStream,
    database: Arc<Database>,
    workspaces: Arc<WorkspaceService>,
    providers: Arc<ProviderSessionService>,
    registry: Arc<SessionLaunchRegistry>,
) {
    if let Err(error) = stream.set_nonblocking(false) {
        let response = SessionLaunchResponse::failure(
            "STREAM_SETUP_FAILED",
            format!("Could not prepare session launch connection: {error}"),
        );
        let _ = write_json_line(&mut stream, &response);
        return;
    }
    let _ = stream.set_read_timeout(Some(SERVER_IO_TIMEOUT));
    let _ = stream.set_write_timeout(Some(SERVER_IO_TIMEOUT));
    let request = match read_json_line::<SessionLaunchRequest>(&mut stream, MAX_REQUEST_BYTES) {
        Ok(request) => request,
        Err(error) => {
            let response = SessionLaunchResponse::failure(error.code, error.message);
            let _ = write_json_line(&mut stream, &response);
            return;
        }
    };
    let Some(parent) = registry.resolve(&request.token) else {
        let response = SessionLaunchResponse::failure(
            "AUTH_FAILED",
            "Session launch credential is missing or invalid.",
        );
        let _ = write_json_line(&mut stream, &response);
        return;
    };
    tauri::async_runtime::spawn(async move {
        let response = launch_session(request, parent, database, workspaces, providers)
            .await
            .unwrap_or_else(|error| SessionLaunchResponse::failure(error.code, error.message));
        let _ = write_json_line(&mut stream, &response);
    });
}

struct ProtocolFailure {
    code: &'static str,
    message: String,
}

fn read_json_line<T: for<'de> Deserialize<'de>>(
    reader: &mut impl Read,
    max_bytes: usize,
) -> Result<T, ProtocolFailure> {
    let mut reader = io::BufReader::new(reader);
    let mut bytes = Vec::new();
    reader
        .by_ref()
        .take((max_bytes + 1) as u64)
        .read_until(b'\n', &mut bytes)
        .map_err(|error| ProtocolFailure {
            code: "REQUEST_READ_FAILED",
            message: format!("Could not read request: {error}"),
        })?;
    if bytes.len() > max_bytes {
        return Err(ProtocolFailure {
            code: "REQUEST_TOO_LARGE",
            message: format!("Request exceeds the {max_bytes}-byte limit."),
        });
    }
    if !bytes.ends_with(b"\n") {
        return Err(ProtocolFailure {
            code: "REQUEST_NOT_TERMINATED",
            message: "Request must end with a newline.".to_string(),
        });
    }
    bytes.pop();
    if bytes.last() == Some(&b'\r') {
        bytes.pop();
    }
    serde_json::from_slice(&bytes).map_err(|error| ProtocolFailure {
        code: "REQUEST_INVALID",
        message: format!("Request is not valid protocol JSON: {error}"),
    })
}

fn write_json_line(writer: &mut impl Write, response: &SessionLaunchResponse) -> io::Result<()> {
    serde_json::to_writer(&mut *writer, response)?;
    writer.write_all(b"\n")?;
    writer.flush()
}

/// Everything needed to launch a top-level session. The session-launch
/// socket derives it from a parent session's settings; the scheduled-task
/// scheduler derives it from a stored routine row.
pub(crate) struct LaunchSpec {
    pub project: Option<String>,
    pub prompt: String,
    pub worktree: bool,
    pub provider: crate::providers::ProviderId,
    pub model_label: String,
    pub model_id: String,
    pub reasoning_effort: Option<crate::providers::ReasoningEffort>,
    pub fast_mode: bool,
    pub permission_mode: crate::providers::PermissionMode,
    pub agent_mode: crate::providers::AgentMode,
}

pub(crate) struct LaunchOutcome {
    pub session_id: String,
    pub workspace_id: String,
    pub project_id: String,
    pub project_name: String,
}

/// Resolve the project, create the workspace, and launch the provider —
/// the shared tail of every programmatic session launch.
pub(crate) async fn launch_with_spec(
    spec: LaunchSpec,
    database: Arc<Database>,
    workspaces: Arc<WorkspaceService>,
    providers: Arc<ProviderSessionService>,
    fallback_project_id: &str,
) -> Result<LaunchOutcome, SessionLaunchProtocolError> {
    let prompt = Prompt::try_from(spec.prompt).map_err(invalid_input_error)?;
    let task_label =
        TaskLabel::try_from(task_label(prompt.as_str())).map_err(invalid_input_error)?;
    let projects = {
        let connection = database.connection();
        list_projects(&connection).map_err(argmax_protocol_error)?
    };
    let project = resolve_project(&projects, spec.project.as_deref(), fallback_project_id)?;
    let project_id = ProjectId::try_from(project.id.clone()).map_err(invalid_input_error)?;
    let model_label = NonEmptyString::try_from(spec.model_label).map_err(invalid_input_error)?;
    let model_id = NonEmptyString::try_from(spec.model_id).map_err(invalid_input_error)?;
    let cols = terminal_cols(120)?;
    let rows = terminal_rows(32)?;

    let workspace = if spec.worktree {
        let base_ref =
            BaseRef::try_from(project.current_branch.clone()).map_err(invalid_input_error)?;
        workspaces
            .create_isolated(WorkspacesCreateIsolatedInput {
                project_id,
                task_label,
                base_ref: Some(base_ref),
            })
            .await
    } else {
        workspaces.create_current(WorkspacesCreateCurrentInput {
            project_id,
            task_label,
        })
    }
    .map_err(argmax_protocol_error)?;

    let workspace_id = WorkspaceId::try_from(workspace.id.clone()).map_err(invalid_input_error)?;
    let launch_result = providers
        .launch(ProvidersLaunchInput {
            workspace_id,
            provider: spec.provider,
            prompt,
            model_label,
            model_id,
            reasoning_effort: spec.reasoning_effort,
            fast_mode: spec.fast_mode,
            agent_mode: Some(spec.agent_mode),
            permission_mode: Some(spec.permission_mode),
            cols,
            rows,
            attachments: None,
        })
        .await;
    let session = match launch_result {
        Ok(session) => session,
        Err(error) => {
            let _ = workspaces
                .archive(WorkspacesArchiveInput {
                    workspace_id: WorkspaceId::try_from(workspace.id.clone())
                        .map_err(invalid_input_error)?,
                    force: Some(false),
                })
                .await;
            return Err(argmax_protocol_error(error));
        }
    };
    Ok(LaunchOutcome {
        session_id: session.id,
        workspace_id: workspace.id,
        project_id: project.id,
        project_name: project.name,
    })
}

async fn launch_session(
    request: SessionLaunchRequest,
    parent: ParentLaunchSettings,
    database: Arc<Database>,
    workspaces: Arc<WorkspaceService>,
    providers: Arc<ProviderSessionService>,
) -> Result<SessionLaunchResponse, SessionLaunchProtocolError> {
    if request.version != PROTOCOL_VERSION {
        return Err(protocol_error(
            "VERSION_UNSUPPORTED",
            format!(
                "Protocol version {} is not supported. Expected {PROTOCOL_VERSION}.",
                request.version
            ),
        ));
    }
    let parent_project_id = {
        let connection = database.connection();
        let parent_session =
            find_session_by_id(&connection, &parent.session_id).map_err(argmax_protocol_error)?;
        find_workspace_by_id(&connection, &parent_session.workspace_id)
            .map_err(argmax_protocol_error)?
            .project_id
    };
    let outcome = launch_with_spec(
        LaunchSpec {
            project: request.project,
            prompt: request.prompt,
            worktree: request.worktree,
            provider: parent.provider,
            model_label: parent.model_label,
            model_id: parent.model_id,
            reasoning_effort: parent.reasoning_effort,
            fast_mode: parent.fast_mode,
            permission_mode: parent.permission_mode,
            agent_mode: parent.agent_mode,
        },
        database,
        workspaces,
        providers,
        &parent_project_id,
    )
    .await?;
    Ok(SessionLaunchResponse::success(
        outcome.session_id,
        outcome.workspace_id,
        outcome.project_id,
        outcome.project_name,
    ))
}

fn resolve_project(
    projects: &[ProjectSummary],
    selector: Option<&str>,
    parent_project_id: &str,
) -> Result<ProjectSummary, SessionLaunchProtocolError> {
    // The hidden scratch project is not a repository: routing a launch at it
    // would run `create_current` against the app-owned side-chats root.
    let projects: Vec<ProjectSummary> = projects
        .iter()
        .filter(|project| project.id != crate::workspaces::SCRATCH_PROJECT_ID)
        .cloned()
        .collect();
    let Some(selector) = selector else {
        return projects
            .iter()
            .find(|project| project.id == parent_project_id)
            .cloned()
            .ok_or_else(|| {
                protocol_error(
                    "PARENT_PROJECT_NOT_FOUND",
                    "The parent session's project is no longer registered.",
                )
            });
    };
    if selector.trim().is_empty() {
        return Err(protocol_error(
            "PROJECT_SELECTOR_EMPTY",
            "Project selector must not be empty.",
        ));
    }
    if let Some(project) = projects.iter().find(|project| project.id == selector) {
        return Ok(project.clone());
    }

    let selector_path = Path::new(selector);
    let selector_canonical = selector_path.canonicalize().ok();
    let mut path_matches = projects
        .iter()
        .filter(|project| {
            project.repo_path == selector
                || selector_canonical.as_ref().is_some_and(|canonical| {
                    Path::new(&project.repo_path)
                        .canonicalize()
                        .is_ok_and(|project_path| project_path == *canonical)
                })
        })
        .cloned()
        .collect::<Vec<_>>();
    if path_matches.len() == 1 {
        return Ok(path_matches.remove(0));
    }
    if path_matches.len() > 1 {
        return Err(protocol_error(
            "PROJECT_SELECTOR_AMBIGUOUS",
            format!("Project path '{selector}' matches more than one registered project."),
        ));
    }

    let mut name_matches = projects
        .iter()
        .filter(|project| project.name.eq_ignore_ascii_case(selector))
        .cloned()
        .collect::<Vec<_>>();
    if name_matches.len() == 1 {
        return Ok(name_matches.remove(0));
    }
    if name_matches.len() > 1 {
        return Err(protocol_error(
            "PROJECT_SELECTOR_AMBIGUOUS",
            format!("Project name '{selector}' is ambiguous. Use its id or absolute repo path."),
        ));
    }
    Err(protocol_error(
        "PROJECT_NOT_FOUND",
        format!("No registered project matches '{selector}'."),
    ))
}

fn task_label(prompt: &str) -> String {
    let first_line = prompt.lines().next().unwrap_or_default().trim();
    if first_line.is_empty() {
        return DEFAULT_TASK_LABEL.to_string();
    }
    if first_line.chars().count() <= MAX_TASK_LABEL_CHARS
        && first_line.len() <= MAX_TASK_LABEL_BYTES
    {
        return first_line.to_string();
    }
    let max_prefix_chars = MAX_TASK_LABEL_CHARS - TASK_LABEL_ELLIPSIS.chars().count();
    let max_prefix_bytes = MAX_TASK_LABEL_BYTES - TASK_LABEL_ELLIPSIS.len();
    let mut prefix = String::new();
    for character in first_line.chars().take(max_prefix_chars) {
        if prefix.len() + character.len_utf8() > max_prefix_bytes {
            break;
        }
        prefix.push(character);
    }
    format!("{prefix}{TASK_LABEL_ELLIPSIS}")
}

fn terminal_cols(value: u16) -> Result<TerminalCols, SessionLaunchProtocolError> {
    serde_json::from_value(serde_json::json!(value)).map_err(|error| {
        protocol_error(
            "INTERNAL_INPUT_INVALID",
            format!("Could not prepare terminal columns: {error}"),
        )
    })
}

fn terminal_rows(value: u16) -> Result<TerminalRows, SessionLaunchProtocolError> {
    serde_json::from_value(serde_json::json!(value)).map_err(|error| {
        protocol_error(
            "INTERNAL_INPUT_INVALID",
            format!("Could not prepare terminal rows: {error}"),
        )
    })
}

fn invalid_input_error(error: crate::error::InvalidInputIssue) -> SessionLaunchProtocolError {
    protocol_error(error.code, error.message)
}

fn argmax_protocol_error(error: ArgmaxError) -> SessionLaunchProtocolError {
    match error {
        ArgmaxError::InvalidInput { issues } => issues.into_iter().next().map_or_else(
            || protocol_error("INVALID_INPUT", "Input is invalid."),
            invalid_input_error,
        ),
        ArgmaxError::RecordNotFound { kind, id } => {
            protocol_error("RECORD_NOT_FOUND", format!("{kind} '{id}' was not found."))
        }
        ArgmaxError::MigrationDrift { detail } => protocol_error("MIGRATION_DRIFT", detail),
        ArgmaxError::ServiceError { sub_code, message } => SessionLaunchProtocolError {
            code: sub_code,
            message,
        },
    }
}

fn protocol_error(
    code: impl Into<String>,
    message: impl Into<String>,
) -> SessionLaunchProtocolError {
    SessionLaunchProtocolError {
        code: code.into(),
        message: message.into(),
    }
}

fn random_bearer_token() -> String {
    format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple())
}

#[derive(Debug, PartialEq)]
struct SessionLaunchCliInput {
    project: Option<String>,
    prompt: CliPrompt,
    worktree: bool,
}

#[derive(Debug, PartialEq)]
enum CliPrompt {
    Value(String),
    Stdin,
}

pub fn try_run_session_launch_cli<I, S>(args: I) -> Option<i32>
where
    I: IntoIterator<Item = S>,
    S: Into<OsString>,
{
    let args = args.into_iter().map(Into::into).collect::<Vec<_>>();
    if args.get(1).and_then(|value| value.to_str()) != Some("session") {
        return None;
    }
    let input = match parse_session_launch_cli(&args) {
        Ok(input) => input,
        Err(message) => {
            eprintln!("argmax: {message}");
            return Some(2);
        }
    };
    Some(run_session_launch_cli(input))
}

fn parse_session_launch_cli(args: &[OsString]) -> Result<SessionLaunchCliInput, String> {
    if args.get(2).and_then(|value| value.to_str()) != Some("launch") {
        return Err(session_launch_usage());
    }
    let mut project = None;
    let mut prompt = None;
    let mut worktree = false;
    let mut index = 3;
    while index < args.len() {
        let flag = args[index]
            .to_str()
            .ok_or_else(|| "arguments must be valid UTF-8".to_string())?;
        match flag {
            "--project" => {
                if project.is_some() {
                    return Err("--project may be provided only once".to_string());
                }
                index += 1;
                let value = args
                    .get(index)
                    .and_then(|value| value.to_str())
                    .ok_or_else(|| "--project requires a value".to_string())?;
                if value.is_empty() {
                    return Err("--project must not be empty".to_string());
                }
                project = Some(value.to_string());
            }
            "--worktree" => {
                if worktree {
                    return Err("--worktree may be provided only once".to_string());
                }
                worktree = true;
            }
            "--prompt" => {
                if prompt.is_some() {
                    return Err("provide exactly one of --prompt or --prompt-stdin".to_string());
                }
                index += 1;
                let value = args
                    .get(index)
                    .and_then(|value| value.to_str())
                    .ok_or_else(|| "--prompt requires a UTF-8 value".to_string())?;
                prompt = Some(CliPrompt::Value(value.to_string()));
            }
            "--prompt-stdin" => {
                if prompt.is_some() {
                    return Err("provide exactly one of --prompt or --prompt-stdin".to_string());
                }
                prompt = Some(CliPrompt::Stdin);
            }
            _ => return Err(format!("unknown session launch argument '{flag}'")),
        }
        index += 1;
    }
    let prompt = prompt.ok_or_else(session_launch_usage)?;
    Ok(SessionLaunchCliInput {
        project,
        prompt,
        worktree,
    })
}

fn session_launch_usage() -> String {
    "usage: argmax session launch [--project VALUE] [--worktree] (--prompt VALUE | --prompt-stdin)"
        .to_string()
}

fn run_session_launch_cli(input: SessionLaunchCliInput) -> i32 {
    #[cfg(not(unix))]
    {
        let _ = input;
        eprintln!("argmax: session launching is not supported on this platform");
        return 1;
    }
    #[cfg(unix)]
    {
        match run_session_launch_cli_unix(input) {
            Ok(response) => {
                println!(
                    "{}",
                    serde_json::to_string(&response)
                        .unwrap_or_else(|_| "{\"ok\":true}".to_string())
                );
                0
            }
            Err(error) => {
                eprintln!("argmax: {}: {}", error.code, error.message);
                1
            }
        }
    }
}

#[cfg(unix)]
fn run_session_launch_cli_unix(
    input: SessionLaunchCliInput,
) -> Result<SessionLaunchResponse, SessionLaunchProtocolError> {
    use std::net::Shutdown;
    use std::os::unix::net::UnixStream;

    let socket = env::var_os(SESSION_LAUNCH_SOCKET_ENV).ok_or_else(|| {
        protocol_error(
            "ENV_MISSING",
            format!("{SESSION_LAUNCH_SOCKET_ENV} is not set. Run this command inside Argmax."),
        )
    })?;
    let token = env::var(SESSION_LAUNCH_TOKEN_ENV).map_err(|_| {
        protocol_error(
            "ENV_MISSING",
            format!("{SESSION_LAUNCH_TOKEN_ENV} is not set. Run this command inside Argmax."),
        )
    })?;
    let prompt = match input.prompt {
        CliPrompt::Value(value) => value,
        CliPrompt::Stdin => read_bounded_stdin()?,
    };
    let request = SessionLaunchRequest {
        version: PROTOCOL_VERSION,
        token,
        project: input.project,
        prompt,
        worktree: input.worktree,
    };
    let mut encoded = serde_json::to_vec(&request).map_err(|error| {
        protocol_error(
            "REQUEST_ENCODE_FAILED",
            format!("Could not encode request: {error}"),
        )
    })?;
    encoded.push(b'\n');
    if encoded.len() > MAX_REQUEST_BYTES {
        return Err(protocol_error(
            "REQUEST_TOO_LARGE",
            format!("Request exceeds the {MAX_REQUEST_BYTES}-byte limit."),
        ));
    }
    let mut stream = UnixStream::connect(PathBuf::from(socket)).map_err(|error| {
        protocol_error(
            "CONNECT_FAILED",
            format!("Could not connect to Argmax: {error}"),
        )
    })?;
    stream
        .set_read_timeout(Some(CLIENT_IO_TIMEOUT))
        .map_err(|error| protocol_error("TIMEOUT_SETUP_FAILED", error.to_string()))?;
    stream
        .set_write_timeout(Some(CLIENT_IO_TIMEOUT))
        .map_err(|error| protocol_error("TIMEOUT_SETUP_FAILED", error.to_string()))?;
    stream.write_all(&encoded).map_err(|error| {
        protocol_error(
            "REQUEST_WRITE_FAILED",
            format!("Could not send request: {error}"),
        )
    })?;
    stream
        .shutdown(Shutdown::Write)
        .map_err(|error| protocol_error("REQUEST_WRITE_FAILED", error.to_string()))?;
    let response = read_json_line::<SessionLaunchResponse>(&mut stream, MAX_RESPONSE_BYTES)
        .map_err(|error| protocol_error(error.code, error.message))?;
    if response.version != PROTOCOL_VERSION {
        return Err(protocol_error(
            "VERSION_UNSUPPORTED",
            format!("Argmax returned protocol version {}.", response.version),
        ));
    }
    if !response.ok {
        return Err(response.error.unwrap_or_else(|| {
            protocol_error(
                "RESPONSE_INVALID",
                "Argmax returned an invalid error response.",
            )
        }));
    }
    if response.session_id.is_none()
        || response.workspace_id.is_none()
        || response.project_id.is_none()
        || response.project_name.is_none()
        || response.error.is_some()
    {
        return Err(protocol_error(
            "RESPONSE_INVALID",
            "Argmax returned an incomplete success response.",
        ));
    }
    Ok(response)
}

fn read_bounded_stdin() -> Result<String, SessionLaunchProtocolError> {
    let mut bytes = Vec::new();
    io::stdin()
        .take((MAX_REQUEST_BYTES + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|error| {
            protocol_error(
                "STDIN_READ_FAILED",
                format!("Could not read prompt from stdin: {error}"),
            )
        })?;
    if bytes.len() > MAX_REQUEST_BYTES {
        return Err(protocol_error(
            "REQUEST_TOO_LARGE",
            format!("Prompt exceeds the {MAX_REQUEST_BYTES}-byte request limit."),
        ));
    }
    String::from_utf8(bytes)
        .map_err(|_| protocol_error("PROMPT_INVALID", "Prompt stdin must be valid UTF-8."))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        persistence::projects::{ProjectCounts, ProjectSettings},
        providers::{AgentMode, PermissionMode, ProviderId, ReasoningEffort},
    };
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

    fn project(id: &str, name: &str, repo_path: &str) -> ProjectSummary {
        ProjectSummary {
            id: id.to_string(),
            name: name.to_string(),
            repo_path: repo_path.to_string(),
            current_branch: "main".to_string(),
            default_branch: Some("main".to_string()),
            settings: ProjectSettings {
                default_provider: "codex".to_string(),
                default_model_label: "GPT-5.6 Sol".to_string(),
                default_model_id: String::new(),
                worktree_location: "/tmp/worktrees".to_string(),
                setup_command: String::new(),
                check_commands: Vec::new(),
            },
            counts: ProjectCounts {
                active: 0,
                blocked: 0,
                failed: 0,
                review_ready: 0,
            },
            latest_activity_at: None,
        }
    }

    #[test]
    fn cli_parser_accepts_prompt_value_and_stdin_forms() {
        let args = [
            "argmax",
            "session",
            "launch",
            "--project",
            "Argmax",
            "--worktree",
            "--prompt",
            "Review this",
        ]
        .map(OsString::from);
        assert_eq!(
            parse_session_launch_cli(&args).unwrap(),
            SessionLaunchCliInput {
                project: Some("Argmax".to_string()),
                prompt: CliPrompt::Value("Review this".to_string()),
                worktree: true,
            }
        );

        let stdin_args = ["argmax", "session", "launch", "--prompt-stdin"].map(OsString::from);
        assert_eq!(
            parse_session_launch_cli(&stdin_args).unwrap(),
            SessionLaunchCliInput {
                project: None,
                prompt: CliPrompt::Stdin,
                worktree: false,
            }
        );
    }

    #[test]
    fn cli_parser_rejects_missing_duplicate_and_unknown_arguments() {
        for args in [
            vec!["argmax", "session", "launch"],
            vec![
                "argmax",
                "session",
                "launch",
                "--prompt",
                "one",
                "--prompt-stdin",
            ],
            vec!["argmax", "session", "launch", "--wat"],
        ] {
            let args = args.into_iter().map(OsString::from).collect::<Vec<_>>();
            assert!(parse_session_launch_cli(&args).is_err());
        }
    }

    #[test]
    fn title_uses_trimmed_first_line_and_unicode_character_cap() {
        assert_eq!(task_label("  Ship it  \nignore me"), "Ship it");
        assert_eq!(task_label("\nsecond line"), DEFAULT_TASK_LABEL);
        let long = "å".repeat(65);
        assert_eq!(task_label(&long), format!("{}...", "å".repeat(61)));
        assert_eq!(task_label(&long).chars().count(), 64);
        let multibyte = "😀".repeat(51);
        let label = task_label(&multibyte);
        assert_eq!(label, format!("{}...", "😀".repeat(49)));
        assert!(label.len() <= MAX_TASK_LABEL_BYTES);
        assert!(TaskLabel::try_from(label).is_ok());
    }

    #[test]
    fn resolver_uses_parent_id_then_exact_id_path_and_case_insensitive_name() {
        let projects = vec![
            project("one", "Argmax", "/tmp/argmax"),
            project("two", "Other", "/tmp/other"),
        ];
        assert_eq!(resolve_project(&projects, None, "two").unwrap().id, "two");
        assert_eq!(
            resolve_project(&projects, Some("one"), "two").unwrap().id,
            "one"
        );
        assert_eq!(
            resolve_project(&projects, Some("/tmp/other"), "one")
                .unwrap()
                .id,
            "two"
        );
        assert_eq!(
            resolve_project(&projects, Some("argmax"), "two")
                .unwrap()
                .id,
            "one"
        );
    }

    #[test]
    fn resolver_rejects_ambiguous_and_unknown_names() {
        let projects = vec![
            project("one", "Same", "/tmp/one"),
            project("two", "same", "/tmp/two"),
        ];
        assert_eq!(
            resolve_project(&projects, Some("SAME"), "one")
                .unwrap_err()
                .code,
            "PROJECT_SELECTOR_AMBIGUOUS"
        );
        assert_eq!(
            resolve_project(&projects, Some("missing"), "one")
                .unwrap_err()
                .code,
            "PROJECT_NOT_FOUND"
        );
    }

    #[test]
    fn request_rejects_unknown_fields_and_requires_newline() {
        let with_unknown = b"{\"version\":1,\"token\":\"x\",\"project\":null,\"prompt\":\"p\",\"worktree\":false,\"extra\":true}\n";
        assert_eq!(
            read_json_line::<SessionLaunchRequest>(&mut with_unknown.as_slice(), MAX_REQUEST_BYTES)
                .unwrap_err()
                .code,
            "REQUEST_INVALID"
        );
        let no_newline =
            br#"{"version":1,"token":"x","project":null,"prompt":"p","worktree":false}"#;
        assert_eq!(
            read_json_line::<SessionLaunchRequest>(&mut no_newline.as_slice(), MAX_REQUEST_BYTES)
                .unwrap_err()
                .code,
            "REQUEST_NOT_TERMINATED"
        );
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

    #[test]
    fn process_config_adds_env_and_hidden_instruction() {
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
        let prompt = config.prepend_instruction("Do the work");
        assert!(prompt.starts_with("Argmax session launching"));
        assert!(prompt.ends_with("\n\nDo the work"));
        assert!(prompt.contains("not a subagent"));
    }
}
