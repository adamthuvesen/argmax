use std::{
    ffi::{OsStr, OsString},
    path::{Path, PathBuf},
    process::{ExitStatus, Stdio},
    sync::OnceLock,
    time::Duration,
};

use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWriteExt},
    process::Command,
    time,
};

#[cfg(unix)]
use crate::login_shell;
use argmax_contracts::error::{ArgmaxError, ArgmaxResult};

pub const GIT_DEFAULT_TIMEOUT: Duration = Duration::from_secs(30);
pub const GIT_STDOUT_CAP_BYTES: usize = 8 * 1024 * 1024;
const GIT_STDERR_CAP_BYTES: usize = 64 * 1024;
const ERROR_DETAIL_CAP_BYTES: usize = 4096;

#[derive(Debug, Clone)]
pub struct GitExecOptions {
    pub timeout: Duration,
    pub stdout_cap_bytes: usize,
    /// Extra env vars layered onto git's environment, including the scratch
    /// index used for selected-file commits.
    pub env: Vec<(OsString, OsString)>,
    /// For output that is only shown to the user (diffs, search hits): decode
    /// non-UTF-8 bytes lossily and truncate at the cap instead of failing, so
    /// one legacy-encoded or oversized file cannot fail the whole read.
    pub lossy_display: bool,
    /// Bytes written to git's stdin, for `--stdin` and `--pathspec-from-file=-`
    /// forms. `None` leaves stdin as it was.
    pub stdin: Option<Vec<u8>>,
}

impl Default for GitExecOptions {
    fn default() -> Self {
        Self {
            timeout: GIT_DEFAULT_TIMEOUT,
            stdout_cap_bytes: GIT_STDOUT_CAP_BYTES,
            env: Vec::new(),
            lossy_display: false,
            stdin: None,
        }
    }
}

impl GitExecOptions {
    pub fn with_env<K: Into<OsString>, V: Into<OsString>>(mut self, key: K, value: V) -> Self {
        self.env.push((key.into(), value.into()));
        self
    }

    pub fn with_stdin(mut self, input: impl Into<Vec<u8>>) -> Self {
        self.stdin = Some(input.into());
        self
    }

    pub fn lossy_display(mut self) -> Self {
        self.lossy_display = true;
        self
    }

