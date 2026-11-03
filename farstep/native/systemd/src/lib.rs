//! Native systemd queries and job control, independent of desktop backends
#![forbid(unsafe_code)]

#[cfg(target_os = "linux")]
#[path = "systemd.rs"]
mod systemd;
#[cfg(target_os = "linux")]
pub use systemd::Command;
