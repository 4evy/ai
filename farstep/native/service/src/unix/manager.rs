use std::path::PathBuf;
#[cfg(target_os = "linux")]
use std::process::Command;
#[cfg(target_os = "macos")]
use std::process::Command;

use backon::{ConstantBuilder, Retryable};
use serde_json::Value;

use super::storage::{directory, marker};
use super::{name, shell, socket, uid};
#[cfg(target_os = "linux")]
use super::{system_path, systemd};
use crate::Result;

const HEALTH_POLL_INTERVAL: std::time::Duration = std::time::Duration::from_millis(100);
const HEALTH_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);

pub(super) fn unit(owner: &str) -> PathBuf {
    #[cfg(target_os = "linux")]
    return PathBuf::from("/etc/systemd/system").join(name(owner));
    #[cfg(target_os = "macos")]
    return PathBuf::from("/Library/LaunchDaemons").join(format!("{}.plist", name(owner)));
}

#[cfg(target_os = "macos")]
fn manager(args: &[&str], allow_failure: bool) -> Result<()> {
    let output = Command::new("/bin/launchctl").args(args).output()?;
    if !output.status.success() && !allow_failure {
        return Err(format!("launchctl: {}", String::from_utf8_lossy(&output.stderr)).into());
    }
    Ok(())
}

pub(super) fn stop(owner: &str) -> Result<()> {
    #[cfg(target_os = "linux")]
    return systemd::manage(owner, systemd::Action::Stop, true);
    #[cfg(target_os = "macos")]
    return manager(&["bootout", &format!("system/{}", name(owner))], true);
}

pub(super) fn start(owner: &str) -> Result<()> {
    #[cfg(target_os = "linux")]
    {
        systemd::manage(owner, systemd::Action::Reload, false)?;
        systemd::manage(owner, systemd::Action::Enable, false)?;
        systemd::manage(owner, systemd::Action::Start, false)
    }
    #[cfg(target_os = "macos")]
    {
        manager(&["enable", &format!("system/{}", name(owner))], false)?;
        manager(
            &["bootstrap", "system", &unit(owner).to_string_lossy()],
            false,
        )
    }
}

pub(super) fn definition(owner: &str) -> Result<String> {
    let binary = directory(owner).join("farstep-service");
    #[cfg(target_os = "linux")]
    let template = include_str!("systemd.service.in");
    #[cfg(target_os = "macos")]
    let template = include_str!("agent.plist");

    // Expand source placeholders once so inserted paths remain literal
    template
        .split('@')
        .enumerate()
        .map(|(index, part)| {
            if index % 2 == 0 {
                return Ok(part.to_owned());
            }
            match part {
                "MARKER" => Ok(marker(owner)),
                "NAME" => Ok(name(owner)),
                "BINARY" => Ok(binary.display().to_string()),
                "SHELL" => Ok(shell()?.display().to_string()),
                "OWNER" => Ok(owner.to_owned()),
                _ => Err(format!("Unknown service template placeholder: {part}").into()),
            }
        })
        .collect()
}

pub(super) fn labels(owner: &str) -> Result<()> {
    #[cfg(target_os = "linux")]
    {
        // Atomic replacement creates new inodes, so restore their labels
        match Command::new("restorecon")
            .env("PATH", system_path()?)
            .arg("-R")
            .arg(directory(owner))
            .arg(unit(owner))
            .output()
        {
            Ok(output) if !output.status.success() => {
                return Err(String::from_utf8_lossy(&output.stderr).into_owned().into());
            }
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
    }
    #[cfg(target_os = "macos")]
    let _ = owner;
    Ok(())
}

pub(super) fn healthy(owner: &str) -> Result<()> {
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
    tokio::runtime::Runtime::new()?.block_on(async {
        let expected = std::fs::canonicalize(directory(owner).join("farstep-service"))?;
        let probe = async {
            let mut stream = (|| tokio::net::UnixStream::connect(socket(owner)))
                .retry(
                    ConstantBuilder::new()
                        .with_delay(HEALTH_POLL_INTERVAL)
                        .without_max_times(),
                )
                .await?;
            if stream.peer_cred()?.uid() != 0 {
                return Err("Service peer must run as root".into());
            }
            stream.write_all(b"{\"operation\":\"status\"}\n").await?;
            let mut reply = String::new();
            BufReader::new(stream).read_line(&mut reply).await?;
            let value: Value = serde_json::from_str(&reply)?;
            if value["result"]["root"] == true
                && value["result"]["uid"] == uid(owner)?
                && value["result"]["executable"] == expected.to_string_lossy().as_ref()
            {
                return Ok(());
            }
            Err("Service identity mismatch".into())
        };
        tokio::time::timeout(HEALTH_TIMEOUT, probe)
            .await
            .map_err(|_| "Service failed its startup health check")?
    })
}