    /// For a command that talks to a remote. The cleared environment drops
    /// what SSH and credential helpers read, and a prompt would hang until the
    /// timeout because nothing can answer it.
    pub fn remote_access(mut self) -> Self {
        for key in [
            "SSH_AUTH_SOCK",
            "SSH_ASKPASS",
            "GIT_SSH",
            "GIT_SSH_COMMAND",
            "GIT_ASKPASS",
            "GH_TOKEN",
            "GITHUB_TOKEN",
            "HTTP_PROXY",
            "HTTPS_PROXY",
            "ALL_PROXY",
            "NO_PROXY",
            "http_proxy",
            "https_proxy",
            "all_proxy",
            "no_proxy",
            "GIT_SSL_CAINFO",
            "SSL_CERT_FILE",
            "SSL_CERT_DIR",
            "XDG_CONFIG_HOME",
        ] {
            if let Some(value) = std::env::var_os(key) {
                self.env.push((key.into(), value));
            }
        }
        self.with_env("GIT_TERMINAL_PROMPT", "0")
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GitExit {
    pub stdout: String,
    pub exit_code: i32,
}

#[derive(Debug)]
struct GitCommandOutput {
    status: ExitStatus,
    stdout: Vec<u8>,
    stderr: Vec<u8>,
}

pub async fn run_git_text<P, I, S>(
    workspace_path: P,
    args: I,
    timeout: Duration,
) -> ArgmaxResult<String>
where
    P: AsRef<Path>,
    I: IntoIterator<Item = S>,
    S: AsRef<OsStr>,
{
    run_git_text_with_options(
        workspace_path,
        args,
        GitExecOptions {
            timeout,
            ..GitExecOptions::default()
        },
    )
    .await
}

/// Like [`run_git_text`] but with caller-supplied [`GitExecOptions`] (env
/// overrides, custom timeout). Used by callers that drive git against a
/// scratch `GIT_INDEX_FILE`.
pub async fn run_git_text_with_options<P, I, S>(
    workspace_path: P,
    args: I,
    options: GitExecOptions,
) -> ArgmaxResult<String>
where
    P: AsRef<Path>,
    I: IntoIterator<Item = S>,
    S: AsRef<OsStr>,
{
    let lossy_display = options.lossy_display;
    let output = run_git_output(workspace_path.as_ref(), args, options).await?;
    decode_stdout(output, lossy_display)
}

/// Blocking counterpart to [`run_git_text`], for the callers that have no
/// runtime to await on — startup archive recovery, and test fixtures that seed
/// a repo before the service under test exists. The command runs on its own
/// thread with a throwaway current-thread runtime, so an ambient runtime can
/// neither be blocked nor panic the call, and every guarantee above still
/// holds.
pub fn run_git_text_blocking<P, I, S>(
    workspace_path: P,
    args: I,
    timeout: Duration,
) -> ArgmaxResult<String>
where
    P: AsRef<Path>,
    I: IntoIterator<Item = S>,
    S: AsRef<OsStr>,
{
    let workspace_path = workspace_path.as_ref();
    let args = collect_args(args);
    std::thread::scope(|scope| {
        scope
            .spawn(|| {
                let runtime = tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()
                    .map_err(|error| {
                        ArgmaxError::service(
                            "GIT_RUNTIME_UNAVAILABLE",
                            format!("failed to start a runtime for git: {error}"),
                        )
                    })?;
                runtime.block_on(run_git_text(workspace_path, &args, timeout))
            })
            .join()
            .map_err(|_| ArgmaxError::service("GIT_SPAWN_FAILED", "git worker thread panicked"))?
    })
}

pub async fn run_git_text_with_allowed_exit_codes<P, I, S>(
    workspace_path: P,
    args: I,
    allowed_exit_codes: &[i32],
    timeout: Duration,
) -> ArgmaxResult<GitExit>
where
    P: AsRef<Path>,
    I: IntoIterator<Item = S>,
    S: AsRef<OsStr>,
{
    run_git_text_with_allowed_exit_codes_and_options(
        workspace_path,
        args,
        allowed_exit_codes,
        GitExecOptions {
            timeout,
            ..GitExecOptions::default()
        },
    )
    .await
}

pub async fn run_git_text_with_allowed_exit_codes_and_options<P, I, S>(
    workspace_path: P,
    args: I,
    allowed_exit_codes: &[i32],
    options: GitExecOptions,
) -> ArgmaxResult<GitExit>
where
    P: AsRef<Path>,
    I: IntoIterator<Item = S>,
    S: AsRef<OsStr>,
{
    let args = collect_args(args);
    let lossy_display = options.lossy_display;
    let output = run_git_command(workspace_path.as_ref(), &args, options).await?;
    let stdout = decode_stdout(output.stdout, lossy_display)?;
    let exit_code = output.status.code().unwrap_or(-1);

    if output.status.success() || allowed_exit_codes.contains(&exit_code) {
        return Ok(GitExit { stdout, exit_code });
    }

    Err(non_zero_error(exit_code, &output.stderr))
}

pub async fn run_git_buffer_with_options<P, I, S>(
    workspace_path: P,
    args: I,
    options: GitExecOptions,
) -> ArgmaxResult<Vec<u8>>
where
    P: AsRef<Path>,
    I: IntoIterator<Item = S>,
    S: AsRef<OsStr>,
{
    run_git_output(workspace_path.as_ref(), args, options).await
}

pub async fn run_git_buffer<P, I, S>(
    workspace_path: P,
    args: I,
    timeout: Duration,
) -> ArgmaxResult<Vec<u8>>
where
    P: AsRef<Path>,
    I: IntoIterator<Item = S>,
    S: AsRef<OsStr>,
{
    run_git_output(
        workspace_path.as_ref(),
        args,
        GitExecOptions {
            timeout,
            ..GitExecOptions::default()
        },
    )
    .await
}

pub fn reject_leading_dash(field: &'static str, value: &str) -> ArgmaxResult<()> {
    if value.starts_with('-') {
        return Err(ArgmaxError::service(
            "GIT_ARG_LEADING_DASH",
            format!("{field} must not start with '-'"),
        ));
    }
    Ok(())
}

async fn run_git_output<I, S>(
    workspace_path: &Path,
    args: I,
    options: GitExecOptions,
) -> ArgmaxResult<Vec<u8>>
where
    I: IntoIterator<Item = S>,
    S: AsRef<OsStr>,
{
    let args = collect_args(args);
    let output = run_git_command(workspace_path, &args, options).await?;
    if !output.status.success() {
        return Err(non_zero_error(
            output.status.code().unwrap_or(-1),
            &output.stderr,
        ));
    }
    Ok(output.stdout)
}

/// The git executable every Argmax git call runs, resolved once.
///
/// On macOS without Homebrew git, `git` on PATH is `/usr/bin/git`, Apple's
/// xcrun shim: it looks up the developer directory on every call and then
/// execs the real binary. Measured 2026-11-13: `--version` 20.6 ms through the
/// shim against 8.2 ms direct, `status` 27.5 against 13.8 ms. Argmax runs
/// dozens of git calls around each turn, so it asks `xcrun` once and runs the
/// real binary. Anything unexpected falls back to plain `git`.
pub fn git_program() -> &'static OsStr {
    static PROGRAM: OnceLock<OsString> = OnceLock::new();
    PROGRAM.get_or_init(resolve_git_program).as_os_str()
}

fn resolve_git_program() -> OsString {
    #[cfg(unix)]
    let path = login_shell::path();
    #[cfg(not(unix))]
    let path = std::env::var("PATH").unwrap_or_default();
    git_program_on(&path, xcrun_git)
}

/// [`resolve_git_program`] for a given PATH and `xcrun --find git` lookup.
fn git_program_on(path: &str, xcrun_git: impl FnOnce() -> Option<PathBuf>) -> OsString {
    let Some(found) = std::env::split_paths(path)
        .map(|dir| dir.join("git"))
        .find(|candidate| is_executable(candidate))
    else {
        return OsString::from("git");
    };
    if cfg!(target_os = "macos") && found == Path::new("/usr/bin/git") {
        if let Some(real) = xcrun_git() {
            return real.into_os_string();
        }
    }
    found.into_os_string()
}

fn xcrun_git() -> Option<PathBuf> {
    let output = std::process::Command::new("/usr/bin/xcrun")
        .args(["--find", "git"])
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let real = PathBuf::from(String::from_utf8(output.stdout).ok()?.trim());
    (real.is_absolute() && is_executable(&real)).then_some(real)
}

fn is_executable(path: &Path) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        path.metadata()
            .is_ok_and(|meta| meta.is_file() && meta.permissions().mode() & 0o111 != 0)
    }
    #[cfg(not(unix))]
    {
        path.is_file()
    }
}

