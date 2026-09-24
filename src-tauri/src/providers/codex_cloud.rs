use std::{collections::HashMap, path::PathBuf, process::Stdio, time::Duration};

use serde::Deserialize;
use tokio::{
    io::{AsyncRead, AsyncReadExt},
    process::Command,
};

use crate::{
    error::{ArgmaxError, ArgmaxResult},
    providers::{cloud::CloudEnvironment, environment::build_provider_environment, ProviderId},
};

const CODEX_ENVIRONMENTS_BASE_URL: &str =
    "https://chatgpt.com/backend-api/wham/environments/by-repo/github";
const REQUEST_TIMEOUT: Duration = Duration::from_secs(20);
const LAUNCH_TIMEOUT: Duration = Duration::from_secs(60);
const MAX_CLOUD_OUTPUT_BYTES: usize = 64 * 1024;

#[derive(Deserialize)]
struct CodexAuthFile {
    tokens: Option<CodexTokens>,
}

#[derive(Deserialize)]
struct CodexTokens {
    access_token: Option<String>,
    account_id: Option<String>,
}

#[derive(Deserialize)]
struct EnvironmentResponse {
    id: String,
    label: Option<String>,
}

pub async fn environments(repository: &str) -> ArgmaxResult<Vec<CloudEnvironment>> {
    let repository = repository.to_string();
    tauri::async_runtime::spawn_blocking(move || {
        environments_blocking(&repository, CODEX_ENVIRONMENTS_BASE_URL)
    })
    .await
    .map_err(|error| {
        ArgmaxError::service("CLOUD_CODEX_ENVIRONMENT_JOIN_FAILED", error.to_string())
    })?
}

fn environments_blocking(repository: &str, base_url: &str) -> ArgmaxResult<Vec<CloudEnvironment>> {
    let auth = read_auth_file()?;
    let tokens = auth.tokens.ok_or_else(codex_login_error)?;
    let access_token = tokens
        .access_token
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(codex_login_error)?;
    let account_id = tokens
        .account_id
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(codex_login_error)?;
    fetch_environments(repository, base_url, &access_token, &account_id)
}

fn fetch_environments(
    repository: &str,
    base_url: &str,
    access_token: &str,
    account_id: &str,
) -> ArgmaxResult<Vec<CloudEnvironment>> {
    let url = format!("{base_url}/{repository}");
    let response = ureq::AgentBuilder::new()
        .timeout(REQUEST_TIMEOUT)
        .redirects(0)
        .build()
        .get(&url)
        .set("Authorization", &format!("Bearer {access_token}"))
        .set("ChatGPT-Account-ID", account_id)
        .set("User-Agent", "argmax")
        .call()
        .map_err(codex_environment_request_error)?;
    let body = response.into_string().map_err(|_| {
        ArgmaxError::service(
            "CLOUD_CODEX_ENVIRONMENTS_INVALID",
            "Codex Cloud returned an unreadable environment list.",
        )
    })?;
    let environments: Vec<EnvironmentResponse> = serde_json::from_str(&body).map_err(|_| {
        ArgmaxError::service(
            "CLOUD_CODEX_ENVIRONMENTS_INVALID",
            "Codex Cloud returned an invalid environment list.",
        )
    })?;
    if environments
        .iter()
        .any(|environment| !valid_environment_id(&environment.id))
    {
        return Err(ArgmaxError::service(
            "CLOUD_CODEX_ENVIRONMENTS_INVALID",
            "Codex Cloud returned an invalid environment identifier.",
        ));
    }
    let environments = environments
        .into_iter()
        .map(|environment| CloudEnvironment {
            name: environment.label.unwrap_or_else(|| environment.id.clone()),
            id: environment.id,
        })
        .collect::<Vec<_>>();
    if environments.is_empty() {
        return Err(ArgmaxError::service(
            "CLOUD_CODEX_ENVIRONMENT_NOT_FOUND",
            format!("{repository} has no Codex Cloud environment. Create one in Codex Cloud settings, then try again."),
        ));
    }
    Ok(environments)
}

fn read_auth_file() -> ArgmaxResult<CodexAuthFile> {
    let environment = build_provider_environment(Vec::new())
        .into_iter()
        .collect::<HashMap<_, _>>();
    let codex_home = environment
        .get("CODEX_HOME")
        .map(PathBuf::from)
        .or_else(|| {
            environment
                .get("HOME")
                .map(|home| PathBuf::from(home).join(".codex"))
        })
        .ok_or_else(codex_login_error)?;
    let contents =
        std::fs::read_to_string(codex_home.join("auth.json")).map_err(|_| codex_login_error())?;
    serde_json::from_str(&contents).map_err(|_| codex_login_error())
}

fn codex_login_error() -> ArgmaxError {
    ArgmaxError::service(
        "CLOUD_CODEX_LOGIN_REQUIRED",
        "Argmax cannot read your Codex sign-in. Add `cli_auth_credentials_store = \"file\"` to ~/.codex/config.toml, run `codex login`, then try again.",
    )
}

