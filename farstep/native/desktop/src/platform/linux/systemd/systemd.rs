use std::collections::BTreeMap;

use farstep_protocol::{Failure, Result};
use futures_util::{StreamExt, TryStreamExt, stream};
use serde_json::json;
use zbus_systemd::{login1, systemd1, zbus};

const INACTIVE_EXIT_CODE: i32 = 3;
const ACTIVE_STATES: &[&str] = &["active", "reloading", "refreshing"];
const ENABLED_STATES: &[&str] = &[
    "enabled",
    "enabled-runtime",
    "alias",
    "static",
    "indirect",
    "generated",
];

#[derive(clap::Args)]
pub struct Command {
    #[arg(long, global = true)]
    user: bool,
    #[arg(long, global = true)]
    now: bool,
    #[command(subcommand)]
    action: Action,
}

#[derive(clap::Subcommand)]
enum Action {
    #[command(subcommand)]
    Show(Show),
    #[command(subcommand)]
    Is(Is),
    #[command(subcommand)]
    Daemon(Daemon),
    Enable {
        unit: String,
    },
    Disable {
        unit: String,
    },
    Start {
        unit: String,
    },
    Stop {
        unit: String,
    },
    #[command(subcommand)]
    Try(Try),
    Sessions,
}

#[derive(clap::Subcommand)]
enum Show {
    Environment,
}

#[derive(clap::Subcommand)]
enum Is {
    Active { unit: String },
    Enabled { unit: String },
}

#[derive(clap::Subcommand)]
enum Daemon {
    Reload,
}

#[derive(clap::Subcommand)]
enum Try {
    Restart { unit: String },
}

impl Command {
    pub async fn run(self) -> Result<i32> {
        self.execute()
            .await
            .map_err(|error| Failure::new("systemd", error))
    }

    async fn execute(self) -> zbus::Result<i32> {
        let bus = if self.user {
            zbus::Connection::session().await?
        } else {
            zbus::Connection::system().await?
        };
        if matches!(self.action, Action::Sessions) {
            return sessions(&bus).await;
        }
        let manager = systemd1::ManagerProxy::new(&bus).await?;
        if let Some(status) = self.query(&bus, &manager).await? {
            return Ok(status);
        }
        if !self.configure(&manager).await? {
            return Ok(0);
        }
        wait_job(&manager, self.action).await
    }

    async fn query(
        &self,
        bus: &zbus::Connection,
        manager: &systemd1::ManagerProxy<'_>,
    ) -> zbus::Result<Option<i32>> {
        let status = match &self.action {
            Action::Show(Show::Environment) => {
                let values: BTreeMap<_, _> = manager
                    .environment()
                    .await?
                    .into_iter()
                    .filter_map(|entry| {
                        entry
                            .split_once('=')
                            .map(|(key, value)| (key.to_owned(), value.to_owned()))
                    })
                    .collect();
                println!("{}", json!(values));
                0
            }
            Action::Is(Is::Active { unit }) => {
                let path = manager.get_unit(unit.clone()).await?;
                let unit = systemd1::UnitProxy::builder(bus)
                    .path(path)?
                    .build()
                    .await?;
                if ACTIVE_STATES.contains(&unit.active_state().await?.as_str()) {
                    0
                } else {
                    INACTIVE_EXIT_CODE
                }
            }
            Action::Is(Is::Enabled { unit }) => {
                let state = manager.get_unit_file_state(unit.clone()).await?;
                if ENABLED_STATES.contains(&state.as_str()) {
                    0
                } else {
                    1
                }
            }
            Action::Daemon(Daemon::Reload) => {
                manager.reload().await?;
                0
            }
            _ => return Ok(None),
        };
        Ok(Some(status))
    }

    async fn configure(&self, manager: &systemd1::ManagerProxy<'_>) -> zbus::Result<bool> {
        match &self.action {
            Action::Enable { unit } => {
                manager
                    .enable_unit_files(vec![unit.clone()], false, false)
                    .await?;
            }
            Action::Disable { unit } => {
                manager
                    .disable_unit_files(vec![unit.clone()], false)
                    .await?;
            }
            _ => return Ok(true),
        }
        manager.reload().await?;
        Ok(self.now)
    }
}

async fn sessions(bus: &zbus::Connection) -> zbus::Result<i32> {
    let manager = login1::ManagerProxy::new(bus).await?;
    let sessions: Vec<_> = stream::iter(manager.list_sessions().await?)
        .then(|(id, _, _, _, path)| async move {
            let session = login1::SessionProxy::builder(bus)
                .path(path)?
                .build()
                .await?;
            Ok::<_, zbus::Error>(json!({
                "id": id,
                "tty": session.tty().await?,
                "vtNr": session.vt_nr().await?,
            }))
        })
        .try_collect()
        .await?;
    println!("{}", json!(sessions));
    Ok(0)
}

async fn wait_job(manager: &systemd1::ManagerProxy<'_>, action: Action) -> zbus::Result<i32> {
    // Subscribe before enqueueing so a fast job cannot finish unobserved
    let mut jobs = manager.receive_job_removed().await?;
    manager.subscribe().await?;
    let mode = "replace".to_owned();
    let job = match action {
        Action::Start { unit } | Action::Enable { unit } => manager.start_unit(unit, mode).await?,
        Action::Stop { unit } | Action::Disable { unit } => manager.stop_unit(unit, mode).await?,
        Action::Try(Try::Restart { unit }) => manager.try_restart_unit(unit, mode).await?,
        _ => {
            return Err(zbus::Error::Failure(
                "Systemd command did not enqueue a job".to_owned(),
            ));
        }
    };
    while let Some(signal) = jobs.next().await {
        let result = signal.args()?;
        if result.job != job {
            continue;
        }
        if result.result == "done" {
            return Ok(0);
        }
        return Err(zbus::Error::Failure(format!(
            "{} job {}",
            result.unit, result.result
        )));
    }
    Err(zbus::Error::Failure(
        "Systemd disconnected before the job finished".to_owned(),
    ))
}
