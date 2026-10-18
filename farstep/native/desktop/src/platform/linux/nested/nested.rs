use std::path::PathBuf;

use backon::{ConstantBuilder, Retryable};
use procfs::process::Process;

pub(super) mod capture;

use super::MAX_IDENTITY_BYTES;
use super::protocol::{Failure, Result};

const SUPERVISOR_WAIT: ConstantBuilder = ConstantBuilder::new()
    .with_delay(std::time::Duration::from_millis(50))
    .with_max_times(20 - 1);
const STOP_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(7);

pub fn cosmic() -> bool {
    std::env::var("XDG_CURRENT_DESKTOP").is_ok_and(|desktop| {
        desktop
            .split(':')
            .any(|name| name.eq_ignore_ascii_case("COSMIC"))
    })
}

pub async fn run() -> Result<()> {
    let helper = std::env::current_exe().map_err(|error| Failure::new("prerequisite", error))?;
    let package = std::env::var_os("FARSTEP_PACKAGE_PATH")
        .map(PathBuf::from)
        .or_else(|| helper.parent()?.parent().map(PathBuf::from))
        .ok_or_else(|| Failure::new("prerequisite", "Farstep package path is missing"))?;
    let resources = package.join("share/farstep");
    let script = resources.join("nested/main.js");
    if !script.is_file() {
        return Err(Failure::new(
            "prerequisite",
            "Nested desktop resources are missing",
        ));
    }
    let supervisor = dirs::runtime_dir()
        .ok_or_else(|| Failure::new("prerequisite", "XDG_RUNTIME_DIR is missing"))?
        .join("farstep")
        .join(format!("nested-supervisor-{}.json", uuid::Uuid::new_v4()));
    let supervisor = scopeguard::guard(supervisor, |path| {
        let _ = std::fs::remove_file(path);
    });
    let mut launcher = tokio::process::Command::new("dbus-run-session");
    if let Some(configuration) = std::env::var_os("FARSTEP_WORKSPACE_DBUS_CONFIG") {
        launcher.arg("--config-file").arg(configuration);
    }
    let mut child = launcher
        .env("FARSTEP_NESTED_SUPERVISOR", supervisor.as_os_str())
        .args(["--", "gjs", "-m"])
        .arg(script)
        .arg(helper)
        .arg(resources)
        .process_group(0)
        .kill_on_drop(true)
        .spawn()
        .map_err(|error| Failure::new("prerequisite", error))?;
    let mut terminate = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
        .map_err(|error| Failure::new("prerequisite", error))?;
    let interrupted = tokio::select! {
        status = child.wait() => Some(status),
        _ = terminate.recv() => None,
        _ = tokio::signal::ctrl_c() => None,
    };
    let requested_stop = interrupted.is_none();
    let status = if let Some(status) = interrupted {
        status
    } else {
        stop(&mut child, &supervisor).await
    }
    .map_err(|error| Failure::new("backend-error", error))?;
    if requested_stop || status.success() {
        Ok(())
    } else {
        Err(Failure::new(
            "backend-error",
            format!("Nested desktop exited: {status}"),
        ))
    }
}

async fn stop(
    child: &mut tokio::process::Child,
    supervisor: &std::path::Path,
) -> std::io::Result<std::process::ExitStatus> {
    let group = child
        .id()
        .and_then(|pid| rustix::process::Pid::from_raw(pid as i32));
    if let Some(group) = group {
        // Keep the private bus alive while the supervisor drains scopes
        let stopped = (|| async { supervisor_pid(supervisor, group).ok_or(()) })
            .retry(SUPERVISOR_WAIT)
            .await;
        match stopped {
            Ok(pid) => {
                let _ = rustix::process::kill_process(pid, rustix::process::Signal::TERM);
            }
            Err(()) => {
                let _ = rustix::process::kill_process_group(group, rustix::process::Signal::TERM);
            }
        }
    }
    match tokio::time::timeout(STOP_TIMEOUT, child.wait()).await {
        Ok(status) => status,
        Err(_) => {
            if let Some(group) = group {
                let _ = rustix::process::kill_process_group(group, rustix::process::Signal::KILL);
            }
            child.wait().await
        }
    }
}

fn supervisor_pid(
    path: &std::path::Path,
    group: rustix::process::Pid,
) -> Option<rustix::process::Pid> {
    use std::os::unix::fs::MetadataExt;

    let metadata = std::fs::symlink_metadata(path).ok()?;
    if !metadata.is_file()
        || metadata.uid() != rustix::process::geteuid().as_raw()
        || metadata.mode() & 0o077 != 0
        || metadata.len() > MAX_IDENTITY_BYTES
    {
        return None;
    }
    let identity: serde_json::Value = serde_json::from_slice(&std::fs::read(path).ok()?).ok()?;
    let pid = identity["pid"]
        .as_u64()
        .filter(|pid| *pid <= i32::MAX as u64)?;
    let pid = rustix::process::Pid::from_raw(pid as i32)?;
    if rustix::process::getpgid(Some(pid)).ok()? != group {
        return None;
    }
    let start = Process::new(pid.as_raw_nonzero().get())
        .ok()?
        .stat()
        .ok()?
        .starttime;
    (identity["startTime"].as_str()? == start.to_string()).then_some(pid)
}
