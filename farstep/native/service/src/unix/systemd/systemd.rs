use std::time::Duration;

use futures_util::StreamExt;
use zbus_systemd::systemd1::ManagerProxy;
use zbus_systemd::zbus;

use crate::Result;

const MANAGER_TIMEOUT: Duration = Duration::from_secs(30);

pub(super) enum Action {
    Reload,
    Enable,
    Disable,
    Start,
    Stop,
}

pub(super) fn manage(owner: &str, action: Action, allow_failure: bool) -> Result<()> {
    tokio::runtime::Runtime::new()?.block_on(async {
        let bus = zbus::Connection::system().await?;
        let manager = ManagerProxy::new(&bus).await?;
        let work = async {
            let unit = super::name(owner);
            match action {
                Action::Reload => return Ok(manager.reload().await?),
                Action::Enable => {
                    manager.enable_unit_files(vec![unit], false, false).await?;
                    return Ok(manager.reload().await?);
                }
                Action::Disable => {
                    manager.disable_unit_files(vec![unit], false).await?;
                    return Ok(manager.reload().await?);
                }
                Action::Start | Action::Stop => {}
            }
            // Subscribe before enqueueing so a fast job cannot finish
            // unobserved
            let mut jobs = manager.receive_job_removed().await?;
            manager.subscribe().await?;
            let job = match action {
                Action::Start => manager.start_unit(unit, "replace".into()).await?,
                _ => manager.stop_unit(unit, "replace".into()).await?,
            };
            while let Some(signal) = jobs.next().await {
                let result = signal.args()?;
                if result.job != job {
                    continue;
                }
                if result.result == "done" {
                    return Ok(());
                }
                return Err(format!("{} job {}", result.unit, result.result).into());
            }
            Err("Systemd disconnected before the job finished".into())
        };
        let result: Result<()> = tokio::time::timeout(MANAGER_TIMEOUT, work)
            .await
            .map_err(|_| "Systemd service management timed out")?;
        if allow_failure { Ok(()) } else { result }
    })
}
