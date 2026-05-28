use std::{
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};

use serde::Serialize;
use specta::Type;
use tokio::{sync::Semaphore, task::JoinSet};

use crate::{
    error::{ArgmaxError, ArgmaxResult},
    git::exec::run_git_text,
    util::workspace_paths::{resolve_inside, PathError},
};

pub const DIFF_FANOUT_LIMIT: usize = 8;
pub const PER_FILE_DIFF_CAP_BYTES: usize = 1_048_576;
const GIT_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ChangedFileSummary {
    pub path: String,
    pub status: String,
    pub additions: usize,
    pub deletions: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub old_path: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceDiff {
    pub workspace_id: String,
    pub file_path: Option<String>,
    pub content: String,
}

pub async fn list_changed_files_at_path(
    repo_path: impl AsRef<Path>,
) -> ArgmaxResult<Vec<ChangedFileSummary>> {
    let repo_path = validate_repo_path(repo_path.as_ref())?;
    let porcelain =
        run_git_text(&repo_path, ["status", "--porcelain=v1", "-z"], GIT_TIMEOUT).await?;
    let files: Vec<_> = parse_porcelain_z(&porcelain)
        .into_iter()
        .filter(|file| !file.path.ends_with('/'))
        .collect();
    load_file_summaries(repo_path, files).await
}

pub async fn load_diff_at_path(
    repo_path: impl AsRef<Path>,
    diff_workspace_id: impl Into<String>,
    file_path: Option<&str>,
) -> ArgmaxResult<WorkspaceDiff> {
    let repo_path = validate_repo_path(repo_path.as_ref())?;
    let diff_workspace_id = diff_workspace_id.into();
    let content = match file_path {
        Some(path) => {
            validate_relative_review_path(&repo_path, path)?;
            let porcelain = run_git_text(
                &repo_path,
                ["status", "--porcelain=v1", "-z", "--", path],
                GIT_TIMEOUT,
            )
            .await?;
            let file = parse_porcelain_z(&porcelain)
                .into_iter()
                .find(|item| item.path == path);
            match file {
                Some(file) => load_file_diff(&repo_path, &file).await?,
                None => run_git_text(&repo_path, ["diff", "HEAD", "--", path], GIT_TIMEOUT).await?,
            }
        }
        None => {
            let porcelain =
                run_git_text(&repo_path, ["status", "--porcelain=v1", "-z"], GIT_TIMEOUT).await?;
            let files = parse_porcelain_z(&porcelain);
            let diffs = load_file_diffs(repo_path.clone(), files).await?;
            diffs
                .into_iter()
                .filter(|content| !content.is_empty())
                .collect::<Vec<_>>()
                .join("\n")
        }
    };

    Ok(WorkspaceDiff {
        workspace_id: diff_workspace_id,
        file_path: file_path.map(ToOwned::to_owned),
        content,
    })
}

async fn load_file_summaries(
    repo_path: PathBuf,
    files: Vec<ChangedFileSummary>,
) -> ArgmaxResult<Vec<ChangedFileSummary>> {
    let semaphore = Arc::new(Semaphore::new(DIFF_FANOUT_LIMIT));
    let mut tasks = JoinSet::new();
    for (index, file) in files.into_iter().enumerate() {
        let repo_path = repo_path.clone();
        let semaphore = semaphore.clone();
        tasks.spawn(async move {
            let _permit = semaphore.acquire_owned().await.map_err(|error| {
                ArgmaxError::service(
                    "REVIEW_FANOUT_CLOSED",
                    format!("diff fanout closed: {error}"),
                )
            })?;
            let diff = load_file_diff(&repo_path, &file).await?;
            let (additions, deletions) = count_diff_lines(&diff);
            Ok::<_, ArgmaxError>((
                index,
                ChangedFileSummary {
                    additions,
                    deletions,
                    ..file
                },
            ))
        });
    }

    collect_ordered(tasks).await
}

async fn load_file_diffs(
    repo_path: PathBuf,
    files: Vec<ChangedFileSummary>,
) -> ArgmaxResult<Vec<String>> {
    let semaphore = Arc::new(Semaphore::new(DIFF_FANOUT_LIMIT));
    let mut tasks = JoinSet::new();
    for (index, file) in files.into_iter().enumerate() {
        let repo_path = repo_path.clone();
        let semaphore = semaphore.clone();
        tasks.spawn(async move {
            let _permit = semaphore.acquire_owned().await.map_err(|error| {
                ArgmaxError::service(
                    "REVIEW_FANOUT_CLOSED",
                    format!("diff fanout closed: {error}"),
                )
            })?;
            Ok::<_, ArgmaxError>((index, load_file_diff(&repo_path, &file).await?))
        });
    }

    collect_ordered(tasks).await
}

async fn collect_ordered<T: Send + 'static>(
    mut tasks: JoinSet<ArgmaxResult<(usize, T)>>,
) -> ArgmaxResult<Vec<T>> {
    let mut results = Vec::new();
    while let Some(result) = tasks.join_next().await {
        let (index, value) = result.map_err(|error| {
            ArgmaxError::service("REVIEW_TASK_JOIN_FAILED", error.to_string())
        })??;
        results.push((index, value));
    }
    results.sort_by_key(|(index, _)| *index);
    Ok(results.into_iter().map(|(_, value)| value).collect())
}

