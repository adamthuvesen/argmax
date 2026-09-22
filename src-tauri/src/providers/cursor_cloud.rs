use std::{
    collections::{HashMap, HashSet},
    os::unix::fs::MetadataExt,
    path::Path,
    sync::{Mutex, OnceLock},
    time::{Duration, Instant},
};

use reqwest::{redirect::Policy, StatusCode, Url};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::{
    error::{ArgmaxError, ArgmaxResult},
    providers::{
        cloud::{CheckoutSnapshot, CloudEnvironment},
        environment::build_provider_environment,
    },
};

const CURSOR_API_BASE_URL: &str = "https://api.cursor.com/v1";
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const PREPARE_TIMEOUT: Duration = Duration::from_secs(45);
const LAUNCH_TIMEOUT: Duration = Duration::from_secs(30);
const MAX_RESPONSE_BYTES: u64 = 4 * 1024 * 1024;
const CURSOR_ENVIRONMENT_ID: &str = "cursor-cloud";
const REPOSITORY_ACCESS_CACHE_TTL: Duration = Duration::from_secs(60);

#[derive(Debug)]
struct RepositoryAccessCacheEntry {
    repositories: HashSet<String>,
    checked_at: Instant,
}

static REPOSITORY_ACCESS_CACHE: OnceLock<Mutex<HashMap<[u8; 32], RepositoryAccessCacheEntry>>> =
    OnceLock::new();

#[derive(Debug, Deserialize)]
struct RepositoriesResponse {
    items: Vec<Repository>,
}

