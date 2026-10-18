mod bus;
mod launch;
mod lease;
mod proxy;
mod scope;

pub use bus::{available, backend, busy, inspect};
pub use launch::{app, child, run};

use super::protocol::Failure;

pub struct Lease {
    pub id: String,
    bus: zbus::Connection,
    profile: Option<tempfile::TempDir>,
}

fn prerequisite(error: impl std::fmt::Display) -> Failure {
    Failure::new(
        "prerequisite",
        format!(
            "Workspace isolation is unavailable: {error}; enable the Farstep adapter for this \
             compositor (GNOME needs static workspaces on every monitor)"
        ),
    )
}
