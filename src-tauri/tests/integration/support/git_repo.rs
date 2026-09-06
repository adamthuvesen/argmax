use std::path::{Path, PathBuf};

use argmax_lib::git::exec::{run_git_text_blocking, GIT_DEFAULT_TIMEOUT};
use tempfile::TempDir;

pub struct SeededGitRepo {
    _temp_dir: TempDir,
    path: PathBuf,
}

impl SeededGitRepo {
    pub fn path(&self) -> &Path {
        &self.path
    }
}

pub fn seed_git_repo(files: &[(&str, &str)]) -> SeededGitRepo {
    let temp_dir = tempfile::tempdir().expect("create temp git repo dir");
    let path = temp_dir.path().to_path_buf();

    // Explicit branch name: `git init` takes it from the machine's
    // `init.defaultBranch`, so a fixture that hardcodes "main" passed locally
    // and failed on a runner that still defaults to "master".
    run_git(&path, &["init", "-b", "main"]);
    run_git(&path, &["config", "user.email", "test@example.com"]);
    run_git(&path, &["config", "user.name", "Argmax Test"]);

    for (relative_path, contents) in files {
        let file_path = path.join(relative_path);
        if let Some(parent) = file_path.parent() {
            std::fs::create_dir_all(parent).expect("create fixture parent dir");
        }
        std::fs::write(&file_path, contents).expect("write fixture file");
    }

    run_git(&path, &["add", "-A"]);
    run_git(&path, &["commit", "-m", "seed"]);

    SeededGitRepo {
        _temp_dir: temp_dir,
        path,
    }
}

pub fn run_git(repo_path: &Path, args: &[&str]) {
    let _ = run_git_stdout(repo_path, args);
}

pub fn run_git_stdout(repo_path: &Path, args: &[&str]) -> String {
    run_git_text_blocking(repo_path, args, GIT_DEFAULT_TIMEOUT).unwrap_or_else(|error| {
        panic!(
            "git fixture command failed: git -C {} {}: {error}",
            repo_path.display(),
            args.join(" ")
        )
    })
}