#[derive(Debug, Deserialize)]
struct Repository {
    url: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CreateAgentRequest<'a> {
    prompt: Prompt<'a>,
    repos: [RepositoryRequest<'a>; 1],
    work_on_current_branch: bool,
    #[serde(rename = "autoCreatePR")]
    auto_create_pr: bool,
}

#[derive(Debug, Serialize)]
struct Prompt<'a> {
    text: &'a str,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct RepositoryRequest<'a> {
    url: &'a str,
    starting_ref: &'a str,
}

#[derive(Debug, Deserialize)]
struct CreateAgentResponse {
    agent: CreatedAgent,
}

#[derive(Debug, Deserialize)]
struct CreatedAgent {
    id: String,
    url: String,
}

#[derive(Debug, Deserialize)]
struct SecretCache {
    version: u32,
    secrets: HashMap<String, String>,
}

#[derive(Debug, Deserialize)]
struct CursorErrorResponse {
    message: Option<String>,
    error: Option<CursorErrorValue>,
}

#[derive(Debug, Deserialize)]
#[serde(untagged)]
enum CursorErrorValue {
    Message(String),
    Object { message: Option<String> },
}

pub async fn environments(repository: &str) -> ArgmaxResult<Vec<CloudEnvironment>> {
    let api_key = cursor_api_key()?;
    environments_with_base(repository, CURSOR_API_BASE_URL, &api_key).await
}

pub async fn launch(snapshot: &CheckoutSnapshot, brief: &str) -> ArgmaxResult<String> {
    let api_key = cursor_api_key()?;
    launch_with_base(snapshot, brief, CURSOR_API_BASE_URL, &api_key).await
}

async fn environments_with_base(
    repository: &str,
    base_url: &str,
    api_key: &str,
) -> ArgmaxResult<Vec<CloudEnvironment>> {
    let client = http_client(PREPARE_TIMEOUT)?;
    let me_url = endpoint(base_url, "me")?;
    let repositories_url = endpoint(base_url, "repositories")?;

    let me_response = client
        .get(me_url)
        .basic_auth(api_key, Some(""))
        .send()
        .await
        .map_err(cursor_prepare_transport_error)?;
    ensure_prepare_success(me_response.status())?;

    let credential_hash = credential_hash(api_key);
    // GitHub owner and repository names are case-insensitive, and the origin
    // URL's casing need not match what Cursor lists.
    let expected_url = format!("https://github.com/{repository}").to_ascii_lowercase();
    if let Some(has_access) = cached_repository_access(credential_hash, &expected_url) {
        return if has_access {
            Ok(cursor_environment())
        } else {
            Err(repository_not_found_error(repository))
        };
    }

    let repositories_response = client
        .get(repositories_url)
        .basic_auth(api_key, Some(""))
        .send()
        .await
        .map_err(cursor_prepare_transport_error)?;
    ensure_prepare_success(repositories_response.status())?;
    let repositories = response_json::<RepositoriesResponse>(
        repositories_response,
        "CLOUD_CURSOR_REPOSITORIES_INVALID",
        "Cursor Cloud returned an invalid repository list.",
    )
    .await?;

    let repositories = repositories
        .items
        .into_iter()
        .filter_map(|item| canonical_repository_url(&item.url))
        .collect::<HashSet<_>>();
    let has_access = repositories.contains(&expected_url);
    remember_repository_access(credential_hash, repositories);
    if !has_access {
        return Err(repository_not_found_error(repository));
    }

    Ok(cursor_environment())
}

fn cursor_environment() -> Vec<CloudEnvironment> {
    vec![CloudEnvironment {
        id: CURSOR_ENVIRONMENT_ID.to_string(),
        name: "Managed by Cursor Cloud".to_string(),
    }]
}

async fn launch_with_base(
    snapshot: &CheckoutSnapshot,
    brief: &str,
    base_url: &str,
    api_key: &str,
) -> ArgmaxResult<String> {
    let client = http_client(LAUNCH_TIMEOUT)?;
    let agents_url = endpoint(base_url, "agents")?;
    let repository_url = format!("https://github.com/{}", snapshot.repository);
    let request = CreateAgentRequest {
        prompt: Prompt { text: brief },
        repos: [RepositoryRequest {
            url: &repository_url,
            starting_ref: &snapshot.commit,
        }],
        work_on_current_branch: false,
        auto_create_pr: false,
    };

    let response = client
        .post(agents_url)
        .basic_auth(api_key, Some(""))
        .json(&request)
        .send()
        .await
        .map_err(cursor_launch_transport_error)?;
    let status = response.status();
    if status == StatusCode::UNAUTHORIZED || status == StatusCode::FORBIDDEN {
        return Err(cursor_login_error());
    }
    if status == StatusCode::TOO_MANY_REQUESTS {
        return Err(ArgmaxError::service(
            "CLOUD_CURSOR_RATE_LIMITED",
            "Cursor Cloud is rate-limiting launches. Wait a minute, then try again.",
        ));
    }
    if status.is_server_error() {
        return Err(delivery_unknown_error(format!(
            "Cursor Cloud returned HTTP {} after receiving the launch request.",
            status.as_u16()
        )));
    }
    if !status.is_success() {
        let detail = cursor_error_detail(response).await;
        let detail = detail
            .as_deref()
            .map(|message| format!(" {message}"))
            .unwrap_or_default();
        return Err(ArgmaxError::service(
            "CLOUD_CURSOR_LAUNCH_REJECTED",
            format!(
                "Cursor Cloud rejected the task (HTTP {}).{detail} Check the repository's Cloud Agent setup and try again.",
                status.as_u16(),
            ),
        ));
    }

    let created = response_json::<CreateAgentResponse>(
        response,
        "CLOUD_LAUNCH_DELIVERY_UNKNOWN",
        "Cursor Cloud accepted the task but returned an unreadable response. It may have created the task, so Argmax will not retry it. Check cursor.com/agents before sending it again.",
    )
    .await?;
    validate_agent_url(&created.agent.url, &created.agent.id)
}

fn cursor_api_key() -> ArgmaxResult<String> {
    let mut environment = build_provider_environment(Vec::new())
        .into_iter()
        .collect::<HashMap<_, _>>();
    if let Some(api_key) = environment
        .remove("CURSOR_API_KEY")
        .filter(|value| !value.trim().is_empty())
    {
        return Ok(api_key);
    }
    let home = environment
        .remove("HOME")
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(cursor_login_error)?;
    cursor_api_key_from_cache(Path::new(&home)).map_err(|_| cursor_login_error())
}

fn cursor_api_key_from_cache(home: &Path) -> Result<String, ()> {
    let path = home
        .join(".local")
        .join("share")
        .join("dotfiles")
        .join("agent-secrets.json");
    let metadata = std::fs::symlink_metadata(&path).map_err(|_| ())?;
    let home_metadata = std::fs::symlink_metadata(home).map_err(|_| ())?;
    if !metadata.file_type().is_file()
        || metadata.file_type().is_symlink()
        || metadata.uid() != home_metadata.uid()
        || metadata.mode() & 0o777 != 0o600
    {
        return Err(());
    }
    let cache: SecretCache =
        serde_json::from_slice(&std::fs::read(path).map_err(|_| ())?).map_err(|_| ())?;
    if cache.version != 1 {
        return Err(());
    }
    cache
        .secrets
        .get("CURSOR_API_KEY")
        .filter(|value| !value.trim().is_empty())
        .cloned()
        .ok_or(())
}

fn http_client(timeout: Duration) -> ArgmaxResult<reqwest::Client> {
    let _ = rustls::crypto::ring::default_provider().install_default();
    reqwest::Client::builder()
        .connect_timeout(CONNECT_TIMEOUT)
        .timeout(timeout)
        .redirect(Policy::none())
        .retry(reqwest::retry::never())
        .user_agent("argmax")
        .build()
        .map_err(|error| {
            ArgmaxError::service(
                "CLOUD_CURSOR_HTTP_FAILED",
                format!("Could not configure Cursor Cloud requests: {error}"),
            )
        })
}

fn endpoint(base_url: &str, path: &str) -> ArgmaxResult<Url> {
    let value = format!(
        "{}/{}",
        base_url.trim_end_matches('/'),
        path.trim_matches('/')
    );
    Url::parse(&value).map_err(|_| {
        ArgmaxError::service(
            "CLOUD_CURSOR_HTTP_FAILED",
            "Cursor Cloud's API endpoint is invalid.",
        )
    })
}

fn credential_hash(api_key: &str) -> [u8; 32] {
    let mut digest = Sha256::new();
    digest.update(api_key.as_bytes());
    digest.finalize().into()
}

fn cached_repository_access(credential_hash: [u8; 32], repository_url: &str) -> Option<bool> {
    let cache = REPOSITORY_ACCESS_CACHE
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    cache.get(&credential_hash).and_then(|entry| {
        (entry.checked_at.elapsed() < REPOSITORY_ACCESS_CACHE_TTL)
            .then(|| entry.repositories.contains(repository_url))
    })
}

fn remember_repository_access(credential_hash: [u8; 32], repositories: HashSet<String>) {
    let mut cache = REPOSITORY_ACCESS_CACHE
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    cache.retain(|_, entry| entry.checked_at.elapsed() < REPOSITORY_ACCESS_CACHE_TTL);
    cache.insert(
        credential_hash,
        RepositoryAccessCacheEntry {
            repositories,
            checked_at: Instant::now(),
        },
    );
}

fn repository_not_found_error(repository: &str) -> ArgmaxError {
    ArgmaxError::service(
        "CLOUD_CURSOR_REPOSITORY_NOT_FOUND",
        format!(
            "Cursor Cloud cannot see {repository}. Connect it in Cursor's Cloud Agents settings, then try again."
        ),
    )
}

fn ensure_prepare_success(status: StatusCode) -> ArgmaxResult<()> {
    if status.is_success() {
        return Ok(());
    }
    match status {
        StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN => Err(cursor_login_error()),
        StatusCode::TOO_MANY_REQUESTS => Err(ArgmaxError::service(
            "CLOUD_CURSOR_RATE_LIMITED",
            "Cursor Cloud is rate-limiting repository checks. Wait a minute, then try again.",
        )),
        _ => Err(ArgmaxError::service(
            "CLOUD_CURSOR_PREPARE_FAILED",
            format!(
                "Cursor Cloud could not verify this setup (HTTP {}).",
                status.as_u16()
            ),
        )),
    }
}

fn cursor_prepare_transport_error(error: reqwest::Error) -> ArgmaxError {
    let message = if error.is_timeout() {
        "Cursor Cloud did not finish checking repository access within 45 seconds."
    } else {
        "Could not reach Cursor Cloud. Check your connection and try again."
    };
    ArgmaxError::service("CLOUD_CURSOR_PREPARE_FAILED", message)
}

fn cursor_launch_transport_error(error: reqwest::Error) -> ArgmaxError {
    let detail = if error.is_timeout() {
        "Cursor Cloud did not answer the launch request within 30 seconds."
    } else {
        "The Cursor Cloud launch request ended before its response was received."
    };
    delivery_unknown_error(detail)
}

fn cursor_login_error() -> ArgmaxError {
    ArgmaxError::service(
        "CLOUD_CURSOR_LOGIN_REQUIRED",
        "Cursor Cloud credentials are unavailable or invalid. Set CURSOR_API_KEY in your shell profile, then restart Argmax.",
    )
}

fn delivery_unknown_error(detail: impl AsRef<str>) -> ArgmaxError {
    ArgmaxError::service(
        "CLOUD_LAUNCH_DELIVERY_UNKNOWN",
        format!(
            "{} Cursor Cloud may have created the task, so Argmax will not retry it. Check cursor.com/agents before sending it again.",
            detail.as_ref()
        ),
    )
}

async fn response_json<T: for<'de> Deserialize<'de>>(
    response: reqwest::Response,
    code: &'static str,
    message: &'static str,
) -> ArgmaxResult<T> {
    if response
        .content_length()
        .is_some_and(|length| length > MAX_RESPONSE_BYTES)
    {
        return Err(ArgmaxError::service(code, message));
    }
    let body = response
        .bytes()
        .await
        .map_err(|_| ArgmaxError::service(code, message))?;
    if body.len() as u64 > MAX_RESPONSE_BYTES {
        return Err(ArgmaxError::service(code, message));
    }
    serde_json::from_slice(&body).map_err(|_| ArgmaxError::service(code, message))
}

async fn cursor_error_detail(response: reqwest::Response) -> Option<String> {
    if response
        .content_length()
        .is_some_and(|length| length > MAX_RESPONSE_BYTES)
    {
        return None;
    }
    let body = response.bytes().await.ok()?;
    if body.len() as u64 > MAX_RESPONSE_BYTES {
        return None;
    }
    let error: CursorErrorResponse = serde_json::from_slice(&body).ok()?;
    let message = error.message.or(match error.error {
        Some(CursorErrorValue::Message(message)) => Some(message),
        Some(CursorErrorValue::Object { message }) => message,
        None => None,
    })?;
    let message = message
        .chars()
        .filter(|character| !character.is_control())
        .take(300)
        .collect::<String>();
    (!message.trim().is_empty()).then(|| message.trim().to_string())
}

fn canonical_repository_url(value: &str) -> Option<String> {
    let url = Url::parse(value).ok()?;
    if url.scheme() != "https"
        || url.host_str() != Some("github.com")
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return None;
    }
    let path = url
        .path()
        .trim_matches('/')
        .strip_suffix(".git")
        .unwrap_or_else(|| url.path().trim_matches('/'));
    let mut parts = path.split('/');
    let owner = parts.next()?;
    let repository = parts.next()?;
    if owner.is_empty() || repository.is_empty() || parts.next().is_some() {
        return None;
    }
    Some(format!("https://github.com/{owner}/{repository}").to_ascii_lowercase())
}

