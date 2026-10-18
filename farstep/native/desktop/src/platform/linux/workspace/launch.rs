use std::os::unix::process::CommandExt;

use backon::Retryable;
use procfs::process::Process;
use zbus_systemd::systemd1::ManagerProxy;
use zbus_systemd::zvariant::Value;

use super::super::protocol::{Failure, Result};
use super::bus::adapter;
use super::scope::{SCOPE_POLL_INTERVAL, SCOPE_WAIT, WaitError, in_scope, manager_bus, scope};
use super::{Lease, prerequisite, proxy};

pub(super) fn signal_exit_code(signal: i32) -> i32 {
    128 + signal
}

pub async fn run(arguments: &[String]) -> Result<i32> {
    let mut terminate = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
        .map_err(prerequisite)?;
    let mut interrupt = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::interrupt())
        .map_err(prerequisite)?;
    let mut hangup = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::hangup())
        .map_err(prerequisite)?;
    let lease = Lease::launch(arguments).await?;
    let mut interval = tokio::time::interval(SCOPE_POLL_INTERVAL);
    let parent = rustix::process::getppid();
    let stdin = std::io::stdin();
    let mut input = [rustix::event::PollFd::new(
        &stdin,
        rustix::event::PollFlags::HUP,
    )];
    let result = loop {
        tokio::select! {
            _ = terminate.recv() => break Ok(signal_exit_code(rustix::process::Signal::TERM.as_raw())),
            _ = interrupt.recv() => break Ok(signal_exit_code(rustix::process::Signal::INT.as_raw())),
            _ = hangup.recv() => break Ok(signal_exit_code(rustix::process::Signal::HUP.as_raw())),
            _ = interval.tick() => {
                if rustix::process::getppid() != parent {
                    break Ok(signal_exit_code(rustix::process::Signal::HUP.as_raw()));
                }
                let timeout = rustix::event::Timespec::default();
                if let Err(error) = rustix::event::poll(&mut input, Some(&timeout)) {
                    break Err(prerequisite(error));
                }
                if input[0].revents().contains(rustix::event::PollFlags::HUP) {
                    break Ok(0);
                }
                match lease.status().await {
                    Ok((_, true, status)) => break Ok(status),
                    Ok((_, false, _)) => {}
                    Err(error) => break Err(error),
                }
            },
        }
    };
    let released = lease.release().await;
    match result {
        Err(error) => Err(error),
        Ok(status) => released.map(|()| status),
    }
}

pub async fn child(id: &str, arguments: &[String]) -> Result<()> {
    uuid::Uuid::parse_str(id).map_err(prerequisite)?;
    if arguments.is_empty() {
        return Err(Failure::new(
            "invalid-request",
            "workspace child requires an executable",
        ));
    }
    let bus = zbus::Connection::session().await.map_err(prerequisite)?;
    let unit = scope(id);
    let mut properties = vec![
        ("PIDs", Value::new(vec![std::process::id()])),
        ("Description", Value::from("Farstep isolated GUI launch")),
        ("CollectMode", Value::from("inactive-or-failed")),
    ];
    if let Ok(parent) = std::env::var("FARSTEP_WORKSPACE_SCOPE_PARENT")
        && !parent.is_empty()
    {
        properties.push(("BindsTo", Value::new(vec![parent.clone()])));
        properties.push(("After", Value::new(vec![parent])));
    }
    let properties = properties
        .into_iter()
        .map(|(name, value)| Ok((name.to_owned(), value.try_to_owned()?)))
        .collect::<zbus_systemd::zvariant::Result<Vec<_>>>()
        .map_err(prerequisite)?;
    let manager = manager_bus().await?;
    ManagerProxy::new(&manager)
        .await
        .map_err(prerequisite)?
        .start_transient_unit(unit.clone(), "fail".into(), properties, Vec::new())
        .await
        .map_err(prerequisite)?;
    (|| async {
        let process = Process::myself().map_err(prerequisite)?;
        if in_scope(&process, &unit).map_err(prerequisite)? {
            Ok(())
        } else {
            Err(WaitError::Pending)
        }
    })
    .retry(SCOPE_WAIT)
    .when(|error| matches!(error, WaitError::Pending))
    .await
    .map_err(|error| error.failure("The user-systemd launch scope did not attach"))?;
    let _: () = adapter(&bus)
        .await
        .map_err(prerequisite)?
        .ready(id)
        .await
        .map_err(prerequisite)?;
    drop(bus);
    // The session daemon closes FD 3, so its activation environment must not
    // advertise that inherited socket to portals or their GTK descendants
    let mut command = std::process::Command::new("setsid");
    command
        .env_remove("WAYLAND_SOCKET")
        .env("FARSTEP_WORKSPACE_ID", id)
        .args(["--wait", "dbus-run-session"]);
    if let Some(configuration) = std::env::var_os("FARSTEP_WORKSPACE_DBUS_CONFIG") {
        command.arg("--config-file").arg(configuration);
    }
    let error = command
        .arg("--")
        .arg(std::env::current_exe().map_err(prerequisite)?)
        .args(["workspace", "app", "--"])
        .args(arguments)
        .exec();
    Err(prerequisite(error))
}

pub fn app(arguments: &[String]) -> Result<()> {
    if std::env::var("FARSTEP_WORKSPACE_SOCKET").as_deref() == Ok("proxy") {
        return proxy::run(arguments);
    }
    let Some((executable, arguments)) = arguments.split_first() else {
        return Err(Failure::new(
            "invalid-request",
            "workspace app requires an executable",
        ));
    };
    // Only the direct native app inherits the compositor's trusted socket
    let mut command = std::process::Command::new(executable);
    command.args(arguments);
    if std::env::var("FARSTEP_WORKSPACE_SOCKET").as_deref() == Ok("inherited") {
        command.env("WAYLAND_SOCKET", "3");
    } else {
        command.env_remove("WAYLAND_SOCKET");
    }
    let error = command.exec();
    Err(prerequisite(error))
}
