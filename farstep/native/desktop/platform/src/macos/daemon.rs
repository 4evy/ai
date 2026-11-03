use std::os::unix::fs::{MetadataExt, PermissionsExt};
use std::sync::Arc;

use farstep_desktop_runtime::server::Shared;
use farstep_protocol::{Failure, Result};
use tokio_util::sync::CancellationToken;

use super::storage::{effective_uid, protect_directory, runtime};
use crate::native::{failure, serve};

const PACKAGE_ROOT_DEPTH: usize = 5;

pub fn gateway(args: &[String]) -> Result<()> {
    let executable = std::env::current_exe().map_err(failure)?;
    let root = executable
        .ancestors()
        .nth(PACKAGE_ROOT_DEPTH)
        .ok_or_else(|| failure("Gateway must run from Farstep.app"))?;
    let mut command = std::process::Command::new(root.join("bin/bun"));
    command
        .arg(root.join("lib/farstep/farstep/runtime/main.ts"))
        .args(args)
        .env("FARSTEP_PACKAGE_PATH", root);
    // Retain the app process as the responsible TCC identity for child jobs
    let status = command.status().map_err(failure)?;
    std::process::exit(status.code().unwrap_or(1));
}

pub async fn daemon(shared: Result<Arc<Shared>>) -> Result<()> {
    let shared = shared?;
    let runtime = runtime()?;
    protect_directory(&runtime)?;
    let socket = runtime.join("desktop.sock");
    if let Ok(info) = std::fs::symlink_metadata(&socket) {
        use std::os::unix::fs::FileTypeExt;
        if !info.file_type().is_socket() || info.uid() != effective_uid() {
            return Err(failure("Refusing unrelated socket"));
        }
        if tokio::net::UnixStream::connect(&socket).await.is_ok() {
            return Err(Failure::new("busy", "Desktop daemon is already running"));
        }
        std::fs::remove_file(&socket).map_err(failure)?;
    }
    let listener = tokio::net::UnixListener::bind(&socket).map_err(failure)?;
    std::fs::set_permissions(&socket, std::fs::Permissions::from_mode(0o600)).map_err(failure)?;
    let shutdown = CancellationToken::new();
    let mut term = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
        .map_err(failure)?;
    let mut tasks = tokio::task::JoinSet::new();
    loop {
        tokio::select! {
            _ = tokio::signal::ctrl_c() => break,
            _ = term.recv() => break,
            connection = listener.accept() => {
                let (stream, _) = connection.map_err(failure)?;
                if stream.peer_cred().map_or(true, |peer| peer.uid() != effective_uid()) {
                    continue;
                }
                tasks.spawn(serve(stream, shared.clone(), shutdown.child_token()));
            }
            Some(_) = tasks.join_next(), if !tasks.is_empty() => {}
        }
    }
    shutdown.cancel();
    while tasks.join_next().await.is_some() {}
    let _ = std::fs::remove_file(socket);
    Ok(())
}
