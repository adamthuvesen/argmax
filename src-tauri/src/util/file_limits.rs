use nix::sys::resource::{getrlimit, setrlimit, Resource};

/// GUI launches can inherit a 256-descriptor soft limit. Raise it before
/// starting services so provider processes and their tools inherit headroom.
pub fn raise_open_file_limit() -> Result<(), nix::errno::Errno> {
    let (soft, hard) = getrlimit(Resource::RLIMIT_NOFILE)?;
    let target = hard.min(8192);
    if soft < target {
        setrlimit(Resource::RLIMIT_NOFILE, target, hard)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs::File;
    use std::process::Command;

    #[test]
    fn raises_limit_in_an_isolated_process() {
        const CHILD: &str = "ARGMAX_FILE_LIMIT_TEST_CHILD";
        if std::env::var_os(CHILD).is_some() {
            let (_, hard) = getrlimit(Resource::RLIMIT_NOFILE).unwrap();
            assert!(hard >= 512, "test requires a hard limit of at least 512");
            setrlimit(Resource::RLIMIT_NOFILE, 256, hard).unwrap();
            let mut files = Vec::new();
            loop {
                match File::open("/dev/null") {
                    Ok(file) => files.push(file),
                    Err(error) => {
                        assert_eq!(error.raw_os_error(), Some(nix::libc::EMFILE));
                        break;
                    }
                }
            }
            raise_open_file_limit().unwrap();
            for _ in 0..128 {
                files.push(File::open("/dev/null").expect("headroom after raising limit"));
            }
            drop(files);
            let (soft, new_hard) = getrlimit(Resource::RLIMIT_NOFILE).unwrap();
            assert_eq!(soft, hard.min(8192));
            assert_eq!(new_hard, hard);
            let output = Command::new("/bin/sh")
                .args(["-c", "ulimit -Sn"])
                .output()
                .unwrap();
            assert!(output.status.success());
            assert_eq!(
                String::from_utf8(output.stdout).unwrap().trim(),
                soft.to_string()
            );

            if hard >= 16384 {
                setrlimit(Resource::RLIMIT_NOFILE, 16384, hard).unwrap();
                raise_open_file_limit().unwrap();
                assert_eq!(getrlimit(Resource::RLIMIT_NOFILE).unwrap(), (16384, hard));
            }

            // Respect a lower hard limit.
            setrlimit(Resource::RLIMIT_NOFILE, 256, 512).unwrap();
            raise_open_file_limit().unwrap();
            assert_eq!(getrlimit(Resource::RLIMIT_NOFILE).unwrap(), (512, 512));
            return;
        }
        let status = Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "util::file_limits::tests::raises_limit_in_an_isolated_process",
                "--nocapture",
            ])
            .env(CHILD, "1")
            .status()
            .unwrap();
        assert!(status.success());
    }
}
