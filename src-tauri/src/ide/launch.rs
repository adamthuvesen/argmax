// IDE launch. Mirrors `src/main/ide/ideLaunch.ts`.
//
// Direct spawn — we never route through `Shell::open` because that hands
// folders to Finder. CLI helpers (`code`, `cursor`, ...) are preferred
// when present so the worktree opens in the existing IDE window;
// otherwise we fall back to `open -a "<App>"`. Terminal targets use
// `osascript` to issue a `do script` with `cd <path>`.
//
// Every child is spawned with stdio inherited from /dev/null and
// detached so closing Argmax does not kill the editor. Success is "the
// child was handed to the OS" — we never await `exit`.

use std::process::{Command, Stdio};

use super::detection::{DetectedIde, IdeId};
use crate::error::{ArgmaxError, ArgmaxResult};

struct CliMapping {
    cli: &'static str,
    app_name: &'static str,
}

fn cli_for(id: IdeId) -> Option<CliMapping> {
    Some(match id {
        IdeId::Vscode => CliMapping {
            cli: "code",
            app_name: "Visual Studio Code",
        },
        IdeId::Cursor => CliMapping {
            cli: "cursor",
            app_name: "Cursor",
        },
        IdeId::Windsurf => CliMapping {
            cli: "windsurf",
            app_name: "Windsurf",
        },
        IdeId::Zed => CliMapping {
            cli: "zed",
            app_name: "Zed",
        },
        IdeId::Terminal | IdeId::Iterm => return None,
    })
}

pub fn launch_ide(ide: IdeId, path: &str, detected: &[DetectedIde]) -> ArgmaxResult<()> {
    if path.is_empty() {
        return Err(ArgmaxError::service(
            "IDE_LAUNCH_EMPTY_PATH",
            "Worktree path is empty.",
        ));
    }
    if path.contains('\n') || path.contains('\r') {
        return Err(ArgmaxError::service(
            "IDE_LAUNCH_INVALID_PATH",
            "Worktree path contains newline characters.",
        ));
    }

    match ide {
        IdeId::Terminal => launch_terminal(path),
        IdeId::Iterm => {
            if detected.iter().any(|entry| entry.id == IdeId::Iterm) {
                launch_iterm(path)
            } else {
                // iTerm picked but not installed: fall through to
                // Terminal so the user still gets a usable shell.
                launch_terminal(path)
            }
        }
        gui => {
            let entry = detected.iter().find(|d| d.id == gui).ok_or_else(|| {
                ArgmaxError::service(
                    "IDE_NOT_INSTALLED",
                    format!("IDE {:?} is not installed.", gui),
                )
            })?;
            let mapping = cli_for(gui).expect("gui ides have CLI mappings");
            if entry.has_cli {
                if spawn_detached(mapping.cli, &[path]).is_ok() {
                    return Ok(());
                }
                // Fall through to `open -a` on spawn failure.
            }
            spawn_detached("open", &["-a", mapping.app_name, path])
        }
    }
}

fn launch_terminal(path: &str) -> ArgmaxResult<()> {
    let script = format!(
        "tell application \"Terminal\" to do script \"cd \" & quoted form of \"{}\"",
        escape_for_osascript(path),
    );
    spawn_detached("osascript", &["-e", &script])
}

fn launch_iterm(path: &str) -> ArgmaxResult<()> {
    let escaped = escape_for_osascript(path);
    let script = format!(
        "tell application \"iTerm\"\n  create window with default profile\n  tell current session of current window to write text \"cd \" & quoted form of \"{escaped}\"\nend tell"
    );
    spawn_detached("osascript", &["-e", &script])
}

/// Escape a path for use inside an AppleScript double-quoted string
/// literal. The AppleScript layer then passes the value through
/// `quoted form of`, which produces a single-quoted shell argument —
/// that's what stops shell metacharacters in the path (`;`, backticks,
/// `$(...)`) from being executed. Newlines are rejected upstream in
/// `launch_ide`.
fn escape_for_osascript(value: &str) -> String {
    value.replace('\\', "\\\\").replace('"', "\\\"")
}

fn spawn_detached(command: &str, args: &[&str]) -> ArgmaxResult<()> {
    let mut cmd = Command::new(command);
    cmd.args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }
    cmd.spawn().map_err(|error| {
        ArgmaxError::service(
            "IDE_LAUNCH_SPAWN_FAILED",
            format!("failed to spawn {command}: {error}"),
        )
    })?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_empty_path() {
        let err = launch_ide(IdeId::Vscode, "", &[]).expect_err("empty path rejected");
        assert!(err.to_string().contains("empty"));
    }

    #[test]
    fn rejects_path_with_newline() {
        let err = launch_ide(IdeId::Vscode, "/tmp/foo\nbar", &[]).expect_err("newline rejected");
        assert!(err.to_string().contains("newline"));
    }

    #[test]
    fn refuses_when_ide_not_detected() {
        let err = launch_ide(IdeId::Vscode, "/tmp", &[]).expect_err("not installed rejected");
        assert!(err.to_string().contains("not installed"));
    }

    #[test]
    fn escape_for_osascript_doubles_backslashes_and_quotes() {
        assert_eq!(escape_for_osascript(r#"a"b"#), "a\\\"b");
        assert_eq!(escape_for_osascript("a\\b"), "a\\\\b");
    }
}
