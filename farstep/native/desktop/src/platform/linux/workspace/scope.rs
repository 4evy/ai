use std::time::Duration;

use backon::ConstantBuilder;
use procfs::process::Process;
use zbus_systemd::zbus;

use super::super::protocol::{Failure, Result};
use super::prerequisite;

pub(super) const SCOPE_POLL_INTERVAL: Duration = Duration::from_millis(100);

// Backon counts retries after the first attempt: 49 retries give 50 checks
pub(super) const SCOPE_WAIT: ConstantBuilder = ConstantBuilder::new()
    .with_delay(SCOPE_POLL_INTERVAL)
    .with_max_times(50 - 1);

pub(super) const SCOPE_STOP_WAIT: ConstantBuilder = SCOPE_WAIT.with_max_times(20 - 1);

#[derive(derive_more::From)]
pub(super) enum WaitError {
    Pending,
    Failed(Failure),
}

impl WaitError {
    pub(super) fn failure(self, timeout: &str) -> Failure {
        match self {
            Self::Pending => prerequisite(timeout),
            Self::Failed(error) => error,
        }
    }
}

pub(super) fn scope(id: &str) -> String {
    format!("omp-gui-{id}.scope")
}

pub(super) fn in_scope(process: &Process, unit: &str) -> procfs::ProcResult<bool> {
    Ok(process
        .cgroups()?
        .into_iter()
        .any(|group| group.pathname.split('/').any(|component| component == unit)))
}

pub(super) async fn manager_bus() -> Result<zbus::Connection> {
    use zbus::address::transport::{Unix, UnixSocket};
    // The private application bus has no user systemd manager
    let runtime = dirs::runtime_dir().ok_or_else(|| prerequisite("XDG_RUNTIME_DIR is missing"))?;
    let address = zbus::Address::new(zbus::address::Transport::Unix(Unix::new(UnixSocket::File(
        runtime.join("bus"),
    ))));
    zbus::connection::Builder::address(address)
        .map_err(prerequisite)?
        .build()
        .await
        .map_err(prerequisite)
}