async fn run_git_command(
    workspace_path: &Path,
    args: &[OsString],
    options: GitExecOptions,
) -> ArgmaxResult<GitCommandOutput> {
    let mut command = Command::new(git_program());
    command
        .arg("-C")
        .arg(workspace_path)
        // `core.fsmonitor=true` in a user's global config makes every git
        // invocation start (and then keep alive) a `git fsmonitor--daemon` for
        // the worktree. Argmax drives git across many worktrees, so honouring
        // it accumulates a fleet of daemons that each hold their own FSEvents
        // stream. Argmax already watches these paths itself.
        .arg("-c")
        .arg("core.fsmonitor=false")
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        // Hooks export GIT_DIR. `-C` cannot override it, so a spawn from
        // pre-push would `git config` the app repo and can set `core.bare`.
        // Clear the inherited environment; re-apply only what git needs.
        .env_clear()
        .env("LC_ALL", "C")
        .env("LANG", "C")
        .env("LANGUAGE", "")
        // Read-only commands like `status` opportunistically take `index.lock`
        // to write back a refreshed index. Argmax's reads are frequent and
        // concurrent with the user's own git, where that lock causes contention and
        // spurious failures for no benefit. Commands that genuinely need the
        // lock still take it.
        .env("GIT_OPTIONAL_LOCKS", "0")
        // Every path Argmax hands git is a literal file name. Without this, a
        // Next.js route like `app/[id]/page.tsx` is a glob that also matches
        // `app/i/page.tsx`, so revert/stage/commit would touch both.
        .env("GIT_LITERAL_PATHSPECS", "1");
    if let Some(home) = std::env::var_os("HOME") {
        command.env("HOME", home);
    }
    if let Some(tmpdir) = std::env::var_os("TMPDIR") {
        command.env("TMPDIR", tmpdir);
    }
    // Launched from Finder/Dock, Argmax inherits launchd's stripped PATH, which
    // has no `/opt/homebrew/bin`. Git hooks then can't find the tools they call,
    // and a hook's exit status *is* the command's — so a pre-commit hook that
    // fails to find `lefthook` makes `git commit` exit 127. Hand git the PATH
    // the user's own terminal would give it.
    #[cfg(unix)]
    command.env("PATH", login_shell::path());
    // After the injected PATH, so a caller can still override it.
    for (key, value) in &options.env {
        command.env(key, value);
    }
    if options.stdin.is_some() {
        command.stdin(Stdio::piped());
    }

    let mut child = command.spawn().map_err(|error| {
        ArgmaxError::service("GIT_SPAWN_FAILED", format!("failed to run git: {error}"))
    })?;
    #[cfg(any(test, feature = "test-support"))]
    spawn_counts::record(workspace_path);
    let stdout = child.stdout.take().ok_or_else(|| {
        ArgmaxError::service("GIT_SPAWN_FAILED", "git stdout pipe was unavailable")
    })?;
    let stderr = child.stderr.take().ok_or_else(|| {
        ArgmaxError::service("GIT_SPAWN_FAILED", "git stderr pipe was unavailable")
    })?;
    // Written beside the reads, so a command that answers while it still
    // reads cannot fill its stdout pipe and deadlock against this write. A
    // failed write is held until git exits: git that stopped reading early
    // (a bad argument, a fatal error) says why on stderr.
    let stdin_pipe = child.stdin.take();
    let stdin = async {
        let (Some(input), Some(mut pipe)) = (options.stdin.as_deref(), stdin_pipe) else {
            return Ok(None);
        };
        Ok(pipe.write_all(input).await.err())
    };

    let wait = async {
        time::timeout(options.timeout, child.wait())
            .await
            .map_err(|_| {
                ArgmaxError::service(
                    "GIT_TIMEOUT",
                    format!(
                        "git command timed out after {} ms",
                        options.timeout.as_millis()
                    ),
                )
            })?
            .map_err(|error| {
                ArgmaxError::service(
                    "GIT_WAIT_FAILED",
                    format!("failed to wait for git: {error}"),
                )
            })
    };
    let stdout = async {
        if options.lossy_display {
            read_truncated(stdout, options.stdout_cap_bytes).await
        } else {
            read_capped(stdout, options.stdout_cap_bytes).await
        }
    };
    let stderr = read_truncated(stderr, GIT_STDERR_CAP_BYTES);

    let (status, stdout, stderr, stdin_error) = tokio::try_join!(wait, stdout, stderr, stdin)?;
    if let Some(error) = stdin_error {
        return Err(stdin_write_error(status, &stderr, error));
    }
    Ok(GitCommandOutput {
        status,
        stdout,
        stderr,
    })
}

