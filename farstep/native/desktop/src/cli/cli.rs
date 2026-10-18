use clap::Parser;
use farstep_protocol::Result;

#[cfg(feature = "desktop")]
use crate::linux::{clipboard, daemon, workspace};
#[cfg(feature = "systemd")]
use crate::systemd;

#[derive(Parser)]
enum Cli {
    #[cfg(feature = "systemd")]
    /// Query and control systemd through its native D-Bus interfaces
    Systemd(systemd::Command),
    #[cfg(feature = "desktop")]
    /// Serve desktop tools over the private Unix socket
    Daemon,
    #[cfg(feature = "desktop")]
    /// Clipboard ownership helpers
    #[command(subcommand)]
    Clipboard(Clipboard),
    #[cfg(feature = "desktop")]
    /// Inspect and control isolated desktop workspaces
    #[command(subcommand)]
    Workspace(Workspace),
}

#[cfg(feature = "desktop")]
#[derive(clap::Subcommand)]
enum Clipboard {
    /// Own a data-control clipboard selection supplied on stdin
    Worker,
}

#[cfg(feature = "desktop")]
#[derive(clap::Subcommand)]
enum Workspace {
    /// Run a command in an isolated desktop workspace
    Run {
        #[arg(last = true, required = true, num_args = 1.., value_name = "EXECUTABLE [ARGUMENTS]")]
        arguments: Vec<String>,
    },
    /// Inspect the active workspace adapter, including the private COSMIC
    /// desktop
    Inspect,
    /// Count live workspace scopes, including the private COSMIC desktop
    Busy,
    /// Attach to the workspace scope and exec the isolated command
    Child {
        id: String,
        #[arg(last = true, required = true, num_args = 1.., value_name = "EXECUTABLE [ARGUMENTS]")]
        arguments: Vec<String>,
    },
    /// Restore the trusted socket only after the private bus daemon starts
    #[command(hide = true)]
    App {
        #[arg(last = true, required = true, num_args = 1.., value_name = "EXECUTABLE [ARGUMENTS]")]
        arguments: Vec<String>,
    },
}

pub(crate) async fn run() -> Result<i32> {
    match Cli::parse() {
        #[cfg(feature = "systemd")]
        Cli::Systemd(command) => command.run().await,
        #[cfg(feature = "desktop")]
        Cli::Daemon => daemon().await.map(|()| 0).map_err(Into::into),
        #[cfg(feature = "desktop")]
        Cli::Clipboard(Clipboard::Worker) => clipboard::worker().map(|()| 0).map_err(Into::into),
        #[cfg(feature = "desktop")]
        Cli::Workspace(Workspace::Run { arguments }) => {
            workspace::run(&arguments).await.map_err(Into::into)
        }
        #[cfg(feature = "desktop")]
        Cli::Workspace(Workspace::Inspect) => workspace::inspect()
            .await
            .map(|inspection| {
                println!("{inspection}");
                0
            })
            .map_err(Into::into),
        #[cfg(feature = "desktop")]
        Cli::Workspace(Workspace::Busy) => workspace::busy()
            .await
            .map(|count| {
                println!("{count}");
                0
            })
            .map_err(Into::into),
        #[cfg(feature = "desktop")]
        Cli::Workspace(Workspace::Child { id, arguments }) => workspace::child(&id, &arguments)
            .await
            .map(|()| 0)
            .map_err(Into::into),
        #[cfg(feature = "desktop")]
        Cli::Workspace(Workspace::App { arguments }) => {
            workspace::app(&arguments).map(|()| 0).map_err(Into::into)
        }
    }
}
