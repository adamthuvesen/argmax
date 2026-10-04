// Reads inside a project's linked repositories (docs/memory.md#linked-repositories).
//
// Every entry point resolves a caller-supplied relative path against the
// stored canonical root and refuses anything that leaves it. This module only
// reads on demand. It never watches a root: a linked checkout belongs to
// someone else's work, and observing it would cost a watcher per project for
// no benefit.

use std::path::{Component, Path, PathBuf};

use crate::error::{ArgmaxError, ArgmaxResult};
use crate::files::workspace_files::{read_resolved_file, SkippedReason, WorkspaceFilePreview};
use crate::persistence::linked_repos::LinkedRepo;
use crate::util::workspace_paths::{resolve_inside, PathError};

/// Directory listings stop here, however large the page the caller asked for.
pub const LIST_MAX_LIMIT: usize = 500;
pub const LIST_DEFAULT_LIMIT: usize = 100;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LinkedEntry {
    pub name: String,
    /// `file`, `dir`, `symlink`, or `other`. A symlink is never followed.
    pub kind: &'static str,
    pub size: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LinkedListing {
    pub entries: Vec<LinkedEntry>,
    /// Every entry in the directory, so a caller that trims the page (to fit a
    /// byte budget) can tell where the next one starts and whether one exists.
    pub total: usize,
    pub next_offset: Option<usize>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LinkedFileRead {
    pub content: String,
    pub truncated: bool,
    /// The absolute path that was read.
    pub location: String,
}

fn error(code: &'static str, message: impl Into<String>) -> ArgmaxError {
    ArgmaxError::service(code, message)
}

/// The canonical path for `relative` inside `repo`, or the reason it is not
/// allowed. An empty path or `.` is the root itself.
pub fn resolve(repo: &LinkedRepo, relative: &str) -> ArgmaxResult<PathBuf> {
    if !repo.enabled {
        return Err(error(
            "LINKED_REPO_DISABLED",
            format!(
                "Linked repository '{}' is switched off in Settings.",
                repo.name
            ),
        ));
    }
    let stored = Path::new(&repo.root_path);
    // The allowlist holds the canonical form. A root that now resolves
    // elsewhere (a directory swapped for a symlink) must not be followed.
    let current = stored.canonicalize().map_err(|cause| {
        error(
            "LINKED_REPO_ROOT_MISSING",
            format!(
                "Linked repository '{}' is not readable at {}: {cause}",
                repo.name, repo.root_path
            ),
        )
    })?;
    if current != stored {
        return Err(error(
            "LINKED_REPO_ROOT_CHANGED",
            format!(
                "Linked repository '{}' now resolves to {}. Remove it and link it again.",
                repo.name,
                current.display()
            ),
        ));
    }
    let relative = relative.trim();
    if relative.contains('\0') {
        return Err(error(
            "LINKED_REPO_PATH_INVALID",
            "The path contains a NUL byte.",
        ));
    }
    let path = Path::new(relative);
    if path.is_absolute() {
        return Err(error(
            "LINKED_REPO_PATH_ABSOLUTE",
            "Pass a path relative to the linked repository root.",
        ));
    }
    for component in path.components() {
        match component {
            Component::ParentDir => {
                return Err(error(
                    "LINKED_REPO_PATH_ESCAPES",
                    "A path may not contain '..'. It must stay inside the linked repository.",
                ))
            }
            Component::Normal(part) if part == ".git" => {
                return Err(error(
                    "LINKED_REPO_PATH_FORBIDDEN",
                    "Git internals are not readable through a linked repository.",
                ))
            }
            _ => {}
        }
    }
    let resolved = resolve_inside(&current, path).map_err(|cause| match cause {
        PathError::Escapes(_) => error(
            "LINKED_REPO_PATH_ESCAPES",
            "That path resolves outside the linked repository (a symlink leaves the root).",
        ),
        PathError::NotFound(_) => error(
            "LINKED_REPO_PATH_NOT_FOUND",
            format!(
                "No such path in linked repository '{}': {relative}",
                repo.name
            ),
        ),
        PathError::Io(io) => error("LINKED_REPO_PATH_IO", io.to_string()),
    })?;
    // A symlink inside the root can point at `.git`; the check above only saw
    // the spelled components.
    let inside = resolved.strip_prefix(&current).unwrap_or(&resolved);
    if inside
        .components()
        .any(|c| matches!(c, Component::Normal(part) if part == ".git"))
    {
        return Err(error(
            "LINKED_REPO_PATH_FORBIDDEN",
            "Git internals are not readable through a linked repository.",
        ));
    }
    Ok(resolved)
}

pub fn list_directory(
    repo: &LinkedRepo,
    relative: &str,
    offset: usize,
    limit: usize,
) -> ArgmaxResult<LinkedListing> {
    let resolved = resolve(repo, relative)?;
    if !resolved.is_dir() {
        return Err(error(
            "LINKED_REPO_NOT_A_DIRECTORY",
            "That path is a file. Read it, or list its directory.",
        ));
    }
    let mut entries = Vec::new();
    for entry in std::fs::read_dir(&resolved)
        .map_err(|cause| error("LINKED_REPO_PATH_IO", cause.to_string()))?
    {
        let entry = entry.map_err(|cause| error("LINKED_REPO_PATH_IO", cause.to_string()))?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if name == ".git" {
            continue;
        }
        let file_type = entry
            .file_type()
            .map_err(|cause| error("LINKED_REPO_PATH_IO", cause.to_string()))?;
        let (kind, size) = if file_type.is_symlink() {
            ("symlink", None)
        } else if file_type.is_dir() {
            ("dir", None)
        } else if file_type.is_file() {
            ("file", entry.metadata().ok().map(|meta| meta.len()))
        } else {
            ("other", None)
        };
        entries.push(LinkedEntry { name, kind, size });
    }
    entries.sort_by(|a, b| a.name.cmp(&b.name));
    let limit = limit.clamp(1, LIST_MAX_LIMIT);
    let total = entries.len();
    let page: Vec<LinkedEntry> = entries.into_iter().skip(offset).take(limit).collect();
    let next = offset.saturating_add(page.len());
    Ok(LinkedListing {
        entries: page,
        total,
        next_offset: (next < total).then_some(next),
    })
}

pub async fn read_text(
    repo: &LinkedRepo,
    relative: &str,
    max_chars: usize,
) -> ArgmaxResult<LinkedFileRead> {
    if relative.trim().is_empty() || relative.trim() == "." {
        return Err(error(
            "LINKED_REPO_NOT_A_FILE",
            "Pass the path of a file to read. List a directory with sources_list.",
        ));
    }
    let resolved = resolve(repo, relative)?;
    let content = match read_resolved_file(&resolved).await? {
        WorkspaceFilePreview::Text { content, .. } => content,
        WorkspaceFilePreview::Skipped { reason, .. } => {
            return Err(match reason {
                SkippedReason::NotAFile => error(
                    "LINKED_REPO_NOT_A_FILE",
                    "That path is not a regular file. List it with sources_list instead.",
                ),
                SkippedReason::TooLarge => error(
                    "LINKED_REPO_FILE_TOO_LARGE",
                    "That file exceeds the 1 MiB read limit.",
                ),
                SkippedReason::Binary => error(
                    "LINKED_REPO_FILE_BINARY",
                    "That file is binary and cannot be read as text.",
                ),
            })
        }
    };
    let truncated = content.chars().count() > max_chars;
    let content = if truncated {
        content.chars().take(max_chars).collect()
    } else {
        content
    };
    Ok(LinkedFileRead {
        content,
        truncated,
        location: resolved.to_string_lossy().into_owned(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    fn repo_at(root: &Path) -> LinkedRepo {
        LinkedRepo {
            id: "l1".to_owned(),
            project_id: "p1".to_owned(),
            name: "docs".to_owned(),
            root_path: root.canonicalize().unwrap().to_string_lossy().into_owned(),
            enabled: true,
            created_at: String::new(),
            updated_at: String::new(),
        }
    }

    fn code(error: ArgmaxError) -> String {
        match error {
            ArgmaxError::ServiceError { sub_code, .. } => sub_code,
            other => panic!("unexpected {other:?}"),
        }
    }

    #[tokio::test]
    async fn reads_a_file_and_lists_a_directory_inside_the_root() {
        let dir = TempDir::new().unwrap();
        fs::create_dir_all(dir.path().join("src")).unwrap();
        fs::write(dir.path().join("src/a.txt"), "hello world").unwrap();
        fs::create_dir_all(dir.path().join(".git")).unwrap();
        fs::write(dir.path().join(".git/config"), "[remote]").unwrap();
        let repo = repo_at(dir.path());

        let read = read_text(&repo, "src/a.txt", 5).await.unwrap();
        assert_eq!(read.content, "hello");
        assert!(read.truncated);

        let listing = list_directory(&repo, "", 0, 100).unwrap();
        let names: Vec<_> = listing.entries.iter().map(|e| e.name.as_str()).collect();
        assert_eq!(names, vec!["src"], ".git is hidden from listings");
        assert_eq!(
            list_directory(&repo, "src", 0, 100).unwrap().entries[0].size,
            Some(11)
        );
    }

    #[test]
    fn rejects_traversal_absolute_paths_and_git_internals() {
        let dir = TempDir::new().unwrap();
        fs::create_dir_all(dir.path().join(".git")).unwrap();
        let repo = repo_at(dir.path());
        assert_eq!(
            code(resolve(&repo, "../x").unwrap_err()),
            "LINKED_REPO_PATH_ESCAPES"
        );
        assert_eq!(
            code(resolve(&repo, "a/../../x").unwrap_err()),
            "LINKED_REPO_PATH_ESCAPES"
        );
        assert_eq!(
            code(resolve(&repo, "/etc/passwd").unwrap_err()),
            "LINKED_REPO_PATH_ABSOLUTE"
        );
        assert_eq!(
            code(resolve(&repo, ".git/config").unwrap_err()),
            "LINKED_REPO_PATH_FORBIDDEN"
        );
        assert_eq!(
            code(resolve(&repo, "nope").unwrap_err()),
            "LINKED_REPO_PATH_NOT_FOUND"
        );
    }

    #[cfg(unix)]
    #[test]
    fn rejects_a_symlink_that_leaves_the_root() {
        let outside = TempDir::new().unwrap();
        fs::write(outside.path().join("secret.txt"), "secret").unwrap();
        let dir = TempDir::new().unwrap();
        std::os::unix::fs::symlink(outside.path(), dir.path().join("escape")).unwrap();
        std::os::unix::fs::symlink(
            outside.path().join("secret.txt"),
            dir.path().join("link.txt"),
        )
        .unwrap();
        let repo = repo_at(dir.path());
        assert_eq!(
            code(resolve(&repo, "escape").unwrap_err()),
            "LINKED_REPO_PATH_ESCAPES"
        );
        assert_eq!(
            code(resolve(&repo, "escape/secret.txt").unwrap_err()),
            "LINKED_REPO_PATH_ESCAPES"
        );
        assert_eq!(
            code(resolve(&repo, "link.txt").unwrap_err()),
            "LINKED_REPO_PATH_ESCAPES"
        );
    }

    #[cfg(unix)]
    #[test]
    fn a_symlink_to_git_internals_inside_the_root_is_refused() {
        let dir = TempDir::new().unwrap();
        fs::create_dir_all(dir.path().join(".git")).unwrap();
        fs::write(dir.path().join(".git/config"), "x").unwrap();
        std::os::unix::fs::symlink(dir.path().join(".git"), dir.path().join("sneaky")).unwrap();
        let repo = repo_at(dir.path());
        assert_eq!(
            code(resolve(&repo, "sneaky/config").unwrap_err()),
            "LINKED_REPO_PATH_FORBIDDEN"
        );
    }

    #[cfg(unix)]
    #[test]
    fn a_root_swapped_for_a_symlink_is_not_followed() {
        let real = TempDir::new().unwrap();
        let elsewhere = TempDir::new().unwrap();
        let mut repo = repo_at(real.path());
        let link = real
            .path()
            .parent()
            .unwrap()
            .join(format!("link-{}", std::process::id()));
        std::os::unix::fs::symlink(elsewhere.path(), &link).unwrap();
        repo.root_path = link.to_string_lossy().into_owned();
        let result = resolve(&repo, "");
        fs::remove_file(&link).unwrap();
        assert_eq!(code(result.unwrap_err()), "LINKED_REPO_ROOT_CHANGED");
    }

    #[test]
    fn a_disabled_repository_is_not_readable() {
        let dir = TempDir::new().unwrap();
        let mut repo = repo_at(dir.path());
        repo.enabled = false;
        assert_eq!(
            code(resolve(&repo, "").unwrap_err()),
            "LINKED_REPO_DISABLED"
        );
    }

    #[test]
    fn listing_pages_with_a_next_offset() {
        let dir = TempDir::new().unwrap();
        for name in ["a", "b", "c"] {
            fs::write(dir.path().join(name), name).unwrap();
        }
        let repo = repo_at(dir.path());
        let first = list_directory(&repo, "", 0, 2).unwrap();
        assert_eq!(first.entries.len(), 2);
        assert_eq!(first.next_offset, Some(2));
        let second = list_directory(&repo, "", 2, 2).unwrap();
        assert_eq!(second.entries[0].name, "c");
        assert_eq!(second.next_offset, None);
    }
}
