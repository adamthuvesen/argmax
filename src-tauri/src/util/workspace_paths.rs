// Path-traversal guard. Every workspace-file IPC entry point resolves the
// caller-supplied path through `resolve_inside` before touching disk.
//
// The check is `canonicalize` + `starts_with`. `canonicalize` resolves
// symlinks, so a symlink pointing outside the workspace fails the
// containment check after resolution rather than before.

use std::io;
use std::path::{Path, PathBuf};

#[derive(Debug, thiserror::Error)]
pub enum PathError {
    #[error("path escapes workspace root: {0}")]
    Escapes(String),
    #[error("path does not exist: {0}")]
    NotFound(String),
    #[error("io error resolving path: {0}")]
    Io(#[from] io::Error),
}

/// Resolves `candidate` relative to `root` and confirms the resolved
/// absolute path is still inside `root` after symlink resolution.
///
/// Errors with `PathError::Escapes` when the resolved path is not a
/// descendant of the canonicalized root.
pub fn resolve_inside(root: &Path, candidate: &Path) -> Result<PathBuf, PathError> {
    let canonical_root = root.canonicalize().map_err(|e| match e.kind() {
        io::ErrorKind::NotFound => PathError::NotFound(root.display().to_string()),
        _ => PathError::Io(e),
    })?;

    let joined = if candidate.is_absolute() {
        candidate.to_path_buf()
    } else {
        canonical_root.join(candidate)
    };

    let resolved = joined.canonicalize().map_err(|e| match e.kind() {
        io::ErrorKind::NotFound => PathError::NotFound(joined.display().to_string()),
        _ => PathError::Io(e),
    })?;

    if !resolved.starts_with(&canonical_root) {
        return Err(PathError::Escapes(resolved.display().to_string()));
    }

    Ok(resolved)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::tempdir;

    #[test]
    fn relative_inside_root_resolves() {
        let dir = tempdir().unwrap();
        fs::write(dir.path().join("hello.txt"), "hi").unwrap();
        let resolved = resolve_inside(dir.path(), Path::new("hello.txt")).unwrap();
        assert!(resolved.ends_with("hello.txt"));
        assert!(resolved.starts_with(dir.path().canonicalize().unwrap()));
    }

    #[test]
    fn parent_traversal_outside_root_rejects() {
        let outer = tempdir().unwrap();
        let inner = outer.path().join("inner");
        fs::create_dir(&inner).unwrap();
        fs::write(outer.path().join("escape.txt"), "x").unwrap();
        let err = resolve_inside(&inner, Path::new("../escape.txt")).unwrap_err();
        assert!(matches!(err, PathError::Escapes(_)));
    }

    #[test]
    fn missing_path_reports_not_found() {
        let dir = tempdir().unwrap();
        let err = resolve_inside(dir.path(), Path::new("nope")).unwrap_err();
        assert!(matches!(err, PathError::NotFound(_)));
    }
}