async fn load_file_diff(repo_path: &Path, file: &ChangedFileSummary) -> ArgmaxResult<String> {
    let raw = if file.status == "??" {
        synthesize_untracked_diff(repo_path, &file.path).await?
    } else {
        run_git_text(
            repo_path,
            ["diff", "HEAD", "--", file.path.as_str()],
            GIT_TIMEOUT,
        )
        .await?
    };
    Ok(cap_diff(raw))
}

fn parse_porcelain_z(value: &str) -> Vec<ChangedFileSummary> {
    if value.is_empty() {
        return Vec::new();
    }

    let records: Vec<_> = value
        .split('\0')
        .filter(|entry| !entry.is_empty())
        .collect();
    let mut out = Vec::new();
    let mut index = 0;
    while index < records.len() {
        let record = records[index];
        if record.len() < 4 {
            index += 1;
            continue;
        }
        let code = &record[..2];
        let status = code.trim();
        let path = record[3..].to_owned();
        let mut old_path = None;
        if code.starts_with('R') || code.starts_with('C') {
            old_path = records.get(index + 1).map(|value| (*value).to_owned());
            index += 1;
        }
        out.push(ChangedFileSummary {
            path,
            status: if status.is_empty() {
                "?".to_owned()
            } else {
                status.to_owned()
            },
            additions: 0,
            deletions: 0,
            old_path,
        });
        index += 1;
    }
    out
}

fn count_diff_lines(content: &str) -> (usize, usize) {
    let mut additions = 0;
    let mut deletions = 0;
    for line in content.lines() {
        if line.starts_with("+++") || line.starts_with("---") {
            continue;
        }
        if line.starts_with('+') {
            additions += 1;
        } else if line.starts_with('-') {
            deletions += 1;
        }
    }
    (additions, deletions)
}

async fn synthesize_untracked_diff(repo_path: &Path, file_path: &str) -> ArgmaxResult<String> {
    let absolute_path = validate_relative_review_path(repo_path, file_path)?;
    let metadata = tokio::fs::symlink_metadata(&absolute_path)
        .await
        .map_err(fs_error)?;

    if metadata.file_type().is_symlink() {
        let target = tokio::fs::read_link(&absolute_path)
            .await
            .map_err(fs_error)?;
        return Ok(synthesize_untracked_symlink_diff(
            file_path,
            &target.display().to_string(),
        ));
    }
    if metadata.is_dir() {
        return Ok(String::new());
    }
    if metadata.len() as usize > PER_FILE_DIFF_CAP_BYTES {
        return Ok(synthesize_skipped_untracked_diff(
            file_path,
            metadata.len(),
            "file exceeds diff preview cap",
        ));
    }

    let content = match tokio::fs::read_to_string(&absolute_path).await {
        Ok(content) => content,
        Err(error)
            if matches!(
                error.kind(),
                std::io::ErrorKind::IsADirectory | std::io::ErrorKind::NotFound
            ) =>
        {
            return Ok(String::new());
        }
        Err(error) => return Err(fs_error(error)),
    };
    if content.contains('\0') {
        return Ok(synthesize_skipped_untracked_diff(
            file_path,
            metadata.len(),
            "binary file skipped",
        ));
    }

    Ok(synthesize_untracked_text_diff(file_path, &content))
}