fn codex_environment_request_error(error: ureq::Error) -> ArgmaxError {
    match error {
        ureq::Error::Status(401 | 403, _) => ArgmaxError::service(
            "CLOUD_CODEX_LOGIN_REQUIRED",
            "Your Codex sign-in expired. Run `codex login`, then try again.",
        ),
        ureq::Error::Status(404, _) => ArgmaxError::service(
            "CLOUD_CODEX_ENVIRONMENT_NOT_FOUND",
            "No Codex Cloud environment is connected to this repository.",
        ),
        ureq::Error::Status(status, _) => ArgmaxError::service(
            "CLOUD_CODEX_ENVIRONMENTS_FAILED",
            format!("Codex Cloud could not list environments (HTTP {status})."),
        ),
        ureq::Error::Transport(_) => ArgmaxError::service(
            "CLOUD_CODEX_ENVIRONMENTS_FAILED",
            "Could not reach Codex Cloud. Check your connection and try again.",
        ),
    }
}

pub async fn launch(
    binary_path: &str,
    checkout: &std::path::Path,
    branch: &str,
    environment_id: &str,
    brief: &str,
) -> ArgmaxResult<String> {
    if !valid_environment_id(environment_id) {
        return Err(ArgmaxError::service(
            "CLOUD_ENVIRONMENT_REQUIRED",
            "Choose a Codex Cloud environment before sending the task.",
        ));
    }
    let mut command = Command::new(binary_path);
    command
        .args([
            "cloud",
            "exec",
            "--env",
            environment_id,
            "--branch",
            branch,
            "--attempts",
            "1",
            "--",
            brief,
        ])
        .current_dir(checkout)
        .env_clear()
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    for (key, value) in build_provider_environment(Vec::new()) {
        command.env(key, value);
    }
    let mut child = command.spawn().map_err(|_| {
        ArgmaxError::service(
            "CLOUD_CODEX_LAUNCH_FAILED",
            "Codex Cloud could not be started. Check that Codex is installed and signed in.",
        )
    })?;
    let stdout = child.stdout.take().ok_or_else(|| {
        ArgmaxError::service(
            "CLOUD_CODEX_LAUNCH_FAILED",
            "Codex output could not be read.",
        )
    })?;
    let stderr = child.stderr.take().ok_or_else(|| {
        ArgmaxError::service(
            "CLOUD_CODEX_LAUNCH_FAILED",
            "Codex errors could not be read.",
        )
    })?;
    let completed = async move {
        let (stdout, stderr, status) =
            tokio::join!(read_bounded(stdout), read_bounded(stderr), child.wait());
        Ok::<_, std::io::Error>((stdout?, stderr?, status?))
    };
    let (stdout, stderr, status) = tokio::time::timeout(LAUNCH_TIMEOUT, completed)
        .await
        .map_err(|_| delivery_unknown("Codex Cloud did not return a task link within 60 seconds."))?
        .map_err(|_| {
            ArgmaxError::service(
                "CLOUD_CODEX_LAUNCH_FAILED",
                "Codex Cloud could not be started. Check that Codex is installed and signed in.",
            )
        })?;
    let stdout = String::from_utf8_lossy(&stdout);
    let stderr = String::from_utf8_lossy(&stderr);
    if let Some(url) = task_url(&format!("{stdout}\n{stderr}")) {
        return Ok(url);
    }
    let detail = stderr
        .lines()
        .chain(stdout.lines())
        .rev()
        .find(|line| !line.trim().is_empty())
        .map(safe_output_detail);
    // A non-zero exit without a link is Codex refusing the request (sign-in,
    // environment, arguments) before creating anything. Only a clean exit
    // that printed no link leaves the outcome unknown.
    if !status.success() {
        let exit = status
            .code()
            .map(|code| format!("exit code {code}"))
            .unwrap_or_else(|| "a signal".to_string());
        let detail = detail
            .map(|detail| format!(": {detail}"))
            .unwrap_or_default();
        return Err(ArgmaxError::service(
            "CLOUD_CODEX_LAUNCH_FAILED",
            format!("Codex Cloud did not create the task ({exit}){detail}"),
        ));
    }
    Err(delivery_unknown(
        detail
            .as_deref()
            .unwrap_or("Codex exited without returning a task link."),
    ))
}

async fn read_bounded(mut reader: impl AsyncRead + Unpin) -> std::io::Result<Vec<u8>> {
    let mut retained = Vec::new();
    let mut chunk = [0_u8; 4096];
    loop {
        let read = reader.read(&mut chunk).await?;
        if read == 0 {
            break;
        }
        if retained.len() < MAX_CLOUD_OUTPUT_BYTES {
            let keep = read.min(MAX_CLOUD_OUTPUT_BYTES - retained.len());
            retained.extend_from_slice(&chunk[..keep]);
        }
    }
    Ok(retained)
}

fn delivery_unknown(detail: &str) -> ArgmaxError {
    ArgmaxError::service(
        "CLOUD_LAUNCH_DELIVERY_UNKNOWN",
        format!("{detail} Codex Cloud may have created the task, so Argmax will not retry it. Check chatgpt.com/codex before sending it again."),
    )
}

