use std::path::PathBuf;
use std::time::Duration;

use futures_util::StreamExt;

use super::protocol::{Failure, Result};

const BROKER_TIMEOUT: Duration = Duration::from_secs(5);
const STOP_TIMEOUT: Duration = Duration::from_secs(4);

pub struct Broker(tokio::process::Child);

impl Broker {
    pub async fn start() -> Result<Option<Self>> {
        let desktop = std::env::var("XDG_CURRENT_DESKTOP").unwrap_or_default();
        if std::env::var("FARSTEP_NESTED_DESKTOP").as_deref() == Ok("cosmic")
            || !desktop.split(':').any(|name| {
                ["sway", "niri", "hyprland"]
                    .iter()
                    .any(|native| name.eq_ignore_ascii_case(native))
            })
        {
            return Ok(None);
        }
        let bus = zbus::Connection::session().await.map_err(failure)?;
        let names = zbus::fdo::DBusProxy::new(&bus).await.map_err(failure)?;
        let mut owners = names
            .receive_name_owner_changed_with_args(&[(0, "org.farstep.Workspaces")])
            .await
            .map_err(failure)?;
        if names
            .name_has_owner("org.farstep.Workspaces".try_into().map_err(failure)?)
            .await
            .map_err(failure)?
        {
            return Err(failure(
                "Another workspace broker already owns this session",
            ));
        }
        let package = std::env::var_os("FARSTEP_PACKAGE_PATH")
            .map(PathBuf::from)
            .ok_or_else(|| failure("Farstep package path is missing"))?;
        let mut broker = Self(
            tokio::process::Command::new("gjs")
                .env("FARSTEP_BROKER_PARENT", std::process::id().to_string())
                .arg("-m")
                .arg(package.join("share/farstep/native/broker.js"))
                .kill_on_drop(true)
                .spawn()
                .map_err(failure)?,
        );
        tokio::select! {
            status = broker.0.wait() => {
                return Err(failure(format!("Workspace broker exited: {}", status.map_err(failure)?)));
            },
            ready = tokio::time::timeout(BROKER_TIMEOUT, async {
                while let Some(owner) = owners.next().await {
                    if owner.args().map_err(failure)?.new_owner().is_some() {
                        return Ok(());
                    }
                }
                Err(failure("Workspace broker readiness subscription ended"))
            }) => ready.map_err(|_| failure("Workspace broker did not acquire its session bus name"))??,
        }
        Ok(Some(broker))
    }

    pub async fn exited(&mut self) {
        let _ = self.0.wait().await;
    }

    pub async fn stop(mut self) {
        if let Some(pid) = self
            .0
            .id()
            .and_then(|pid| rustix::process::Pid::from_raw(pid as i32))
        {
            let _ = rustix::process::kill_process(pid, rustix::process::Signal::TERM);
        }
        if tokio::time::timeout(STOP_TIMEOUT, self.0.wait())
            .await
            .is_err()
        {
            let _ = self.0.kill().await;
        }
    }
}

fn failure(error: impl std::fmt::Display) -> Failure {
    Failure::new("prerequisite", error)
}
