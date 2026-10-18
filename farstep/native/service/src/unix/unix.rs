mod installation;
mod manager;
mod storage;

use std::os::unix::fs::{MetadataExt, PermissionsExt};
use std::path::{Path, PathBuf};

pub use installation::{install, uninstall};
use rustix::process::Uid;
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

use crate::{MAX_CONNECTIONS, Result};

#[cfg(target_os = "linux")]
#[path = "systemd/systemd.rs"]
mod systemd;

fn system_path() -> Result<std::ffi::OsString> {
    // Root jobs use package dependencies and system-managed paths
    // Never inherit a requesting user's executable search path
    std::env::join_paths(
        option_env!("FARSTEP_SERVICE_PATH")
            .into_iter()
            .flat_map(std::env::split_paths)
            .chain(std::env::split_paths(
                "/usr/bin:/bin:/usr/sbin:/sbin:/run/current-system/sw/bin:/nix/var/nix/profiles/\
                 default/bin",
            )),
    )
    .map_err(Into::into)
}

fn uid(owner: &str) -> Result<u32> {
    let uid: u32 = owner.parse()?;
    if uid == 0 || uid.to_string() != owner {
        return Err("Owner must be a non-root numeric UID".into());
    }
    Ok(uid)
}

fn root() -> Result<()> {
    if !rustix::process::geteuid().is_root() {
        return Err("Service management and runtime require root".into());
    }
    Ok(())
}

fn socket(owner: &str) -> PathBuf {
    PathBuf::from(format!("/var/run/farstep-system-{owner}.sock"))
}

fn name(owner: &str) -> String {
    #[cfg(target_os = "linux")]
    return format!("farstep-system-{owner}.service");
    #[cfg(target_os = "macos")]
    return format!("org.farstep.system-{owner}");
}

fn shell() -> Result<PathBuf> {
    // A host shell enters the distro's SELinux service domain where needed
    std::iter::once(PathBuf::from("/bin/bash"))
        .chain(std::env::split_paths(&system_path()?).map(|path| path.join("bash")))
        .find(|path| {
            path.metadata()
                .is_ok_and(|info| info.is_file() && info.mode() & 0o111 != 0)
        })
        .ok_or_else(|| "Bash is missing from the service's executable search path".into())
}

pub fn command(_: &str, cwd: &str) -> Result<tokio::process::Command> {
    if !Path::new(cwd).is_absolute() {
        return Err("System cwd must be absolute".into());
    }
    let mut command = tokio::process::Command::new(shell()?);
    command
        .args(["--noprofile", "--norc", "-s"])
        .current_dir(cwd)
        .env_clear()
        .env("PATH", system_path()?)
        .envs([("USER", "root"), ("LOGNAME", "root"), ("LANG", "C.UTF-8")])
        .env(
            "HOME",
            if cfg!(target_os = "macos") {
                "/var/root"
            } else {
                "/root"
            },
        );
    Ok(command)
}

pub fn status(owner: &str) -> Result<Value> {
    Ok(json!({
        "platform": if cfg!(target_os = "macos") { "darwin" } else { "linux" },
        "uid": uid(owner)?, "enabled": true, "root": true,
        "executable": std::env::current_exe()?,
    }))
}

async fn serve(owner: String) -> Result<()> {
    use std::os::unix::fs::FileTypeExt;
    let uid = uid(&owner)?;
    let path = socket(&owner);
    if let Ok(info) = std::fs::symlink_metadata(&path) {
        if !info.file_type().is_socket() || info.uid() != uid {
            return Err("Refusing an unrelated service socket".into());
        }
        if tokio::net::UnixStream::connect(&path).await.is_ok() {
            return Err("Service is already running".into());
        }
        std::fs::remove_file(&path)?;
    }
    let listener = tokio::net::UnixListener::bind(&path)?;
    let _cleanup = scopeguard::guard(path.clone(), |path| {
        let _ = std::fs::remove_file(path);
    });
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600))?;
    rustix::fs::chown(&path, Some(Uid::from_raw(uid)), None)?;
    let stop = CancellationToken::new();
    let mut term = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())?;
    let mut tasks = tokio::task::JoinSet::new();
    loop {
        tokio::select! {
            _ = term.recv() => break,
            _ = tokio::signal::ctrl_c() => break,
            accepted = listener.accept(), if tasks.len() < MAX_CONNECTIONS => {
                let (stream, _) = accepted?;
                let peer = stream.peer_cred()?.uid();
                if peer == uid || peer == 0 {
                    tasks.spawn(crate::connection(stream, owner.clone(), stop.child_token()));
                }
            },
            Some(_) = tasks.join_next(), if !tasks.is_empty() => {},
        }
    }
    stop.cancel();
    while tasks.join_next().await.is_some() {}
    Ok(())
}

pub fn run(owner: String) -> Result<()> {
    root()?;
    uid(&owner)?;
    tokio::runtime::Runtime::new()?.block_on(serve(owner))
}
