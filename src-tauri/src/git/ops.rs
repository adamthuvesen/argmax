use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{Arc, LazyLock, Mutex},
    time::Duration,
};

use regex::Regex;

use crate::error::{ArgmaxError, ArgmaxResult};
use crate::git::exec::run_git_text;
use crate::persistence::projects::ProjectRemote;
use crate::util::sync::LockOrRecover;

static CHECKOUT_WRITE_LOCKS: LazyLock<Mutex<HashMap<PathBuf, Arc<tokio::sync::Mutex<()>>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// Serialize index and working-tree writes for a canonical checkout. This is
/// shared by review and rewind operations because distinct workspace rows may
/// point at the same checkout.
pub(crate) async fn checkout_write_lock(
    workspace_path: &Path,
) -> ArgmaxResult<Arc<tokio::sync::Mutex<()>>> {
    let canonical_path = tokio::fs::canonicalize(workspace_path)
        .await
        .map_err(|error| {
            ArgmaxError::service(
                "GIT_WORKSPACE_PATH_INVALID",
                format!("could not resolve workspace checkout: {error}"),
            )
        })?;
    let mut locks = CHECKOUT_WRITE_LOCKS.lock_or_recover("git checkout write locks");
    Ok(Arc::clone(
        locks
            .entry(canonical_path)
            .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(()))),
    ))
}

/// gh prints the new PR URL on its own line as the last meaningful line
/// of stdout. Anchor to `https://github.com/` so a hijacked gh binary
/// can't print a malicious URL that downstream code would open.
pub fn extract_pr_url(stdout: &str) -> Option<String> {
    // PR identity ends at the number. JSON punctuation and discussion
    // fragments belong to the surrounding output, not the stored PR link.
    let re = Regex::new(r"https://github\.com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+/pull/[0-9]+").ok()?;
    re.find(stdout).map(|m| m.as_str().to_owned())
}

/// Extracts the PR number from a GitHub PR URL (e.g. `https://github.com/o/r/pull/42`).
pub fn extract_pr_number(url: &str) -> Option<i64> {
    let re = Regex::new(r"/pull/(\d+)(?:[/?#]|$)").ok()?;
    let captures = re.captures(url)?;
    captures.get(1)?.as_str().parse::<i64>().ok()
}

/// Parses owner and repository name from a GitHub remote URL.
/// Supports SSH (`git@github.com:owner/repo.git`), HTTPS (`https://github.com/owner/repo.git`),
/// and other git variants.
pub fn parse_github_remote(url: &str) -> Option<ProjectRemote> {
    let trimmed = url.trim();
    let without_scheme = trimmed.strip_prefix("ssh://").unwrap_or(trimmed);
    let after_host = without_scheme
        .strip_prefix("git@github.com:")
        .or_else(|| without_scheme.strip_prefix("git@github.com/"))
        .or_else(|| without_scheme.strip_prefix("https://github.com/"))
        .or_else(|| without_scheme.strip_prefix("http://github.com/"))
        .or_else(|| without_scheme.strip_prefix("git://github.com/"))?;
    let without_git = after_host.strip_suffix(".git").unwrap_or(after_host);
    let mut parts = without_git.split('/');
    let owner = parts.next()?.trim();
    let name = parts.next()?.trim();
    if owner.is_empty() || name.is_empty() || parts.next().is_some() {
        return None;
    }
    Some(ProjectRemote {
        owner: owner.to_string(),
        name: name.to_string(),
    })
}

/// Extracts owner and repo from a canonical GitHub URL (e.g. `https://github.com/owner/repo/pull/123`).
pub fn extract_github_remote_from_url(url: &str) -> Option<ProjectRemote> {
    let trimmed = url.trim();
    let path = trimmed
        .strip_prefix("https://github.com/")
        .or_else(|| trimmed.strip_prefix("http://github.com/"))?;
    let mut parts = path.split('/');
    let owner = parts.next()?.trim();
    let name = parts.next()?.trim();
    if owner.is_empty() || name.is_empty() {
        return None;
    }
    Some(ProjectRemote {
        owner: owner.to_string(),
        name: name.to_string(),
    })
}

/// Discovers the project remote from the workspace's git origin configuration.
pub async fn resolve_project_remote(workspace_path: &Path) -> Option<ProjectRemote> {
    if let Ok(output) = run_git_text(
        workspace_path,
        ["config", "--get", "remote.origin.url"],
        Duration::from_secs(5),
    )
    .await
    {
        if let Some(remote) = parse_github_remote(&output) {
            return Some(remote);
        }
    }
    if let Ok(output) = run_git_text(
        workspace_path,
        ["remote", "get-url", "origin"],
        Duration::from_secs(5),
    )
    .await
    {
        if let Some(remote) = parse_github_remote(&output) {
            return Some(remote);
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extract_pr_url_rejects_non_github() {
        let stdout = "https://evil.example.com/pull/1\n";
        assert!(extract_pr_url(stdout).is_none());
    }

    #[test]
    fn extract_pr_url_drops_json_and_discussion_suffixes() {
        let output = r#"{"html_url":"https://github.com/o/r/pull/761#discussion_r123","pull_request_url":"https://api.github.com/repos/o/r/pulls/761"}"#;
        assert_eq!(
            extract_pr_url(output).as_deref(),
            Some("https://github.com/o/r/pull/761")
        );
    }

    #[test]
    fn parse_github_remote_handles_various_formats() {
        let ssh = parse_github_remote("git@github.com:menti/argmax.git").unwrap();
        assert_eq!(ssh.owner, "menti");
        assert_eq!(ssh.name, "argmax");

        let ssh_no_git = parse_github_remote("git@github.com:menti/argmax").unwrap();
        assert_eq!(ssh_no_git.owner, "menti");
        assert_eq!(ssh_no_git.name, "argmax");

        let https = parse_github_remote("https://github.com/menti/argmax.git").unwrap();
        assert_eq!(https.owner, "menti");
        assert_eq!(https.name, "argmax");

        let https_no_git = parse_github_remote("https://github.com/menti/argmax").unwrap();
        assert_eq!(https_no_git.owner, "menti");
        assert_eq!(https_no_git.name, "argmax");

        let non_github = parse_github_remote("git@gitlab.com:menti/argmax.git");
        assert!(non_github.is_none());
    }

    #[test]
    fn extract_github_remote_from_pr_url() {
        let remote =
            extract_github_remote_from_url("https://github.com/menti/argmax/pull/42").unwrap();
        assert_eq!(remote.owner, "menti");
        assert_eq!(remote.name, "argmax");

        let non_github = extract_github_remote_from_url("https://gitlab.com/menti/argmax/pull/42");
        assert!(non_github.is_none());
    }

    #[test]
    fn extract_pr_number_from_url() {
        assert_eq!(
            extract_pr_number("https://github.com/menti/argmax/pull/42"),
            Some(42)
        );
        assert_eq!(
            extract_pr_number("https://github.com/menti/argmax/pull/42/files"),
            Some(42)
        );
        assert_eq!(extract_pr_number("https://github.com/menti/argmax"), None);
    }
}