fn safe_output_detail(value: &str) -> String {
    value.chars().take(300).collect()
}

fn task_url(output: &str) -> Option<String> {
    output.split_whitespace().find_map(|word| {
        let url = word.trim_matches(|character: char| {
            matches!(character, ')' | ']' | '}' | ',' | '"' | '\'')
        });
        let id = url.strip_prefix("https://chatgpt.com/codex/tasks/")?;
        valid_task_id(id).then(|| format!("https://chatgpt.com/codex/tasks/{id}"))
    })
}

fn valid_environment_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '_' | '-'))
}

fn valid_task_id(value: &str) -> bool {
    value.starts_with("task_")
        && value.len() > 5
        && value
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || character == '_')
}

pub async fn binary_path(discovery: &super::discovery::ProviderDiscovery) -> ArgmaxResult<String> {
    discovery
        .discover(ProviderId::Codex)
        .await
        .binary_path
        .ok_or_else(|| ArgmaxError::service("CLOUD_CODEX_NOT_INSTALLED", "Codex is not installed."))
}

pub fn environment_is_current(environments: &[CloudEnvironment], environment_id: &str) -> bool {
    environments
        .iter()
        .any(|environment| environment.id == environment_id)
}

#[cfg(test)]
mod tests {
    use std::{
        io::{Read, Write},
        net::TcpListener,
    };

    use super::*;

    #[test]
    fn parses_only_codex_task_links() {
        assert_eq!(
            task_url("Created https://chatgpt.com/codex/tasks/task_e_0123\n"),
            Some("https://chatgpt.com/codex/tasks/task_e_0123".to_string())
        );
        assert_eq!(task_url("https://evil.test/codex/tasks/task_e_0123"), None);
        assert_eq!(task_url("https://chatgpt.com/codex/tasks/not-a-task"), None);
    }

    #[test]
    fn environment_request_uses_codex_auth_and_rejects_malformed_ids() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind fake Codex API");
        let address = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = [0_u8; 4096];
            let read = stream.read(&mut request).unwrap();
            let request = String::from_utf8_lossy(&request[..read]);
            assert!(
                request.starts_with("GET /owner/repository HTTP/1.1"),
                "{request}"
            );
            assert!(
                request
                    .to_ascii_lowercase()
                    .contains("authorization: bearer test-token"),
                "{request}"
            );
            assert!(
                request
                    .to_ascii_lowercase()
                    .contains("chatgpt-account-id: account-test"),
                "{request}"
            );
            let body = r#"[{"id":"env_test123","label":"owner/repository"}]"#;
            write!(
                stream,
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                body.len(), body
            )
            .unwrap();
        });

        let environments = fetch_environments(
            "owner/repository",
            &format!("http://{address}"),
            "test-token",
            "account-test",
        )
        .expect("fetch environments");
        server.join().unwrap();
        assert_eq!(
            environments,
            vec![CloudEnvironment {
                id: "env_test123".to_string(),
                name: "owner/repository".to_string(),
            }]
        );

        let listener = TcpListener::bind("127.0.0.1:0").expect("bind malformed API");
        let address = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = [0_u8; 1024];
            let _ = stream.read(&mut request);
            let body = r#"[{"id":"bad id","label":"Bad"}]"#;
            write!(
                stream,
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                body.len(),
                body
            )
            .unwrap();
        });
        let error = fetch_environments(
            "owner/repository",
            &format!("http://{address}"),
            "test-token",
            "account-test",
        )
        .expect_err("malformed identifier");
        server.join().unwrap();
        assert!(
            matches!(error, ArgmaxError::ServiceError { sub_code, .. } if sub_code == "CLOUD_CODEX_ENVIRONMENTS_INVALID")
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn launch_passes_environment_branch_and_prompt_as_distinct_arguments() {
        use std::os::unix::fs::PermissionsExt;

        let directory = tempfile::tempdir().expect("temporary fake Codex directory");
        let binary = directory.path().join("codex");
        let log = directory.path().join("invocation.log");
        std::fs::write(
            &binary,
            format!(
                "#!/bin/sh\nprintf '%s\\n' \"$@\" > '{}'\nprintf 'https://chatgpt.com/codex/tasks/task_e_fake123\\n'\n",
                log.display()
            ),
        )
        .expect("write fake Codex");
        let mut permissions = std::fs::metadata(&binary).unwrap().permissions();
        permissions.set_mode(0o700);
        std::fs::set_permissions(&binary, permissions).unwrap();

        let url = launch(
            binary.to_str().unwrap(),
            directory.path(),
            "main",
            "env_test123",
            "--help\nInspect this repository.",
        )
        .await
        .expect("launch");
        assert_eq!(url, "https://chatgpt.com/codex/tasks/task_e_fake123");
        let args = std::fs::read_to_string(log).unwrap();
        assert!(args.contains("cloud\nexec\n--env\nenv_test123"), "{args}");
        assert!(
            args.contains("--branch\nmain\n--attempts\n1\n--\n--help\nInspect this repository."),
            "{args}"
        );
    }
}
