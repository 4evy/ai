//! Desktop command routing without native backend implementation
#![forbid(unsafe_code)]

#[cfg(all(target_os = "linux", any(feature = "desktop", feature = "systemd")))]
#[path = "cli/cli.rs"]
mod cli;

#[cfg(feature = "cli")]
pub async fn run() -> farstep_protocol::Result<i32> {
    #[cfg(all(target_os = "linux", any(feature = "desktop", feature = "systemd")))]
    return cli::run().await;

    #[cfg(all(feature = "desktop", any(target_os = "macos", target_os = "windows")))]
    return farstep_desktop_platform::run().await;

    #[cfg(not(any(
        all(target_os = "linux", any(feature = "desktop", feature = "systemd")),
        all(feature = "desktop", any(target_os = "macos", target_os = "windows"))
    )))]
    Err(farstep_protocol::Failure::new(
        "unsupported-platform",
        format!("No desktop backend enabled for {}", std::env::consts::OS),
    ))
}
