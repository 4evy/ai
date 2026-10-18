mod backend;
#[path = "broker/broker.rs"]
mod broker;
mod capture;
pub(crate) mod clipboard;
#[path = "direct/direct.rs"]
mod direct;
#[path = "eis/eis.rs"]
mod eis;
mod error;
#[path = "keyboard/keyboard.rs"]
mod keyboard;
#[path = "nested/nested.rs"]
mod nested;
#[path = "portal/portal.rs"]
mod portal;
mod protocol;
#[path = "session/session.rs"]
mod session;
#[path = "workspace/workspace.rs"]
pub(crate) mod workspace;

use std::os::unix::fs::{DirBuilderExt, FileTypeExt, MetadataExt, OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use farstep_desktop_runtime::server::{Channel, Shared};
use protocol::{Failure, Result};
use serde_json::{Value, json};
use tokio::net::UnixListener;
use tokio_util::sync::CancellationToken;

const MAX_IDENTITY_BYTES: u64 = 4096;
const MAX_KEYMAP_BYTES: u32 = 16 * 1024 * 1024;
// XKB keycodes include an offset from Linux evdev codes
const XKB_KEYCODE_OFFSET: u32 = 8;
const PRIVATE_OUTPUT: &str = "HEADLESS-1";

pub(super) fn maintenance_gate(
    state: &Path,
) -> Result<scopeguard::ScopeGuard<PathBuf, impl FnOnce(PathBuf) + use<>>> {
    use std::io::Write;
    let path = state.join("maintenance.lock");
    std::fs::DirBuilder::new()
        .mode(0o700)
        .create(&path)
        .map_err(|e| {
            Failure::new(
                if e.kind() == std::io::ErrorKind::AlreadyExists {
                    "busy"
                } else {
                    "prerequisite"
                },
                "Helper maintenance gate unavailable; do not steal a surviving lock",
            )
        })?;
    let gate = scopeguard::guard(path, |path| {
        let _ = std::fs::remove_file(path.join("owner.json"));
        let _ = std::fs::remove_dir(path);
    });
    let mut owner = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(gate.join("owner.json"))
        .map_err(|e| Failure::new("prerequisite", e))?;
    owner
        .write_all(json!({"pid": std::process::id()}).to_string().as_bytes())
        .map_err(|e| Failure::new("prerequisite", e))?;
    Ok(gate)
}

fn private_directory(path: &Path) -> Result<()> {
    std::fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(path)
        .map_err(|e| Failure::new("prerequisite", e))?;
    let metadata = std::fs::symlink_metadata(path).map_err(|e| Failure::new("prerequisite", e))?;
    if !metadata.is_dir()
        || metadata.uid() != rustix::process::geteuid().as_raw()
        || metadata.mode() & 0o077 != 0
    {
        return Err(Failure::new(
            "prerequisite",
            "Helper directory must be owned by this UID and mode 0700",
        ));
    }
    Ok(())
}

pub(crate) async fn daemon() -> Result<()> {
    let paths = DaemonPaths::prepare()?;
    let installation_id = installation_id(&paths.state)?;
    let socket = paths.runtime.join("desktop.sock");
    prepare_socket(&socket).await?;
    if nested::cosmic() {
        return nested::run().await;
    }
    if std::env::var("FARSTEP_NESTED_DESKTOP").as_deref() == Ok("cosmic") {
        direct::Direct::private().await?;
    }
    let mut broker = broker::Broker::start().await?;
    let listener = listen(&socket)?;
    let shared = Shared::new(backend::Linux, paths.state, installation_id);
    let shutdown = shutdown_signal();
    let broker_failed = serve(&listener, &shared, &shutdown, &mut broker).await?;
    if let Some(broker) = broker {
        broker.stop().await;
    }
    let _ = std::fs::remove_file(socket);
    if broker_failed {
        return Err(Failure::new("disconnected", "Workspace broker stopped"));
    }
    Ok(())
}

struct DaemonPaths {
    runtime: PathBuf,
    state: PathBuf,
}

impl DaemonPaths {
    fn prepare() -> Result<Self> {
        let runtime = dirs::runtime_dir()
            .ok_or_else(|| Failure::new("prerequisite", "XDG_RUNTIME_DIR is missing"))?
            .join("farstep");
        let state = dirs::state_dir()
            .ok_or_else(|| Failure::new("prerequisite", "User state directory is missing"))?
            .join("farstep");
        for path in [&runtime, &state] {
            private_directory(path)?;
        }
        Ok(DaemonPaths { runtime, state })
    }
}

fn installation_id(state: &Path) -> Result<String> {
    let identity = state.join("installation.json");
    let metadata =
        std::fs::symlink_metadata(&identity).map_err(|e| Failure::new("prerequisite", e))?;
    if !metadata.is_file()
        || metadata.uid() != rustix::process::geteuid().as_raw()
        || metadata.mode() & 0o077 != 0
        || metadata.len() > MAX_IDENTITY_BYTES
    {
        return Err(Failure::new(
            "prerequisite",
            "Installation identity must be private, owned and bounded",
        ));
    }
    let identity: Value = serde_json::from_slice(
        &std::fs::read(identity).map_err(|e| Failure::new("prerequisite", e))?,
    )
    .map_err(|e| Failure::new("prerequisite", e))?;
    let installation_id = identity
        .get("installationId")
        .and_then(Value::as_str)
        .filter(|id| uuid::Uuid::parse_str(id).is_ok())
        .ok_or_else(|| {
            Failure::new(
                "prerequisite",
                "Installer has not created a valid installation UUID",
            )
        })?
        .to_owned();
    Ok(installation_id)
}

async fn prepare_socket(socket: &Path) -> Result<()> {
    if let Ok(metadata) = std::fs::symlink_metadata(socket) {
        if !metadata.file_type().is_socket()
            || metadata.uid() != rustix::process::geteuid().as_raw()
        {
            return Err(Failure::new(
                "prerequisite",
                "Refusing unrelated desktop socket path",
            ));
        }
        if tokio::net::UnixStream::connect(&socket).await.is_ok() {
            return Err(Failure::new(
                "busy",
                "Desktop daemon already listens on this socket",
            ));
        }
        std::fs::remove_file(socket).map_err(|e| Failure::new("prerequisite", e))?;
    }
    Ok(())
}

fn listen(socket: &Path) -> Result<UnixListener> {
    let listener = UnixListener::bind(socket).map_err(|e| Failure::new("prerequisite", e))?;
    std::fs::set_permissions(socket, std::fs::Permissions::from_mode(0o600))
        .map_err(|e| Failure::new("prerequisite", e))?;
    if let Some(ready) = std::env::var_os("FARSTEP_NESTED_READY") {
        std::fs::write(ready, std::process::id().to_string())
            .map_err(|error| Failure::new("prerequisite", error))?;
    }
    Ok(listener)
}

fn shutdown_signal() -> CancellationToken {
    let shutdown = CancellationToken::new();
    let stopping = shutdown.clone();
    tokio::spawn(async move {
        let mut term =
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()).ok();
        tokio::select! {
            _ = tokio::signal::ctrl_c() => {},
            Some(_) = async { term.as_mut()?.recv().await } => {},
        }
        stopping.cancel();
    });
    shutdown
}

async fn serve(
    listener: &UnixListener,
    shared: &Arc<Shared>,
    shutdown: &CancellationToken,
    broker: &mut Option<broker::Broker>,
) -> Result<bool> {
    let mut tasks = tokio::task::JoinSet::new();
    let mut broker_failed = false;
    loop {
        tokio::select! {
            _ = shutdown.cancelled() => break,
            Some(()) = async {
                broker.as_mut()?.exited().await;
                Some(())
            } => {
                broker_failed = true;
                shutdown.cancel();
                break;
            },
            connection = listener.accept() => {
                let (stream, _) = connection.map_err(|e| Failure::new("disconnected", e))?;
                if stream
                    .peer_cred()
                    .map_err(|e| Failure::new("disconnected", e))?
                    .uid()
                    != rustix::process::geteuid().as_raw()
                {
                    continue;
                }
                let channel = Channel::new(shared.clone(), shutdown.child_token());
                tasks.spawn(async move {
                    let (read, write) = stream.into_split();
                    channel.serve_connection(read, write).await;
                });
            },
            Some(_) = tasks.join_next(), if !tasks.is_empty() => {},
        }
    }
    while tasks.join_next().await.is_some() {}
    Ok(broker_failed)
}
