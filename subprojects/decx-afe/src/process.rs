//! Shared child-process helper: spawn with piped stdio and a wall-clock
//! timeout. Adb invocations and the external framework tools (debugfs,
//! fsck.erofs, extract.erofs) both need this; the TypeScript code used
//! `spawnSync` with a `timeout` option for the same effect.

use std::io::Write;
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

/// Captured result of a child process.
#[derive(Debug, Clone, Default)]
pub struct ProcessOutput {
    pub stdout: String,
    pub stderr: String,
    pub status: Option<i32>,
    /// Set when the process could not be started at all (for example a
    /// missing binary); `status` is then `None` and `stderr` carries the
    /// message, like Node's `spawnSync` result.
    pub spawn_error: Option<String>,
    /// Set when the timeout elapsed and the process was killed.
    pub timed_out: bool,
}

/// Spawn `command` with piped stdio, drain both pipes on helper threads, and
/// kill the process when `timeout` elapses. Spawn failures are reported in
/// the returned value (never an error) so callers can phrase them the way
/// their contract requires.
pub fn spawn_capture(
    mut command: Command,
    timeout: Duration,
    input: Option<Vec<u8>>,
) -> ProcessOutput {
    command
        .stdin(if input.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let mut child: Child = match command.spawn() {
        Ok(child) => child,
        Err(err) => {
            return ProcessOutput {
                stderr: err.to_string(),
                spawn_error: Some(err.to_string()),
                ..ProcessOutput::default()
            }
        }
    };

    if let Some(bytes) = input {
        if let Some(mut stdin) = child.stdin.take() {
            std::thread::spawn(move || {
                let _ = stdin.write_all(&bytes);
                // Dropping the handle closes the pipe so the child sees EOF.
            });
        }
    }

    let mut stdout_pipe = child.stdout.take();
    let mut stderr_pipe = child.stderr.take();
    let stdout_reader = std::thread::spawn(move || read_all(&mut stdout_pipe));
    let stderr_reader = std::thread::spawn(move || read_all(&mut stderr_pipe));

    let deadline = Instant::now() + timeout;
    let mut timed_out = false;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status.code(),
            Ok(None) => {
                if Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    timed_out = true;
                    break None;
                }
                std::thread::sleep(Duration::from_millis(10));
            }
            Err(_) => break None,
        }
    };

    let stdout = stdout_reader.join().unwrap_or_default();
    let stderr = stderr_reader.join().unwrap_or_default();
    ProcessOutput {
        stdout: String::from_utf8_lossy(&stdout).to_string(),
        stderr: String::from_utf8_lossy(&stderr).to_string(),
        status: if timed_out { None } else { status },
        spawn_error: None,
        timed_out,
    }
}

fn read_all(pipe: &mut Option<impl std::io::Read>) -> Vec<u8> {
    let mut buffer = Vec::new();
    if let Some(reader) = pipe.as_mut() {
        let _ = reader.read_to_end(&mut buffer);
    }
    buffer
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Build a command that runs `script` through the platform shell: POSIX
    /// `sh` on Unix, `cmd /C` on Windows.
    fn shell_command(script: &str) -> Command {
        #[cfg(unix)]
        let (program, flag) = ("/bin/sh", "-c");
        #[cfg(windows)]
        let (program, flag) = ("cmd", "/C");
        let mut command = Command::new(program);
        command.arg(flag).arg(script);
        command
    }

    #[test]
    fn captures_stdout_and_status() {
        #[cfg(unix)]
        let script = "printf out; printf err 1>&2; exit 3";
        #[cfg(windows)]
        let script = "echo out & echo err 1>&2 & exit 3";
        let result = spawn_capture(shell_command(script), Duration::from_secs(10), None);
        // cmd's `echo` appends CRLF, so compare trimmed output.
        assert_eq!(result.stdout.trim(), "out");
        assert_eq!(result.stderr.trim(), "err");
        assert_eq!(result.status, Some(3));
        assert!(result.spawn_error.is_none());
        assert!(!result.timed_out);
    }

    #[test]
    fn missing_binary_reports_spawn_error() {
        let result = spawn_capture(
            Command::new("/definitely/not/a/binary"),
            Duration::from_secs(10),
            None,
        );
        assert!(result.status.is_none());
        assert!(result.spawn_error.is_some());
        assert!(result.stdout.is_empty());
    }

    #[test]
    fn timeout_kills_the_child() {
        // `ping` is the portable cmd equivalent of `sleep`.
        #[cfg(unix)]
        let script = "sleep 30";
        #[cfg(windows)]
        let script = "ping -n 30 127.0.0.1 >NUL";
        let started = Instant::now();
        let result = spawn_capture(shell_command(script), Duration::from_millis(200), None);
        assert!(result.timed_out);
        assert!(result.status.is_none());
        assert!(started.elapsed() < Duration::from_secs(10));
    }
}