fn synthesize_untracked_text_diff(file_path: &str, content: &str) -> String {
    let mut lines: Vec<_> = content.split('\n').collect();
    let has_trailing_newline = content.ends_with('\n');
    if has_trailing_newline {
        lines.pop();
    }
    let body = lines
        .iter()
        .map(|line| format!("+{line}"))
        .collect::<Vec<_>>()
        .join("\n");
    let no_newline_marker = if has_trailing_newline {
        ""
    } else {
        "\n\\ No newline at end of file"
    };
    [
        format!("diff --git a/{file_path} b/{file_path}"),
        "new file mode 100644".to_owned(),
        "index 0000000..0000000".to_owned(),
        "--- /dev/null".to_owned(),
        format!("+++ b/{file_path}"),
        format!("@@ -0,0 +1,{} @@", lines.len()),
        format!("{body}{no_newline_marker}"),
    ]
    .join("\n")
}

fn synthesize_skipped_untracked_diff(file_path: &str, size_bytes: u64, reason: &str) -> String {
    [
        format!("diff --git a/{file_path} b/{file_path}"),
        "new file mode 100644".to_owned(),
        "index 0000000..0000000".to_owned(),
        "--- /dev/null".to_owned(),
        format!("+++ b/{file_path}"),
        "@@ -0,0 +1 @@".to_owned(),
        format!("+[untracked file not loaded: {reason}; size {size_bytes} bytes]"),
        "\\ No newline at end of file".to_owned(),
    ]
    .join("\n")
}

fn synthesize_untracked_symlink_diff(file_path: &str, target: &str) -> String {
    [
        format!("diff --git a/{file_path} b/{file_path}"),
        "new file mode 120000".to_owned(),
        "index 0000000..0000000".to_owned(),
        "--- /dev/null".to_owned(),
        format!("+++ b/{file_path}"),
        "@@ -0,0 +1 @@".to_owned(),
        format!("+{target}"),
        "\\ No newline at end of file".to_owned(),
    ]
    .join("\n")
}

fn cap_diff(content: String) -> String {
    if content.len() <= PER_FILE_DIFF_CAP_BYTES {
        return content;
    }
    let dropped_bytes = content.len() - PER_FILE_DIFF_CAP_BYTES;
    format!(
        "{}\n[diff truncated at {} bytes; dropped {} bytes]\n",
        &content[..PER_FILE_DIFF_CAP_BYTES],
        PER_FILE_DIFF_CAP_BYTES,
        dropped_bytes
    )
}

fn validate_repo_path(repo_path: &Path) -> ArgmaxResult<PathBuf> {
    resolve_inside(repo_path, Path::new(".")).map_err(path_error)
}

fn validate_relative_review_path(repo_path: &Path, file_path: &str) -> ArgmaxResult<PathBuf> {
    let candidate = Path::new(file_path);
    let parent = candidate
        .parent()
        .filter(|path| !path.as_os_str().is_empty());
    let parent = parent.unwrap_or_else(|| Path::new("."));
    let parent = resolve_inside(repo_path, parent).map_err(path_error)?;
    let file_name = candidate
        .file_name()
        .ok_or_else(|| ArgmaxError::service("REVIEW_PATH_INVALID", "file path has no file name"))?;
    Ok(parent.join(file_name))
}

fn path_error(error: PathError) -> ArgmaxError {
    ArgmaxError::service("WORKSPACE_PATH_INVALID", error.to_string())
}

fn fs_error(error: std::io::Error) -> ArgmaxError {
    ArgmaxError::service("WORKSPACE_FILE_IO", error.to_string())
}
