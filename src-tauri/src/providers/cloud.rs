use std::{
    path::{Path, PathBuf},
    time::Duration,
};

use tokio::process::Command;

use serde::{Deserialize, Serialize};
use specta::Type;

use crate::{
    error::{ArgmaxError, ArgmaxResult},
    persistence::events::PersistTimelineEventInput,
};

const GIT_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CloudEnvironment {
    pub id: String,
    pub name: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CheckoutSnapshot {
    pub path: PathBuf,
    pub repository: String,
    pub origin_url: String,
    pub branch: String,
    pub commit: String,
}

pub async fn validate_checkout(path: PathBuf) -> ArgmaxResult<CheckoutSnapshot> {
    let (branch, commit, origin_url) = tokio::try_join!(
        git_stdout(&path, &["symbolic-ref", "--quiet", "--short", "HEAD"]),
        git_stdout(&path, &["rev-parse", "--verify", "HEAD"]),
        git_stdout(&path, &["remote", "get-url", "origin"]),
    )?;

    let branch = required_git_value(
        branch,
        "CLOUD_DETACHED_HEAD",
        "The checkout must be on a branch before it can be sent to a cloud agent.",
    )?;
    let commit = required_git_value(
        commit,
        "CLOUD_GIT_HEAD_MISSING",
        "The checkout has no commit to send to a cloud agent.",
    )?;
    let origin_url = required_git_value(
        origin_url,
        "CLOUD_GITHUB_ORIGIN_REQUIRED",
        "The checkout needs a GitHub origin before it can be sent to a cloud agent.",
    )?;
    let repository = parse_github_repository(&origin_url).ok_or_else(|| {
        ArgmaxError::service(
            "CLOUD_GITHUB_ORIGIN_REQUIRED",
            "Cloud tasks currently require a github.com origin.",
        )
    })?;

    let remote_ref = format!("refs/heads/{branch}");
    let remote = git_stdout(
        &path,
        &[
            "-c",
            "protocol.ext.allow=never",
            "ls-remote",
            "--exit-code",
            origin_url.as_str(),
            remote_ref.as_str(),
        ],
    )
    .await
    .map_err(|error| match error {
        ArgmaxError::ServiceError { message, .. } => ArgmaxError::service(
            "CLOUD_REMOTE_REF_UNAVAILABLE",
            format!("Could not verify origin/{branch}: {message}"),
        ),
        other => other,
    })?;
    let remote_commit = parse_ls_remote_commit(&remote).ok_or_else(|| {
        ArgmaxError::service(
            "CLOUD_REMOTE_REF_UNAVAILABLE",
            format!(
                "origin does not have branch {branch}. Push it before sending this cloud task."
            ),
        )
    })?;
    if remote_commit != commit {
        return Err(ArgmaxError::service(
            "CLOUD_UNPUSHED_COMMIT",
            format!(
                "The local HEAD ({}) does not match origin/{branch} ({}). Push the branch before sending this cloud task.",
                short_sha(&commit),
                short_sha(remote_commit)
            ),
        ));
    }

    Ok(CheckoutSnapshot {
        path,
        repository,
        origin_url,
        branch,
        commit,
    })
}

pub fn handoff_brief(connection: &rusqlite::Connection, session_id: &str) -> ArgmaxResult<String> {
    super::follow_up::compose_follow_up_prompt(
        connection,
        session_id,
        "Continue this task in the selected cloud agent. Use the conversation context above and inspect the repository before making changes.",
        false,
    )
}

pub async fn clone_verified_checkout(
    snapshot: &CheckoutSnapshot,
) -> ArgmaxResult<tempfile::TempDir> {
    let directory = tempfile::tempdir().map_err(|error| {
        ArgmaxError::service(
            "CLOUD_TEMP_CHECKOUT_FAILED",
            format!("Could not create a temporary checkout: {error}"),
        )
    })?;
    let destination = directory.path().join("repository");
    let destination_text = destination.to_string_lossy().into_owned();
    git_stdout(
        directory.path(),
        &[
            "-c",
            "protocol.ext.allow=never",
            "clone",
            "--depth",
            "1",
            "--single-branch",
            "--branch",
            snapshot.branch.as_str(),
            "--",
            snapshot.origin_url.as_str(),
            destination_text.as_str(),
        ],
    )
    .await
    .map_err(|error| match error {
        ArgmaxError::ServiceError { message, .. } => ArgmaxError::service(
            "CLOUD_TEMP_CHECKOUT_FAILED",
            format!("Could not clone the verified remote branch: {message}"),
        ),
        other => other,
    })?;
    let cloned_commit = git_stdout(&destination, &["rev-parse", "--verify", "HEAD"]).await?;
    if cloned_commit != snapshot.commit {
        return Err(ArgmaxError::service(
            "CLOUD_REMOTE_CHANGED",
            "The remote branch changed while the cloud task was being prepared. Review the new commit and try again.",
        ));
    }
    Ok(directory)
}

pub fn handoff_note(
    provider_name: &str,
    provider_key: &str,
    url: &str,
) -> PersistTimelineEventInput {
    PersistTimelineEventInput {
        id: uuid::Uuid::new_v4().to_string(),
        session_id: String::new(),
        r#type: "session.note".to_string(),
        message: format!("Sent task to {provider_name} Cloud: {url}"),
        payload: serde_json::json!({
            "operation": format!("{provider_key}-cloud.handoff"),
            "url": url,
        }),
        created_at: None,
    }
}

async fn git_stdout(path: &Path, args: &[&str]) -> ArgmaxResult<String> {
    let run = async {
        let mut command = Command::new("git");
        command
            .args(args)
            .current_dir(path)
            .env("GIT_TERMINAL_PROMPT", "0")
            .kill_on_drop(true);
        command.output().await
    };
    let output = tokio::time::timeout(GIT_TIMEOUT, run)
        .await
        .map_err(|_| {
            ArgmaxError::service(
                "CLOUD_GIT_TIMEOUT",
                "Git did not respond within 30 seconds.",
            )
        })?
        .map_err(|error| {
            ArgmaxError::service("CLOUD_GIT_FAILED", format!("Could not run git: {error}"))
        })?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(ArgmaxError::service(
            "CLOUD_GIT_FAILED",
            stderr
                .lines()
                .last()
                .unwrap_or("git failed")
                .trim()
                .to_string(),
        ));
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

fn required_git_value(
    value: String,
    code: &'static str,
    message: &'static str,
) -> ArgmaxResult<String> {
    if value.is_empty() {
        Err(ArgmaxError::service(code, message))
    } else {
        Ok(value)
    }
}

fn parse_ls_remote_commit(value: &str) -> Option<&str> {
    value
        .split_whitespace()
        .next()
        .filter(|commit| is_sha(commit))
}

fn parse_github_repository(origin: &str) -> Option<String> {
    let path = if let Some(path) = origin.strip_prefix("git@github.com:") {
        path
    } else if let Some(path) = origin.strip_prefix("https://github.com/") {
        path
    } else {
        origin.strip_prefix("ssh://git@github.com/")?
    };
    if path.contains(['?', '#']) {
        return None;
    }
    let path = path.strip_suffix(".git").unwrap_or(path).trim_matches('/');
    let mut parts = path.split('/');
    let owner = parts.next()?;
    let repository = parts.next()?;
    if parts.next().is_some()
        || !valid_github_component(owner)
        || !valid_github_component(repository)
    {
        return None;
    }
    Some(format!("{owner}/{repository}"))
}

fn valid_github_component(value: &str) -> bool {
    !value.is_empty()
        && value.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.')
        })
}

fn is_sha(value: &str) -> bool {
    value.len() == 40 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn short_sha(value: &str) -> &str {
    value.get(..7).unwrap_or(value)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn github_origins_are_canonicalized_without_accepting_other_hosts_or_paths() {
        for origin in [
            "git@github.com:example/argmax.git",
            "https://github.com/example/argmax.git",
            "ssh://git@github.com/example/argmax",
        ] {
            assert_eq!(
                parse_github_repository(origin).as_deref(),
                Some("example/argmax")
            );
        }
        for origin in [
            "https://gitlab.com/example/argmax.git",
            "https://github.com/example/argmax/extra",
            "ext::sh -c whoami",
            "https://github.com/example/argmax.git?token=x",
        ] {
            assert_eq!(parse_github_repository(origin), None, "{origin}");
        }
    }

    #[test]
    fn remote_ref_parser_requires_a_full_sha() {
        assert_eq!(parse_ls_remote_commit("abc refs/heads/main"), None);
        assert_eq!(
            parse_ls_remote_commit("0123456789abcdef0123456789abcdef01234567\trefs/heads/main"),
            Some("0123456789abcdef0123456789abcdef01234567")
        );
    }
}
