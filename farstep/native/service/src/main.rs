use clap::{Parser, Subcommand};
use process_wrap::tokio::{CommandWrap, KillOnDrop};
use serde::Deserialize;
use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio_util::sync::CancellationToken;

#[cfg(unix)]
#[path = "unix/unix.rs"]
mod platform;
#[cfg(windows)]
#[allow(
    unsafe_code,
    reason = "Native Win32 service, pipe and job API boundary"
)]
#[path = "windows/windows.rs"]
mod platform;

type Result<T> = std::result::Result<T, Box<dyn std::error::Error + Send + Sync>>;

const MAX_REQUEST_BYTES: usize = 1024 * 1024;
const MAX_OUTPUT_BYTES: u64 = 256 * 1024;
const MAX_COMMAND_BYTES: usize = 120 * 1024;
const MAX_COMMAND_SECONDS: u64 = 3600;
const MAX_CONNECTIONS: usize = 64;
const IO_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);

#[derive(Parser)]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Install and start the privileged service for one account
    Install { owner: String },
    /// Stop and remove the service belonging to this account
    Uninstall { owner: String },
    /// Run under the platform service manager
    Run { owner: String },
    #[cfg(windows)]
    /// Send one stdin request through an authenticated LocalSystem pipe
    Request { owner: String },
}

#[derive(Deserialize)]
#[serde(tag = "operation", rename_all = "lowercase", deny_unknown_fields)]
enum Request {
    Status,
    Exec {
        command: String,
        cwd: String,
        timeout: u64,
    },
}

async fn output(mut stream: impl tokio::io::AsyncRead + Unpin) -> Result<(String, bool)> {
    let mut bytes = Vec::new();
    (&mut stream)
        .take(MAX_OUTPUT_BYTES)
        .read_to_end(&mut bytes)
        .await?;
    let truncated = tokio::io::copy(&mut stream, &mut tokio::io::sink()).await? != 0;
    Ok((String::from_utf8_lossy(&bytes).into_owned(), truncated))
}

async fn execute(command: String, cwd: String, timeout: u64) -> Result<Value> {
    if command.is_empty()
        || command.len() > MAX_COMMAND_BYTES
        || command.contains('\0')
        || !(1..=MAX_COMMAND_SECONDS).contains(&timeout)
        || cwd.contains('\0')
    {
        return Err("Invalid system command or timeout".into());
    }
    let mut process = platform::command(&command, &cwd)?;
    process
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    let mut process = CommandWrap::from(process);
    process.wrap(KillOnDrop);
    #[cfg(unix)]
    process.wrap(process_wrap::tokio::ProcessGroup::leader());
    #[cfg(windows)]
    process.wrap(process_wrap::tokio::JobObject);
    // Kill the whole group/job on disconnect, timeout or service stop
    let mut child = scopeguard::guard(process.spawn()?, |mut child| {
        let _ = child.start_kill();
    });
    let mut stdin = child.stdin().take().ok_or("Child stdin missing")?;
    let stdout = child.stdout().take().ok_or("Child stdout missing")?;
    let stderr = child.stderr().take().ok_or("Child stderr missing")?;
    let work = async {
        tokio::try_join!(
            async {
                stdin.write_all(command.as_bytes()).await?;
                stdin.shutdown().await?;
                drop(stdin);
                Ok::<_, Box<dyn std::error::Error + Send + Sync>>(())
            },
            output(stdout),
            output(stderr),
            async move {
                // Wait for the shell rather than the wrapper's whole tree, then
                // kill descendants before draining their inherited output pipes
                let status = child.inner_mut().wait().await?;
                drop(child);
                Ok::<_, Box<dyn std::error::Error + Send + Sync>>(status)
            },
        )
    };
    let ((), (stdout, stdout_truncated), (stderr, stderr_truncated), status) =
        tokio::time::timeout(std::time::Duration::from_secs(timeout), work)
            .await
            .map_err(|_| "System command exceeded its budget; process tree terminated")??;
    Ok(json!({
        "exitCode": status.code(), "stdout": stdout, "stderr": stderr,
        "stdoutTruncated": stdout_truncated, "stderrTruncated": stderr_truncated,
        "budgetSeconds": timeout,
    }))
}

async fn connection<T>(stream: T, owner: String, stop: CancellationToken)
where
    T: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    let (read, mut write) = tokio::io::split(stream);
    let mut read = BufReader::new(read).take(MAX_REQUEST_BYTES as u64 + 1);
    let mut frame = Vec::new();
    let request = tokio::select! {
        _ = stop.cancelled() => return,
        result = tokio::time::timeout(IO_TIMEOUT, read.read_until(b'\n', &mut frame)) => result,
    };
    if !matches!(request, Ok(Ok(_))) || frame.len() > MAX_REQUEST_BYTES || !frame.ends_with(b"\n") {
        return;
    }
    let reply = async {
        match serde_json::from_slice::<Request>(&frame)? {
            Request::Status => platform::status(&owner),
            Request::Exec {
                command,
                cwd,
                timeout,
            } => execute(command, cwd, timeout).await,
        }
    };
    let mut extra = [0];
    let result: Result<Value> = tokio::select! {
        _ = stop.cancelled() => return,
        // Exactly one request per connection; EOF or extra input cancels work
        _ = read.read(&mut extra) => return,
        result = reply => result,
    };
    let value = match result {
        Ok(value) => json!({"result": value}),
        Err(error) => json!({"error": error.to_string()}),
    };
    if let Ok(mut bytes) = serde_json::to_vec(&value) {
        bytes.push(b'\n');
        let _ = tokio::time::timeout(IO_TIMEOUT, write.write_all(&bytes)).await;
    }
}

fn main() -> std::process::ExitCode {
    let result = match Cli::parse().command {
        Command::Install { owner } => platform::install(&owner),
        Command::Uninstall { owner } => platform::uninstall(&owner),
        Command::Run { owner } => platform::run(owner),
        #[cfg(windows)]
        Command::Request { owner } => platform::request(owner),
    };
    match result {
        Ok(()) => std::process::ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("farstep-service: {error}");
            std::process::ExitCode::FAILURE
        }
    }
}