async fn read_capped<R>(mut reader: R, cap_bytes: usize) -> ArgmaxResult<Vec<u8>>
where
    R: AsyncRead + Unpin,
{
    let mut output = Vec::new();
    let mut buffer = [0_u8; 8192];
    loop {
        let read = reader.read(&mut buffer).await.map_err(|error| {
            ArgmaxError::service(
                "GIT_PIPE_READ_FAILED",
                format!("failed to read git stdout: {error}"),
            )
        })?;
        if read == 0 {
            return Ok(output);
        }
        if output.len() + read > cap_bytes {
            return Err(ArgmaxError::service(
                "GIT_STDOUT_TOO_LARGE",
                format!(
                    "git stdout exceeded {cap_bytes} bytes (received at least {} bytes)",
                    output.len() + read
                ),
            ));
        }
        output.extend_from_slice(&buffer[..read]);
    }
}

async fn read_truncated<R>(mut reader: R, cap_bytes: usize) -> ArgmaxResult<Vec<u8>>
where
    R: AsyncRead + Unpin,
{
    let mut output = Vec::new();
    let mut buffer = [0_u8; 8192];
    loop {
        let read = reader.read(&mut buffer).await.map_err(|error| {
            ArgmaxError::service(
                "GIT_PIPE_READ_FAILED",
                format!("failed to read git output: {error}"),
            )
        })?;
        if read == 0 {
            return Ok(output);
        }
        let remaining = cap_bytes.saturating_sub(output.len());
        if remaining > 0 {
            output.extend_from_slice(&buffer[..read.min(remaining)]);
        }
    }
}

fn collect_args<I, S>(args: I) -> Vec<OsString>
where
    I: IntoIterator<Item = S>,
    S: AsRef<OsStr>,
{
    args.into_iter()
        .map(|arg| arg.as_ref().to_os_string())
        .collect()
}

fn decode_stdout(stdout: Vec<u8>, lossy_display: bool) -> ArgmaxResult<String> {
    if lossy_display {
        return Ok(String::from_utf8_lossy(&stdout).into_owned());
    }
    String::from_utf8(stdout).map_err(|error| {
        ArgmaxError::service(
            "GIT_STDOUT_NOT_UTF8",
            format!("git stdout was not valid UTF-8: {error}"),
        )
    })
}

