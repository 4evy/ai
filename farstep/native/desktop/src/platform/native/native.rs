#[path = "keyboard/keyboard.rs"]
mod keyboard;
#[path = "session/session.rs"]
mod session;

use std::path::{Path, PathBuf};

use clap::Parser;
use farstep_desktop_runtime::backend::{Backend, DesktopSession, SessionInfo, WorkspaceLease};
use farstep_desktop_runtime::server::{Channel, Shared};
use farstep_protocol::*;
use tokio_util::sync::CancellationToken;

#[cfg(target_os = "macos")]
use crate::macos as os;
#[cfg(target_os = "windows")]
use crate::windows as os;

#[derive(Clone, Debug, PartialEq)]
pub struct Bounds {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub pixels_width: u32,
    pub pixels_height: u32,
}

pub fn failure(error: impl ToString) -> Failure {
    Failure::new("native-backend", error)
}

pub use farstep_desktop_runtime::image::encode;

pub struct Native;

#[async_trait::async_trait]
impl Backend for Native {
    fn platform(&self) -> &'static str {
        os::PLATFORM
    }

    fn maintenance_gate(&self, state: &Path) -> Result<Box<dyn Send>> {
        let path = state.join("maintenance.lock");
        let builder = std::fs::DirBuilder::new();
        #[cfg(target_os = "macos")]
        let builder = {
            use std::os::unix::fs::DirBuilderExt;
            let mut builder = builder;
            builder.mode(0o700);
            builder
        };
        builder.create(&path).map_err(|e| Failure::new("busy", e))?;
        let gate = scopeguard::guard(path, |path| {
            let _ = std::fs::remove_file(path.join("owner.json"));
            let _ = std::fs::remove_dir(path);
        });
        os::protect_directory(&gate)?;
        std::fs::write(
            gate.join("owner.json"),
            serde_json::json!({"pid": std::process::id()}).to_string(),
        )
        .map_err(failure)?;
        Ok(Box::new(gate))
    }

    async fn inspect(&self, session: Option<SessionInfo>) -> Result<Inspection> {
        let capture = os::capture_granted();
        let input = os::input_granted();
        #[cfg(target_os = "macos")]
        let open = os::workspace::available();
        #[cfg(target_os = "windows")]
        let open = false;
        Ok(Inspection {
            status: "ok",
            operations: [
                (
                    "capture",
                    capture,
                    os::PERMISSION_PROMPTS,
                    "Screen recording permission or an interactive desktop is required",
                ),
                (
                    "keyboard",
                    input,
                    os::PERMISSION_PROMPTS,
                    "Accessibility permission or an interactive desktop is required",
                ),
                (
                    "pointer",
                    input,
                    os::PERMISSION_PROMPTS,
                    "Accessibility permission or an interactive desktop is required",
                ),
                (
                    "clipboard",
                    false,
                    false,
                    "Text is submitted using native Unicode events without replacing the clipboard",
                ),
                (
                    "open",
                    open,
                    false,
                    "An interactive desktop with a Space adapter and Accessibility access is \
                     required for owned isolated launches",
                ),
            ]
            .into_iter()
            .map(
                |(operation, granted, requestable, reason)| OperationAvailability {
                    operation,
                    available: granted || requestable,
                    requestable,
                    granted,
                    backend: Some(os::BACKEND.to_owned()),
                    reason: (!granted).then(|| reason.to_owned()),
                },
            )
            .collect(),
            sources: vec![Source::Monitor, Source::Window],
            session_id: session.map(|s| s.id),
        })
    }

    async fn create_session(
        &self,
        source: Source,
        control: bool,
        output_name: Option<&str>,
        _state: &Path,
    ) -> Result<Box<dyn DesktopSession>> {
        os::authorize(control)?;
        #[cfg(target_os = "macos")]
        let target = os::Target::select(&source, output_name).await?;
        #[cfg(target_os = "windows")]
        let target = os::Target::select(&source, output_name)?;
        Ok(Box::new(session::Session::new(source, target, control)?))
    }

    #[cfg(target_os = "macos")]
    async fn open(&self, uri: &str) -> Result<Box<dyn WorkspaceLease>> {
        Ok(Box::new(os::workspace::Lease::open(uri).await?))
    }

    #[cfg(target_os = "windows")]
    async fn open(&self, _: &str) -> Result<Box<dyn WorkspaceLease>> {
        Err(Failure::new(
            "unsupported-operation",
            "This platform cannot lease an isolated workspace",
        ))
    }
}

fn state() -> Result<PathBuf> {
    os::state()
}

fn shared() -> Result<std::sync::Arc<Shared>> {
    let state = state()?;
    os::protect_directory(&state)?;
    let value: serde_json::Value =
        serde_json::from_slice(&std::fs::read(state.join("installation.json")).map_err(failure)?)
            .map_err(failure)?;
    let id = value
        .get("installationId")
        .and_then(serde_json::Value::as_str)
        .filter(|id| uuid::Uuid::parse_str(id).is_ok())
        .ok_or_else(|| {
            Failure::new(
                "prerequisite",
                "Run farstep install before starting the desktop daemon",
            )
        })?;
    Ok(Shared::new(Native, state, id.to_owned()))
}

#[derive(Parser)]
struct Cli {
    #[command(subcommand)]
    command: Option<Command>,
}

#[derive(clap::Subcommand)]
enum Command {
    Daemon,
    Permissions,
    Inspect,
    Sources,
    #[cfg(target_os = "macos")]
    #[command(subcommand)]
    Workspace(Workspace),
    #[command(disable_help_flag = true)]
    Gateway {
        #[arg(trailing_var_arg = true, allow_hyphen_values = true)]
        arguments: Vec<String>,
    },
}

#[cfg(target_os = "macos")]
#[derive(clap::Subcommand)]
enum Workspace {
    Inspect,
    Host { id: String, uri: String },
}

pub async fn run() -> Result<i32> {
    let result = match Cli::parse().command {
        #[cfg(target_os = "macos")]
        None => os::permissions(),
        Some(Command::Daemon) => os::daemon(shared()).await,
        Some(Command::Permissions) => os::permissions(),
        Some(Command::Inspect) => Native.inspect(None).await.and_then(|v| {
            println!("{}", serde_json::to_string(&v).map_err(failure)?);
            Ok(())
        }),
        #[cfg(target_os = "macos")]
        Some(Command::Sources) => os::sources().await,
        #[cfg(target_os = "windows")]
        Some(Command::Sources) => os::sources(),
        #[cfg(target_os = "macos")]
        Some(Command::Workspace(Workspace::Inspect)) => os::workspace::inspect(),
        #[cfg(target_os = "macos")]
        Some(Command::Workspace(Workspace::Host { id, uri })) => {
            os::workspace::host(&id, &uri).await
        }
        Some(Command::Gateway { arguments }) => os::gateway(&arguments),
        #[cfg(target_os = "windows")]
        None => Err(Failure::new(
            "invalid-request",
            "Usage: farstep-desktop daemon|permissions|inspect|sources|gateway",
        )),
    };
    result.map(|()| 0)
}

pub async fn serve<T>(stream: T, shared: std::sync::Arc<Shared>, shutdown: CancellationToken)
where
    T: tokio::io::AsyncRead + tokio::io::AsyncWrite + Send + Unpin + 'static,
{
    let (read, write) = tokio::io::split(stream);
    Channel::new(shared, shutdown)
        .serve_connection(read, write)
        .await;
}
