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
/// A shallow clone of a large repository legitimately takes minutes. Nothing
/// has been sent to the provider yet, so a longer wait costs only time.
const CLONE_TIMEOUT: Duration = Duration::from_secs(180);

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
    let reading = "reading the checkout";
    let (branch, commit, origin_url) = tokio::try_join!(
        run_git(
            &path,
            &["symbolic-ref", "--quiet", "--short", "HEAD"],
            reading,
            GIT_TIMEOUT
        ),
        run_git(
            &path,
            &["rev-parse", "--verify", "HEAD"],
            reading,
            GIT_TIMEOUT
        ),
        run_git(
            &path,
            &["remote", "get-url", "origin"],
            reading,
            GIT_TIMEOUT
        ),
    )?;

    // Each of these fails with a non-zero exit and little or no stderr (a
    // detached HEAD prints nothing at all), so the exit status is the answer.
    let branch = required_git_value(
        branch,
        "CLOUD_DETACHED_HEAD",
        "Check out a branch first. Cloud tasks run from a pushed branch, not a detached HEAD.",
    )?;
    let commit = required_git_value(
        commit,
        "CLOUD_GIT_HEAD_MISSING",
        "The checkout has no commits yet. Commit and push before sending a cloud task.",
    )?;
    let origin_url = required_git_value(
        origin_url,
        "CLOUD_GITHUB_ORIGIN_REQUIRED",
        "Cloud tasks need a GitHub remote named origin.",
    )?;
    let repository = parse_github_repository(&origin_url).ok_or_else(|| {
        ArgmaxError::service(
            "CLOUD_GITHUB_ORIGIN_REQUIRED",
            format!(
                "Cloud tasks need origin to be a github.com URL (git@github.com:owner/repo or https://github.com/owner/repo). This checkout's origin is {}.",
                origin_for_display(&origin_url)
            ),
        )
    })?;

    // Without `--exit-code`, a branch origin does not have is an empty answer
    // rather than a silent exit 2, so it gets the push hint below.
    let remote_ref = format!("refs/heads/{branch}");
    let remote = run_git(
        &path,
        &[
            "-c",
            "protocol.ext.allow=never",
            "ls-remote",
            origin_url.as_str(),
            remote_ref.as_str(),
        ],
        "checking origin",
        GIT_TIMEOUT,
    )
    .await?
    .map_err(|stderr| {
        ArgmaxError::service(
            "CLOUD_REMOTE_REF_UNAVAILABLE",
            format!("Could not reach origin to check {branch}: {stderr}"),
        )
    })?;
    let remote_commit = parse_ls_remote_commit(&remote).ok_or_else(|| {
        ArgmaxError::service(
            "CLOUD_REMOTE_REF_UNAVAILABLE",
            format!("{branch} is not on origin yet. Push it before sending this cloud task."),
        )
    })?;
    if remote_commit != commit {
        return Err(ArgmaxError::service(
            "CLOUD_UNPUSHED_COMMIT",
            format!(
                "Local {branch} ({}) does not match GitHub ({}). Push it, then try again.",
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

const DEFAULT_HANDOFF_INSTRUCTION: &str = "Continue this task in the selected cloud agent. Use the conversation context above and inspect the repository before making changes.";

/// The brief a chat hands to a cloud agent: the chat's transcript, then one
/// closing instruction. The user's own words after `/cloud` take that place,
/// so the agent never reads two competing "new messages".
pub fn handoff_brief(
    connection: &rusqlite::Connection,
    session_id: &str,
    instruction: Option<&str>,
) -> ArgmaxResult<String> {
    let instruction = instruction
        .map(str::trim)
        .filter(|instruction| !instruction.is_empty())
        .unwrap_or(DEFAULT_HANDOFF_INSTRUCTION);
    super::follow_up::compose_follow_up_prompt(connection, session_id, instruction, false)
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
    run_git(
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
        "cloning the branch",
        CLONE_TIMEOUT,
    )
    .await?
    .map_err(|stderr| {
        ArgmaxError::service(
            "CLOUD_TEMP_CHECKOUT_FAILED",
            format!("Could not clone {}: {stderr}", snapshot.branch),
        )
    })?;
    let cloned_commit = run_git(
        &destination,
        &["rev-parse", "--verify", "HEAD"],
        "reading the clone",
        GIT_TIMEOUT,
    )
    .await?
    .map_err(|stderr| ArgmaxError::service("CLOUD_TEMP_CHECKOUT_FAILED", stderr))?;
    if cloned_commit != snapshot.commit {
        return Err(ArgmaxError::service(
            "CLOUD_REMOTE_CHANGED",
            "The branch changed on GitHub while this task was being prepared. Try again to send the latest commit.",
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

/// Run git once. The outer error is git not running at all (spawn failure or
/// timeout); the inner one is a non-zero exit, carrying its last stderr line,
/// so each caller can say what that exit means for its own step.
async fn run_git(
    path: &Path,
    args: &[&str],
    step: &str,
    timeout: Duration,
) -> ArgmaxResult<Result<String, String>> {
    let run = async {
        let mut command = Command::new("git");
        command
            .args(args)
            .current_dir(path)
            .env("GIT_TERMINAL_PROMPT", "0")
            .kill_on_drop(true);
        command.output().await
    };
    let output = tokio::time::timeout(timeout, run)
        .await
        .map_err(|_| {
            ArgmaxError::service(
                "CLOUD_GIT_TIMEOUT",
                format!(
                    "Git timed out after {} seconds while {step}. Check your network connection and try again.",
                    timeout.as_secs()
                ),
            )
        })?
        .map_err(|error| {
            ArgmaxError::service("CLOUD_GIT_FAILED", format!("Could not run git: {error}"))
        })?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let detail = stderr.lines().last().map(str::trim).unwrap_or_default();
        return Ok(Err(if detail.is_empty() {
            format!(
                "git exited with status {}",
                output.status.code().unwrap_or(-1)
            )
        } else {
            detail.to_string()
        }));
    }
    Ok(Ok(String::from_utf8_lossy(&output.stdout)
        .trim()
        .to_string()))
}

fn required_git_value(
    value: Result<String, String>,
    code: &'static str,
    message: &'static str,
) -> ArgmaxResult<String> {
    match value {
        Ok(value) if !value.is_empty() => Ok(value),
        _ => Err(ArgmaxError::service(code, message)),
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

/// The origin as an error message may show it: an HTTPS remote can carry a
/// token in its userinfo or query, and the message lands in the dialog.
fn origin_for_display(origin: &str) -> String {
    let origin = origin.split(['?', '#']).next().unwrap_or(origin);
    let Some((scheme, rest)) = origin.split_once("://") else {
        return origin.to_string();
    };
    let authority_end = rest.find('/').unwrap_or(rest.len());
    match rest[..authority_end].rfind('@') {
        Some(at) => format!("{scheme}://{}", &rest[at + 1..]),
        None => origin.to_string(),
    }
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
    fn rejected_origins_are_shown_without_credentials() {
        assert_eq!(
            origin_for_display("https://user:ghp_secret@gitlab.com/o/r.git?token=x"),
            "https://gitlab.com/o/r.git"
        );
        assert_eq!(
            origin_for_display("git@gitlab.com:o/r.git"),
            "git@gitlab.com:o/r.git"
        );
    }

    fn git(path: &Path, args: &[&str]) {
        let status = std::process::Command::new("git")
            .args(["-c", "user.email=t@example.com", "-c", "user.name=T"])
            .args(args)
            .current_dir(path)
            .output()
            .expect("run git")
            .status;
        assert!(status.success(), "git {args:?}");
    }

    async fn validation_code(path: &Path) -> String {
        let error = validate_checkout(path.to_path_buf())
            .await
            .expect_err("checkout is not sendable");
        serde_json::to_value(&error).expect("serialize")["sub_code"]
            .as_str()
            .expect("sub_code")
            .to_owned()
    }

    /// Each of these exits non-zero with little or no stderr, which used to
    /// surface as a bare "git failed" instead of what to fix.
    #[tokio::test]
    async fn local_checkout_problems_get_their_own_messages() {
        let repo = tempfile::tempdir().expect("tempdir");
        git(repo.path(), &["init", "-q", "-b", "main"]);
        assert_eq!(validation_code(repo.path()).await, "CLOUD_GIT_HEAD_MISSING");

        git(
            repo.path(),
            &["commit", "-q", "--allow-empty", "-m", "first"],
        );
        assert_eq!(
            validation_code(repo.path()).await,
            "CLOUD_GITHUB_ORIGIN_REQUIRED"
        );

        git(repo.path(), &["checkout", "-q", "--detach"]);
        assert_eq!(validation_code(repo.path()).await, "CLOUD_DETACHED_HEAD");
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
