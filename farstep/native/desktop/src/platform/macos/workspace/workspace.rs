use std::io::{self, Write};
use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
use std::process::Stdio;
use std::time::Duration;

use farstep_desktop_runtime::backend::WorkspaceLease;
use farstep_protocol::{Failure, MAX_REQUEST, Result};
use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, BufReader};
use tokio::process::{Child, ChildStdin, ChildStdout, Command};

use super::{protect_directory, state};
use crate::native::failure;

mod browser;
mod devtools;
mod process;

use browser::{Browser, prepare};
#[path = "spaces/spaces.rs"]
mod spaces;

const PREPARE_TIMEOUT: Duration = Duration::from_secs(30);
const CLEANUP_TIMEOUT: Duration = Duration::from_secs(15);

fn prerequisite(error: impl ToString) -> Failure {
    Failure::new("prerequisite", error)
}

pub fn available() -> bool {
    spaces::available().unwrap_or(false)
}

pub fn inspect() -> Result<()> {
    println!(
        "{}",
        serde_json::to_string(&spaces::snapshot()?).map_err(failure)?
    );
    Ok(())
}

// Serialize Dock mutations across helpers without holding a lock for the
// lifetime of a lease; existing user-created Spaces are never adopted
fn mutate<T>(operation: impl FnOnce() -> Result<T>) -> Result<T> {
    let state = state()?;
    protect_directory(&state)?;
    let file = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(state.join("workspaces.lock"))
        .map_err(failure)?;
    let metadata = file.metadata().map_err(failure)?;
    let uid = rustix::process::geteuid().as_raw();
    if !metadata.is_file() || metadata.uid() != uid || metadata.mode() & 0o077 != 0 {
        return Err(prerequisite("Workspace lock is not private and owned"));
    }
    file.lock().map_err(failure)?;
    operation()
}

fn report(value: &Value) -> Result<()> {
    let mut output = io::stdout().lock();
    writeln!(output, "{value}").map_err(failure)?;
    output.flush().map_err(failure)
}

// A dedicated helper owns the browser and observes stdin EOF, including daemon
// crashes and cancellation before readiness, without depending on a live lease
pub async fn host(id: &str, uri: &str) -> Result<()> {
    let mut browser = Browser::default();
    let mut input = process::owner_input()?;
    let mut byte = [0];
    let mut terminate = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
        .map_err(failure)?;
    let mut interrupt = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::interrupt())
        .map_err(failure)?;
    let result = tokio::select! {
        result = prepare(uri, &mut browser) => result,
        _ = input.read(&mut byte) => Err(prerequisite("Workspace owner disconnected before readiness")),
        _ = terminate.recv() => Err(prerequisite("Workspace launch was terminated")),
        _ = interrupt.recv() => Err(prerequisite("Workspace launch was interrupted")),
    };
    match result {
        Ok(()) => {
            report(
                &json!({"status": "ok", "workspaceId": id, "space": browser.space, "pid": browser.pid()}),
            )?;
            tokio::select! {
                _ = input.read(&mut byte) => {},
                _ = terminate.recv() => {},
                _ = interrupt.recv() => {},
            }
            let result = browser.stop();
            report(&match result {
                Ok(()) => json!({"status": "ok"}),
                Err(error) => error.value(),
            })
        }
        Err(error) => {
            let result = match browser.stop() {
                Ok(()) => error,
                Err(cleanup) => Failure::new(
                    error.code,
                    format!("{}; cleanup: {}", error.message, cleanup.message),
                ),
            };
            report(&result.value())
        }
    }
}

pub struct Lease {
    id: String,
    child: Child,
    input: Option<ChildStdin>,
    output: BufReader<ChildStdout>,
}

impl Lease {
    pub async fn open(uri: &str) -> Result<Self> {
        let id = uuid::Uuid::new_v4().to_string();
        let mut child = Command::new(std::env::current_exe().map_err(failure)?)
            .args(["workspace", "host", &id, uri])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .map_err(failure)?;
        let input = child.stdin.take();
        let output = child
            .stdout
            .take()
            .ok_or_else(|| failure("Workspace helper stdout is missing"))?;
        let mut lease = Self {
            id,
            child,
            input,
            output: BufReader::new(output),
        };
        let result = tokio::time::timeout(PREPARE_TIMEOUT, lease.response())
            .await
            .map_err(|_| prerequisite("Timed out preparing the isolated workspace"))??;
        if result["workspaceId"] != lease.id {
            return Err(prerequisite(
                "Workspace helper returned another lease identity",
            ));
        }
        Ok(lease)
    }

    async fn response(&mut self) -> Result<Value> {
        let mut response = String::new();
        let length = (&mut self.output)
            .take(MAX_REQUEST as u64 + 1)
            .read_line(&mut response)
            .await
            .map_err(failure)?;
        if length == 0 || length > MAX_REQUEST || !response.ends_with('\n') {
            return Err(prerequisite(
                "Workspace helper closed or exceeded its response limit",
            ));
        }
        let value: Value = serde_json::from_str(&response).map_err(failure)?;
        if value["status"] != "ok" {
            return Err(Failure::new(
                if value["code"] == "workspace-retained" {
                    "workspace-retained"
                } else if value["code"] == "unsupported-operation" {
                    "unsupported-operation"
                } else {
                    "prerequisite"
                },
                value["message"]
                    .as_str()
                    .unwrap_or("Workspace helper failed"),
            ));
        }
        Ok(value)
    }
}

#[async_trait::async_trait]
impl WorkspaceLease for Lease {
    fn id(&self) -> &str {
        &self.id
    }

    async fn release(mut self: Box<Self>) -> Result<()> {
        self.input.take();
        let result = tokio::time::timeout(CLEANUP_TIMEOUT, self.response())
            .await
            .map_err(|_| prerequisite("Timed out cleaning up the isolated workspace"))?;
        self.child.wait().await.map_err(failure)?;
        result.map(|_| ())
    }
}