fn validate_agent_url(value: &str, agent_id: &str) -> ArgmaxResult<String> {
    let url = Url::parse(value).map_err(|_| invalid_agent_url_error())?;
    let expected_path = format!("/agents/{agent_id}");
    if url.scheme() != "https"
        || url.host_str() != Some("cursor.com")
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || url.path().trim_end_matches('/') != expected_path
    {
        return Err(invalid_agent_url_error());
    }
    Ok(url.to_string())
}

fn invalid_agent_url_error() -> ArgmaxError {
    delivery_unknown_error("Cursor Cloud accepted the task but returned an invalid task link.")
}

#[cfg(test)]
mod tests {
    use std::{
        collections::VecDeque, fs::Permissions, os::unix::fs::PermissionsExt, path::PathBuf,
        sync::Arc,
    };

    use base64::{engine::general_purpose::STANDARD, Engine};
    use serde_json::Value;
    use tokio::{
        io::{AsyncReadExt, AsyncWriteExt},
        net::TcpListener,
        sync::Mutex,
    };

    use super::*;

    #[derive(Debug)]
    struct CapturedRequest {
        request_line: String,
        headers: HashMap<String, String>,
        body: Vec<u8>,
    }

    async fn fake_server(
        responses: Vec<String>,
    ) -> (
        String,
        Arc<Mutex<Vec<CapturedRequest>>>,
        tokio::task::JoinHandle<()>,
    ) {
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind fake server");
        let address = listener.local_addr().expect("fake server address");
        let captured = Arc::new(Mutex::new(Vec::new()));
        let server_captured = Arc::clone(&captured);
        let mut responses = VecDeque::from(responses);
        let handle = tokio::spawn(async move {
            while let Some(response) = responses.pop_front() {
                let (mut stream, _) = listener.accept().await.expect("accept request");
                let mut bytes = Vec::new();
                let mut buffer = [0_u8; 4096];
                let header_end = loop {
                    let read = stream.read(&mut buffer).await.expect("read request");
                    assert!(read > 0, "connection closed before headers");
                    bytes.extend_from_slice(&buffer[..read]);
                    if let Some(index) = bytes.windows(4).position(|part| part == b"\r\n\r\n") {
                        break index + 4;
                    }
                };
                let headers_text = String::from_utf8(bytes[..header_end].to_vec())
                    .expect("request headers are UTF-8");
                let mut lines = headers_text.split("\r\n");
                let request_line = lines.next().expect("request line").to_string();
                let headers = lines
                    .filter_map(|line| line.split_once(':'))
                    .map(|(name, value)| (name.to_ascii_lowercase(), value.trim().to_string()))
                    .collect::<HashMap<_, _>>();
                let content_length = headers
                    .get("content-length")
                    .and_then(|value| value.parse::<usize>().ok())
                    .unwrap_or(0);
                while bytes.len() - header_end < content_length {
                    let read = stream.read(&mut buffer).await.expect("read request body");
                    assert!(read > 0, "connection closed before body");
                    bytes.extend_from_slice(&buffer[..read]);
                }
                server_captured.lock().await.push(CapturedRequest {
                    request_line,
                    headers,
                    body: bytes[header_end..header_end + content_length].to_vec(),
                });
                stream
                    .write_all(response.as_bytes())
                    .await
                    .expect("write fake response");
            }
        });
        (format!("http://{address}/v1/"), captured, handle)
    }