/// A write to git's stdin that failed. Git that exited non-zero stopped
/// reading for a reason it wrote to stderr, which says more than the pipe.
#[inline(never)]
fn stdin_write_error(status: ExitStatus, stderr: &[u8], error: std::io::Error) -> ArgmaxError {
    if !status.success() {
        return non_zero_error(status.code().unwrap_or(-1), stderr);
    }
    ArgmaxError::service(
        "GIT_PIPE_WRITE_FAILED",
        format!("failed to write git stdin: {error}"),
    )
}

fn non_zero_error(exit_code: i32, stderr: &[u8]) -> ArgmaxError {
    let detail = String::from_utf8_lossy(stderr);
    let detail = detail.trim();
    let detail = if detail.is_empty() {
        format!("git exited with status {exit_code}")
    } else {
        detail.chars().take(ERROR_DETAIL_CAP_BYTES).collect()
    };
    ArgmaxError::service("GIT_NON_ZERO_EXIT", format!("git failed: {detail}"))
}

/// Git processes spawned per checkout, so a test can pin how many git
/// processes an operation costs. Keyed by the canonical path, so tests that
/// run in parallel on their own checkouts do not see each other's spawns.
#[cfg(any(test, feature = "test-support"))]
pub mod spawn_counts {
    use std::{
        collections::HashMap,
        path::{Path, PathBuf},
        sync::{Mutex, OnceLock},
    };

    fn counts() -> &'static Mutex<HashMap<PathBuf, usize>> {
        static COUNTS: OnceLock<Mutex<HashMap<PathBuf, usize>>> = OnceLock::new();
        COUNTS.get_or_init(Default::default)
    }

    fn canonical(path: &Path) -> PathBuf {
        std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
    }

    pub(super) fn record(workspace_path: &Path) {
        let mut counts = counts().lock().unwrap_or_else(|error| error.into_inner());
        *counts.entry(canonical(workspace_path)).or_default() += 1;
    }

    /// Git processes spawned with `-C workspace_path` so far.
    pub fn git_spawns(workspace_path: &Path) -> usize {
        let counts = counts().lock().unwrap_or_else(|error| error.into_inner());
        counts.get(&canonical(workspace_path)).copied().unwrap_or(0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    fn executable(dir: &Path, name: &str) -> PathBuf {
        use std::os::unix::fs::PermissionsExt;
        let path = dir.join(name);
        std::fs::write(&path, "#!/bin/sh\n").unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        path
    }

    // The shim looks up the developer directory on every call: 20.6 ms
    // against 8.2 ms direct for `--version` (measured 2026-11-13).
    #[cfg(target_os = "macos")]
    #[test]
    fn the_xcrun_shim_on_path_resolves_to_the_real_git() {
        let dir = tempfile::tempdir().unwrap();
        let real = executable(dir.path(), "git-real");
        assert_eq!(git_program_on("/usr/bin", || Some(real.clone())), real);
        // With no answer from xcrun the shim is still a working git.
        assert_eq!(git_program_on("/usr/bin", || None), "/usr/bin/git");
    }

    #[cfg(unix)]
    #[test]
    fn a_git_ahead_of_usr_bin_on_path_wins_without_asking_xcrun() {
        let dir = tempfile::tempdir().unwrap();
        let homebrew = executable(dir.path(), "git");
        let path = format!("{}:/usr/bin", dir.path().display());
        assert_eq!(
            git_program_on(&path, || panic!("xcrun asked for a non-shim git")),
            homebrew
        );
    }

    #[tokio::test]
    async fn every_git_spawn_is_counted_against_its_checkout() {
        let dir = tempfile::tempdir().unwrap();
        let before = spawn_counts::git_spawns(dir.path());
        run_git_text(dir.path(), ["--version"], GIT_DEFAULT_TIMEOUT)
            .await
            .unwrap();
        run_git_text_blocking(dir.path(), ["--version"], GIT_DEFAULT_TIMEOUT).unwrap();
        assert_eq!(spawn_counts::git_spawns(dir.path()), before + 2);
    }

    #[tokio::test]
    async fn git_that_stops_reading_stdin_reports_its_own_error() {
        // Far past a pipe buffer, so the write is still running when git
        // rejects the option and exits.
        let input = vec![b'x'; 4 * 1024 * 1024];
        let error = run_git_text_with_options(
            std::env::temp_dir(),
            ["hash-object", "--no-such-option", "--stdin"],
            GitExecOptions::default().with_stdin(input),
        )
        .await
        .expect_err("unknown option");
        let message = error.to_string();
        assert!(message.contains("git failed"), "{message}");
        assert!(!message.contains("failed to write git stdin"), "{message}");
    }
}
