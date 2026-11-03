use std::collections::HashMap;
use std::os::fd::AsFd;
use std::os::unix::fs::PermissionsExt;

use backon::Retryable;
use zbus::OwnedFd;
use zbus_systemd::systemd1::ManagerProxy;

use super::super::protocol::{Failure, Result};
use super::bus::{adapter, launch_bus};
use super::scope::{SCOPE_STOP_WAIT, SCOPE_WAIT, WaitError, manager_bus, scope};
use super::{Lease, prerequisite};

impl Lease {
    pub async fn open(bus: zbus::Connection, uri: &str) -> Result<Self> {
        let adapter = adapter(&bus).await.map_err(prerequisite)?;
        let id = uuid::Uuid::new_v4().to_string();
        let mut profile = tempfile::Builder::new()
            .prefix("omp-gui-")
            .permissions(std::fs::Permissions::from_mode(0o700))
            .tempdir()
            .map_err(prerequisite)?;
        let helper = std::env::current_exe().map_err(prerequisite)?;
        let environment = std::iter::once((
            "FARSTEP_WORKSPACE_HELPER".into(),
            helper.to_string_lossy().into_owned(),
        ))
        .chain(
            ["FARSTEP_WORKSPACE_DBUS_CONFIG", "PATH"]
                .into_iter()
                .filter_map(|key| std::env::var(key).ok().map(|value| (key.into(), value))),
        )
        .collect();
        let _: u32 = adapter
            .open(
                &id,
                uri,
                profile.path().to_string_lossy().as_ref(),
                &environment,
            )
            .await
            .map_err(prerequisite)?;
        // Retain a live browser's profile if stopping its scope later fails
        profile.disable_cleanup(true);
        drop(adapter);
        Self::prepared(Self {
            id,
            bus,
            profile: Some(profile),
        })
        .await
    }

    pub(super) async fn launch(arguments: &[String]) -> Result<Self> {
        if arguments.is_empty() {
            return Err(Failure::new(
                "invalid-request",
                "workspace run requires an executable",
            ));
        }
        if std::env::var_os("WAYLAND_DISPLAY").is_none() {
            return Err(prerequisite(
                "Wayland graphical-session environment is required",
            ));
        }
        let bus = launch_bus().await?;
        let id = uuid::Uuid::new_v4().to_string();
        let duplicate = |fd: std::os::fd::BorrowedFd<'_>| -> Result<OwnedFd> {
            fd.try_clone_to_owned()
                .map(OwnedFd::from)
                .map_err(prerequisite)
        };
        let descriptors = vec![
            duplicate(std::io::stdin().as_fd())?,
            duplicate(std::io::stdout().as_fd())?,
            duplicate(std::io::stderr().as_fd())?,
        ];
        let mut environment: HashMap<String, String> = std::env::vars().collect();
        environment.insert(
            "FARSTEP_WORKSPACE_HELPER".into(),
            std::env::current_exe()
                .map_err(prerequisite)?
                .to_string_lossy()
                .into_owned(),
        );
        let directory = std::env::current_dir().map_err(prerequisite)?;
        let _: u32 = adapter(&bus)
            .await
            .map_err(prerequisite)?
            .launch(
                &id,
                arguments,
                &environment,
                directory.to_string_lossy().as_ref(),
                &descriptors,
            )
            .await
            .map_err(prerequisite)?;
        Self::prepared(Self {
            id,
            bus,
            profile: None,
        })
        .await
    }

    pub(super) async fn status(&self) -> Result<(bool, bool, i32)> {
        adapter(&self.bus)
            .await
            .map_err(prerequisite)?
            .status(&self.id)
            .await
            .map_err(prerequisite)
    }

    async fn prepared(lease: Self) -> Result<Self> {
        let result = (|| async {
            let (ready, exited, status) = lease.status().await?;
            if ready {
                return Ok(());
            }
            if exited {
                return Err(prerequisite(format!(
                    "Scoped GUI launcher exited before isolation was ready ({status})"
                ))
                .into());
            }
            Err(WaitError::Pending)
        })
        .retry(SCOPE_WAIT)
        .when(|error| matches!(error, WaitError::Pending))
        .await
        .map_err(|error| error.failure("Timed out waiting for the user-systemd launch scope"));
        if let Err(error) = result {
            let _ = lease.release().await;
            return Err(error);
        }
        Ok(lease)
    }

    async fn signal_scope(&self, signal: i32) -> Result<()> {
        let manager = manager_bus().await?;
        match ManagerProxy::new(&manager)
            .await
            .map_err(prerequisite)?
            .kill_unit(scope(&self.id), "all".into(), signal)
            .await
        {
            Ok(()) => Ok(()),
            Err(zbus_systemd::zbus::Error::MethodError(name, ..))
                if matches!(
                    name.as_str(),
                    "org.freedesktop.systemd1.NoSuchUnit"
                        | "org.freedesktop.systemd1.UnitNotLoaded"
                        | "org.freedesktop.systemd1.UnitNotRunning"
                        | "org.freedesktop.systemd1.NoSuchProcess"
                ) =>
            {
                Ok(())
            }
            Err(error) => Err(prerequisite(error)),
        }
    }

    pub async fn release(self) -> Result<()> {
        // Scope identity survives forks, reparenting and new process sessions
        // Stop all descendants while pre-map routing remains installed
        self.signal_scope(rustix::process::Signal::TERM.as_raw())
            .await?;
        let proxy = adapter(&self.bus).await.map_err(prerequisite)?;
        let complete = (|| async {
            if proxy.release(&self.id).await.map_err(prerequisite)? {
                Ok(())
            } else {
                Err(WaitError::Pending)
            }
        })
        .retry(SCOPE_STOP_WAIT)
        .when(|error| matches!(error, WaitError::Pending))
        .await;
        if let Err(WaitError::Failed(error)) = complete {
            return Err(error);
        }
        if matches!(complete, Err(WaitError::Pending)) {
            self.signal_scope(rustix::process::Signal::KILL.as_raw())
                .await?;
            // Deferred cleanup never deletes a workspace with unrelated windows
            let _: bool = proxy.release(&self.id).await.map_err(prerequisite)?;
        }
        if let Some(profile) = self.profile {
            profile.close().map_err(prerequisite)?;
        }
        Ok(())
    }
}
