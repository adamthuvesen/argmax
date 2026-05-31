use std::path::{Path, PathBuf};

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

    run_git(&path, &["init"]);
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
    let output = std::process::Command::new("git")
        .arg("-C")
        .arg(repo_path)
        .args(args)
        .env("LC_ALL", "C")
        .env("LANG", "C")
        .env("LANGUAGE", "")
        .output()
        .expect("run git fixture command");

    assert!(
        output.status.success(),
        "git fixture command failed: git -C {} {}\nstdout:\n{}\nstderr:\n{}",
        repo_path.display(),
        args.join(" "),
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
}