    fn response(status: &str, body: &str) -> String {
        format!(
            "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        )
    }

    fn snapshot() -> CheckoutSnapshot {
        CheckoutSnapshot {
            path: PathBuf::from("/tmp/repository"),
            repository: "example/private-sandbox".to_string(),
            origin_url: "git@github.com:example/private-sandbox.git".to_string(),
            branch: "main".to_string(),
            commit: "0123456789abcdef0123456789abcdef01234567".to_string(),
        }
    }

    #[tokio::test]
    async fn prepare_checks_auth_and_repository_access_with_basic_auth() {
        let me = response("200 OK", r#"{"apiKeyName":"Argmax"}"#);
        let repositories = response(
            "200 OK",
            r#"{"items":[{"url":"https://github.com/example/private-sandbox.git"}]}"#,
        );
        let (base_url, captured, server) = fake_server(vec![me, repositories]).await;

        let result = environments_with_base("example/private-sandbox", &base_url, "cursor-secret")
            .await
            .expect("prepare cursor cloud");
        server.await.expect("fake server task");

        assert_eq!(
            result,
            vec![CloudEnvironment {
                id: "cursor-cloud".to_string(),
                name: "Managed by Cursor Cloud".to_string(),
            }]
        );
        let requests = captured.lock().await;
        assert_eq!(requests[0].request_line, "GET /v1/me HTTP/1.1");
        assert_eq!(requests[1].request_line, "GET /v1/repositories HTTP/1.1");
        let expected_auth = format!("Basic {}", STANDARD.encode("cursor-secret:"));
        assert_eq!(
            requests[0].headers.get("authorization"),
            Some(&expected_auth)
        );
        assert_eq!(
            requests[1].headers.get("authorization"),
            Some(&expected_auth)
        );
    }

    #[tokio::test]
    async fn prepare_rejects_missing_repository_access() {
        let me = response("200 OK", "{}");
        let repositories = response(
            "200 OK",
            r#"{"items":[{"url":"https://github.com/other/repository"}]}"#,
        );
        let (base_url, _, server) = fake_server(vec![me, repositories]).await;

        let error = environments_with_base(
            "example/private-sandbox",
            &base_url,
            "cursor-secret-without-access",
        )
        .await
        .expect_err("repository must be visible");
        server.await.expect("fake server task");

        assert!(matches!(
            error,
            ArgmaxError::ServiceError { sub_code, .. }
                if sub_code == "CLOUD_CURSOR_REPOSITORY_NOT_FOUND"
        ));
    }

    #[tokio::test]
    async fn prepare_reuses_the_repository_list_across_projects_for_one_credential() {
        let me = response("200 OK", "{}");
        let repositories = response(
            "200 OK",
            r#"{"items":[{"url":"https://github.com/example/first"},{"url":"https://github.com/example/second"}]}"#,
        );
        let second_me = response("200 OK", "{}");
        let (base_url, captured, server) = fake_server(vec![me, repositories, second_me]).await;

        environments_with_base("example/first", &base_url, "cursor-cache-key")
            .await
            .expect("prepare first repository");
        environments_with_base("example/second", &base_url, "cursor-cache-key")
            .await
            .expect("prepare second repository");
        server.await.expect("fake server task");

        let requests = captured.lock().await;
        assert_eq!(
            requests
                .iter()
                .filter(|request| request.request_line.contains("/repositories"))
                .count(),
            1
        );
    }

    #[tokio::test]
    async fn launch_sends_pinned_commit_without_pr_or_branch_mutation() {
        let launch_response = response(
            "200 OK",
            r#"{"agent":{"id":"bc-123","url":"https://cursor.com/agents/bc-123"},"run":{"id":"run-123"}}"#,
        );
        let (base_url, captured, server) = fake_server(vec![launch_response]).await;

        let url = launch_with_base(
            &snapshot(),
            "Inspect the repository.",
            &base_url,
            "cursor-secret",
        )
        .await
        .expect("launch cursor cloud");
        server.await.expect("fake server task");

        assert_eq!(url, "https://cursor.com/agents/bc-123");
        let requests = captured.lock().await;
        assert_eq!(requests[0].request_line, "POST /v1/agents HTTP/1.1");
        let body: Value = serde_json::from_slice(&requests[0].body).expect("request JSON");
        assert_eq!(body["prompt"]["text"], "Inspect the repository.");
        assert_eq!(
            body["repos"][0]["url"],
            "https://github.com/example/private-sandbox"
        );
        assert_eq!(
            body["repos"][0]["startingRef"],
            "0123456789abcdef0123456789abcdef01234567"
        );
        assert_eq!(body["workOnCurrentBranch"], false);
        assert_eq!(body["autoCreatePR"], false);
        assert!(body.get("model").is_none());
    }

    #[tokio::test]
    async fn launch_treats_invalid_success_response_as_delivery_unknown() {
        let launch_response = response(
            "200 OK",
            r#"{"agent":{"id":"bc-123","url":"https://example.com/agents/bc-123"}}"#,
        );
        let (base_url, _, server) = fake_server(vec![launch_response]).await;

        let error = launch_with_base(
            &snapshot(),
            "Inspect the repository.",
            &base_url,
            "cursor-secret",
        )
        .await
        .expect_err("foreign URL must be rejected");
        server.await.expect("fake server task");

        assert!(matches!(
            error,
            ArgmaxError::ServiceError { sub_code, .. }
                if sub_code == "CLOUD_LAUNCH_DELIVERY_UNKNOWN"
        ));
    }

    #[tokio::test]
    async fn rejected_launch_surfaces_only_the_bounded_api_message() {
        let launch_response = response(
            "400 Bad Request",
            r#"{"error":{"message":"Repository is not configured for Cloud Agents."},"debug":"ignored"}"#,
        );
        let (base_url, _, server) = fake_server(vec![launch_response]).await;

        let error = launch_with_base(
            &snapshot(),
            "Inspect the repository.",
            &base_url,
            "cursor-secret",
        )
        .await
        .expect_err("launch must be rejected");
        server.await.expect("fake server task");

        match error {
            ArgmaxError::ServiceError { sub_code, message } => {
                assert_eq!(sub_code, "CLOUD_CURSOR_LAUNCH_REJECTED");
                assert!(message.contains("Repository is not configured for Cloud Agents."));
                assert!(!message.contains("debug"));
            }
            other => panic!("unexpected error: {other:?}"),
        }
    }

    #[tokio::test]
    async fn redirects_are_not_followed() {
        let redirect = "HTTP/1.1 302 Found\r\nLocation: https://example.com/steal\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";
        let (base_url, captured, server) = fake_server(vec![redirect.to_string()]).await;

        let error = environments_with_base("example/private-sandbox", &base_url, "cursor-secret")
            .await
            .expect_err("redirect must be rejected");
        server.await.expect("fake server task");

        assert!(matches!(
            error,
            ArgmaxError::ServiceError { sub_code, .. }
                if sub_code == "CLOUD_CURSOR_PREPARE_FAILED"
        ));
        assert_eq!(captured.lock().await.len(), 1);
    }

    #[test]
    fn secret_cache_fallback_requires_a_regular_owned_mode_0600_file() {
        let home = tempfile::tempdir().expect("temporary home");
        let cache_dir = home.path().join(".local/share/dotfiles");
        std::fs::create_dir_all(&cache_dir).expect("create cache directory");
        let cache_path = cache_dir.join("agent-secrets.json");
        std::fs::write(
            &cache_path,
            r#"{"version":1,"secrets":{"CURSOR_API_KEY":"cached-secret","OTHER":"ignored"}}"#,
        )
        .expect("write secret cache");
        std::fs::set_permissions(&cache_path, Permissions::from_mode(0o600))
            .expect("set secure permissions");

        assert_eq!(
            cursor_api_key_from_cache(home.path()).as_deref(),
            Ok("cached-secret")
        );

        std::fs::set_permissions(&cache_path, Permissions::from_mode(0o644))
            .expect("set insecure permissions");
        assert_eq!(cursor_api_key_from_cache(home.path()), Err(()));
    }
}
